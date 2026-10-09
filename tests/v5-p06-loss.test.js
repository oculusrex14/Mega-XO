'use strict';
/* P06 dependency-loss behaviour over COMMITTED PAID state (V5 P06, design Part D: "losing the
 * ephemeral tier may only make the system MORE conservative - never free an entrant, never grant,
 * never admit, never authenticate").
 *
 * WHY THIS FILE EXISTS. The existing P06 suites prove namespacing/TTL/bound fallbacks, cross-process
 * presence, and that a wipe leaves durable tables content-identical while every wallet in the fixture
 * is EMPTY. They do not prove the paid case: an ACTIVE RANKED match whose Coins are really reserved,
 * whose actors are really occupied, and whose entry fee must not be released (or permanently stuck)
 * by Redis loss; nor that a durable SENSITIVE admission budget still bounds repeated wrong attempts
 * while Redis is gone.
 *
 * WHAT IS EXERCISED
 *  1. A nonempty paid ranked match seeded through the real Core commands (`queue` + two `accept`s),
 *     so `match.matches.escrow`, `economy.wallets.reserved_coins` and `core.actor_occupancy` are
 *     genuinely populated. Durable state is snapshotted BEFORE the Redis namespace wipe and BEFORE a
 *     real adapter pointed at an unreachable endpoint, then read back with strong PostgreSQL reads:
 *     status/revision/escrow/symbols/deadline/participants/ratings/receipt are byte-identical, and
 *     the paid occupancy keeps refusing an incompatible active admission while Redis is gone. A lawful
 *     terminal outcome through the EXISTING domain path (`void`, operator-only) releases escrow and
 *     occupancy exactly once, and the entrant is admitted again afterwards - so "not stuck" is proven
 *     by a real release, never by leaving the occupancy in place forever.
 *  2. A synthetic verified store receipt (driven through the shipped commerce verifier seam, exactly
 *     like the existing P06 ephemera fixture) so a durable purchase receipt is part of the invariant.
 *  3. The persisted OTP invalid-attempt lockout across a namespace wipe, and the durable credential /
 *     ticket admission budgets with an unreachable adapter: repeated wrong attempts still hit the
 *     SAME approved persisted cap. These budgets stay in PostgreSQL (design 2.10 - one-use durable
 *     auth security is never moved to Redis) and this file never invents a cap: each boundary is the
 *     shipped constant (`policy.OTP_ATTEMPTS`, `tickets.IP_ISSUE_MAX`, the `email-continue` budget of
 *     10 in packages/services/accounts.js).
 *
 * WHAT IS NOT CLAIMED. No provider/store/device acceptance (the receipt verifier is SYNTHETIC and
 * labelled as such), no production or managed-endpoint mutation, no schema/field-type assertions, no
 * copies of service logic, no fake Redis and no fake Core. Only real guarded role pools, the real
 * checksummed migration chain, real services and real adapters; owned synthetic actors only.
 *
 * Harness: the frozen tests/v5-pg-lab.js disposable PG16 lab (loopback only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const policy = require('../packages/domain/account-policy.js');
const domain = require('../src/domain.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createCommerceService } = require('../packages/services/commerce.js');
const tickets = require('../packages/services/tickets.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const REDIS_GATE = HAVE_REDIS ? false : 'no REDIS_URL';
/* The real unreachable loopback endpoint (a genuine `present-but-down` dependency, shared with the
 * existing P06 child fixture). */
const DEAD_URL = 'redis://127.0.0.1:59999';
const PASSWORD = 'SyntheticPassw0rd';
const WRONG_PASSWORD = 'WrongPassw0rd9';
/* The shipped `email-continue` budget (packages/services/accounts.js: `rate(repositories, live.token,
 * 'email-continue', 10, 300)`). Cited, never invented: this file asserts the ACTUAL boundary. */
const EMAIL_CONTINUE_BUDGET = 10;

/* The managed endpoint may be `rediss://`; the plaintext opt-in is derived from the scheme and TLS
 * verification is never weakened with it. Each test owns a DISTINCT `keyVersion` namespace so its
 * wipe can only ever delete keys it created (isolated from the default `v1` fixture namespace and
 * from a concurrent sibling test's keys). */
const redisOptions = (keyVersion, url = REDIS_URL, extra = {}) => ({
  url,
  environment: 'test',
  keyVersion,
  allowPlaintext: !url.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
  ...extra,
});
/* A live adapter on the owned Redis: PING must answer, otherwise the "wipe" would be a no-op and the
 * test would be proving nothing. */
const ephemeraFor = async (keyVersion) => {
  const service = await createEphemeraService(redisOptions(keyVersion));
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');
  return service;
};
/* A real adapter against an unreachable endpoint: connect and every operation resolve to the
 * documented conservative fallback within the adapter's own deadline. */
const deadEphemeraFor = (keyVersion) => createEphemeraService(redisOptions(
  keyVersion, DEAD_URL, { socket: { connectTimeout: 400, reconnectStrategy: () => 60000 } },
));

/* ---------------------------------------------------------------- durable fixtures */

/* Content snapshot of the durable tables this slice must never disturb, read as canonically ordered
 * row JSON so the comparison is by CONTENT (never by count or physical order). */
const DURABLE_TABLES = Object.freeze([
  'economy.wallets', 'economy.ledger', 'economy.ratings', 'economy.system_burns',
  'economy.command_outcomes', 'economy.season_state', 'economy.wallet_operations',
  'core.actor_occupancy', 'match.matches', 'match.participants', 'match.move_outcomes',
  'monetization.receipts', 'ops.outbox',
  'identity.realtime_tickets', 'identity.email_challenges', 'identity.email_credential_versions',
]);
const durableSnapshot = async (database) => {
  const admin = await lab.adminClient(database);
  try {
    const snapshot = {};
    for (const table of DURABLE_TABLES) {
      const result = await admin.query(`SELECT row_to_json(t) AS record FROM ${table} t ORDER BY row_to_json(t)::text COLLATE "C"`);
      snapshot[table] = result.rows.map((row) => row.record);
    }
    return snapshot;
  } finally { await admin.end(); }
};
const digestOf = (snapshot) => crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

/* A credential row written by the trusted admin exactly as the importer would (the shipped legacy
 * unprefixed verifier, packages/domain/account-policy.js). Synthetic address, no provider claim. */
async function seedCredential(database, actor, email, password) {
  const salt = policy.passwordSalt();
  const hash = policy.passwordHash(password, salt);
  const c = await lab.adminClient(database);
  try {
    await c.query('INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [email, actor, salt, hash, new Date(lab.CLOCK - lab.DAY).toISOString(), new Date(lab.CLOCK - lab.DAY).toISOString()]);
  } finally { await c.end(); }
}

async function walletOf(database, actor) {
  const c = await lab.adminClient(database);
  try {
    const r = await c.query('SELECT coins, crowns, reserved_coins, reserved_crowns FROM economy.wallets WHERE actor_id = $1', [actor]);
    if (!r.rows[0]) return null;
    /* BIGINT columns arrive as strings from a raw pg client; the comparison is numeric. */
    const row = r.rows[0];
    return { coins: Number(row.coins), crowns: Number(row.crowns), reserved_coins: Number(row.reserved_coins), reserved_crowns: Number(row.reserved_crowns) };
  } finally { await c.end(); }
}
async function occupancyRows(database) {
  const c = await lab.adminClient(database);
  try {
    return (await c.query('SELECT actor_id, kind, ref_id FROM core.actor_occupancy ORDER BY actor_id')).rows;
  } finally { await c.end(); }
}

/* ================================================================ 1. paid occupancy survives loss */

test('P06 loss: a committed paid ranked match survives a namespace wipe and an unreachable adapter, keeps blocking incompatible admission, and releases exactly once through the existing domain path', { skip: REDIS_GATE }, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('p06losspaid');
  await lab.seedActors(database, lab.seedFor(['svc_alice', 'svc_bob', 'svc_carol']));

  /* The approved ranked queue quote for the fixture tier (gold), taken from the pure domain helper so
   * every expected amount in this test is DERIVED, never re-typed. */
  const quote = domain.quote({ mode: 'queue', from: 'gold', to: 'gold', rated: true });
  assert.equal(quote.rated, true, 'the ranked queue quote is a rated Coins quote');
  assert.ok(quote.pool > 0 && quote.contributions[0] > 0, 'the ranked queue quote is nonempty (paid)');

  const core = await lab.coreFor(database);
  /* SYNTHETIC STORE VERIFIER - NOT a store-acceptance claim. The shipped commerce flow is driven with
   * a synthetic receipt projection (the existing P06 ephemera fixture convention) so the real durable
   * receipt/wallet write happens while no provider, credential or production resource is contacted. */
  const commerce = await createCommerceService(lab.poolsFor(database).core, {
    now: () => lab.CLOCK, purchasesEnabled: true, eligible: () => true,
    verifyPurchase: async (evidence, actor) => ({
      valid: true, accountId: actor, store: evidence.store, transactionId: evidence.transactionId,
      productId: evidence.productId, refunded: false,
    }),
  });
  const live = await ephemeraFor('loss1');
  const dead = await deadEphemeraFor('loss1');
  const coreDead = await lab.coreFor(database, { ephemera: dead });
  const coreLive = await lab.coreFor(database, { ephemera: live });

  try {
    /* A real paid ranked match: a trusted matchmaker queue offer, accepted by BOTH seated players. */
    const offered = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'loss-queue',
      { type: 'queue', id: 'loss-match', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' });
    assert.equal(offered.status, 'OFFERED', 'the queue offer is created in PostgreSQL');
    await core.run({ actor: 'svc_alice', scope: 'player' }, 'loss-accept-a', { type: 'accept', id: 'loss-match', termsHash: offered.termsHash });
    const playing = await core.run({ actor: 'svc_bob', scope: 'player' }, 'loss-accept-b', { type: 'accept', id: 'loss-match', termsHash: offered.termsHash });
    assert.equal(playing.status, 'PLAYING', 'both accepts make the paid match run');

    /* A durable, nonempty synthetic verified receipt (real receipt + wallet write). */
    const grant = await commerce.purchase('svc_alice', 'loss-buy', { store: 'google', productId: 'crowns_100', transactionId: 'loss-tx-1', purchaseToken: 'synthetic-loss-token' });
    assert.equal(grant.crowns, 100, 'the synthetic receipt granted its catalogue Crowns');

    /* ---- durable snapshot BEFORE any loss ---- */
    const beforeView = await core.readMatch('svc_alice', 'loss-match');
    assert.equal(beforeView.status, 'PLAYING');
    assert.equal(Number(beforeView.escrow), quote.pool, 'the committed escrow is the quoted pool');
    assert.ok(Number.isFinite(beforeView.deadline), 'the running match has a real turn deadline');
    const aliceWallet = await walletOf(database, 'svc_alice');
    assert.equal(aliceWallet.coins, 1000 - quote.contributions[0], 'the entry fee left the available balance');
    assert.equal(aliceWallet.reserved_coins, quote.contributions[0], 'and is encumbered, not spent');
    assert.deepEqual(await occupancyRows(database), [
      { actor_id: 'svc_alice', kind: 'match', ref_id: 'loss-match' },
      { actor_id: 'svc_bob', kind: 'match', ref_id: 'loss-match' },
    ], 'both paid entrants hold a durable occupancy claim');
    assert.equal(Number(await lab.scalar(database, "SELECT rating FROM economy.ratings WHERE actor_id = 'svc_alice'")), 1500, 'fixture rank');
    assert.equal(Number(await lab.scalar(database, "SELECT count(*)::int FROM monetization.receipts WHERE store = 'google' AND transaction_id = 'loss-tx-1'")), 1, 'the synthetic receipt is durable');
    /* Membership is enforced on EVERY read, before and after loss. */
    await lab.throwsCode(core.readMatch('svc_carol', 'loss-match'), 'NOT_PARTICIPANT');
    await lab.throwsCode(core.readMatch('svc_alice', 'loss-nope'), 'UNKNOWN_MATCH');

    const before = digestOf(await durableSnapshot(database));

    /* ---- real namespace wipe: genuinely populated ephemeral state, then ALL of it removed ---- */
    await live.presenceTouch('svc_alice', 'loss-sess', true, 60000);
    await live.cacheSet('cache', 'loss-offer', 'ephemeral', 60000);
    await live.setHint('revoked', 'loss-hint', 60000);
    await live.enqueueCandidate('ranked', 'loss-ticket', 0, { windowMs: 600000, keyTtlMs: 600000 });
    const wiped = await live.wipeNamespace();
    assert.equal(wiped.available, true, 'the owned adapter reports its bounded wipe result');
    assert.ok(wiped.deleted >= 4, 'the wipe really deleted this namespace keys');
    assert.deepEqual((await live.presenceRead('svc_alice')).sessions, [], 'presence is gone after the wipe');
    assert.deepEqual((await live.peekCandidates('ranked')).candidates, [], 'the queue is gone after the wipe');

    /* ---- recovered strong read after the wipe ---- */
    assert.deepEqual(await core.readMatch('svc_alice', 'loss-match'), beforeView,
      'every durable match fact (status/revision/escrow/symbols/deadline/participants) is identical after the wipe');
    assert.equal(digestOf(await durableSnapshot(database)), before, 'the wipe mutates no durable content');

    /* ---- total dependency loss: a real adapter at an unreachable endpoint ---- */
    assert.equal((await dead.presenceRead('svc_alice')).available, false, 'the loss adapter is genuinely unreachable (conservative, not a fake success)');
    assert.deepEqual(await coreDead.readMatch('svc_alice', 'loss-match'), beforeView,
      'a down dependency changes no durable match fact');
    const stillReserved = await walletOf(database, 'svc_alice');
    assert.equal(stillReserved.reserved_coins, quote.contributions[0], 'the paid reservation is NOT freed by Redis loss');
    assert.equal(stillReserved.coins, 1000 - quote.contributions[0], 'nor is the fee refunded by Redis loss');
    assert.equal((await occupancyRows(database)).length, 2, 'paid occupancy survives Redis loss');
    /* Rank/identity/receipt facts are equally untouched (the digest above proves content equality for
     * economy.ratings / monetization.receipts; these are the explicit spot checks). */
    assert.equal(Number(await lab.scalar(database, "SELECT rating FROM economy.ratings WHERE actor_id = 'svc_alice'")), 1500, 'the competitive rank is unchanged by Redis loss');
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM monetization.receipts WHERE store = 'google' AND transaction_id = 'loss-tx-1' AND refunded = false"), 1, 'the synthetic receipt is unchanged by Redis loss');
    /* PAID OCCUPANCY STILL BLOCKS: an incompatible active admission is refused while Redis is gone,
     * through the existing ALREADY_IN_MATCH semantics (no new rule, no Redis involvement). */
    await lab.throwsCode(coreDead.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'loss-busy-queue',
      { type: 'queue', id: 'loss-busy', a: 'svc_alice', b: 'svc_carol', mode: 'ranked' }), 'ALREADY_IN_MATCH');
    await lab.throwsCode(coreDead.run({ actor: 'svc_alice', scope: 'player' }, 'loss-busy-offer',
      { type: 'offer', id: 'loss-busy-direct', opponent: 'svc_carol', terms: { kind: 'leaderboard', amount: 40 } }), 'ALREADY_IN_MATCH');
    assert.equal(digestOf(await durableSnapshot(database)), before, 'a refused admission writes nothing durable');
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM match.matches WHERE match_id IN ('loss-busy', 'loss-busy-direct')"), 0, 'the refused admissions created no match');

    /* ---- recovery: a live adapter again + strong reads still yield exactly the committed truth ---- */
    await live.presenceTouch('svc_alice', 'loss-sess-recovered', true, 60000);
    assert.deepEqual((await live.presenceRead('svc_alice')).sessions.map(session => session.ref), ['loss-sess-recovered'], 'the ephemeral tier self-heals');
    assert.deepEqual(await coreLive.readMatch('svc_alice', 'loss-match'), beforeView, 'recovery reads the same committed match');
    assert.equal(digestOf(await durableSnapshot(database)), before, 'the whole loss/recovery cycle wrote nothing durable');

    /* ---- lawful release EXACTLY ONCE through the existing domain path (operator `void`) ---- */
    const released = await core.run({ actor: 'operator', scope: 'operator' }, 'loss-void',
      { type: 'void', id: 'loss-match', reason: 'p06 dependency-loss fixture' });
    assert.equal(released.refunded, quote.pool, 'the void refunds the committed escrow');
    const afterRelease = await walletOf(database, 'svc_alice');
    assert.equal(afterRelease.coins, 1000, 'the released entry fee returns to the available balance');
    assert.equal(afterRelease.reserved_coins, 0, 'the encumbrance is released');
    assert.deepEqual(await occupancyRows(database), [], 'the lawful finish frees the paid occupancy');
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM economy.ledger WHERE entry_id = 'loss-match:refund:svc_alice'"), 1, 'the refund is journaled exactly once');

    /* A second terminal attempt is idempotent: the stored receipt is returned and NOTHING is refunded
     * twice - both for the SAME operation key (the stored-response replay path) and for a NEW key
     * (the domain's own already-settled no-op), which leaves no side effect to suppress. */
    const replayed = await core.run({ actor: 'operator', scope: 'operator' }, 'loss-void',
      { type: 'void', id: 'loss-match', reason: 'p06 dependency-loss fixture' });
    assert.deepEqual(replayed, released, 'a same-key replay returns the stored receipt');
    const replayedAgain = await core.run({ actor: 'operator', scope: 'operator' }, 'loss-void-again',
      { type: 'void', id: 'loss-match', reason: 'p06 dependency-loss fixture' });
    assert.deepEqual(replayedAgain, released, 'a new-key terminal command is the domain already-settled no-op');
    assert.deepEqual(await walletOf(database, 'svc_alice'), afterRelease, 'no second payout and no second release');
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM economy.ledger WHERE entry_id = 'loss-match:refund:svc_alice'"), 1, 'still exactly one refund entry');

    /* NOT STUCK: the same entrant is admitted again after the lawful release. */
    const next = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'loss-next',
      { type: 'queue', id: 'loss-next', a: 'svc_alice', b: 'svc_carol', mode: 'ranked' });
    assert.equal(next.status, 'OFFERED', 'the released entrant is admitted to a new queue offer');
    assert.deepEqual(await occupancyRows(database), [], 'an OFFERED match claims no occupancy yet');
  } finally {
    core.close(); coreDead.close(); coreLive.close();
    await commerce.close();
    await live.close();
    await dead.close();
  }
  await lab.closeDatabasePools(database);
});

/* ================================================================ 2. OTP lockout across a wipe */

test('P06 loss: persisted OTP invalid-attempt lockout is unaffected by a Redis namespace wipe (no unlimited retry, no changed cap)', { skip: REDIS_GATE }, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('p06lossotp');
  await lab.seedActors(database, lab.seedFor(['svc_alice']));
  await seedCredential(database, 'svc_alice', 'alice@loss-otp.test', PASSWORD);

  const live = await ephemeraFor('loss2');
  /* The auth service genuinely owns the adapter whose namespace is wiped below, so the throttle is
   * proven independent of ephemera - not merely tested with no adapter present. */
  const accounts = await lab.accountsFor(database, { ephemera: live });
  try {
    const anon = await accounts.issue();
    const reset = await accounts.emailResetStart(anon.token, 'alice@loss-otp.test');
    assert.ok(reset.challengeId, 'a known synthetic credential issues a real reset challenge');
    assert.ok(reset.delivery && reset.delivery.code, 'a known address gets a real code');

    /* Populate then wipe: the durable one-use auth state must survive an EMPTY ephemeral tier. */
    await live.presenceTouch('svc_alice', 'loss2-sess', true, 60000);
    await live.setHint('revoked', 'loss2-hint', 60000);
    const wiped = await live.wipeNamespace();
    assert.equal(wiped.available, true, 'the wipe reports its bounded result');
    assert.ok(wiped.deleted >= 2, 'the wipe really deleted this namespace keys');
    assert.deepEqual((await live.presenceRead('svc_alice')).sessions, [], 'the ephemeral tier is empty');
    assert.equal((await live.checkHint('revoked', 'loss2-hint')).present, false, 'the hint is gone');

    const wrongCode = reset.delivery.code === '000000' ? '000001' : '000000';
    const attemptsOf = () => lab.scalar(database, 'SELECT attempts FROM identity.email_challenges WHERE challenge_id = $1', [reset.challengeId]);

    /* The approved persisted attempt cap (policy.OTP_ATTEMPTS, never invented here). */
    for (let n = 0; n < policy.OTP_ATTEMPTS; n += 1) {
      await lab.throwsCode(accounts.emailVerify(anon.token, reset.challengeId, wrongCode), 'INVALID_OTP');
    }
    assert.equal(Number(await attemptsOf()), policy.OTP_ATTEMPTS, 'every wrong code persists a durable attempt');

    /* Wipe AGAIN between the cap and the over-cap attempt: Redis loss cannot reset the counter. */
    assert.equal((await live.wipeNamespace()).available, true, 'the second wipe also really ran');
    await lab.throwsCode(accounts.emailVerify(anon.token, reset.challengeId, reset.delivery.code), 'OTP_LOCKED');
    for (let n = 0; n < 3; n += 1) await lab.throwsCode(accounts.emailVerify(anon.token, reset.challengeId, wrongCode), 'OTP_LOCKED');
    assert.equal(Number(await attemptsOf()), policy.OTP_ATTEMPTS, 'a locked challenge never advances further - no unlimited retry');

    /* Nothing was granted: the challenge is unconsumed/unverified and the credential is unverified. */
    const challenge = await lab.adminClient(database);
    try {
      const row = (await challenge.query('SELECT attempts, consumed, verified_at FROM identity.email_challenges WHERE challenge_id = $1', [reset.challengeId])).rows[0];
      assert.equal(row.consumed, false, 'the locked challenge was never consumed');
      assert.equal(row.verified_at, null, 'and never verified');
    } finally { await challenge.end(); }
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM identity.sessions WHERE actor_id = 'svc_alice'"), 0, 'no wrong attempt ever granted a linked session');
    /* The seeded credential is untouched: no wrong attempt rotated or re-verified it. */
    assert.equal(await lab.scalar(database, "SELECT verified_at IS NOT NULL FROM identity.email_credentials WHERE actor_id = 'svc_alice'"), true, 'the durable credential keeps its original verification stamp');

    /* The durable one-time state is not silently replaced either (cooldown still applies). */
    await lab.throwsCode(accounts.emailResetStart(anon.token, 'alice@loss-otp.test'), 'OTP_COOLDOWN');
  } finally {
    await accounts.close();
    await live.close();
  }
  await lab.closeDatabasePools(database);
});

/* ================================================================ 3. durable admission budgets, Redis down */

test('P06 loss: with an unreachable adapter the durable credential-attempt and 60s ticket-issuance admission still cap at the approved limits', { skip: REDIS_GATE }, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('p06lossbudget');
  const ticketActors = Array.from({ length: tickets.IP_ISSUE_MAX }, (_, i) => `svc_loss_t${i}`);
  await lab.seedActors(database, [
    { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
    ...ticketActors.map((actor) => ({ actor, coins: 1000, crowns: 0, rating: 1500, games: 30, stats: 'friends' })),
  ]);
  await seedCredential(database, 'svc_alice', 'alice@loss-cred.test', PASSWORD);

  const dead = await deadEphemeraFor('loss3');
  /* The API service really holds an unreachable adapter: Redis loss must not weaken a durable
   * sensitive budget (design 2.10 keeps one-use auth security in PostgreSQL). */
  const accounts = await lab.accountsFor(database, { ephemera: dead });
  const issuer = await tickets.createTicketIssuer(lab.poolsFor(database).api, { now: () => lab.CLOCK, environment: 'test' });
  try {
    assert.equal((await dead.presenceRead('svc_alice')).available, false, 'the adapter is genuinely unreachable (conservative, not a fake success)');

    /* (a) Repeated wrong credentials hit the SHIPPED `email-continue` budget of 10, durably. */
    const anon = await accounts.issue();
    for (let n = 0; n < EMAIL_CONTINUE_BUDGET; n += 1) {
      await lab.throwsCode(accounts.emailContinue(anon.token, 'alice@loss-cred.test', WRONG_PASSWORD), 'INVALID_CREDENTIALS');
    }
    const bucket = async () => Number(await lab.scalar(database, 'SELECT hits FROM ops.rate_buckets WHERE bucket_id LIKE $1', ['email-continue:%']));
    assert.equal(await bucket(), EMAIL_CONTINUE_BUDGET, 'every denied attempt persists its durable budget spend in PostgreSQL');
    for (let n = 0; n < 3; n += 1) {
      await lab.throwsCode(accounts.emailContinue(anon.token, 'alice@loss-cred.test', WRONG_PASSWORD), 'RATE_LIMITED');
    }
    /* An over-budget call is refused inside its own preflight transaction, which rolls that
     * increment back with it (the shipped `rate()` throws before the transaction commits): the durable
     * count stays EXACTLY at the approved cap and no further retry can extend, reset or bypass it. */
    assert.equal(await bucket(), EMAIL_CONTINUE_BUDGET, 'the durable count stays at the approved cap value; retries are refused, never unlimited');
    assert.equal(await lab.scalar(database, "SELECT count(*)::int FROM identity.sessions WHERE actor_id = 'svc_alice'"), 0, 'no credential attempt ever granted a linked session');

    /* (b) The durable 60s ticket-issuance admission (tickets.IP_ISSUE_MAX per ipHash per window) is
     * unaffected by the lost Redis: the approved cap is reached, then the next issuance is refused. */
    const ipHash = crypto.createHash('sha256').update('p06-loss-ip').digest('hex');
    for (const actor of ticketActors) {
      const issued = await issuer.issue({ actor, sessionId: 'loss-ticket-session', generation: 1, connectionClass: 'game', ipHash });
      assert.ok(issued.ticket && issued.expiresAt > lab.CLOCK, 'each in-budget issuance is a real durable ticket');
    }
    await lab.throwsCode(
      issuer.issue({ actor: ticketActors[0], sessionId: 'loss-ticket-session', generation: 1, connectionClass: 'game', ipHash }),
      'TICKET_LIMIT');
    assert.equal(Number(await lab.scalar(database, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE issued_ip_hash = $1', [ipHash])), tickets.IP_ISSUE_MAX, 'the durable issuance count is exactly the approved admission cap');
  } finally {
    issuer.close();
    await accounts.close();
    await dead.close();
  }
  await lab.closeDatabasePools(database);
});
