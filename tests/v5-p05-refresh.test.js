/* tests/v5-p05-refresh.test.js - V5 P05 hashed refresh families, rotation and device revocation.
 *
 * WHAT THIS PROVES (docs/v5/designs/p05-session-design.md B3, risk R1)
 *   The REAL `createRefreshService` over a caller-owned GUARDED api_runtime pool against a schema
 *   built by the REAL checksummed 42-migration chain, driving the FROZEN rotation protocol:
 *     - normal rotation returns a NEW secret exactly once, marks the presented row 'rotated' with a
 *       grace window, and derives the successor by HKDF-SHA256(secret, 'mx:refresh:'+familyId,
 *       'successor') - never a fresh random credential;
 *     - two parallel rotations of the same secret have exactly ONE winner; the loser's retry inside
 *       the grace window recovers the SAME committed successor, and the reuse is bounded;
 *     - the 4th in-grace retry and a post-grace retry are TRUE replay: family revoked, the durable
 *       session generation bumped, an ops.outbox security notice in the SAME transaction, and
 *       SESSION_REVOKED;
 *     - a two-generations-old secret is replay; a malformed secret is refused before any database
 *       access and an unknown secret revokes nothing;
 *     - revokeForActor / revokeForSession / revokeDevice revoke families and bump the generation
 *       exactly once per logical event;
 *     - mintAccess receives the actor's CURRENT durable revocation generation (not the family
 *       lineage generation), and an absolute-expired family refuses with REFRESH_EXPIRED;
 *     - the database never contains a raw secret, only its sha256 hex.
 *
 * Harness: tests/v5-pg-lab.js only - the frozen disposable PG16 contract. V5_PG_URL + V5_PG_DISPOSABLE=1
 * is a loopback synthetic cluster the lab owns; V5_PG_REQUIRED=1 fails instead of skipping.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lab = require('./v5-pg-lab.js');
const { createRefreshService } = require('../packages/services/refresh.js');

lab.installCleanup(test);

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
/* The frozen successor derivation, recomputed independently of the service. */
const derive = (secret, familyId) => Buffer.from(crypto.hkdfSync(
 'sha256', Buffer.from(secret, 'base64url'), Buffer.from('mx:refresh:' + familyId), Buffer.from('successor'), 32)).toString('base64url');

async function rows(db, text, params = []) {
 const c = await lab.adminClient(db);
 try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

/* A directly inserted live session row; its public session id IS the stored sha256 hex of the
 * bearer (the same value core.actor_access_state exposes, design B3.1/C3). */
async function makeSession(db, actor, at) {
 const bearer = crypto.randomBytes(32).toString('base64url');
 const c = await lab.adminClient(db);
 try {
  await c.query('INSERT INTO identity.sessions (token_hash, actor_id, csrf, created_at, expires_at, auth_at) VALUES ($1, $2, $3, $4, $5, $6)',
   [HEX(bearer), actor, crypto.randomBytes(24).toString('base64url'), new Date(at).toISOString(), new Date(at + 14 * lab.DAY).toISOString(), new Date(at).toISOString()]);
 } finally { await c.end(); }
 return HEX(bearer);
}

/* A service whose only Core-owned effect (the access mint) is a genuine awaited callback, plus a
 * mutable clock so a test can cross the grace window. */
async function serviceFor(db, { ttl, grace, reuse } = {}) {
 const mints = [];
 const pool = lab.poolsFor(db).api;
 const options = {
  now: () => serviceFor.clock,
  mintAccess: async ({ actor, sessionId, generation }) => { mints.push({ actor, sessionId, generation }); return `access:${actor}:${generation}:${crypto.randomUUID()}`; },
 };
 if (ttl !== undefined) options.absoluteTtlMs = ttl;
 if (grace !== undefined) options.graceMs = grace;
 if (reuse !== undefined) options.maxGraceReuse = reuse;
 const service = await createRefreshService(pool, options);
 return { service, mints };
}
serviceFor.clock = lab.CLOCK;

const num = (value) => (value === null || value === undefined ? null : Number(value));
const familyState = (db, familyId) => rows(db, 'SELECT state, generation, reused_in_grace, revoke_reason, revoked_at FROM identity.refresh_families WHERE family_id = $1', [familyId])
 .then((r) => (r[0] ? { ...r[0], generation: num(r[0].generation), reused_in_grace: num(r[0].reused_in_grace) } : r[0]));
const tokenState = (db, secret) => rows(db, 'SELECT generation, state, (extract(epoch from rotate_at) * 1000)::bigint AS rotate_ms, (extract(epoch from grace_until) * 1000)::bigint AS grace_ms FROM identity.refresh_tokens WHERE token_hash = $1', [HEX(secret)])
 .then((r) => (r[0] ? { ...r[0], generation: num(r[0].generation), rotate_ms: num(r[0].rotate_ms), grace_ms: num(r[0].grace_ms) } : r[0]));
const actorGen = (db, actor) => lab.scalar(db, 'SELECT generation FROM identity.session_generations WHERE actor_id = $1', [actor]).then(num);

/* ---------------------------------------------------------------------------- */

test('P05 refresh: normal rotation mints a new secret once, marks the old rotated and stores only the hash', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_normal');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const { service, mints } = await serviceFor(db);
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);

 const started = await service.startFamily({ actor: 'svc_alice', sessionId });
 assert.match(started.familyId, /^rf_/);
 assert.equal(started.refreshSecret.length, 43);
 assert.equal(started.expiresAt, lab.CLOCK + 14 * lab.DAY);
 const first = await familyState(db, started.familyId);
 assert.deepEqual({ state: first.state, generation: Number(first.generation), reused: Number(first.reused_in_grace) }, { state: 'active', generation: 1, reused: 0 });
 const firstTok = await tokenState(db, started.refreshSecret);
 assert.deepEqual({ gen: Number(firstTok.generation), state: firstTok.state }, { gen: 1, state: 'active' });
 assert.equal(await actorGen(db, 'svc_alice'), 1);

 const rotated = await service.rotate({ refreshSecret: started.refreshSecret });
 assert.notEqual(rotated.refreshSecret, started.refreshSecret);
 assert.equal(rotated.refreshSecret, derive(started.refreshSecret, started.familyId)); // frozen derivation, not a fresh random
 assert.equal(rotated.familyId, started.familyId);
 assert.equal(rotated.generation, 2);
 assert.match(rotated.accessToken, /^access:svc_alice:1:/);
 assert.deepEqual(mints, [{ actor: 'svc_alice', sessionId, generation: 1 }]);

 const old = await tokenState(db, started.refreshSecret);
 assert.equal(old.state, 'rotated');
 assert.equal(Number(old.rotate_ms), lab.CLOCK);
 assert.equal(Number(old.grace_ms), lab.CLOCK + 10000);
 const fresh = await tokenState(db, rotated.refreshSecret);
 assert.deepEqual({ gen: Number(fresh.generation), state: fresh.state }, { gen: 2, state: 'active' });
 const fam = await familyState(db, started.familyId);
 assert.equal(Number(fam.generation), 2);
 assert.equal(Number(fam.reused_in_grace), 0);

 /* The database stores the hash and never the raw secret (in any string column). */
 for (const secret of [started.refreshSecret, rotated.refreshSecret]) {
  assert.match(HEX(secret), /^[0-9a-f]{64}$/);
  assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.refresh_tokens WHERE token_hash = $1', [secret]), 0);
  assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.refresh_families WHERE family_id = $1 OR session_id = $1', [secret]), 0);
  assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.refresh_tokens WHERE token_hash = $1', [HEX(secret)]), 1);
 }
 await service.close();
});

test('P05 refresh: two parallel rotations with the same secret have one winner and a bounded retry', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_parallel');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const { service } = await serviceFor(db);
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);
 const { familyId, refreshSecret } = await service.startFamily({ actor: 'svc_alice', sessionId });

 /* Two genuinely concurrent rotations of the SAME presented secret: the family row lock is the
  * only serializer, so exactly one commits the normal transition and the other recovers it. */
 const [a, b] = await Promise.all([service.rotate({ refreshSecret }), service.rotate({ refreshSecret })]);
 assert.equal(a.refreshSecret, b.refreshSecret);
 assert.equal(a.refreshSecret, derive(refreshSecret, familyId));
 assert.equal(a.generation, 2);
 assert.equal(b.generation, 2);
 assert.equal(Number(await lab.scalar(db, 'SELECT generation FROM identity.refresh_families WHERE family_id = $1', [familyId])), 2);
 /* Exactly one ACTIVE current row and one 'rotated' presented row - never two successors. */
 assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_tokens WHERE family_id = $1 AND state = 'active'", [familyId]), 1);
 assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_tokens WHERE family_id = $1 AND state = 'rotated'", [familyId]), 1);
 assert.equal(Number((await familyState(db, familyId)).reused_in_grace), 1);

 /* The legitimate retry is BOUNDED: retries 2 and 3 succeed with the same successor, the 4th use
  * of the presented secret (cap 3 reached) is replay. */
 for (let reuse = 2; reuse <= 3; reuse += 1) {
  const again = await service.rotate({ refreshSecret });
  assert.equal(again.refreshSecret, a.refreshSecret);
  assert.equal(Number((await familyState(db, familyId)).reused_in_grace), reuse);
 }
 await lab.throwsCode(service.rotate({ refreshSecret }), 'SESSION_REVOKED');
 assert.equal((await familyState(db, familyId)).state, 'revoked');
 await service.close();
});

test('P05 refresh: the 4th in-grace retry and a post-grace retry revoke the family, bump the generation and notify', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_replay');
 await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
 serviceFor.clock = lab.CLOCK;
 const { service } = await serviceFor(db);

 /* (a) 4th in-grace retry: winner + retries 1..3 succeed, the 4th retry is replay. */
 const aliceSession = await makeSession(db, 'svc_alice', lab.CLOCK);
 const a = await service.startFamily({ actor: 'svc_alice', sessionId: aliceSession });
 const won = await service.rotate({ refreshSecret: a.refreshSecret });
 for (let i = 0; i < 3; i += 1) assert.equal((await service.rotate({ refreshSecret: a.refreshSecret })).refreshSecret, won.refreshSecret);
 assert.equal(Number((await familyState(db, a.familyId)).reused_in_grace), 3);
 await lab.throwsCode(service.rotate({ refreshSecret: a.refreshSecret }), 'SESSION_REVOKED');
 const revokedA = await familyState(db, a.familyId);
 assert.equal(revokedA.state, 'revoked');
 assert.equal(revokedA.revoke_reason, 'replay');
 assert.ok(revokedA.revoked_at !== null);
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.refresh_tokens WHERE family_id = $1 AND state = $2', [a.familyId, 'active']), 0);
 assert.equal(await actorGen(db, 'svc_alice'), 2);
 const noticeA = await rows(db, "SELECT outbox_id, kind FROM ops.outbox WHERE kind = 'security.refresh-replay' AND outbox_id = $1", [`security.refresh-replay:${a.familyId}`]);
 assert.equal(noticeA.length, 1);

 /* (b) post-grace retry: the grace window has passed, so the same presented secret is replay. */
 const bobSession = await makeSession(db, 'svc_bob', lab.CLOCK);
 const b = await service.startFamily({ actor: 'svc_bob', sessionId: bobSession });
 await service.rotate({ refreshSecret: b.refreshSecret });
 serviceFor.clock = lab.CLOCK + 10001;
 await lab.throwsCode(service.rotate({ refreshSecret: b.refreshSecret }), 'SESSION_REVOKED');
 assert.equal((await familyState(db, b.familyId)).state, 'revoked');
 assert.equal((await familyState(db, b.familyId)).revoke_reason, 'replay');
 assert.equal(await actorGen(db, 'svc_bob'), 2);
 await service.close();
});

test('P05 refresh: replaying a two-generations-old secret is refused', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_old');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const { service } = await serviceFor(db);
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);
 const { familyId, refreshSecret } = await service.startFamily({ actor: 'svc_alice', sessionId });
 const second = (await service.rotate({ refreshSecret })).refreshSecret;
 await service.rotate({ refreshSecret: second }); // family is now at generation 3

 await lab.throwsCode(service.rotate({ refreshSecret }), 'SESSION_REVOKED');
 assert.equal((await familyState(db, familyId)).state, 'revoked');
 assert.equal((await familyState(db, familyId)).revoke_reason, 'replay');
 assert.equal(await actorGen(db, 'svc_alice'), 2);
 await service.close();
});

test('P05 refresh: revokeForActor, revokeForSession and revokeDevice revoke families and bump the generation exactly once', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_revoke');
 await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_carol']));
 serviceFor.clock = lab.CLOCK;
 const { service } = await serviceFor(db);

 /* Two active families for one actor; revokeForActor is ONE logical event. */
 const sessionA = await makeSession(db, 'svc_alice', lab.CLOCK);
 const one = await service.startFamily({ actor: 'svc_alice', sessionId: sessionA });
 const two = await service.startFamily({ actor: 'svc_alice', sessionId: sessionA });
 const first = await service.revokeForActor('svc_alice', 'logout-all');
 assert.equal(first.revoked, 2);
 assert.equal((await familyState(db, one.familyId)).state, 'revoked');
 assert.equal((await familyState(db, two.familyId)).state, 'revoked');
 assert.equal((await familyState(db, one.familyId)).revoke_reason, 'logout-all');
 assert.equal(await actorGen(db, 'svc_alice'), 2);
 await lab.throwsCode(service.rotate({ refreshSecret: one.refreshSecret }), 'SESSION_REVOKED');
 /* A repeat matches no active family: nothing revoked, the counter does not advance again. */
 assert.equal((await service.revokeForActor('svc_alice', 'logout-all')).revoked, 0);
 assert.equal(await actorGen(db, 'svc_alice'), 2);

 /* revokeForSession binds by public session id. */
 const sessionC = await makeSession(db, 'svc_carol', lab.CLOCK);
 const bySession = await service.startFamily({ actor: 'svc_carol', sessionId: sessionC });
 assert.equal((await service.revokeForSession(sessionC)).revoked, 1);
 assert.equal((await familyState(db, bySession.familyId)).revoke_reason, 'session-revoked');
 await lab.throwsCode(service.rotate({ refreshSecret: bySession.refreshSecret }), 'SESSION_REVOKED');
 assert.equal(await actorGen(db, 'svc_carol'), 2);

 /* revokeDevice revokes only that device's families. */
 const deviceId = 'device-android-1';
 await service.registerDevice({ actor: 'svc_alice', platform: 'android', label: 'Pixel', deviceId });
 const onDevice = await service.startFamily({ actor: 'svc_alice', sessionId: sessionA, deviceId });
 const otherDevice = await service.startFamily({ actor: 'svc_alice', sessionId: sessionA, deviceId: 'device-android-2' });
 const deviceRevoke = await service.revokeDevice('svc_alice', deviceId);
 assert.equal(deviceRevoke.revoked, 1);
 assert.equal((await familyState(db, onDevice.familyId)).revoke_reason, 'device-revoked');
 assert.equal((await familyState(db, otherDevice.familyId)).state, 'active');
 assert.ok((await rows(db, 'SELECT revoked_at FROM identity.devices WHERE device_id = $1', [deviceId]))[0].revoked_at !== null);
 /* svc_alice was already bumped to 2 by the earlier actor revoke; this is ONE further event. */
 assert.equal(await actorGen(db, 'svc_alice'), 3);
 await lab.throwsCode(service.rotate({ refreshSecret: onDevice.refreshSecret }), 'SESSION_REVOKED');
 await service.close();
});

test('P05 refresh: an access token is minted against the actor current revocation generation', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_gen');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const { service, mints } = await serviceFor(db);
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);

 /* A prior revocation bumps the durable counter to 2; a later rotation must carry gen 2 in the
  * access token even though the family's own lineage starts again at generation 2. */
 await service.startFamily({ actor: 'svc_alice', sessionId });
 await service.revokeForActor('svc_alice', 'password-reset');
 assert.equal(await actorGen(db, 'svc_alice'), 2);
 const fresh = await service.startFamily({ actor: 'svc_alice', sessionId });
 const rotated = await service.rotate({ refreshSecret: fresh.refreshSecret });
 assert.equal(rotated.generation, 2);
 assert.deepEqual(mints, [{ actor: 'svc_alice', sessionId, generation: 2 }]);
 assert.match(rotated.accessToken, /^access:svc_alice:2:/);
 await service.close();
});

test('P05 refresh: an absolute-expired family refuses with REFRESH_EXPIRED', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_expiry');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const { service } = await serviceFor(db, { ttl: 60000 });
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);
 const { familyId, refreshSecret } = await service.startFamily({ actor: 'svc_alice', sessionId });
 serviceFor.clock = lab.CLOCK + 60001;
 await lab.throwsCode(service.rotate({ refreshSecret }), 'REFRESH_EXPIRED');
 assert.equal((await familyState(db, familyId)).state, 'expired');
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.session_generations WHERE actor_id = $1', ['svc_alice']), 1); // no revocation bump
 await service.close();
});

test('P05 refresh: a malformed secret is refused before any database access and an unknown secret revokes nothing', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('refresh_guard');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 serviceFor.clock = lab.CLOCK;
 const inner = lab.poolsFor(db).api;
 const state = { calls: 0 };
 const counting = { describe: () => inner.describe(), withTransaction: (...args) => { state.calls += 1; return inner.withTransaction(...args); } };
 const service = await createRefreshService(counting, {
  now: () => serviceFor.clock,
  mintAccess: async () => 'access',
 });
 const sessionId = await makeSession(db, 'svc_alice', lab.CLOCK);
 const { familyId, refreshSecret } = await service.startFamily({ actor: 'svc_alice', sessionId });

 state.calls = 0;
 await lab.throwsCode(service.rotate({ refreshSecret: 'not-a-32-byte-secret' }), 'INVALID_REFRESH');
 assert.equal(state.calls, 0, 'a malformed secret must be refused before the pool is touched');
 await lab.throwsCode(service.rotate({ refreshSecret: crypto.randomBytes(31).toString('base64url') }), 'INVALID_REFRESH');
 assert.equal(state.calls, 0);

 /* A well-formed but unknown secret revokes nothing and leaves the family untouched. */
 await lab.throwsCode(service.rotate({ refreshSecret: crypto.randomBytes(32).toString('base64url') }), 'SESSION_REVOKED');
 const fam = await familyState(db, familyId);
 assert.deepEqual({ state: fam.state, generation: Number(fam.generation) }, { state: 'active', generation: 1 });
 assert.equal((await tokenState(db, refreshSecret)).state, 'active');
 assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM ops.outbox WHERE kind = 'security.refresh-replay'"), 0);
 assert.equal(await lab.scalar(db, 'SELECT count(*)::int FROM identity.session_generations WHERE actor_id = $1', ['svc_alice']), 1);
 await service.close();
});
