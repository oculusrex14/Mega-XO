/* packages/db/pg/accounts.js - V5 P04 normalized account/profile/identity/social repository.
 *
 * The entity-level complement to `pgRepositoriesFor` (repositories.js). That set owns the
 * aggregate/economy seam; THIS set owns the account-owned tables the API writes statement by
 * statement: `identity.actors/eligibility/profiles/identities`, the credential/challenge/signin
 * state, `identity.sessions`, `profile.profile_saves`, the `social.*` pair tables,
 * `social.command_outcomes` via the shared outcome repository, `privacy.reports` and the durable
 * `ops.outbox` provisioning/cancellation rows.
 *
 * Usage (always inside one unit of work):
 *
 *   const accounts = accountRepositoryFor({ client: tx.client, clock: tx.clock, role, options });
 *   await accounts.profiles.for('u_1');
 *
 * Contract, identical where the storage model allows to `pgRepositoriesFor`:
 *  - Every member requires a LIVE transaction scope on the supplied client and raises the shared
 *    `ContextError('TRANSACTION_REQUIRED')` outside one. The guarded pool only vouches for role,
 *    search_path and timers inside the borrowed transaction, so an out-of-scope read would run on
 *    a session this layer cannot vouch for.
 *  - Bounded, parameterized SQL only: no value is interpolated, every potentially large read
 *    passes a LIMIT.
 *  - No minting. A missing actor/profile/wallet is an error, never a created default, and every
 *    written timestamp comes from the caller's injected clock or the caller's own object.
 *  - Column-level privilege discipline: the runtime roles' SELECT grants deliberately exclude the
 *    credential/challenge/signin SECRET columns, so those reads go through the owner-created,
 *    explicitly-authorized read functions named in `SECRET_READ_FUNCTIONS` (see the header of
 *    each member). A privileged connection or a widened grant is never the answer.
 *
 * Session/attempt hash convention: `identity.sessions.token_hash` is 64 lowercase hex with a
 * CHECK (0005) and `identity.signin_attempts`/`identity.email_challenges` correlate on the SAME
 * 64-hex sha256 of the bearer, so this module stores hex. The repositories.js `hashIn`/`hashOut`
 * pair is the base64url<->hex translation for the legacy encoding; here the token is hashed once,
 * directly into the target encoding, and the raw bearer never touches a column.
 */
'use strict';
const crypto = require('node:crypto');
const { ContextError } = require('../context');
const { currentPgScope } = require('./pool');
const { lockTransactionIdentity } = require('./locks');

/* The retention horizon used by the challenge sweep: mirrors the legacy cleanup() window. */
const DAY = 86400000;

/* Owner-created, EXECUTE-granted read functions. They exist because 0020 deliberately withholds
 * the secret columns from `api_runtime` (salt/password_hash/code_hash/password_salt/nonce/
 * verifier are simply absent from its column grants) and because the API has no USAGE on
 * `economy`/`core`, so it cannot read the competitive/economic projection directly. Each is a
 * reported P04 schema dependency, not something worked around here. */
const SECRET_READ_FUNCTIONS = Object.freeze({
 /* profile.account_state(actor_id text) RETURNS json - canonical bounded projection:
  * {walletReady, wealth:{coins,crowns,reservedCoins,reservedCrowns,owned,purchaseInfluenced,
  * monetization:{credits,equipped}}, competitive:{rating,peak,games,casualRating,casualGames,tier,
  * reachedAt,lastRatedAt,activeMatch}, season, seasonHistory, tournamentRecord, history} */
 accountState: 'profile.account_state',
 /* identity.auth_credential(p_email text, p_actor text) RETURNS json - ONE row, the credential
  * identified by lower(email) when p_email is non-null, else by p_actor:
  * {email, actorId, salt, passwordHash, createdAt, verifiedAt} or SQL NULL. */
 credential: 'identity.auth_credential',
 /* identity.auth_challenge(p_id text, p_session_hash text) RETURNS json - the challenge row plus
  * its credential stamp: {challengeId, sessionHash, email, purpose, actorId, codeHash,
  * passwordSalt, passwordHash, credentialHash, createdAt, expiresAt, attempts, verifiedAt,
  * consumed} or SQL NULL. */
 challenge: 'identity.auth_challenge',
 /* identity.auth_signin_attempt(p_state_hash text) RETURNS json - {stateHash, sessionHash,
  * provider, kind, intent, targetActor, nonce, verifier, expiresAt, used} or SQL NULL. */
 signinAttempt: 'identity.auth_signin_attempt',
 /* profile.account_activity(p_actor text) RETURNS json - the lightweight visibility/deletion
  * projection: {deletionPending, competitiveBusy}. deletionPending is a durable deletion request
  * in a state outside ('cancelled','completed') (0040); competitiveBusy is any Core occupancy OR an
  * OFFERED/PLAYING match participant. */
 activity: 'profile.account_activity',
 /* profile.account_export(p_actor text) RETURNS json - the bounded, complete economic projection
  * {state, daily, economyJournal, purchaseReceipts, monetization}. Overflow raises STATE_TRUNCATED
  * (54000); a missing actor row returns SQL NULL. api_runtime reads it through the owner function
  * because it holds no USAGE on economy/monetization/core. */
 export: 'profile.account_export',
});

/* ------------------------------------------------------------------ scope plumbing */

function scopeOf(context) {
 const scope = context && context.client ? currentPgScope(context.client) : null;
 if (!scope) throw new ContextError('TRANSACTION_REQUIRED');
 return scope;
}
function clockOf(context) {
 const scope = context && context.client ? currentPgScope(context.client) : null;
 const clock = (context && context.clock) || (scope && scope.tx && scope.tx.clock);
 if (typeof clock !== 'function') throw new ContextError('CLOCK_REQUIRED');
 return clock();
}
function iso(value, what) {
 if (value === null || value === undefined) return null;
 if (!Number.isFinite(value)) {
  const error = new ContextError('INVALID_TIMESTAMP');
  error.detail = `${what}: ${String(value)}`;
  throw error;
 }
 return new Date(value).toISOString();
}
function toMs(value) {
 if (value === null || value === undefined) return null;
 if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
 if (typeof value === 'number') return Number.isFinite(value) ? value : null;
 const text = String(value);
 if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
 const ms = Date.parse(text);
 return Number.isFinite(ms) ? ms : null;
}
const msColumn = (expression, alias) => `(extract(epoch from ${expression}) * 1000)::bigint AS ${alias}`;
function msOrNull(value, what) {
 if (value === null || value === undefined) return null;
 const ms = toMs(value);
 if (ms === null) throw new ContextError('INVALID_TIMESTAMP');
 return ms;
}
/* TYPED JSON. Every JSON/JSONB column (`identity.actors.region`, and every `json`-returning read
 * function) arrives from the driver ALREADY decoded (pg parses OID 114/3802): a JSON string scalar
 * comes back as a plain JS string, an object as an object. Re-parsing here would corrupt any
 * legitimate string that is not valid JSON text (a region like 'EU') and would also destroy a
 * historic JSON value of false/0/null. This mirrors `packages/db/pg/repositories.js` `decodeJson`
 * exactly: pass the typed value through, substituting the fallback only for SQL NULL/undefined.
 *
 * TEXT columns that hold canonical JSON TEXT (outcome responses, wallet-operation fingerprints,
 * the opaque `payload_text` archive) are a DIFFERENT representation and are never passed through
 * this helper - the opaque archive stays verbatim text and the outcome families are decoded by the
 * shared repositories.js `decodeJsonText`. */
function decodeJson(value, fallback) {
 return value === null || value === undefined ? fallback : value;
}

/* ------------------------------------------------------------------ members */

function accountRepositoryFor(context) {
 if (!context || typeof context !== 'object') throw new ContextError('CONTEXT_REQUIRED');
 const scope = scopeOf(context);
 const q = scope.tx.query;
 /* The shared logical-identity mutex (packages/db/pg/locks.js) for facts that durable uniqueness
  * alone cannot serialize inside this transaction: a provider subject or an actor before its
  * account row exists, and the account-wide session/identity decision points. A missing row cannot
  * be locked with FOR UPDATE, so the absent-row races (identical provider reauthentication,
  * conflicting concurrent link, a second concurrent login racing logout/revocation, concurrent
  * unlink removing every method) are serialized here instead. Durable outcomes remain the truth. */
 const lockIdentity = (namespace, parts) => lockTransactionIdentity(scope.tx, namespace, parts);

 /* --- actors + eligibility (both SELECTable by api_runtime) --- */
 const accounts = {
  async has(actor) {
   const r = await q('SELECT 1 AS ok FROM identity.actors WHERE actor_id = $1', [actor]);
   return r.rows.length > 0;
  },
  /* The API-owned account facts. `region` is a NOT NULL JSON column (0034) whose value the driver
    * has already decoded, so it is assigned DIRECTLY: a JSON string ('EU'), false, 0 and a JSON
    * literal null all survive verbatim. A fallback here would be wrong - the column is never SQL
    * NULL, and a JSON null would be indistinguishable from a SQL NULL after decoding, so only a
    * missing ACTOR row (handled below) means "no region", never a substituted ''. */
  async for(actor) {
   const r = await q(
    'SELECT a.actor_id, a.region, a.wealth_public,'
    + ` ${msColumn('a.created_at', 'created')},`
    + ' e.verified, e.suspended, e.security_hold'
    + ' FROM identity.actors a LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'
    + ' WHERE a.actor_id = $1', [actor]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    id: row.actor_id, region: row.region,
    wealthPublic: row.wealth_public === true, created: msOrNull(row.created, 'actors.created_at'),
    verified: row.verified === true, suspended: row.suspended === true, hold: row.security_hold === true,
   };
  },
  /* The canonical competitive/economic projection. api_runtime has no USAGE on economy/core, so
    * this MUST be the owner's read function; a missing function is reported as a clear dependency
    * error instead of being silently answered with zeros (a fabricated balance is worse than a
    * refusal). */
  async state(actor) {
   try {
    const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.accountState}($1) AS state`, [actor]);
    return decodeJson(r.rows[0] ? r.rows[0].state : null, null);
   } catch (error) {
    if (error && error.code === '42883') {
     const wrapped = new ContextError('ACCOUNT_STATE_UNAVAILABLE');
     wrapped.detail = `${SECRET_READ_FUNCTIONS.accountState}(text) is required by api_runtime`;
     throw wrapped;
    }
    throw error;
   }
  },
  /* The lightweight visibility/deletion projection (0040): a complete bounded read on its own
    * (EXISTS predicates, no cap) so profile visibility and the deletion busy check never depend on
    * a pulled financial export. A missing function is a deployment failure and is surfaced, never
    * answered with a fabricated {deletionPending:false, competitiveBusy:false}. */
  async activity(actor) {
   try {
    const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.activity}($1) AS activity`, [actor]);
    return decodeJson(r.rows[0] ? r.rows[0].activity : null, null);
   } catch (error) {
    if (error && error.code === '42883') {
     const wrapped = new ContextError('ACCOUNT_ACTIVITY_UNAVAILABLE');
     wrapped.detail = `${SECRET_READ_FUNCTIONS.activity}(text) is required by api_runtime`;
     throw wrapped;
    }
    throw error;
   }
  },
  /* The bounded, COMPLETE economic projection for the privacy export (0040): journal, receipts and
    * the monetization register the API cannot read directly. Overflow raises STATE_TRUNCATED inside
    * the function; that code is propagated verbatim (never a partial economy export). */
  async export(actor) {
   try {
    const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.export}($1) AS export`, [actor]);
    return decodeJson(r.rows[0] ? r.rows[0].export : null, null);
   } catch (error) {
    if (error && error.code === '42883') {
     const wrapped = new ContextError('ACCOUNT_EXPORT_UNAVAILABLE');
     wrapped.detail = `${SECRET_READ_FUNCTIONS.export}(text) is required by api_runtime`;
     throw wrapped;
    }
    throw error;
   }
  },
  /* Durable wallet readiness IS wallet-row existence (parent contract): no ready bit is stored.
    * An actor with no wallet row is pending provisioning and is therefore not yet able to mutate. */
  async walletReady(actor) {
   const state = await accounts.state(actor);
   return state !== null && state.walletReady === true;
  },
  async insert(row, at) {
   await q('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, $3, $4)',
    [row.actor, JSON.stringify(row.region === undefined ? '' : row.region), row.wealthPublic === true, iso(at, 'actors.created_at')]);
  },
  async eligibilityInsert(actor, verified, at) {
   await q('INSERT INTO identity.eligibility (actor_id, verified) VALUES ($1, $2) ON CONFLICT (actor_id) DO NOTHING',
    [actor, verified === true]);
  },
  /* The verified flag is api_runtime's column grant (0037); suspended/security_hold are NOT in the
    * statement, so a suspension can never be cleared from the API side. */
  async markVerified(actor) {
   await q('UPDATE identity.eligibility SET verified = true WHERE actor_id = $1', [actor]);
  },
  /* Coordinated deletion disables the account: the API holds the `verified` column grant and
    * nothing else, so clearing it is exactly the API's real disable. */
  async setUnverified(actor) {
   const r = await q('UPDATE identity.eligibility SET verified = false WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
  /* The REAL row lock on the actor's eligibility row (sorted ids, FOR UPDATE). This is the lock Core
    * itself takes for actor admission, so it is the lock that actually serializes an API decision
    * (deletion/unlink/login) with Core claiming an aggregate. `SELECT ... FOR UPDATE` needs SELECT
    * plus ANY column-level UPDATE, both of which api_runtime holds (0037), so it is authorized. It is
    * taken AFTER the actor's advisory auth mutex and BEFORE the dependent busy/credential reads. A
    * missing eligibility row still locks the actor's LOGICAL identity via the advisory mutex. */
  async lockEligibility(ids) {
   const list = [...new Set(ids.map(String))].sort();
   if (list.length === 0) return [];
   await q('SELECT actor_id FROM identity.eligibility WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE', [list]);
   return list;
  },
 };

 /* --- profiles (canonical for tag/username/display name, design 5.4) --- */
 const profiles = {
  async for(actor) {
   const r = await q(
    'SELECT actor_id, tag, username, display_name, avatar, stats_visibility, presence_visibility,'
    + ` ${msColumn('created_at', 'created')}, ${msColumn('username_changed', 'username_changed')}, version`
    + ' FROM identity.profiles WHERE actor_id = $1', [actor]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    actor: row.actor_id, tag: row.tag, username: row.username, display_name: row.display_name,
    avatar: row.avatar, stats_visibility: row.stats_visibility, presence_visibility: row.presence_visibility,
    created: msOrNull(row.created, 'profiles.created_at'),
    username_changed: msOrNull(row.username_changed, 'profiles.username_changed') || 0,
    version: Number(row.version),
   };
  },
  async byUsername(username) {
   const r = await q('SELECT actor_id FROM identity.profiles WHERE username = $1', [username]);
   return r.rows[0] ? r.rows[0].actor_id : null;
  },
  async byTag(tag) {
   const r = await q('SELECT actor_id FROM identity.profiles WHERE tag = $1', [tag]);
   return r.rows[0] ? r.rows[0].actor_id : null;
  },
  /* The legacy prefix search: `username >= p AND username < p||chr(255)` with an exact match first,
    * bounded to 20 rows (server/community-store.js:203). text_pattern_ops makes it an index scan. */
  async prefix(username, limit = 20) {
   const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
   const r = await q(
    'SELECT actor_id FROM identity.profiles WHERE username >= $1 AND username < $1 || chr(255)'
    + ' ORDER BY CASE WHEN username = $1 THEN 0 ELSE 1 END, username LIMIT $2', [username, bounded]);
   return r.rows.map((row) => row.actor_id);
  },
  async insert(row, at) {
   await q(
    'INSERT INTO identity.profiles (actor_id, tag, username, display_name, avatar, stats_visibility, presence_visibility, created_at)'
    + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [row.actor, row.tag, row.username, row.display_name, row.avatar || 'board',
     row.stats_visibility || 'friends', row.presence_visibility || 'friends', iso(at, 'profiles.created_at')]);
  },
  /* Coordinated deletion scrubs the public identity in place: the username (the searchable key) and
    * the display name become the tombstone, and the privacy flags close. The tag keeps its
    * 'MEGA-<hex>' grammar so the CHECK still holds and the row can stay as a soft reference target.
    * No DELETE on identity.profiles is required, so the actor row remains for Core's cascade. */
  async tombstone(actor, tombstone) {
   const scrub = tombstone.slice(0, 24);
   await q('UPDATE identity.profiles SET username = $2, display_name = $2, stats_visibility = $3, presence_visibility = $4, version = version + 1 WHERE actor_id = $1',
    [actor, scrub, 'private', 'hidden']);
  },
  /* One statement, one version increment. `username_changed` moves only when the username changed,
    * so the 7-day cooldown cannot be reset by an unrelated edit. */
  async update(actor, next) {
   const r = await q(
    'UPDATE identity.profiles SET username = $2, display_name = $3, avatar = $4, stats_visibility = $5,'
    + ' presence_visibility = $6, username_changed = $7, version = version + 1'
    + ' WHERE actor_id = $1 RETURNING version',
    [actor, next.username, next.display_name, next.avatar, next.stats_visibility, next.presence_visibility, iso(next.username_changed, 'profiles.username_changed')]);
   return r.rows[0] ? Number(r.rows[0].version) : null;
  },
 };

 /* --- linked identities --- */
 const identities = {
  async list(actor) {
   const r = await q('SELECT provider, subject, created_at FROM identity.identities WHERE actor_id = $1 ORDER BY provider', [actor]);
   return r.rows.map((row) => ({ provider: row.provider, subject: row.subject, created: msOrNull(row.created_at, 'identities.created_at') }));
  },
  async actorFor(provider, subject) {
   const r = await q('SELECT actor_id FROM identity.identities WHERE provider = $1 AND subject = $2', [provider, subject]);
   return r.rows[0] ? r.rows[0].actor_id : null;
  },
  async subjectFor(actor, provider) {
   const r = await q('SELECT subject FROM identity.identities WHERE actor_id = $1 AND provider = $2', [actor, provider]);
   return r.rows[0] ? r.rows[0].subject : null;
  },
  /* `provider,subject` is the identity's natural key and `(actor_id, provider)` is UNIQUE, so an
    * identical replay is a no-op (rowCount 0) and the caller's prior-subject check surfaces
    * PROVIDER_ALREADY_LINKED for a conflicting link. */
  async insert(provider, subject, actor, at) {
   const r = await q(
    'INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [provider, subject, actor, iso(at, 'identities.created_at')]);
   return r.rowCount > 0;
  },
  async remove(actor, provider) {
   const r = await q('DELETE FROM identity.identities WHERE actor_id = $1 AND provider = $2', [actor, provider]);
   return r.rowCount;
  },
  /* Coordinated deletion removes every linked login identity, not just email: the account keeps no
    * usable sign-in method at all. */
  async removeAll(actor) {
   const r = await q('DELETE FROM identity.identities WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
 };

 /* --- credentials (secret columns via the owner read function) --- */
 const credentials = {
  async read({ email = null, actor = null }) {
   const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.credential}($1, $2) AS credential`, [email, actor]);
   const row = decodeJson(r.rows[0] ? r.rows[0].credential : null);
   if (!row) return null;
   return {
    email: row.email, actor: row.actorId, salt: row.salt, passwordHash: row.passwordHash,
    created: msOrNull(row.createdAt, 'email_credentials.created_at'),
    verified: row.verifiedAt === null || row.verifiedAt === undefined ? null : msOrNull(row.verifiedAt, 'email_credentials.verified_at'),
   };
  },
  async insert(row, at) {
   await q(
    'INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [row.email, row.actor, row.salt, row.passwordHash, iso(at, 'email_credentials.created_at'), iso(row.verifiedAt === undefined ? null : row.verifiedAt, 'email_credentials.verified_at')]);
  },
  async setVerified(actor, at) {
   await q('UPDATE identity.email_credentials SET verified_at = $2 WHERE actor_id = $1', [actor, iso(at, 'email_credentials.verified_at')]);
  },
  /* Take the credential ROW lock: `SELECT actor_id ... FOR UPDATE` needs SELECT(actor_id) plus any
    * column-level UPDATE on identity.email_credentials, both of which api_runtime holds (0020), so no
    * secret SELECT and no widened grant are needed. It serializes credential comparisons with any
    * concurrent writer (including a non-cooperative/admin one) on the pinned transaction. */
  async lockRow(actor) {
   const r = await q('SELECT actor_id FROM identity.email_credentials WHERE actor_id = $1 FOR UPDATE', [actor]);
   return r.rowCount > 0;
  },
  /* The canonical stale-credential stamp: an applicable challenge pins the credential it was issued
    * against (sha256(actor|password_hash) hex, account-policy.credentialStamp) and every grant
    * compares it before proceeding, so a password/email rotation invalidates every challenge
    * authorized against the old credential. The row is keyed to the challenge and cascades with it
    * (0005); an imported production version row is compared VERBATIM, never re-derived. */
  async insertVersion(challengeId, credentialHashValue) {
   await q('INSERT INTO identity.email_credential_versions (challenge_id, credential_hash) VALUES ($1, $2)', [challengeId, credentialHashValue === undefined ? null : credentialHashValue]);
  },
  /* Compare through the owner's read function while holding the credential row lock. Referencing
    * salt/password_hash in an UPDATE predicate would require their SELECT privileges, which the
    * API deliberately lacks. The locked row cannot change between this comparison and the update. */
  async setPasswordIfCurrent(actor, salt, passwordHashValue, at, expectedSalt, expectedHash) {
   if (!(await credentials.lockRow(actor))) return false;
   const current = await credentials.read({ actor });
   if (!current || current.salt !== expectedSalt || current.passwordHash !== expectedHash) return false;
   const r = await q(
    'UPDATE identity.email_credentials SET salt = $2, password_hash = $3, verified_at = $4'
    + ' WHERE actor_id = $1 RETURNING actor_id',
    [actor, salt, passwordHashValue, iso(at, 'email_credentials.verified_at')]);
   return r.rowCount > 0;
  },
  async changeEmailIfCurrent(actor, nextEmail, at, expectedSalt, expectedHash) {
   if (!(await credentials.lockRow(actor))) return false;
   const current = await credentials.read({ actor });
   if (!current || current.salt !== expectedSalt || current.passwordHash !== expectedHash) return false;
   const r = await q(
    'UPDATE identity.email_credentials SET email = $2, verified_at = $3'
    + ' WHERE actor_id = $1 RETURNING actor_id',
    [actor, nextEmail, iso(at, 'email_credentials.verified_at')]);
   if (r.rowCount === 0) return false;
   await q("UPDATE identity.identities SET subject = $2 WHERE actor_id = $1 AND provider = 'email'", [actor, nextEmail]);
   return true;
  },
  async remove(actor) {
   const r = await q('DELETE FROM identity.email_credentials WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
 };

 /* --- email/OTP challenges --- */
 const challenges = {
  async find(id, sessionHash) {
   const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.challenge}($1, $2) AS challenge`, [id, sessionHash]);
   const row = decodeJson(r.rows[0] ? r.rows[0].challenge : null);
   if (!row) return null;
   return {
    id: row.challengeId, session: row.sessionHash, email: row.email, purpose: row.purpose, actor: row.actorId,
    codeHash: row.codeHash, passwordSalt: row.passwordSalt, passwordHash: row.passwordHash,
    credentialHash: row.credentialHash === undefined ? null : row.credentialHash,
    credentialStampPresent: row.credentialStampPresent === true,
    created: msOrNull(row.createdAt, 'email_challenges.created_at'),
    expires: msOrNull(row.expiresAt, 'email_challenges.expires_at'),
    attempts: Number(row.attempts || 0),
    verifiedAt: row.verifiedAt === null || row.verifiedAt === undefined ? null : msOrNull(row.verifiedAt, 'email_challenges.verified_at'),
    consumed: row.consumed === true,
   };
  },
  /* Supersede-then-insert, exactly the legacy shape: the previous unconsumed challenge for the same
    * (session,email,purpose) is consumed in the same transaction as the new row is written. */
  async create(row, at) {
   await q('UPDATE identity.email_challenges SET consumed = true WHERE session_hash = $1 AND email = $2 AND purpose = $3 AND consumed = false',
    [row.session, row.email, row.purpose]);
   await q(
    'INSERT INTO identity.email_challenges (challenge_id, session_hash, email, purpose, actor_id, code_hash, password_salt, password_hash, created_at, expires_at)'
    + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [row.id, row.session, row.email, row.purpose, row.actor, row.codeHash, row.passwordSalt || null, row.passwordHash || null,
     iso(at, 'email_challenges.created_at'), iso(row.expires, 'email_challenges.expires_at')]);
  },
  async bumpAttempts(id) {
   const r = await q('UPDATE identity.email_challenges SET attempts = attempts + 1 WHERE challenge_id = $1 RETURNING challenge_id', [id]);
   return r.rowCount > 0;
  },
  async markVerified(id, at) {
   await q('UPDATE identity.email_challenges SET verified_at = $2, consumed = true WHERE challenge_id = $1', [id, iso(at, 'email_challenges.verified_at')]);
  },
  /* A reset challenge is stamped verified WITHOUT consuming: verification authorizes the completion
    * exactly once, and the completion itself is the consume (see `consumeExpected`). */
  async stampVerified(id, at) {
   await q('UPDATE identity.email_challenges SET verified_at = $2 WHERE challenge_id = $1 AND consumed = false AND verified_at IS NULL', [id, iso(at, 'email_challenges.verified_at')]);
  },
  /* Conditional consume: the UPDATE carries the expected authorized state (`verified_at` not null,
    * not consumed, not expired, SAME session), so a stale or replayed completion is a zero-row result
    * rather than a second grant. */
  async consumeExpected(id, sessionHash, purpose, now) {
   const r = await q(
    'UPDATE identity.email_challenges SET consumed = true, password_hash = NULL, password_salt = NULL'
    + ' WHERE challenge_id = $1 AND session_hash = $2 AND purpose = $3 AND consumed = false AND verified_at IS NOT NULL AND expires_at > $4 RETURNING challenge_id',
    [id, sessionHash, purpose, iso(now, 'email_challenges.consume_expected')]);
   return r.rowCount > 0;
  },
  /* One-shot completion of every unconsumed challenge for an email/purpose set: used when a
    * credential is rotated so no other issued-but-unfinished authorization survives it. */
  async consumePending(email, purpose) {
   const r = await q('UPDATE identity.email_challenges SET consumed = true WHERE email = $1 AND purpose = $2 AND consumed = false', [email, purpose]);
   return r.rowCount;
  },
  async consume(id) {
   const r = await q('UPDATE identity.email_challenges SET consumed = true WHERE challenge_id = $1', [id]);
   return r.rowCount;
  },
  async consumeAllFor(actor) {
   const r = await q('UPDATE identity.email_challenges SET consumed = true WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
  /* The cooldown probe: the newest challenge for this (session,email,purpose) inside the window. */
  async recent(sessionHash, email, purpose, since) {
   const r = await q(
    'SELECT challenge_id FROM identity.email_challenges WHERE session_hash = $1 AND email = $2 AND purpose = $3 AND created_at > $4 ORDER BY created_at DESC LIMIT 1',
    [sessionHash, email, purpose, iso(since, 'email_challenges.recent')]);
   return r.rows[0] ? r.rows[0].challenge_id : null;
  },
  /* Retention: expired challenges and long-consumed ones. */
  async prune(now) {
   const r = await q('DELETE FROM identity.email_challenges WHERE expires_at < $1 OR (consumed = true AND created_at < $2)',
    [iso(now - 3600000, 'email_challenges.prune.expires'), iso(now - DAY, 'email_challenges.prune.consumed')]);
   return r.rowCount;
  },
 };

 /* --- durable signin attempts (nonce/PKCE state) --- */
 const signin = {
  async find(stateHash) {
   const r = await q(`SELECT ${SECRET_READ_FUNCTIONS.signinAttempt}($1) AS attempt`, [stateHash]);
   const row = decodeJson(r.rows[0] ? r.rows[0].attempt : null);
   if (!row) return null;
   return {
    stateHash: row.stateHash, session: row.sessionHash, provider: row.provider, kind: row.kind,
    intent: row.intent, target: row.targetActor, nonce: row.nonce, verifier: row.verifier,
    expires: msOrNull(row.expiresAt, 'signin_attempts.expires_at'), used: row.used === true,
   };
  },
  async create(row) {
   await q(
    'INSERT INTO identity.signin_attempts (state_hash, session_hash, provider, kind, intent, target_actor, nonce, verifier, expires_at)'
    + ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [row.stateHash, row.session, row.provider, row.kind, row.intent, row.target || null, row.nonce, row.verifier,
     iso(row.expires, 'signin_attempts.expires_at')]);
  },
  /* One-use: the UPDATE is the consumption, and `used = false` in the predicate makes a replay a
    * zero-row result instead of a second successful exchange. */
  async consume(stateHash) {
   const r = await q('UPDATE identity.signin_attempts SET used = true WHERE state_hash = $1 AND used = false RETURNING state_hash', [stateHash]);
   return r.rowCount > 0;
  },
  async cancelForSession(sessionHash) {
   const r = await q('DELETE FROM identity.signin_attempts WHERE session_hash = $1', [sessionHash]);
   return r.rowCount;
  },
  /* Unlink/deletion invalidate every outstanding attempt for the ACTOR, across all its sessions: an
    * attempt issued on another bearer must not be replayable to re-add a removed method. */
  async cancelForActor(actor) {
   const r = await q('DELETE FROM identity.signin_attempts WHERE target_actor = $1 OR session_hash IN (SELECT token_hash FROM identity.sessions WHERE actor_id = $1)', [actor]);
   return r.rowCount;
  },
  async prune(now) {
   const r = await q('DELETE FROM identity.signin_attempts WHERE expires_at < $1', [iso(now - 3600000, 'signin_attempts.prune')]);
   return r.rowCount;
  },
 };

 /* --- sessions (bearer is stored as its sha256 hex, never raw) --- */
 const sessions = {
  hash(token) { return crypto.createHash('sha256').update(token).digest('hex'); },
  async insert(row) {
   await q('INSERT INTO identity.sessions (token_hash, actor_id, csrf, created_at, expires_at, auth_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [row.tokenHash, row.actor, row.csrf, iso(row.created, 'sessions.created_at'), iso(row.expires, 'sessions.expires_at'), iso(row.authAt, 'sessions.auth_at')]);
  },
  async touchAuth(actor, tokenHash, at) {
   const r = await q('UPDATE identity.sessions SET auth_at = $3 WHERE actor_id = $1 AND token_hash = $2', [actor, tokenHash, iso(at, 'sessions.auth_at')]);
   return r.rowCount;
  },
  async list(actor, now) {
   const r = await q(
    `SELECT token_hash, ${msColumn('created_at', 'created')}, ${msColumn('expires_at', 'expires')}, ${msColumn('auth_at', 'auth_at')}`
    + ' FROM identity.sessions WHERE actor_id = $1 AND expires_at > $2 ORDER BY created_at DESC LIMIT 100',
    [actor, iso(now, 'sessions.list')]);
   return r.rows.map((row) => ({
    hash: row.token_hash, created: msOrNull(row.created, 'sessions.created_at'),
    expires: msOrNull(row.expires, 'sessions.expires_at'), auth_at: msOrNull(row.auth_at, 'sessions.auth_at'),
   }));
  },
  async revoke(actor, tokenHash) {
   const r = await q('DELETE FROM identity.sessions WHERE actor_id = $1 AND token_hash = $2', [actor, tokenHash]);
   return r.rowCount;
  },
  async revokeOthers(actor, tokenHash, now) {
   const r = await q('DELETE FROM identity.sessions WHERE actor_id = $1 AND token_hash <> $2 AND expires_at > $3 RETURNING token_hash',
    [actor, tokenHash, iso(now === undefined ? clockOf(context) : now, 'sessions.revokeOthers')]);
   return r.rows.map((row) => row.token_hash);
  },
  async revokeAll(actor) {
   const r = await q('DELETE FROM identity.sessions WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
  /* Single-use bearer rotation deletes by token: an anonymous session has a NULL actor. */
  async rotate(tokenHash) {
   const r = await q('DELETE FROM identity.sessions WHERE token_hash = $1', [tokenHash]);
   return r.rowCount;
  },
  /* The live session row for a bearer hash (the lookup every session-bound method starts from). */
  async live(tokenHash, now) {
   const r = await q(
    `SELECT token_hash, actor_id, csrf, ${msColumn('created_at', 'created')}, ${msColumn('expires_at', 'expires')}, ${msColumn('auth_at', 'auth_at')}`
    + ' FROM identity.sessions WHERE token_hash = $1 AND expires_at > $2',
    [tokenHash, iso(now === undefined ? clockOf(context) : now, 'sessions.live')]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    token: row.token_hash, actor: row.actor_id, csrf: row.csrf,
    created: msOrNull(row.created, 'sessions.created_at'),
    expires: msOrNull(row.expires, 'sessions.expires_at'),
    auth_at: msOrNull(row.auth_at, 'sessions.auth_at'),
   };
  },
  /* Legacy `_replaceSession` keeps at most the 5 most recent sessions for an actor. */
  async pruneBeyond(actor, keep) {
   const bounded = Number.isSafeInteger(keep) && keep >= 0 ? keep : 5;
   const r = await q(
    'DELETE FROM identity.sessions WHERE actor_id = $1 AND token_hash IN ('
    + ' SELECT token_hash FROM identity.sessions WHERE actor_id = $1 ORDER BY created_at DESC OFFSET $2)', [actor, bounded]);
   return r.rowCount;
  },
  async expire(now) {
   const r = await q('DELETE FROM identity.sessions WHERE expires_at <= $1', [iso(now, 'sessions.expire')]);
   return r.rowCount;
  },
 };

 /* --- practice archive (revisioned CAS) --- */
 const saves = {
  async revisionOf(actor) {
   const r = await q('SELECT revision FROM profile.profile_saves WHERE actor_id = $1', [actor]);
   return r.rows.length ? Number(r.rows[0].revision) : 0;
  },
  async for(actor) {
   const r = await q(`SELECT revision, payload_text, ${msColumn('updated_at', 'updated')} FROM profile.profile_saves WHERE actor_id = $1`, [actor]);
   const row = r.rows[0];
   if (!row) return null;
   return { revision: Number(row.revision), updated: msOrNull(row.updated, 'profile_saves.updated_at'), payload: row.payload_text };
  },
  /* Compare-and-swap in at most two statements, with the guard IN the statement:
    *   - UPDATE ... WHERE actor_id = $1 AND revision = $expected: the row only advances from the
    *     revision the caller saw, so of two racers exactly one changes a row;
    *   - a zero-row UPDATE with expected !== 0 is a conflict (the caller expected an existing
    *     revision the row does not hold);
    *   - expected === 0 falls through to the INSERT, and a racing INSERT loses with 23505, which is
    *     the same conflict.
    * The payload text is stored verbatim (0033: payload_text is the authoritative document, so the
    * legacy byte cap is measured on exactly these bytes). */
  async put(actor, expected, payloadText, at) {
   const updated = iso(at, 'profile_saves.updated_at');
   const upd = await q('UPDATE profile.profile_saves SET revision = $2, payload_text = $3, updated_at = $4 WHERE actor_id = $1 AND revision = $5 RETURNING revision',
    [actor, expected + 1, payloadText, updated, expected]);
   if (upd.rowCount > 0) return { revision: Number(upd.rows[0].revision), updated: at };
   if (expected !== 0) throw new ContextError('SAVE_CONFLICT');
   try {
    await q('INSERT INTO profile.profile_saves (actor_id, revision, payload_text, updated_at) VALUES ($1, $2, $3, $4)', [actor, 1, payloadText, updated]);
   } catch (error) {
    if (error && error.code === '23505') throw new ContextError('SAVE_CONFLICT');
    throw error;
   }
   return { revision: 1, updated: at };
  },
  async remove(actor) {
   const r = await q('DELETE FROM profile.profile_saves WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
 };

 /* --- social graph (API-owned pair tables) --- */
 const social = {
  /* The social-command lock: the actor rows are taken FOR UPDATE in SORTED id order before any
    * graph read or write, so a social mutation against actor+target cannot interleave with another
    * command touching the same pair (and with Core's own eligibility lock, neither side can commit
    * a block inside another's read-modify-write of the same pair). Sorting here, never trusting the
    * caller's order, matches `wallets.lock`'s discipline.
    *
    * `SELECT ... FOR UPDATE` needs SELECT plus ANY column-level UPDATE on the relation: api_runtime
    * holds `UPDATE (verified)` (0037), so the lock is authorized today (verified empirically on
    * PG16). The statement re-reads the id alone and mutates nothing. */
  async lock(ids) {
   const list = [...new Set(ids.map(String))].sort();
   if (list.length === 0) return [];
   await q('SELECT actor_id FROM identity.eligibility WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE', [list]);
   return list;
  },
  /* EXACT PAIR DECISIONS + COMPLETE COUNTS. The old whole-incident graph read silently LIMITed each
    * table to 1000 rows, so once an actor's incident set exceeded the cap a blocked relation could
    * look unblocked and a pending request could vanish from an authorization decision. Authorization
    * now asks exact pair questions (indexed, unbounded), and list reads carry an explicit cap plus an
    * overflow flag so a bounded list is never mistaken for the complete set. */
  async pairBlocked(actor, target) {
   const r = await q('SELECT 1 AS present FROM social.blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [actor, target]);
   return r.rows.length > 0;
  },
  async pairFriends(actor, target) {
   const r = await q('SELECT 1 AS present FROM social.friendships WHERE (actor_a = $1 AND actor_b = $2) OR (actor_a = $2 AND actor_b = $1) LIMIT 1', [actor, target]);
   return r.rows.length > 0;
  },
  async pairRequest(from, to) {
   const r = await q('SELECT 1 AS present FROM social.friend_requests WHERE from_id = $1 AND to_id = $2 LIMIT 1', [from, to]);
   return r.rows.length > 0;
  },
  /* Complete counts feeding the approved friend/request limits: a count is never truncated. */
  async countFriends(actor) {
   const r = await q('SELECT count(*)::int AS n FROM social.friendships WHERE actor_a = $1 OR actor_b = $1', [actor]);
   return Number(r.rows[0].n);
  },
  async countIncoming(actor) {
   const r = await q('SELECT count(*)::int AS n FROM social.friend_requests WHERE to_id = $1', [actor]);
   return Number(r.rows[0].n);
  },
  /* Bounded LIST reads for the friends page. `limit` is the visible cap; a full page reports
    * `hasMore` so the caller knows the list is not the complete set. */
  async friendIds(actor, limit) {
   const r = await q('SELECT CASE WHEN actor_a = $1 THEN actor_b ELSE actor_a END AS id FROM social.friendships WHERE actor_a = $1 OR actor_b = $1 ORDER BY id LIMIT $2', [actor, limit + 1]);
   return { ids: r.rows.slice(0, limit).map((row) => row.id), hasMore: r.rows.length > limit };
  },
  async incomingIds(actor, limit) {
   const r = await q('SELECT from_id AS id FROM social.friend_requests WHERE to_id = $1 ORDER BY from_id LIMIT $2', [actor, limit + 1]);
   return { ids: r.rows.slice(0, limit).map((row) => row.id), hasMore: r.rows.length > limit };
  },
  async outgoingIds(actor, limit) {
   const r = await q('SELECT to_id AS id FROM social.friend_requests WHERE from_id = $1 ORDER BY to_id LIMIT $2', [actor, limit + 1]);
   return { ids: r.rows.slice(0, limit).map((row) => row.id), hasMore: r.rows.length > limit };
  },
  async blockedIds(actor, limit) {
   const r = await q('SELECT blocked_id AS id FROM social.blocks WHERE blocker_id = $1 ORDER BY blocked_id LIMIT $2', [actor, limit + 1]);
   return { ids: r.rows.slice(0, limit).map((row) => row.id), hasMore: r.rows.length > limit };
  },
  async friend(actor, other) {
   const [a, b] = [String(actor), String(other)].sort();
   await q('INSERT INTO social.friendships (actor_a, actor_b) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
  },
  async unfriend(actor, other) {
   const [a, b] = [String(actor), String(other)].sort();
   await q('DELETE FROM social.friendships WHERE actor_a = $1 AND actor_b = $2', [a, b]);
  },
  async request(from, to) {
   await q('INSERT INTO social.friend_requests (from_id, to_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [from, to]);
  },
  async dropRequest(from, to) {
   await q('DELETE FROM social.friend_requests WHERE from_id = $1 AND to_id = $2', [from, to]);
  },
  async dropRequestsBetween(actor, other) {
   await q('DELETE FROM social.friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [actor, other]);
  },
  async block(actor, other) {
   await q('INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [actor, other]);
  },
  async unblock(actor, other) {
   await q('DELETE FROM social.blocks WHERE blocker_id = $1 AND blocked_id = $2', [actor, other]);
  },
 };

 /* --- privacy reports (review-only: INSERT + duplicate probe, never a sanction) --- */
 const reports = {
  async recent(reporter, target, category, since) {
   const r = await q(
    "SELECT report_id FROM privacy.reports WHERE reporter_id = $1 AND target_id = $2 AND category = $3 AND state = 'open' AND created_at > $4 ORDER BY created_at DESC LIMIT 1",
    [reporter, target, category, iso(since, 'reports.recent')]);
   return r.rows[0] ? r.rows[0].report_id : null;
  },
  async insert(row, at) {
   await q('INSERT INTO privacy.reports (report_id, reporter_id, target_id, category, detail, created_at, state) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [row.id, row.reporter, row.target, row.category, row.detail || '', iso(at, 'reports.created_at'), 'open']);
  },
  /* The reporter's OWN submitted reports, the exact legacy export shape (server/community-store.js
    * :201): id/target/category/detail/created/state/reviewed_at/outcome. api_runtime holds SELECT on
    * privacy.reports (0020); the target ref is resolved by the service. */
  async submitted(reporter) {
   const r = await q(
    'SELECT report_id, target_id, category, detail,'
    + ` ${msColumn('created_at', 'created')}, ${msColumn('reviewed_at', 'reviewed')}, state, outcome`
    + ' FROM privacy.reports WHERE reporter_id = $1 ORDER BY created_at LIMIT 5000', [reporter]);
   return r.rows.map((row) => ({
    id: row.report_id, target: row.target_id, category: row.category, detail: row.detail,
    created: msOrNull(row.created, 'reports.created_at'), state: row.state,
    reviewed_at: msOrNull(row.reviewed, 'reports.reviewed_at'), outcome: row.outcome,
   }));
  },
 };

 /* --- durable outbox rows (API-owned kinds; the worker owns delivery) --- */
 const outbox = {
  async enqueue(row) {
   await q(
    'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (outbox_id) DO NOTHING',
    [row.id, row.payload === null || row.payload === undefined ? null : JSON.stringify(row.payload), row.kind, 'queued',
     iso(row.created, 'outbox.created_at'), iso(row.expires, 'outbox.expires_at'), iso(row.nextAt === undefined ? row.created : row.nextAt, 'outbox.next_at')]);
  },
 };

 /* --- coordinated-deletion intake. The API's grants on privacy are INSERT on `requests` and
  * SELECT/UPDATE on `reports` only (0020); the request STATE MACHINE and the permanent
  * `deletion_receipts` row belong to worker_runtime (0022). So the API records the request at
  * 'requested' and hands the rest over as a durable ops.outbox row - writing the worker-owned rows
  * from here would simply be denied, and widening the API's grants to "finish the job" would blur
  * the ownership register. --- */
 const deletion = {
  async insertRequest(row) {
   await q(
    'INSERT INTO privacy.requests (request_id, actor_id, kind, state, requested_at, updated_at, policy_version, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [row.id, row.actor, row.kind, row.state, iso(row.requestedAt, 'requests.requested_at'), iso(row.updatedAt, 'requests.updated_at'), row.policyVersion, row.note || '']);
  },
 };

 /* --- durable rate budgets (interim until managed Redis owns the ephemeral tier, P06) --- */
 const rate = {
  async count(bucketId) {
   const r = await q(
    'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, NULL)'
    + ' ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + 1 RETURNING hits', [bucketId]);
   return Number(r.rows[0].hits);
  },
 };

 return Object.freeze({
  accounts, profiles, identities, credentials, challenges, signin, sessions, saves, social, reports, outbox, deletion, rate,
  /* The shared logical-identity lock helper, so the service can serialize an absent-row identity
    * (a provider subject, an actor before its account row exists) on the SAME pinned transaction. */
  lockIdentity,
  SECRET_READ_FUNCTIONS,
 });
}

module.exports = { accountRepositoryFor, SECRET_READ_FUNCTIONS };
