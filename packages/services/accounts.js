/* packages/services/accounts.js - V5 P04 PostgreSQL account/profile/social service.
 *
 * The V5 successor to CommunityStore (server/community-store.js) over the normalized schema:
 * profiles, linked identities, credentials/OTP, sessions, the social graph, privacy reports and
 * the revisioned practice archive - all through the shared PostgreSQL unit of work and the
 * account-owned repository set in packages/db/pg/accounts.js.
 *
 *   const pool = createPgPool(fromEnvironment(process.env));      // caller-owned, guarded
 *   const accounts = await createAccountService(pool, {
 *     now,                  // injected clock (default Date.now)
 *     random,               // unused today; accepted so a caller threads one seed
 *     verifyPurchase,       // forwarded into the domain aggregate
 *     otpSecret,            // REQUIRED stable per-environment HMAC key for one-time codes
 *     securityNotify,       // (actor, event, details) => void, best effort
 *     deletionPolicy,       // {enabled, policyVersion}
 *     provisionActor,       // async (actor) => void, Core-owned (awaited AFTER the API commit)
 *     cancelSocialOffers,   // async (actor, target) => void, Core-owned (awaited AFTER the commit)
 *     completeDeletion,     // async ({actor, receiptId, tombstone, ...}) => void, worker/Core-owned
 *   });
 *
 * Factory contract: construction runs `verifyRuntimeSchema(pool)` and REJECTS with
 * `SCHEMA_NOT_READY` / `SCHEMA_INCOMPATIBLE` (PgGuardError) on an unmigrated or diverged schema,
 * with `RUNTIME_POOL_REQUIRED` when the pool is not a guarded runtime pool, with `ROLE_REQUIRED`
 * when the pool's role is not `api_runtime` (readiness alone permits core/worker, and this service
 * must run with the API's grants), and with `OTP_SECRET_REQUIRED` when `options.otpSecret` is
 * absent or too short (a per-process random fallback would make OTP challenges unverifiable across
 * instances). No constructor creates schema, singletons, actors, wallets or opening balances.
 *
 * Legacy names and argument ORDER are preserved; every method returns a Promise because
 * PostgreSQL I/O cannot be synchronous. Exceptions to a 1:1 port, each deliberate:
 *   - `heartbeat` refuses with PRESENCE_OWNED_BY_P06: presence is the managed-Redis tier's
 *     (V5 P06), and a durable presence row would be a second source of truth for an ephemeral fact.
 *   - `deleteAccount` performs the API's real disable (sessions/challenges/identities/credential
 *     removal, profile tombstone, unverified account) plus a durable privacy request, receipt and
 *     Core hand-off outbox row. The economic/competitive erasure is Core's, so no economic row is
 *     touched here and no no-op "deleted" is returned.
 *   - The cross-platform token/refresh/ticket machinery is P05's; `issue`/`bootstrap` keep exactly
 *     the V4 session semantics (14-day linked / 1-day anonymous bearer + CSRF).
 *   - Economic mutation is Core's: this service never touches economy.wallets/ledger/ratings.
 *
 * Four external read dependencies are REQUIRED schema additions (owner-created, EXECUTE-granted
 * functions; see SECRET_READ_FUNCTIONS in packages/db/pg/accounts.js and the phase report for the
 * exact SQL). They exist because 0020 withholds the credential secret columns from api_runtime and
 * because api_runtime has no USAGE on economy/core, so the credential, competitive and economic
 * projections cannot be read directly. A missing function fails loudly (ACCOUNT_STATE_UNAVAILABLE /
 * ACCOUNT_ACTIVITY_UNAVAILABLE / ACCOUNT_EXPORT_UNAVAILABLE / 42883), never with a fabricated zero
 * balance and never through a privileged connection.
 *
 * CANONICAL AUTH LOCK ORDER (every session/identity mutation): source-bearer logical key, then the
 * provider-subject logical key when a provider identity is in play, then the ONE actor auth mutex
 * (`lockAuth`), then the eligibility/credential/session ROW locks and dependent reads. The actor is
 * resolved optimistically before locking and re-read after every wait, rejecting changed
 * owners/credentials. Row locks alone cannot serialize an ABSENT identity, which is why the logical
 * keys exist; the real `identity.eligibility` row lock is what serializes with Core actor admission.
 *
 * Password verification reuses the shipped format-aware bounded async implementation
 * (server/production/passwords.js) OUTSIDE the transaction: modern scrypt-v1$ (N=131072) and legacy
 * unprefixed (N=16384) verifiers both authenticate, and the bounded scrypt worker keeps a password
 * hash from pinning a database transaction. The extracted pure legacy helper in
 * packages/domain/account-policy.js is left unchanged for its V4 callers.
 */
'use strict';
const crypto = require('node:crypto');
const D = require('../domain/index.js');
const policy = require('../domain/account-policy.js');
const { ContextError } = require('../db/context');
const { verifyRuntimeSchema } = require('../db/pg/readiness');
const { createPgUnitOfWork } = require('../db/pg/uow');
const { accountRepositoryFor, SECRET_READ_FUNCTIONS } = require('../db/pg/accounts');
const { SOCIAL_OPERATIONS } = require('../db/scopes');
const { Passwords } = require('../../server/production/passwords.js');
const { seasonStatusOf } = require('../../src/authority.js');

const DAY = policy.DAY;
const REAUTH_WINDOW = 15 * 60000;
const SESSION_LINKED_TTL = 14 * DAY;
const SESSION_ANON_TTL = DAY;
const SESSION_KEEP = 5;
const SIGNIN_TTL = 5 * 60000;
/* Approved social limits (unchanged policy values from the V4 store) and the bounded page size for
 * the friends LIST reads. Authorization uses exact pair reads and complete COUNTs; only the
 * user-facing lists are paged, and a full page reports `truncated` instead of pretending completeness. */
const FRIEND_MAX = 200;
const REQUEST_MAX = 50;
const FRIEND_LIST_LIMIT = 500;
const PROVISION_KIND = 'account.provision';
const PROVISION_TTL = 30 * DAY;
const SOCIAL_CANCEL_KIND = 'social.cancel-offers';
const EMAIL_CHANGED_KIND = 'account.email-changed';
const DELETION_KIND = 'account.deletion';
const DELETION_RETAINED = Object.freeze(['purchase_replay_records', 'operator_security_audit', 'pseudonymized_moderation_outcomes']);

const fail = (code) => { throw Error(code); };
const json = (value) => JSON.stringify(value);
const safeInt = (value) => Number.isSafeInteger(value) && value >= 0;
const sessionId = (tokenHash) => crypto.createHash('sha256').update(tokenHash).digest('hex').slice(0, 24);
/* The shared logical-identity advisory locks (packages/db/pg/locks.js). THE canonical auth lock
 * order, applied by every session/identity mutation:
 *   1. the source-bearer LOGICAL key (its sha256, never the raw bearer),
 *   2. the provider-subject logical key when a provider identity is in play,
 *   3. the ONE actor auth mutex,
 *   4. the actual eligibility/credential/session ROW locks and dependent reads.
 * The actor is resolved OPTIMISTICALLY before locking and re-read after every wait, rejecting a
 * changed owner/credential. The aggregate namespace/parts shape matches `aggregate + [kind,id]`. */
const LOCK_NAMESPACE = 'aggregate';
const lockActorIdentity = (repositories, actor, key) => repositories.lockIdentity(LOCK_NAMESPACE, [key, String(actor)]);
const lockProviderIdentity = (repositories, provider, subject) => repositories.lockIdentity('provider-subject', [String(provider), String(subject)]);
/* THE one actor auth mutex. Every session/identity operation for an actor serializes here (login
 * issuance, logout/revoke, password reset, unlink, link, reauth), so no two transitions can
 * interleave a session/identity change: a reset that revokes all sessions cannot miss a session a
 * concurrent login is about to insert, and an unlink cannot race a link. */
const lockAuth = (repositories, actor) => lockActorIdentity(repositories, actor, 'auth');
/* The source-bearer logical mutex, taken FIRST by every session-bound mutator (before the actor auth
 * mutex and any session ROW lock). */
const lockSessionToken = (repositories, token) => repositories.lockIdentity(LOCK_NAMESPACE, ['session', repositories.sessions.hash(token)]);
/* One logical identity per challenge, so two concurrent OTP verifications/completions of the same
 * challenge serialize (the durable verified/consumed predicates decide the single winner). */
const lockChallengeIdentity = (repositories, id) => repositories.lockIdentity(LOCK_NAMESPACE, ['challenge', String(id)]);
/* The canonical credential stamp (sha256(actor|password_hash) hex, account-policy.credentialStamp):
 * pinned on a challenge at issue time and compared before every grant, so a rotated/replaced
 * credential invalidates authorizations that were issued against the old one. */
const credStamp = (credential) => (credential && credential.actor && typeof credential.passwordHash === 'string'
 ? policy.credentialStamp(credential.actor, credential.passwordHash) : null);
const stampMatches = (challenge, credential) => challenge.credentialHash !== null && challenge.credentialHash !== undefined
 && challenge.credentialHash === credStamp(credential);
/* G9: a challenge whose credential-version ROW is absent (purged/tampered/legacy) is unusable for
 * every purpose. A signup challenge legitimately pins a NULL stamp VALUE but its row still exists,
 * so the read function's existence flag, not the value, decides. */
const stampRowPresent = (challenge) => challenge.credentialStampPresent === true;
const newActorId = () => `u_${crypto.randomUUID()}`;
const mintTag = () => `MEGA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const mintUsername = () => `player_${crypto.randomBytes(5).toString('hex')}`;

/* ------------------------------------------------------------------ factory */

async function createAccountService(pool, options = {}) {
 if (!pool || typeof pool.withTransaction !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 /* Readiness FIRST: a service that booted against an unmigrated or diverged schema would fail
  * later with a confusing 42P01/42501 inside a request. The exact supported chain is the only
  * accepted state and only the migrator can repair it. */
 const readiness = await verifyRuntimeSchema(pool);
 const role = readiness.role;
 /* Readiness permits any runtime role; THIS service is the API's, so the role is enforced
  * separately. A core_runtime or worker_runtime pool here would silently run with the wrong grants
  * (no identity write privileges, no economy read privileges) instead of failing at construction. */
 if (role !== 'api_runtime') {
  const error = new ContextError('ROLE_REQUIRED');
  error.detail = `createAccountService requires api_runtime, got ${role}`;
  throw error;
 }
 const clock = typeof options.now === 'function' ? options.now : Date.now;
 /* A distributed account service MUST share one stable OTP key: a per-process random fallback would
  * make a challenge created by one instance unverifiable on another (and unverifiable after a
  * restart). Absent or too-short configuration is a hard startup failure, never a silent default. */
 if (typeof options.otpSecret !== 'string' || options.otpSecret.length < 16) throw new ContextError('OTP_SECRET_REQUIRED');
 const otpSecret = Buffer.from(options.otpSecret);
 const securityNotify = typeof options.securityNotify === 'function' ? options.securityNotify : () => {};
 const deletionPolicy = {
  enabled: options.deletionPolicy ? options.deletionPolicy.enabled === true : false,
  policyVersion: options.deletionPolicy && typeof options.deletionPolicy.policyVersion === 'string' ? options.deletionPolicy.policyVersion : '',
 };
 /* Core-owned effects are callbacks awaited only AFTER the API transaction committed. The durable
  * outbox row is the correctness contract, so neither callback is required: without them the work
  * simply stays pending in ops.outbox. Neither is ever a stub or a no-op fallback. */
 const provisionActor = typeof options.provisionActor === 'function' ? options.provisionActor : null;
 const cancelSocialOffers = typeof options.cancelSocialOffers === 'function' ? options.cancelSocialOffers : null;
 const completeDeletion = typeof options.completeDeletion === 'function' ? options.completeDeletion : null;
 const options_ = Object.freeze({ ...options, role });
 const uow = createPgUnitOfWork(pool, { now: clock, role });
 /* The shared format-aware bounded password verifier (one bounded worker per service instance). It
  * is used ONLY outside a transaction; see verifyStoredPassword. */
 const passwords = new Passwords({ concurrency: 2, maxQueue: 16, queueMs: 3000 });

 let closed = false;
 /* One transaction per call. The callback receives the account-owned repository set plus the
  * transaction facade, whose `repositories` carries the shared set (outcomes/jobs/...). The account
  * repository exposes the shared logical-identity lock helper so an absent-row identity can be
  * serialized on the SAME pinned transaction. */
 const run = (fn) => {
  if (closed) return Promise.reject(new ContextError('UNIT_OF_WORK_CLOSED'));
  return uow.run((tx) => fn(accountRepositoryFor({ client: tx.client, clock: tx.clock, role, options: options_ }), tx));
 };
 /* Best-effort Core/worker hand-off. Returns whether the callback actually completed, so a caller
  * can refresh a projection that depended on it. A failure is never swallowed into a fabricated
  * success; the durable ops.outbox row remains the contract and Core/worker drains it. */
 const afterCommit = async (work) => { try { await work(); return true; } catch { return false; } };
 const notify = (actor, event, details = {}) => { try { securityNotify(actor, event, details); } catch { /* best effort, like the legacy store */ } };
 const otpHash = (id, emailAddress, purpose, code) => crypto.createHmac('sha256', otpSecret).update([id, emailAddress, purpose, code].join('|')).digest('base64url');

 /* ---------------------------------------------------------------- shared internals */

 /* The required projection. A missing function is a schema/service failure and must NOT degrade to
  * a null "no economic facts" answer: walletReady and the competitive facts are required for the
  * API's own reads, and a silently-null projection would look like a pending account (or a zero
  * rating) instead of a broken deployment. */
 const accountState = async (repositories, actor) => repositories.accounts.state(actor);
 const rate = async (repositories, subject, bucket, limit, seconds = 60) => {
  const hits = await repositories.rate.count(`${bucket}:${subject}:${Math.floor(clock() / 1000 / seconds)}`);
  if (hits > limit) fail('RATE_LIMITED');
 };
 const sessionOf = async (repositories, token) => {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return null;
  const row = await repositories.sessions.live(repositories.sessions.hash(token), clock());
  if (!row) return null;
  if (row.actor) {
   const account = await repositories.accounts.for(row.actor);
   if (!account || account.suspended || account.hold || !account.verified) return null;
  }
  return { hash: row.token, actor: row.actor, csrf: row.csrf, expires: row.expires, authAt: row.auth_at };
 };
 /* The read-only session guard used by every session-bound method. The session is AWAITED before
  * the AUTH_REQUIRED rejection: `sessionOf(...) || fail(...)` would test a Promise (always truthy)
  * and never reject. */
 const sessionRow = async (repositories, token) => {
  const session = await sessionOf(repositories, token);
  if (!session) return fail('AUTH_REQUIRED');
  return session;
 };
 const linkedRow = async (repositories, token) => {
  const session = await sessionOf(repositories, token);
  if (!session) fail('AUTH_REQUIRED');
  if (!session.actor) fail('LINK_ACCOUNT_REQUIRED');
  return session;
 };
 const verifiedRow = async (repositories, actor) => {
  const account = await repositories.accounts.for(actor);
  if (!account || account.suspended || account.hold || !account.verified) fail('ACCOUNT_UNAVAILABLE');
  return account;
 };
 /* Inactive/held/suspended excluded, but email VERIFICATION-PENDING is allowed: the signup/verify-
  * existing OTP flow must be reachable by an actor whose email is not yet verified (only a valid
  * OTP thereafter stamps verification before any authenticated grant). */
 const activeRow = async (repositories, actor) => {
  const account = await repositories.accounts.for(actor);
  if (!account || account.suspended || account.hold) fail('ACCOUNT_UNAVAILABLE');
  return account;
 };
 /* Wallet-row existence IS the durable readiness fact (parent contract): no ready bit is stored, so
  * a pending actor has no wallet and cannot perform economic mutation. Reads and non-economic
  * identity work stay available. */
 const requireReady = async (repositories, actor) => {
  const account = await verifiedRow(repositories, actor);
  if (!(await repositories.accounts.walletReady(actor))) fail('ACCOUNT_UNAVAILABLE');
  return account;
 };
 const issue = async (repositories, actor = null, authAt = 0) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const created = clock();
  const expires = created + (actor ? SESSION_LINKED_TTL : SESSION_ANON_TTL);
  await repositories.sessions.insert({ tokenHash: repositories.sessions.hash(token), actor, csrf, created, expires, authAt });
  return { token, csrf, actor, expires, authAt };
 };
 /* Legacy `_replaceSession`: consume the SOURCE bearer in place (single-use) and issue its
  * replacement, keeping the five most recent sessions. The caller has already taken the actor auth
  * mutex and the source-bearer logical key (see the canonical order), so the consumption cannot race
  * a logout/revoke/reset. The consumption MUST delete exactly one still-live row; a zero-row result
  * means the source bearer was already consumed elsewhere, and issuing then would resurrect a bearer
  * that is intentionally gone. */
 const replaceSession = async (repositories, session, actor, created = false) => {
  const consumed = await repositories.sessions.rotate(session.hash);
  if (consumed !== 1) fail('AUTH_REQUIRED');
  const issued = await issue(repositories, actor, clock());
  await repositories.sessions.pruneBeyond(actor, SESSION_KEEP);
  return { ...issued, created, profile: await selfProfile(repositories, actor) };
 };
 /* The canonical profile pair-set relation: blocked beats friend, friend beats a pending request,
  * self-view is 'self' (server/community-store.js:196). Every decision is an EXACT pair read against
  * the pair tables - never a truncated incident list - so a block or pending request outside a
  * bounded page still decides the relation correctly. */
 const relationOf = async (repositories, actor, target) => {
  if (await repositories.social.pairBlocked(actor, target)) return 'blocked';
  if (await repositories.social.pairFriends(actor, target)) return 'friend';
  if (await repositories.social.pairRequest(target, actor)) return 'incoming';
  if (await repositories.social.pairRequest(actor, target)) return 'outgoing';
  return actor === target ? 'self' : 'none';
 };
 /* The public profile projection. Visibility is decided by the account flags, the EXACT pair
  * relation and the durable deletion state: a deletion-pending actor is hidden from every OTHER
  * viewer (its own self-view still resolves for the receipt/status surfaces). The published
  * competitive season is the APPROVED read-only projection (src/authority.js seasonStatusOf), not the
  * raw persisted season row - the raw row carries opponent IDs and win/loss counters that V4 never
  * published, and it lacks the approved start/end/uniqueOpponents/requirements/previous fields. */
 const loadProfile = async (repositories, viewer, actor, account, activity = null) => {
  const row = await repositories.profiles.for(actor);
  if (!account || !row) fail('PROFILE_NOT_FOUND');
  if (viewer !== actor) {
   const state = activity || await repositories.accounts.activity(actor);
   if (state && state.deletionPending === true) fail('PROFILE_NOT_FOUND');
  }
  const relation = await relationOf(repositories, viewer, actor);
  if (account.suspended || account.hold || relation === 'blocked') fail('PROFILE_NOT_FOUND');
  const state = await accountState(repositories, actor);
  const show = viewer === actor || row.stats_visibility === 'public' || (row.stats_visibility === 'friends' && relation === 'friend');
  return {
   id: actor, tag: row.tag, friendCode: row.tag, username: row.username, name: row.display_name, displayName: row.display_name,
   avatar: row.avatar,
   rating: state.competitive.rating, games: state.competitive.games, tier: state.competitive.tier,
   /* The approved projection mutates nothing on the Core-owned state it is projected from. A pending
    * actor whose approved season row Core has not yet materialized keeps the season UNKNOWN (null),
    * never a synthesized zero season. */
   season: state.season ? seasonStatusOf(state.season, state.competitive, state.seasonHistory, clock()) : null,
   relation, stats: show ? statsOf(state) : null, statsVisibility: row.stats_visibility,
   /* Presence lives in the managed-Redis tier (P06); a durable row would be a second source of
    * truth for an ephemeral fact, so the projection is reported as hidden rather than invented. */
   presence: { state: 'hidden', online: false },
   walletReady: state.walletReady === true,
  };
 };
 const selfProfile = async (repositories, actor) => {
  const account = await repositories.accounts.for(actor);
  if (!account) fail('PROFILE_NOT_FOUND');
  const base = await loadProfile(repositories, actor, actor, account);
  const row = await repositories.profiles.for(actor);
  const state = await accountState(repositories, actor);
  const identities = await repositories.identities.list(actor);
  const credential = await repositories.credentials.read({ actor });
  const save = await repositories.saves.for(actor);
  return {
   ...base,
   providers: identities.map((i) => i.provider),
   email: credential ? credential.email : null,
   emailVerified: !!credential && credential.verified !== null,
   presenceVisibility: row.presence_visibility,
   profileVersion: row.version,
   activeMatch: state.competitive.activeMatch,
   cloudRevision: save ? save.revision : 0,
   cosmeticCredits: state.wealth && state.wealth.monetization ? state.wealth.monetization.credits : 0,
   wealthPublic: account.wealthPublic,
  };
 };
 const statsOf = (state) => {
  if (!state) return null;
  const out = {};
  for (const mode of ['ranked', 'casual', 'friend']) {
   const rows = (state.history || []).filter((r) => r.mode === mode && ['win', 'loss', 'draw'].includes(r.result));
   const wins = rows.filter((r) => r.result === 'win').length;
   const losses = rows.filter((r) => r.result === 'loss').length;
   const seconds = rows.reduce((s, r) => s + (Number.isFinite(r.activeSeconds) ? Math.max(0, r.activeSeconds) : 0), 0);
   out[mode] = { games: rows.length, wins, losses, draws: rows.length - wins - losses, winRate: rows.length ? wins / rows.length : null, averageSeconds: rows.length ? seconds / rows.length : null, hours: seconds / 3600 };
  }
  out.tournament = D.domain.tournamentStats(state.tournamentRecord);
  return out;
 };
 const ensureProfile = async (repositories, actor) => {
  const existing = await repositories.profiles.for(actor);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
   const username = mintUsername();
   try {
    await repositories.profiles.insert({ actor, tag: mintTag(), username, display_name: username }, clock());
    return await repositories.profiles.for(actor);
   } catch (error) {
    if (!error || error.code !== '23505') throw error;
   }
  }
  fail('PROFILE_UNAVAILABLE');
 };
 const resolveWith = async (repositories, query) => {
  const raw = String(query);
  if (await repositories.accounts.has(raw)) return raw;
  const byUsername = await repositories.profiles.byUsername(raw.toLowerCase().replace(/^@/, ''));
  if (byUsername) return byUsername;
  const byTag = await repositories.profiles.byTag(raw.toUpperCase().replace(/^#/, ''));
  if (byTag) return byTag;
  fail('PROFILE_NOT_FOUND');
 };
 /* The shipped, format-aware bounded async verifier (server/production/passwords.js): it accepts BOTH
  * the modern 'scrypt-v1$' (N=131072) and the legacy unprefixed (N=16384) verifiers, so retained
  * production credentials authenticate. It lives OUTSIDE the database transaction - a scrypt hash
  * never pins a pinned-tx connection - and the caller rechecks the locked credential/session state
  * after awaiting it. The pure legacy helper in account-policy.js is retained unchanged for its V4
  * callers; this service no longer carries a second, sync-only verifier. */
 /* The shipped bounded verifier is used AS-IS. It internally returns false for an unusable
  * verifier/salt or a weak password, but a REAL worker failure (AUTH_BUSY, queue timeout,
  * PASSWORD_PROCESSING_FAILED) MUST propagate: under overload a correct credential must never be
  * misreported as INVALID_CREDENTIALS by a blanket catch. */
 const verifyStoredPassword = (password, salt, stored) => passwords.verify(password, salt, stored);
 /* Hash a NEW credential with the same modern, bounded implementation the shipped production flow
  * uses ('scrypt-v1$', N=131072). Computed OUTSIDE the transaction so the scrypt work never pins the
  * pinned-tx connection; the caller passes the finished {salt, passwordHash} in. */
 const hashStoredPassword = async (password) => {
  const out = await passwords.hash(password);
  return { salt: out.salt, passwordHash: out.password_hash };
 };
 /* The session guard for a MUTATING method, applied in the canonical order: take the actor auth mutex
  * FIRST (all session/identity operations share it), then re-read the live source bearer so a stale
  * bearer cannot mutate after revocation. The source bearer is verified against the locked row, never
  * against a read taken before the wait. */
 const sessionGuard = async (repositories, token, { linked = false, keyed = false } = {}) => {
  const source = await sessionOf(repositories, token);
  if (!source) fail('AUTH_REQUIRED');
  if (linked && !source.actor) fail('LINK_ACCOUNT_REQUIRED');
  if (keyed) await lockSessionToken(repositories, token);
  else if (source.actor) await lockAuth(repositories, source.actor);
  const live = await repositories.sessions.live(repositories.sessions.hash(token), clock());
  if (!live) fail('AUTH_REQUIRED');
  if (live.actor) {
   const account = await repositories.accounts.for(live.actor);
   if (!account || account.suspended || account.hold || !account.verified) fail('AUTH_REQUIRED');
  }
  if (linked && !live.actor) fail('LINK_ACCOUNT_REQUIRED');
  return { hash: live.token, actor: live.actor, csrf: live.csrf, expires: live.expires, authAt: live.auth_at };
 };
 /* The read-only live-bearer projection for a method that must re-read the bearer AFTER waiting (e.g.
  * deletion): same rejection semantics, no lock. */
 const liveSession = async (repositories, token) => {
  const live = await repositories.sessions.live(repositories.sessions.hash(token), clock());
  if (!live) fail('AUTH_REQUIRED');
  if (live.actor) {
   const account = await repositories.accounts.for(live.actor);
   if (!account || account.suspended || account.hold || !account.verified) fail('AUTH_REQUIRED');
  }
  return { hash: live.token, actor: live.actor, csrf: live.csrf, expires: live.expires, authAt: live.auth_at };
 };
 /* Create + deliver a one-time challenge. `delivery` is returned for the mail outbox; an unknown
  * address gets none (no account-existence side channel).
  *
  * `prepared` is the ALREADY-HASHED password ({salt, passwordHash}) for challenges that must carry a
  * verifier; hashing happens outside the transaction (bounded scrypt worker) and the finished pair is
  * passed in. The credential the challenge is authorized against is pinned as its stamp: a challenge
  * against a password/email subsequently rotated can then never grant (see stampMatches). A signup
  * challenge pins a NULL stamp VALUE because no credential row exists yet for that address, but its
  * version ROW is still written; G9 enforcement requires the row's EXISTENCE for every purpose
  * (stampRowPresent) while the value may be NULL for signup.
  *
  * Every applicable challenge (verify-existing / link / reset / change-email) pins the credential
  * stamp; `credential` may be supplied by the caller when it already holds the row. */
 const issueChallenge = async (repositories, session, { email, purpose, actor = null, credential, prepared = null }) => {
  await rate(repositories, session.hash, 'email-otp-session', 8, 3600);
  await rate(repositories, email, 'email-otp-address', 6, 3600);
  if (await repositories.challenges.recent(session.hash, email, purpose, clock() - policy.OTP_COOLDOWN)) fail('OTP_COOLDOWN');
  const id = crypto.randomBytes(18).toString('base64url');
  const code = policy.otpCode();
  const created = clock();
  const expires = created + policy.OTP_TTL;
  const current = credential === undefined ? await repositories.credentials.read({ email }) : credential;
  if (actor) await lockAuth(repositories, actor);
  await repositories.challenges.create({ id, session: session.hash, email, purpose, actor, codeHash: otpHash(id, email, purpose, code), passwordSalt: prepared ? prepared.salt : null, passwordHash: prepared ? prepared.passwordHash : null, expires }, created);
  await repositories.credentials.insertVersion(id, credStamp(current));
  return {
   verificationRequired: true, challengeId: id, email: policy.maskEmail(email), expiresAt: expires,
   resendAt: created + policy.OTP_COOLDOWN,
   delivery: { to: email, code, purpose, idempotencyKey: `mega-xo/${purpose}/${id}` },
  };
 };
/* Read the credential row for an already-normalized address (the async paths need it BEFORE their
 * transaction, so they can verify the password out of band). */
 const credentialFor = async (address) => run((repositories) => repositories.credentials.read({ email: address }));
/* The signup challenge path (no credential exists yet): reached ONLY from emailContinue's no-row
 * branch, never a standalone endpoint. The password is hashed with the shipped bounded worker
 * OUTSIDE the transaction, then the challenge is issued for the address with that prepared verifier. */
 const signupChallenge = async (token, address, password) => {
  const hashed = await hashStoredPassword(password);
  return run(async (repositories) => {
   /* Mutating: source-bearer logical key, then re-read the live bearer; a signup challenge is only
     * issued for a still-anonymous session. */
   await lockSessionToken(repositories, token);
   const session = await sessionOf(repositories, token);
   if (!session) fail('AUTH_REQUIRED');
   if (session.actor) fail('ALREADY_LINKED');
   if (await repositories.credentials.read({ email: address })) fail('INVALID_CREDENTIALS');
   return issueChallenge(repositories, session, { email: address, purpose: 'signup', credential: null, prepared: hashed });
  });
 };
/* The identity half of a verified-provider / OTP sign-in, INSIDE the caller's transaction.
  * Creates the permanent actor, its eligibility row, its profile and a durable `account.provision`
  * outbox row when the actor is new; a replayed provider subject returns the SAME actor and
  * creates nothing. NEVER a wallet: wallet-row existence is Core's readiness fact.
  *
  * PROVIDER-SUBJECT RACE. The subject's logical identity is serialized BEFORE any read, so two
  * concurrent logins/link attempts for one absent subject cannot both observe it absent and both
  * provision an actor. After the serialized insertion BOTH ownership directions are confirmed: a
  * losing caller that finds the subject already owned elsewhere (or the candidate actor already
  * holding a different subject for that provider) aborts the WHOLE candidate-actor/outbox
  * transaction, so no actor with no login identity is ever returned. */
 const createIdentityHalf = async (repositories, { provider, subject, actor = null, verified = true, at }) => {
  await lockProviderIdentity(repositories, provider, subject);
  const existing = await repositories.identities.actorFor(provider, subject);
  if (existing && actor && actor !== existing) fail('ACCOUNT_LINKED_ELSEWHERE');
  if (existing && !actor) return { actor: existing, created: false, linked: false };
  const resolved = actor || newActorId();
  /* `created` means "this call created the permanent account row"; it is decided by the account
    * row, not by whether the caller supplied the id. */
  const known = await repositories.accounts.for(resolved);
  const created = !known;
  if (created) {
   await repositories.accounts.insert({ actor: resolved }, at);
   await repositories.accounts.eligibilityInsert(resolved, verified, at);
   await ensureProfile(repositories, resolved);
   await repositories.outbox.enqueue({ id: `${PROVISION_KIND}:${resolved}`, kind: PROVISION_KIND, payload: { actor: resolved }, created: at, expires: at + PROVISION_TTL });
  }
  const prior = await repositories.identities.subjectFor(resolved, provider);
  if (prior && prior !== subject) fail('PROVIDER_ALREADY_LINKED');
  const inserted = await repositories.identities.insert(provider, subject, resolved, at);
  /* CONFIRM OWNERSHIP after the insert. A suppressed conflict is only an identical replay when the
    * surviving row points at the SAME (provider, subject, actor) triple; anything else is a genuine
    * ownership conflict and aborts the candidate transaction. */
  const owner = await repositories.identities.actorFor(provider, subject);
  if (owner !== resolved) fail('ACCOUNT_LINKED_ELSEWHERE');
  const held = await repositories.identities.subjectFor(resolved, provider);
  if (held !== subject) fail('PROVIDER_ALREADY_LINKED');
  return { actor: resolved, created, linked: inserted && !created };
 };

 /* ---------------------------------------------------------------- service */

 async function viewWith(repositories, viewer, actor) {
  const account = await repositories.accounts.for(actor);
  if (!account) fail('PROFILE_NOT_FOUND');
  return loadProfile(repositories, viewer, actor, account);
 }

 const service = {
  /* --- readiness/identity facts --- */
  async requireAccount(actor) {
   return run(async (repositories) => requireReady(repositories, actor));
  },
  async get(actor) {
   return run((repositories) => repositories.accounts.for(actor));
  },
  async state(actor) {
   return run((repositories) => accountState(repositories, actor));
  },
  async issue(actor = null, authAt = 0) {
   return run((repositories) => issue(repositories, actor, authAt));
  },
  async bootstrap(token) {
   return run(async (repositories) => {
    const session = await sessionOf(repositories, token);
    if (session) return { ...session, token: null };
    return issue(repositories);
   });
  },
  async session(token) {
   return run((repositories) => sessionOf(repositories, token));
  },
  async requireSession(token) {
   return run((repositories) => sessionRow(repositories, token));
  },
  async requireLinked(token) {
   return run((repositories) => linkedRow(repositories, token));
  },
  async csrf(token, provided) {
   return run(async (repositories) => {
    const session = await sessionRow(repositories, token);
    if (!policy.equal(session.csrf, provided)) fail('CSRF_FAILED');
    return session;
   });
  },
  async identities(actor) {
   return run((repositories) => repositories.identities.list(actor));
  },
  async emailAddress(actor) {
   return run(async (repositories) => { const row = await repositories.credentials.read({ actor }); return row ? row.email : null; });
  },
  async emailVerified(actor) {
   return run(async (repositories) => { const row = await repositories.credentials.read({ actor }); return !!row && row.verified !== null; });
  },

  /* --- profiles --- */
  async view(viewer, actor) { return run((repositories) => viewWith(repositories, viewer, actor)); },
  async self(actor) { return run((repositories) => selfProfile(repositories, actor)); },
  async edit(actor, changes) {
   const input = changes || {};
   return run(async (repositories) => {
    /* Profile editing is identity work, not economic: a pending-provisioning actor may still
      * manage its profile (legacy requireAccount gated on verified/suspended/hold only). */
    await verifiedRow(repositories, actor);
    await rate(repositories, actor, 'edit', 15, 300);
    const current = await ensureProfile(repositories, actor);
    const username = typeof input.username === 'string' ? input.username.toLowerCase().trim() : current.username;
    const name = input.displayName === undefined ? current.display_name
     : (typeof input.displayName === 'string' ? input.displayName.trim() : fail('INVALID_DISPLAY_NAME'));
    const avatar = input.avatar === undefined || input.avatar === null ? current.avatar : input.avatar;
    if (!policy.NAME.test(username) || policy.RESERVED.has(username)) fail('INVALID_USERNAME');
    if (!policy.safeText(name, policy.DISPLAY_NAME_MAX)) fail('INVALID_DISPLAY_NAME');
    if (!policy.AVATARS.includes(avatar)) fail('INVALID_AVATAR');
    if (username !== current.username && current.username_changed && clock() - current.username_changed < 7 * DAY) fail('USERNAME_COOLDOWN');
    if (username !== current.username) {
     const owner = await repositories.profiles.byUsername(username);
     if (owner && owner !== actor) fail('USERNAME_TAKEN');
    }
    const statsVisibility = input.statsVisibility === undefined ? current.stats_visibility : input.statsVisibility;
    const presenceVisibility = input.presenceVisibility === undefined ? current.presence_visibility : input.presenceVisibility;
    if (!policy.PRIVACY_STATS.includes(statsVisibility) || !policy.PRIVACY_PRESENCE.includes(presenceVisibility)) fail('INVALID_PRIVACY');
    try {
     await repositories.profiles.update(actor, {
      username, display_name: name, avatar, stats_visibility: statsVisibility, presence_visibility: presenceVisibility,
      username_changed: username !== current.username ? clock() : current.username_changed,
     });
    } catch (error) {
     if (error && error.code === '23505') fail('USERNAME_TAKEN');
     throw error;
    }
    return selfProfile(repositories, actor);
   });
  },
  async search(actor, query) {
   return run(async (repositories) => {
    /* A read: a pending-provisioning actor may still search (only economic/account mutations are
      * gated on readiness). */
    await verifiedRow(repositories, actor);
    await rate(repositories, actor, 'search', 30);
    if (typeof query !== 'string' || query.length > policy.SEARCH_MAX) fail('INVALID_SEARCH');
    const q = query.trim().replace(/^#|^@/, '');
    if (q.length < policy.SEARCH_MIN) fail('SEARCH_TOO_SHORT');
    let ids;
    if (q.toUpperCase().startsWith('MEGA-')) {
     const id = await repositories.profiles.byTag(q.toUpperCase());
     ids = id ? [id] : [];
    } else {
     const key = q.toLowerCase();
     if (!/^[a-z0-9_]+$/.test(key)) return [];
     ids = await repositories.profiles.prefix(key, 20);
    }
    const out = [];
    for (const id of ids) {
     if (id === actor) continue;
     try {
      const profile = await viewWith(repositories, actor, id);
      delete profile.stats;
      out.push(profile);
     } catch { /* blocked/held/suspended targets are simply absent */ }
    }
    return out;
   });
  },
  async friends(actor) {
   return run(async (repositories) => {
    const account = await repositories.accounts.for(actor);
    if (!account || account.suspended || account.hold || !account.verified) fail('ACCOUNT_UNAVAILABLE');
    const view = async (id) => {
     try { return await loadProfile(repositories, actor, id, await repositories.accounts.for(id)); } catch { return null; }
    };
    /* Bounded LISTS (never a silent truncation: a full page reports hasMore). Visibility of each
      * target is decided by the SAME projection as view/search, so a deletion-pending actor is
      * absent from friends too. */
    const load = async (page) => {
     const out = [];
     for (const id of page.ids) { const profile = await view(id); if (profile) out.push(profile); }
     return out;
    };
    const friendPage = await repositories.social.friendIds(actor, FRIEND_LIST_LIMIT);
    const incomingPage = await repositories.social.incomingIds(actor, FRIEND_LIST_LIMIT);
    const outgoingPage = await repositories.social.outgoingIds(actor, FRIEND_LIST_LIMIT);
    const blockedPage = await repositories.social.blockedIds(actor, FRIEND_LIST_LIMIT);
    const friends = await load(friendPage);
    friends.sort((x, y) => Number(y.presence.online) - Number(x.presence.online) || x.username.localeCompare(y.username));
    const incoming = await load(incomingPage);
    const outgoing = await load(outgoingPage);
    const blocked = [];
    for (const id of blockedPage.ids) {
     const row = await repositories.profiles.for(id);
     blocked.push({ id, username: row ? row.username : 'Player' });
    }
    return {
     friends, incoming, outgoing, blocked,
     truncated: friendPage.hasMore || incomingPage.hasMore || outgoingPage.hasMore || blockedPage.hasMore,
    };
   });
  },
  async relation(actor, target) {
   return run(async (repositories) => relationOf(repositories, actor, target));
  },
  async resolve(query) { return run((repositories) => resolveWith(repositories, query)); },

  /* --- practice archive --- */
  /* The client payload is sanitized BEFORE any write (the archive boundary), then stored with a
    * revision compare-and-swap: of two racers exactly one wins and the loser sees SAVE_CONFLICT.
    * The archive is never read by settlement, so an arbitrary wallet-shaped payload cannot change a
    * server wallet - the sanitizer's `wallet` member is practice data only. */
  async save(actor, expected, payload) {
   if (!safeInt(expected)) fail('INVALID_REVISION');
   const clean = policy.sanitizePractice(payload);
   const text = json(clean);
   return run(async (repositories) => {
    /* Practice archive is non-economic (settlement never reads it), so a pending actor may save. */
    await verifiedRow(repositories, actor);
    await rate(repositories, actor, 'save', 20);
    return repositories.saves.put(actor, expected, text, clock());
   });
  },
  async restore(actor) {
   return run(async (repositories) => {
    await verifiedRow(repositories, actor);
    const row = await repositories.saves.for(actor);
    return row ? { revision: row.revision, updated: row.updated, practice: JSON.parse(row.payload) } : { revision: 0, practice: null };
   });
  },

  /* --- reports (review-only) --- */
  async report(actor, target, category, detail = '') {
   if (!policy.REPORT_CATEGORIES.has(category)) fail('INVALID_REPORT_CATEGORY');
   if (typeof detail !== 'string') fail('INVALID_REPORT_DETAIL');
   const text = detail.trim();
   if (text && !policy.safeText(text, 280)) fail('INVALID_REPORT_DETAIL');
   if (category === 'other' && text.length < 8) fail('REPORT_DETAIL_REQUIRED');
   return run(async (repositories) => {
    await verifiedRow(repositories, actor);
    await rate(repositories, actor, 'report', 5, 86400);
    const targetId = await resolveWith(repositories, target);
    if (targetId === actor) fail('CANNOT_REPORT_SELF');
    if (!(await repositories.accounts.has(targetId))) fail('PROFILE_NOT_FOUND');
    /* A report records an allegation: it never touches the target's account, rating, wallet or
      * eligibility, so a report can never punish. */
    const duplicate = await repositories.reports.recent(actor, targetId, category, clock() - DAY);
    if (duplicate) return { reported: true, duplicate: true, id: duplicate };
    const id = `rp_${crypto.randomUUID()}`;
    await repositories.reports.insert({ id, reporter: actor, target: targetId, category, detail: text }, clock());
    return { reported: true, duplicate: false, id };
   });
  },

  /* --- social graph --- */
  async social(actor, key, command, target) {
   if (!policy.safeKey(key)) fail('INVALID_OPERATION');
   if (!['request', 'accept', 'decline', 'cancel', 'remove', 'block', 'unblock'].includes(command)) fail('INVALID_SOCIAL_ACTION');
   const fp = policy.fingerprint({ command, target });
   const op = `${actor}:${key}`;
   const outcome = await run(async (repositories, tx) => {
    /* Graph writes are identity work; a pending-provisioning actor may still manage friends. */
    await verifiedRow(repositories, actor);
    const targetId = await resolveWith(repositories, target);
    if (targetId === actor) fail('SELF_REQUEST');
    /* Serialize the whole command on the pair's eligibility rows, taken in sorted order BEFORE the
      * idempotency probe and every graph read: two concurrent commands on the same pair (or Core's own
      * eligibility lock) then cannot interleave a graph change between this read and its write, and
      * the outcome replay sees a serialized graph. */
    await repositories.social.lock([actor, targetId]);
    const existing = await tx.repositories.outcomes.find(SOCIAL_OPERATIONS, op);
    if (existing) {
     if (existing.fingerprint !== fp) fail('IDEMPOTENCY_CONFLICT');
     return { replay: true, result: existing.result };
    }
    await rate(repositories, actor, 'social', 30);
    /* RE-READ eligibility AFTER the lock. The initiating actor's check happened before the lock was
      * acquired; Core can disable/hold/suspend an actor while this command waits for the pair rows, so
      * the decision is made on the state that is actually locked. */
    await verifiedRow(repositories, actor);
    const relation = await relationOf(repositories, actor, targetId);
    if (relation === 'blocked' && !['block', 'unblock'].includes(command)) fail('PROFILE_NOT_FOUND');
    /* REQUEST/ACCEPT are pairwise actions: the TARGET must satisfy the SAME eligibility policy as the
      * initiator (V4 requestFriend/acceptFriend both go through _players). A held/suspended/unverified
      * target cannot be befriended or accepted, and a held TARGET that becomes unheld while waiting for
      * the lock is validated on the locked row, not on the pre-lock read. */
    if (command === 'request' || command === 'accept') await verifiedRow(repositories, targetId);
    let cancelOffers = false;
    if (command === 'request') {
     /* Complete COUNTs, never a truncated incident page. */
     if (await repositories.social.countFriends(actor) >= FRIEND_MAX || await repositories.social.countIncoming(targetId) >= REQUEST_MAX) fail('FRIEND_LIMIT');
     await repositories.social.request(actor, targetId);
    } else if (command === 'accept') {
     if (await repositories.social.countFriends(actor) >= FRIEND_MAX || await repositories.social.countFriends(targetId) >= FRIEND_MAX) fail('FRIEND_LIMIT');
     if (!(await repositories.social.pairRequest(targetId, actor))) fail('NO_FRIEND_REQUEST');
     await repositories.social.friend(actor, targetId);
     await repositories.social.dropRequestsBetween(actor, targetId);
    } else if (command === 'decline') {
     await repositories.social.dropRequest(targetId, actor);
    } else if (command === 'cancel') {
     await repositories.social.dropRequest(actor, targetId);
    } else if (command === 'remove' || command === 'block') {
     await repositories.social.unfriend(actor, targetId);
     await repositories.social.dropRequestsBetween(actor, targetId);
     /* The match aggregate is Core-owned and this role has no grant there: the API records the
       * intent durably as an outbox row and never writes match.matches itself. */
     await repositories.outbox.enqueue({ id: `${SOCIAL_CANCEL_KIND}:${op}`, kind: SOCIAL_CANCEL_KIND, payload: { actor, target: targetId, command }, created: clock(), expires: clock() + DAY });
     cancelOffers = true;
    }
    if (command === 'block') await repositories.social.block(actor, targetId);
    if (command === 'unblock') await repositories.social.unblock(actor, targetId);
    const result = { ok: true };
    await tx.repositories.outcomes.save(SOCIAL_OPERATIONS, op, fp, json(result));
    return { replay: false, result, cancelOffers, targetId };
   });
   if (!outcome.replay && outcome.cancelOffers && cancelSocialOffers) await afterCommit(() => cancelSocialOffers(actor, outcome.targetId));
   return outcome.result;
  },

  /* --- sessions --- */
  async sessions(token) {
   return run(async (repositories) => {
    const current = await linkedRow(repositories, token);
    const rows = await repositories.sessions.list(current.actor, clock());
    return rows.map((row) => ({
     id: sessionId(row.hash), current: row.hash === current.hash, created: row.created, expires: row.expires,
     recentlyVerified: clock() - row.auth_at <= REAUTH_WINDOW,
    }));
   });
  },
  async revokeSession(token, id) {
   if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) fail('INVALID_SESSION');
   return run(async (repositories) => {
    const current = await sessionGuard(repositories, token, { linked: true });
    const match = (await repositories.sessions.list(current.actor, clock())).find((row) => sessionId(row.hash) === id);
    if (!match) fail('SESSION_NOT_FOUND');
    if (match.hash === current.hash) fail('CURRENT_SESSION');
    await repositories.sessions.revoke(current.actor, match.hash);
    notify(current.actor, 'session_revoked');
    return { revoked: true };
   });
  },
  async revokeOtherSessions(token) {
   return run(async (repositories) => {
    const current = await sessionGuard(repositories, token, { linked: true });
    const revoked = await repositories.sessions.revokeOthers(current.actor, current.hash, clock());
    notify(current.actor, 'other_sessions_revoked', { count: revoked.length });
    return { revoked: revoked.length };
   });
  },
  async logout(token, all = false) {
   return run(async (repositories) => {
    /* Mutating: actor auth mutex first, then the live row is re-read under it. `all` revokes every
      * session (including this one); the single form consumes exactly this bearer. */
    const session = await sessionGuard(repositories, token);
    if (session.actor && all) await repositories.sessions.revokeAll(session.actor);
    else {
     const consumed = await repositories.sessions.rotate(session.hash);
     if (consumed !== 1) fail('AUTH_REQUIRED');
    }
    return { signedOut: true };
   });
  },
  /* Presence is the managed-Redis tier's (P06). The method is preserved so callers need no new
    * code path, and it refuses explicitly instead of fabricating a durable presence row. */
  async heartbeat(token, foreground) {
   if (typeof foreground !== 'boolean') fail('INVALID_PRESENCE');
   return run(async (repositories) => { await linkedRow(repositories, token); fail('PRESENCE_OWNED_BY_P06'); });
  },

  /* --- linked identities --- */
  async unlink(token, provider) {
   return run(async (repositories) => {
    /* Actor auth mutex FIRST (via sessionGuard), then the live bearer re-read under it: a stale
      * bearer cannot unlink after revocation, and the last-method check + provider deletion are one
      * serialized decision, so two concurrent unlinks cannot each delete a different provider and
      * commit an account with zero login methods. */
    const session = await sessionGuard(repositories, token, { linked: true });
    if (clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    const list = await repositories.identities.list(session.actor);
    if (list.length <= 1) fail('LAST_LOGIN_METHOD');
    if (!list.some((i) => i.provider === provider)) fail('PROVIDER_NOT_LINKED');
    /* Invalidate ALL of the target actor's pending one-time state, not just this bearer's: every
      * unconsumed challenge and every outstanding sign-in attempt for the actor is consumed/dropped
      * so a stale provider/challenge (including one issued on ANOTHER session) cannot be replayed to
      * re-add the removed method. A fresh, explicit relink remains allowed. */
    await repositories.challenges.consumeAllFor(session.actor);
    await repositories.signin.cancelForActor(session.actor);
    await repositories.identities.remove(session.actor, provider);
    if (provider === 'email') await repositories.credentials.remove(session.actor);
    notify(session.actor, 'provider_unlinked', { provider });
    return { providers: (await repositories.identities.list(session.actor)).map((i) => i.provider) };
   });
  },

  /* --- provider sign-in state (nonce/PKCE), durable in PostgreSQL --- */
  async start(token, provider, intent = 'login', kind = 'web') {
   return run(async (repositories) => {
    /* Mutating (it writes a durable attempt): actor auth mutex first, live bearer re-read under it. */
    const session = await sessionGuard(repositories, token);
    if (!['google', 'apple'].includes(provider) || !['login', 'link', 'reauth'].includes(intent) || !['web', 'native'].includes(kind)) fail('INVALID_AUTH_REQUEST');
    if (intent === 'reauth' && !session.actor) fail('LINK_ACCOUNT_REQUIRED');
    if (intent === 'link' && session.actor && clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    await rate(repositories, session.hash, 'signin', 15, 300);
    const attempt = {
     state: crypto.randomBytes(32).toString('base64url'), nonce: crypto.randomBytes(32).toString('base64url'),
     verifier: crypto.randomBytes(32).toString('base64url'), provider, kind, intent,
     target: ['link', 'reauth'].includes(intent) ? session.actor : null, expires: clock() + SIGNIN_TTL,
    };
    await repositories.signin.create({
     stateHash: repositories.sessions.hash(attempt.state), session: session.hash, provider, kind, intent,
     target: attempt.target, nonce: attempt.nonce, verifier: attempt.verifier, expires: attempt.expires,
    });
    return attempt;
   });
  },
  async consume(token, state, provider, kind) {
   if (typeof state !== 'string') fail('INVALID_AUTH_STATE');
   return run(async (repositories) => {
    const session = await sessionGuard(repositories, token);
    const stateHash = repositories.sessions.hash(state);
    const row = await repositories.signin.find(stateHash);
    if (!row || row.used || row.expires <= clock() || row.session !== session.hash || row.provider !== provider || row.kind !== kind) fail('INVALID_AUTH_STATE');
    /* One-use consumption: the actor auth mutex is already held, so a target-actor transition cannot
      * interleave between the read and the consume. */
    if (!(await repositories.signin.consume(stateHash))) fail('INVALID_AUTH_STATE');
    /* Same shape the legacy `consume` returned: the stored row, with `state` as its hash. */
    return { state: row.stateHash, session: row.session, provider: row.provider, kind: row.kind, intent: row.intent, target: row.target, nonce: row.nonce, verifier: row.verifier, expires: row.expires, used: false };
   });
  },
  /* Called ONLY with claims already verified by an IdentityProvider, never from public JSON. */
  async finishVerified(token, attempt, identity) {
   const provider = identity && identity.provider;
   const subject = identity && identity.subject;
   const created = await run(async (repositories) => {
    /* Canonical order for a provider transition: source-bearer logical key, then the provider-subject
      * key, then the actor auth mutex (taken once the actor is resolved). */
    const session = await sessionGuard(repositories, token, { keyed: true });
    if (provider !== attempt.provider || typeof subject !== 'string' || !subject || subject.length > 255) fail('INVALID_IDENTITY');
    /* The attempt was consumed BEFORE the external IdentityProvider I/O, so it exists in memory only.
      * Re-read the DURABLE attempt under the actor auth mutex and require it to still be the exact
      * consumed attempt: an unlink on another session (which cancels the actor's attempts) or any
      * tampering cannot be raced into re-adding a removed method. */
    const persisted = attempt && typeof attempt.state === 'string' ? await repositories.signin.find(attempt.state) : null;
    if (!persisted || persisted.used !== true || persisted.session !== session.hash
     || persisted.provider !== provider || persisted.kind !== attempt.kind || persisted.intent !== attempt.intent
     || persisted.target !== (attempt.target || null) || persisted.nonce !== attempt.nonce
     || persisted.verifier !== attempt.verifier || persisted.expires <= clock()) {
     fail('INVALID_AUTH_STATE');
    }
    if (attempt.target && attempt.target !== session.actor) fail('ACCOUNT_CHANGED');
    /* provider-subject logical key BEFORE the actor's identity transition, then resolve the actor
      * optimistically and take its auth mutex. */
    await lockProviderIdentity(repositories, provider, subject);
    const found = await repositories.identities.actorFor(provider, subject);
    if (attempt.intent === 'reauth' && (!attempt.target || !found || found !== attempt.target)) fail('REAUTH_ACCOUNT_MISMATCH');
    if (attempt.target && found && found !== attempt.target) fail('ACCOUNT_LINKED_ELSEWHERE');
    const actor = attempt.target || found || null;
    if (actor) await lockAuth(repositories, actor);
    const half = await createIdentityHalf(repositories, {
     provider, subject, actor, verified: true, at: clock(),
    });
    if (half.linked) notify(half.actor, 'provider_linked', { provider });
    const replaced = await replaceSession(repositories, session, half.actor, half.created);
    return { ...replaced, actor: half.actor, created: half.created, provisioning: half.created };
   });
   /* A new actor's profile in `created.profile` was projected while the wallet did not exist yet.
    * Readiness is a DURABLE fact (wallet-row existence), NOT the callback's return value: an enqueue-
    * only/no-op/failed callback must not publish `walletReady:true`. After the callback we RE-READ the
    * actual wallet readiness and publish only that, so a still-pending actor keeps the honest pending
    * projection. */
   if (created.provisioning && provisionActor) {
    await afterCommit(() => provisionActor(created.actor));
    const ready = await service.requireAccount(created.actor).then(() => true, () => false);
    created.profile = await service.self(created.actor);
    created.walletReady = ready;
    created.provisioning = !ready;
   }
   return created;
  },

  /* --- email credentials/OTP (async, PostgreSQL-backed one-time state) --- */
  async emailCredential(email) {
   const address = policy.normalizeEmail(email);
   return run((repositories) => repositories.credentials.read({ email: address }));
  },
  /* Async because the credential verification runs OUTSIDE the transaction (bounded scrypt worker).
    * ORDER: a cheap in-tx PREFLIGHT validates the source bearer and commits the durable rate spend
    * BEFORE any expensive crypto, so an over-budget or stale-bearer caller never incurs a scrypt.
    * The crypto then runs outside the tx, and a SECOND short transaction re-reads the locked
    * target/credential before granting. Exactly one rate spend per call; the denial count is durable
    * (the preflight commits) while a wrong password is still reported as INVALID_CREDENTIALS. */
  async emailContinue(token, email, password) {
   const address = policy.normalizeEmail(email);
   policy.validatePassword(password);
   const known = await credentialFor(address);
   /* No credential row: nothing to verify against; the signup challenge path (which hashes the
     * password outside the transaction) is the durable response and spends the same rate budget. */
   if (!known) return signupChallenge(token, address, password);
   /* PREFLIGHT: validate the source bearer and spend the rate budget in its OWN committed tx. */
   await run(async (repositories) => {
    await lockSessionToken(repositories, token);
    const source = await sessionOf(repositories, token);
    if (!source) fail('AUTH_REQUIRED');
    if (source.actor) fail('ALREADY_LINKED');
    await lockAuth(repositories, known.actor);
    const live = await repositories.sessions.live(repositories.sessions.hash(token), clock());
    if (!live) fail('AUTH_REQUIRED');
    if (live.actor) fail('ALREADY_LINKED');
    await rate(repositories, live.token, 'email-continue', 10, 300);
   });
   /* EXPENSIVE CRYPTO, outside any transaction. A worker failure propagates (never misreported). */
   const okPassword = await verifyStoredPassword(password, known.salt, known.passwordHash);
   const outcome = await run(async (repositories) => {
    const session = await sessionGuard(repositories, token);
    if (session.actor) fail('ALREADY_LINKED');
    await lockAuth(repositories, known.actor);
    if (!okPassword) return { deny: 'INVALID_CREDENTIALS' };
    /* Re-read the credential under its ROW lock and compare the exact verifier, so a password
      * rotated during verification can neither authenticate nor authorize. */
    await repositories.credentials.lockRow(known.actor);
    const row = await repositories.credentials.read({ email: address });
    if (!row || row.actor !== known.actor || row.salt !== known.salt || row.passwordHash !== known.passwordHash) return { deny: 'INVALID_CREDENTIALS' };
    /* Only suspension/hold excludes here: a verification-PENDING actor may still receive the
      * verify-existing OTP (the source production flow), which is the only path that stamps it. */
    await activeRow(repositories, row.actor);
    if (row.verified !== null) return { result: await replaceSession(repositories, session, row.actor, false) };
    return { result: await issueChallenge(repositories, session, { email: address, purpose: 'verify-existing', actor: row.actor, credential: row }) };
   });
   if (outcome.deny) fail(outcome.deny);
   return outcome.result;
  },
  async emailLinkStart(token, email, password) {
   const address = policy.normalizeEmail(email);
   policy.validatePassword(password);
   const hashed = await hashStoredPassword(password);
   return run(async (repositories) => {
    /* Mutating: actor auth mutex first, live bearer re-read under it. */
    const session = await sessionGuard(repositories, token, { linked: true });
    if (clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    await rate(repositories, session.hash, 'email-link', 5, 300);
    const found = await repositories.credentials.read({ email: address });
    if (found) fail(found.actor === session.actor ? 'EMAIL_ALREADY_LINKED' : 'EMAIL_IN_USE');
    return issueChallenge(repositories, session, { email: address, purpose: 'link', actor: session.actor, credential: null, prepared: hashed });
   });
  },
  async emailChangeStart(token, newEmail) {
   const address = policy.normalizeEmail(newEmail);
   return run(async (repositories) => {
    const session = await sessionGuard(repositories, token, { linked: true });
    if (clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    await rate(repositories, session.hash, 'email-change', 4, 3600);
    const current = await repositories.credentials.read({ actor: session.actor });
    if (!current || current.verified === null) fail('EMAIL_NOT_LINKED');
    if (current.email === address) fail('EMAIL_UNCHANGED');
    const used = await repositories.credentials.read({ email: address });
    if (used) fail(used.actor === session.actor ? 'EMAIL_UNCHANGED' : 'EMAIL_IN_USE');
    /* The challenge pins the CURRENT credential: if a reset/rotation replaces it before the code is
      * entered, the change-email verification is rejected rather than applied to a stale credential. */
    return issueChallenge(repositories, session, { email: address, purpose: 'change-email', actor: session.actor, credential: current });
   });
  },
  async emailResetStart(token, email) {
   const address = policy.normalizeEmail(email);
   return run(async (repositories) => {
    const session = await sessionRow(repositories, token);
    await rate(repositories, session.hash, 'email-reset', 5, 3600);
    const credential = await repositories.credentials.read({ email: address });
    const challenge = await issueChallenge(repositories, session, { email: address, purpose: 'reset', actor: credential ? credential.actor : null, credential: credential || null });
    if (!credential) delete challenge.delivery;
    return challenge;
   });
  },
  /* Complete the password change authorized by a verified reset challenge. The completion consumes
    * the challenge's EXPECTED authorized state atomically and advances the credential only from the
    * exact version the challenge was stamped against, so a stale/replayed/rotated authorization is
    * a zero-row result (RESET_NOT_AUTHORIZED) instead of a second grant. */
  async emailResetComplete(token, id, password) {
   policy.validatePassword(password);
   const hashed = await hashStoredPassword(password);
   const outcome = await run(async (repositories) => {
    const session = await sessionGuard(repositories, token);
    await rate(repositories, session.hash, 'email-reset-complete', 6, 300);
    await lockChallengeIdentity(repositories, id);
    const row = await repositories.challenges.find(id, session.hash);
    /* Guard denials carry NO grant effects, so they are returned as outcomes and thrown after the
      * commit: the rate spend above stays durable instead of being erased by the denial. */
    if (!row || row.consumed || row.verifiedAt === null || row.expires <= clock() || !row.actor || row.purpose !== 'reset') return { deny: 'RESET_NOT_AUTHORIZED' };
    const credential = await repositories.credentials.read({ actor: row.actor });
    if (!credential || credential.email !== row.email) return { deny: 'RESET_NOT_AUTHORIZED' };
    if (!stampMatches(row, credential)) return { deny: 'RESET_NOT_AUTHORIZED' };
    /* From here the branch mutates: actor auth mutex, then the credential ROW lock, then re-read the
      * verifier and require the EXACT salt/passwordHash in the update predicate. A credential
      * replaced after the read (even by a non-cooperative writer) is a zero-row, no-partial-change
      * RESET_NOT_AUTHORIZED. */
    await lockAuth(repositories, row.actor);
    await repositories.credentials.lockRow(row.actor);
    const current = await repositories.credentials.read({ actor: row.actor });
    if (!current || current.email !== row.email || current.salt !== credential.salt || current.passwordHash !== credential.passwordHash) fail('RESET_NOT_AUTHORIZED');
    const advanced = await repositories.credentials.setPasswordIfCurrent(row.actor, hashed.salt, hashed.passwordHash, clock(), current.salt, current.passwordHash);
    if (!advanced) fail('RESET_NOT_AUTHORIZED');
    const consumed = await repositories.challenges.consumeExpected(id, session.hash, 'reset', clock());
    if (!consumed) fail('RESET_NOT_AUTHORIZED');
    /* A password reset invalidates any OTHER pending reset/verification authorization, then kills
      * every existing session and issues one for this caller. */
    await repositories.challenges.consumePending(row.email, 'reset');
    await repositories.sessions.revokeAll(row.actor);
    const issued = await issue(repositories, row.actor, clock());
    return { result: { ...issued, created: false, profile: await selfProfile(repositories, row.actor), passwordChangedEmail: row.email } };
   });
   if (outcome.deny) fail(outcome.deny);
   return outcome.result;
  },
  async emailReauth(token, email, password) {
   const address = policy.normalizeEmail(email);
   const known = await credentialFor(address);
   /* PREFLIGHT: validate the bearer and commit the durable rate spend BEFORE the crypto. */
   await run(async (repositories) => {
    const session = await sessionGuard(repositories, token, { linked: true });
    await rate(repositories, session.hash, 'email-reauth', 8, 300);
   });
   /* EXPENSIVE CRYPTO, outside any transaction; a worker failure propagates. */
   const okPassword = known ? await verifyStoredPassword(password, known.salt, known.passwordHash) : false;
   const outcome = await run(async (repositories) => {
    /* Actor auth mutex first, live bearer re-read under it. */
    const session = await sessionGuard(repositories, token, { linked: true });
    if (!okPassword) return { deny: 'INVALID_CREDENTIALS' };
    /* Recheck the credential under its ROW lock: a password replaced during verification must fail. */
    await repositories.credentials.lockRow(session.actor);
    const row = await repositories.credentials.read({ email: address });
    if (!row || row.actor !== session.actor || row.verified === null || row.salt !== known.salt || row.passwordHash !== known.passwordHash) return { deny: 'INVALID_CREDENTIALS' };
    await repositories.sessions.touchAuth(session.actor, session.hash, clock());
    return { result: await selfProfile(repositories, session.actor) };
   });
   if (outcome.deny) fail(outcome.deny);
   return outcome.result;
  },
  async emailVerify(token, id, code) {
   if (typeof id !== 'string' || id.length > 64 || typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) fail('INVALID_OTP');
   let provisioned = null;
   /* DENIAL OUTCOMES COMMIT. The attempt/expiry/used/locked denials return a sentinel from the
    * transaction (after any accounting write) so the transaction COMMITS and the durable failed-auth
    * increment survives; the code is then thrown OUTSIDE. Throwing inside would roll the accounting
    * back, which is exactly why five wrong codes never reached the lockout before. Racy post-guard
    * re-read failures still throw inside (rollback), because they must not grant nor account twice. */
   const outcome = await run(async (repositories) => {
    const session = await sessionGuard(repositories, token);
    await rate(repositories, session.hash, 'email-otp-verify', 12, 300);
    /* One logical identity per challenge: two concurrent verifications of the same challenge cannot
      * both pass the attempt/expiry guards and both grant. */
    await lockChallengeIdentity(repositories, id);
    let row = await repositories.challenges.find(id, session.hash);
    if (!row || row.consumed) return { deny: 'INVALID_OTP' };
    if (row.expires <= clock()) { await repositories.challenges.consume(id); return { deny: 'OTP_EXPIRED' }; }
    if (row.verifiedAt !== null) return { deny: 'OTP_USED' };
    if (row.attempts >= policy.OTP_ATTEMPTS) return { deny: 'OTP_LOCKED' };
    if (!policy.equal(otpHash(row.id, row.email, row.purpose, code), row.codeHash)) {
     await repositories.challenges.bumpAttempts(id);
     return { deny: 'INVALID_OTP' };
    }
    /* A challenge without a persisted credential-version row can never grant (G9): the row's
     * existence is enforced for every purpose, while its VALUE may legitimately be NULL (signup). */
    row = await repositories.challenges.find(id, session.hash);
    if (!row || row.consumed || row.expires <= clock() || row.verifiedAt !== null || !stampRowPresent(row)) fail('INVALID_OTP');
    /* The challenge names its actor: take that actor's auth mutex before any grant (the session was
      * anonymous for the login/verify/reset flows, so sessionGuard did not already take it). */
    if (row.actor) await lockAuth(repositories, row.actor);
    if (row.purpose === 'reset') {
     if (!row.actor) return { deny: 'INVALID_OTP' };
     /* The credential must still match the stamp pinned when the reset challenge was issued (the
      * shipped production flow checks `['reset','verify-existing']` stamps at verify time); a
      * password rotated between issue and verify invalidates this authorization. */
     const cred = await repositories.credentials.read({ email: row.email });
     if (!cred || cred.actor !== row.actor || !stampMatches(row, cred)) return { deny: 'INVALID_OTP' };
     /* Stamp verified WITHOUT consuming: the reset completion consumes the authorized state. */
     await repositories.challenges.stampVerified(id, clock());
     return { result: { resetReady: true, challengeId: id } };
    }
    if (row.purpose === 'verify-existing') {
     /* Under the canonical auth mutex, take the REAL eligibility row lock and re-read the durable
      * activity so a deletion-pending / held / suspended actor is never revived: only a valid OTP
      * against the current credential stamps verification. */
     await repositories.accounts.lockEligibility([row.actor]);
     const activity = await repositories.accounts.activity(row.actor);
     if (activity && activity.deletionPending === true) fail('INVALID_OTP');
     await repositories.credentials.lockRow(row.actor);
     const credential = await repositories.credentials.read({ email: row.email });
     if (!credential || credential.actor !== row.actor || !stampMatches(row, credential)) fail('INVALID_OTP');
     const account = await repositories.accounts.for(row.actor);
     if (!account || account.suspended || account.hold) fail('ACCOUNT_UNAVAILABLE');
     /* Stamp BOTH halves: the credential's verified_at and the actor's eligibility.verified (the
      * missing stamp: an imported eligibility.verified=false actor stayed unavailable). */
     await repositories.credentials.setVerified(row.actor, clock());
     await repositories.accounts.markVerified(row.actor);
     await repositories.challenges.markVerified(id, clock());
     return { result: await replaceSession(repositories, { hash: session.hash }, row.actor, false) };
    }
    if (row.purpose === 'change-email') {
     if (!session.actor || session.actor !== row.actor || clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
     await repositories.credentials.lockRow(row.actor);
     const current = await repositories.credentials.read({ actor: row.actor });
     if (!current || current.verified === null) fail('EMAIL_NOT_LINKED');
     if (!stampMatches(row, current)) fail('INVALID_OTP');
     if (await repositories.credentials.read({ email: row.email })) fail('EMAIL_IN_USE');
     /* Atomic consume: the credential advances only from the exact verifier re-read under the row
      * lock (no MD5/version abstraction; the predicate compares the real columns). */
     const changed = await repositories.credentials.changeEmailIfCurrent(row.actor, row.email, clock(), current.salt, current.passwordHash);
     if (!changed) fail('INVALID_OTP');
     await repositories.challenges.consumeAllFor(row.actor);
     await repositories.sessions.revokeOthers(row.actor, session.hash, clock());
     await repositories.outbox.enqueue({ id: `${EMAIL_CHANGED_KIND}:${row.actor}:${id}`, kind: EMAIL_CHANGED_KIND, payload: { actor: row.actor, to: row.email }, created: clock(), expires: clock() + DAY });
     return { result: { linked: true, emailChanged: true, oldEmail: current.email, newEmail: row.email, profile: await selfProfile(repositories, row.actor) } };
    }
    if (row.purpose === 'link') {
     if (!session.actor || session.actor !== row.actor) fail('ACCOUNT_CHANGED');
     if (await repositories.credentials.read({ email: row.email })) fail('EMAIL_IN_USE');
     await repositories.credentials.insert({ email: row.email, actor: row.actor, salt: row.passwordSalt, passwordHash: row.passwordHash, verifiedAt: clock() }, clock());
     await repositories.identities.insert('email', row.email, row.actor, clock());
     await repositories.challenges.markVerified(id, clock());
     return { result: { linked: true, profile: await selfProfile(repositories, row.actor) } };
    }
    if (row.purpose === 'signup') {
     if (session.actor) fail('ALREADY_LINKED');
     if (await repositories.credentials.read({ email: row.email })) fail('EMAIL_IN_USE');
     const half = await createIdentityHalf(repositories, { provider: 'email', subject: row.email, actor: row.actor || null, verified: true, at: clock() });
     await repositories.credentials.insert({ email: row.email, actor: half.actor, salt: row.passwordSalt, passwordHash: row.passwordHash, verifiedAt: clock() }, clock());
     await repositories.challenges.markVerified(id, clock());
     const replaced = await replaceSession(repositories, session, half.actor, half.created);
     if (half.created) provisioned = half.actor;
     return { result: { ...replaced, actor: half.actor, created: half.created, provisioning: half.created } };
    }
    return { deny: 'INVALID_OTP' };
   });
   if (outcome.deny) fail(outcome.deny);
   const result = outcome.result;
   if (provisioned) {
    if (provisionActor) await afterCommit(() => provisionActor(provisioned));
    /* Readiness is the DURABLE wallet-row fact, never the callback's return value. */
    const ready = await service.requireAccount(provisioned).then(() => true, () => false);
    result.profile = await service.self(provisioned);
    result.walletReady = ready;
    result.provisioning = !ready;
   }
   return result;
  },

  /* --- new-actor identity halves (explicit, never smuggled into a session call) --- */
  /* `createVerifiedActor({provider, subject, provenance, actor?, verified?})`: provenance MUST be a
    * verified provider subject or an OTP flow ('provider' | 'otp'), or the email-signup flow
    * ('signup'). Creates actor + eligibility + profile + a durable account.provision outbox row in
    * ONE transaction and never a wallet. A replayed subject returns the same actor. */
  async createVerifiedActor(input = {}) {
   const provenance = input.provenance;
   if (!['provider', 'otp', 'signup'].includes(provenance)) fail('INVALID_IDENTITY_PROVENANCE');
   const created = await run((repositories) => createIdentityHalf(repositories, {
    provider: input.provider, subject: input.subject, actor: input.actor || null,
    verified: input.verified === false ? false : true, at: clock(),
   }));
   if (created.created && provisionActor) await afterCommit(() => provisionActor(created.actor));
   return created;
  },
  /* `createPendingEmailActor({email, actor?, salt, passwordHash})`: the email-signup identity half,
    * used by the OTP signup flow. */
  async createPendingEmailActor(input = {}) {
   const address = policy.normalizeEmail(input.email);
   const created = await run(async (repositories) => {
    const half = await createIdentityHalf(repositories, { provider: 'email', subject: address, actor: input.actor || null, verified: true, at: clock() });
    const credential = await repositories.credentials.read({ actor: half.actor });
    if (credential && credential.email !== address) fail('EMAIL_IN_USE');
    if (!credential) await repositories.credentials.insert({ email: address, actor: half.actor, salt: input.salt, passwordHash: input.passwordHash, verifiedAt: clock() }, clock());
    return half;
   });
   if (created.created && provisionActor) await afterCommit(() => provisionActor(created.actor));
   return created;
  },

  /* --- data export / coordinated deletion --- */
  /* The exact V4 privacy export (server/community-store.js:196-206, schemaVersion 1): competitive
    * season/history/tournament/daily/activeMatch, social friends/incoming/outgoing/blocked as
    * {playerId,tag,username} refs, economyJournal, purchaseReceipts, the FULL practice save and
    * reportsSubmitted, with the retained wallet/monetization register. The economic categories the
    * API cannot read directly come from the owner-created bounded projection
    * (profile.account_export, 0040) - never from widened API table grants - and an overflow there
    * fails STATE_TRUNCATED rather than dropping records. */
  async exportData(token) {
   return run(async (repositories) => {
    const session = await linkedRow(repositories, token);
    if (clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    await rate(repositories, session.actor, 'data-export', 3, 86400);
    const actor = session.actor;
    const account = await repositories.accounts.for(actor);
    const row = await repositories.profiles.for(actor);
    const credential = await repositories.credentials.read({ actor });
    const identities = await repositories.identities.list(actor);
    const state = await accountState(repositories, actor);
    const save = await repositories.saves.for(actor);
    const econ = await repositories.accounts.export(actor);
    const economic = econ || {};
    const exported = economic.state || state;
    /* Ref resolution: an id that no longer resolves (a tombstoned/deleted counterpart) is still
      * reported with its id, exactly like the legacy `ref`. */
    const ref = async (id) => {
     const p = await repositories.profiles.for(id);
     return { playerId: id, tag: p ? p.tag : null, username: p ? p.username : null };
    };
    const refs = async (ids) => Promise.all(ids.map(ref));
    const friends = (await repositories.social.friendIds(actor, FRIEND_LIST_LIMIT)).ids;
    const incoming = (await repositories.social.incomingIds(actor, FRIEND_LIST_LIMIT)).ids;
    const outgoing = (await repositories.social.outgoingIds(actor, FRIEND_LIST_LIMIT)).ids;
    const blocked = (await repositories.social.blockedIds(actor, FRIEND_LIST_LIMIT)).ids;
    const reports = await repositories.reports.submitted(actor);
    const submitted = await Promise.all(reports.map(async (r) => ({ ...r, target: await ref(r.target) })));
    const wallet = economic.wealth || state.wealth;
    const competitive = exported.competitive || state.competitive;
    const monetization = economic.monetization || (wallet ? wallet.monetization : null);
    const practice = save ? { revision: save.revision, updated: save.updated, practice: JSON.parse(save.payload) } : null;
    return {
     schemaVersion: 1, exportedAt: clock(),
     account: {
      playerId: actor, createdAt: account.created, region: account.region || '', wealthPublic: !!account.wealthPublic,
      suspended: !!account.suspended, securityHold: !!account.hold,
      profile: { tag: row.tag, username: row.username, displayName: row.display_name, avatar: row.avatar, statsVisibility: row.stats_visibility, presenceVisibility: row.presence_visibility, created: row.created, usernameChanged: row.username_changed },
      email: credential ? { address: credential.email, created: credential.created, verifiedAt: credential.verified } : null,
      identities,
      wallet: {
       coins: wallet ? wallet.coins : null, crowns: wallet ? wallet.crowns : null,
       reservedCoins: wallet ? wallet.reservedCoins : null, reservedCrowns: wallet ? wallet.reservedCrowns : null,
       owned: wallet ? wallet.owned : null, purchaseInfluenced: wallet ? !!wallet.purchaseInfluenced : null,
       monetization: monetization || null,
      },
      competitive: {
       rating: competitive.rating, peakRating: competitive.peak, games: competitive.games, tier: competitive.tier,
       casualRating: competitive.casualRating, casualGames: competitive.casualGames,
       season: exported.season === undefined ? null : exported.season,
       seasonHistory: exported.seasonHistory === undefined ? [] : exported.seasonHistory,
       tournamentRecord: exported.tournamentRecord === undefined ? null : exported.tournamentRecord,
       matchHistory: exported.history === undefined ? [] : exported.history,
       daily: economic.daily === undefined ? {} : economic.daily,
       activeMatch: competitive.activeMatch || null,
      },
      social: {
       friends: await refs(friends), incomingRequests: await refs(incoming),
       outgoingRequests: await refs(outgoing), blocked: await refs(blocked),
      },
      economyJournal: economic.economyJournal === undefined ? [] : economic.economyJournal,
      purchaseReceipts: economic.purchaseReceipts === undefined ? [] : economic.purchaseReceipts,
      practiceSave: practice,
      reportsSubmitted: submitted,
     },
    };
   });
  },
  async deletionStatus(token) {
   return run(async (repositories) => {
    const session = await linkedRow(repositories, token);
    const row = await repositories.profiles.for(session.actor);
    return { available: deletionPolicy.enabled === true, policyVersion: deletionPolicy.policyVersion || null, confirmation: row ? row.tag : null, recentlyVerified: clock() - session.authAt <= REAUTH_WINDOW };
   });
  },
  /* Coordinated deletion. The API half is a REAL disable, not a stub: every session and durable
    * sign-in/challenge is revoked (the actor's login stops working immediately), every linked
    * identity and the credential are removed, and the public profile is scrubbed and the account
    * marked unverified so no read path serves it. A durable `privacy.requests` row ('requested') plus
    * an `account.deletion` outbox row record the intake and hand the worker/Core-owned remainder
    * (request completion, the permanent deletion receipt, economic/competitive erasure) over with
    * exactly the values they need. The API NEVER writes a receipt, NEVER stamps completion, and
    * NEVER claims `{deleted:true}`: while economic rows are still present and the worker has not
    * completed the state machine the only honest answer is a pending acknowledgment. No economic
    * row is touched here. */
  async deleteAccount(token, confirmation) {
   const result = await run(async (repositories) => {
    const session = await linkedRow(repositories, token);
    if (!deletionPolicy.enabled || !deletionPolicy.policyVersion) fail('ACCOUNT_DELETION_UNAVAILABLE');
    if (clock() - session.authAt > REAUTH_WINDOW) fail('REAUTH_REQUIRED');
    const actor = session.actor;
    const row = await repositories.profiles.for(actor);
    if (!row || confirmation !== row.tag) fail('DELETE_CONFIRMATION_REQUIRED');
    await rate(repositories, actor, 'account-delete', 2, 86400);
    /* LOCK ORDER (canonical): actor auth mutex, then the REAL identity.eligibility row lock (the same
      * row Core takes for actor admission), then the live bearer and eligibility are RE-READ and the
      * authoritative busy state is read UNDER those locks. Reading occupancy before the lock let Core
      * claim an active aggregate between the read and setUnverified; advisory-only locks did not
      * serialize with Core at all. */
    await lockAuth(repositories, actor);
    await repositories.accounts.lockEligibility([actor]);
    const live = await liveSession(repositories, token);
    if (live.actor !== actor) fail('ACCOUNT_CHANGED');
    await verifiedRow(repositories, actor);
    const activity = await repositories.accounts.activity(actor);
    if (activity && activity.competitiveBusy === true) fail('ACCOUNT_BUSY');
    const now = clock();
    const tombstone = `deleted_${crypto.randomUUID().replace(/-/g, '')}`;
    const receiptId = `del_${crypto.randomUUID()}`;
    const actorHash = crypto.createHash('sha256').update(`mega-xo-deleted-account:${actor}`).digest('base64url');
    await repositories.deletion.insertRequest({ id: receiptId, actor, kind: 'deletion', state: 'requested', requestedAt: now, updatedAt: now, policyVersion: deletionPolicy.policyVersion, note: 'api-initiated coordinated deletion' });
    await repositories.accounts.setUnverified(actor);
    await repositories.sessions.revokeAll(actor);
    await repositories.signin.cancelForActor(actor);
    await repositories.challenges.consumeAllFor(actor);
    /* EVERY linked login identity is removed, not just email: the disabled account keeps no usable
      * sign-in method at all. */
    await repositories.identities.removeAll(actor);
    await repositories.credentials.remove(actor);
    await repositories.profiles.tombstone(actor, tombstone);
    await repositories.saves.remove(actor);
    await repositories.outbox.enqueue({
     id: `${DELETION_KIND}:${actor}`, kind: DELETION_KIND,
     payload: { actor, receiptId, tombstone, actorHash, policyVersion: deletionPolicy.policyVersion, retained: DELETION_RETAINED },
     created: now, expires: now + 30 * DAY,
    });
    return { receiptId, tombstone, policyVersion: deletionPolicy.policyVersion, actorHash };
   });
   /* Worker/Core-owned remainder (request completion + permanent receipt + economic erasure). The
    * outbox row already makes it durable; a supplied hook just runs it inline. Completion is the
    * worker's to record, so this method always reports PENDING. */
   if (completeDeletion) await afterCommit(() => completeDeletion({ ...result }));
   return { deletionPending: true, receiptId: result.receiptId, policyVersion: result.policyVersion };
  },

  /* --- maintenance --- */
  async cleanup() {
   return run(async (repositories) => {
    const now = clock();
    await repositories.challenges.prune(now);
    await repositories.signin.prune(now);
    await repositories.sessions.expire(now);
    return { cleaned: true };
   });
  },
  /* close() releases THIS service's unit of work only: the pool is caller-owned (it carries a
    * cluster-wide connection-budget claim that must outlive one service). */
  async close() {
   closed = true;
   uow.close();
   return { closed: true };
  },

  /* Reported schema dependency: the owner-created read functions this service requires. */
  READ_FUNCTIONS: SECRET_READ_FUNCTIONS,
  readiness: Object.freeze({ role, schemaHead: readiness.schemaHead, migrations: readiness.migrations }),
 };

 return Object.freeze(service);
}

module.exports = { createAccountService, PROVISION_KIND, SOCIAL_CANCEL_KIND, DELETION_KIND };
