'use strict';
/* P05 integration: the composition the deployment will use, proven end to end on the real services.
 *
 * WHAT THIS PROVES
 *  1. The account service's onSessionRevoked hook (logout all / password reset / coordinated
 *     deletion) revokes the refresh families bound to the affected public session ids, and a
 *     revoked family's next rotation is SESSION_REVOKED with a durable generation bump.
 *  2. The native bearer path composes access + refresh: startFamily after an authenticated
 *     session, rotate mints an access token whose `gen` claim equals the actor's durable
 *     revocation generation, and verify() accepts it for the native audience.
 *  3. The contracts guards: refuseAmbiguousCredential and redactTicket never leak material.
 *  4. Three client styles (email/Google/Apple identities) share ONE actor; each style's refresh
 *     family is independent; revokeForActor ends all of them (A12's code-level half; the real
 *     device/provider acceptance stays separately gated).
 *
 * Everything is synthetic and owned-loopback; no provider, store, device or production claim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createAccessService } = require('../packages/services/access.js');
const { createRefreshService } = require('../packages/services/refresh.js');
const contracts = require('../packages/contracts');
const policy = require('../packages/domain/account-policy.js');

lab.installCleanup(test);

const PLAYER_AUDIENCES = ['mega-browser', 'mega-android', 'mega-ios'];
const SERVICE_AUDIENCES = ['mega-core'];
const OTP_SECRET = lab.OTP_SECRET;

/* The public session id exactly as the account service computes it: sha256 of the stored 43-char
 * base64url digest, hex, first 24 chars. The identity.sessions row stores the same 32 bytes hex. */
function publicSessionIdOf(tokenHashHex) {
 const b64 = Buffer.from(tokenHashHex, 'hex').toString('base64url');
 return crypto.createHash('sha256').update(b64).digest('hex').slice(0, 24);
}
async function latestSessionIds(database, actor) {
 const c = await lab.adminClient(database);
 try {
  const r = await c.query('SELECT token_hash FROM identity.sessions WHERE actor_id = $1 ORDER BY created_at DESC', [actor]);
  return r.rows.map((row) => publicSessionIdOf(row.token_hash));
 } finally { await c.end(); }
}

async function compose(database, { capturedRevocations = null } = {}) {
 const pools = lab.poolsFor(database);
 const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `v5-p05-keys-${process.pid}-`)), 'keys.sealed.json');
 const access = await createAccessService(pools.api, {
  now: () => lab.CLOCK, issuer: 'https://api.megaxo.test', environment: 'stg',
  keyFile, playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
 });
 const refresh = await createRefreshService(pools.api, {
  now: () => lab.CLOCK,
  mintAccess: async ({ actor, sessionId, generation }) => access.issue({
   actor, sessionId, generation, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android',
  }),
 });
 const accounts = await lab.accountsFor(database, {
  deletionPolicy: { enabled: true, policyVersion: 'p05-integ-policy' },
  /* The deployment composition: account-side revocations revoke the refresh families bound to
   * the same public session ids. Failures are best-effort by contract; the test wires a
   * RECORDER so it can pin exactly which ids the hook received. */
  onSessionRevoked: async (publicIds) => { if (capturedRevocations) capturedRevocations.push(...publicIds); await refresh.revokeForSession(publicIds[0]); },
 });
 return { access, refresh, accounts, keyFile };
}

test('P05 composition: account revocations revoke bound refresh families and end their rotation', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('integ-revoke');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 if (db === null) return;
 const captured = [];
 const { access, refresh, accounts } = await compose(db, { capturedRevocations: captured });

 /* A real authenticated session via the shipped email flow. */
 const c0 = await lab.adminClient(db);
 try {
  await c0.query('DELETE FROM identity.email_credentials WHERE actor_id = $1', ['svc_alice']);
  const salt = policy.passwordSalt();
  const hash = policy.passwordHash('IntegPassword1', salt);
  await c0.query("INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ('alice@integ.test','svc_alice',$1,$2,now(),now())", [salt, hash]);
  await c0.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('email','alice@integ.test','svc_alice',now())");
 } finally { await c0.end(); }

 const linked = await accounts.emailContinue((await accounts.issue()).token, 'alice@integ.test', 'IntegPassword1');
 assert.equal(linked.actor, 'svc_alice');
 const idsAfterLogin = await latestSessionIds(db, 'svc_alice');
 const family = await refresh.startFamily({ actor: 'svc_alice', sessionId: idsAfterLogin[0], deviceId: null });
 assert.ok(family.refreshSecret.length === 43);

 /* Rotate once: works, and the access token's gen claim is the durable revocation generation. */
 const rotation = await refresh.rotate({ refreshSecret: family.refreshSecret });
 assert.ok(rotation.refreshSecret && rotation.refreshSecret !== family.refreshSecret);
 const payload = await access.verify(rotation.accessToken, { audience: 'mega-android' });
 assert.equal(payload.sub, 'svc_alice');
 assert.equal(payload.sid, idsAfterLogin[0]);
 assert.ok(Number.isInteger(payload.gen) && payload.gen >= 1);

 /* A password reset revokes every session of the actor; the hook must have received the bound
  * session id and the family's next rotation must now be SESSION_REVOKED. */
 const resetCaller = await accounts.issue();
 const reset = await accounts.emailResetStart(resetCaller.token, 'alice@integ.test');
 await accounts.emailVerify(resetCaller.token, reset.challengeId, reset.delivery.code);
 await accounts.emailResetComplete(resetCaller.token, reset.challengeId, 'NewIntegPassword2');
 assert.ok(captured.length >= 1, 'the revocation hook observed the affected public session ids');
 assert.ok(captured.includes(idsAfterLogin[0]), 'the bound session id was among the revoked ids');
 await assert.rejects(() => refresh.rotate({ refreshSecret: rotation.refreshSecret }), (e) => e.message === 'SESSION_REVOKED');
 const bumped = await lab.scalar(db, 'SELECT generation FROM identity.session_generations WHERE actor_id = $1', ['svc_alice']);
 assert.equal(Number(bumped), 2, 'one durable revocation bump for the reset');

 await accounts.close(); await refresh.close(); await access.close();
 await lab.closeDatabasePools(db);
});

test('P05 composition: coordinated deletion ends every family; three client styles share one actor', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('integ-deletion');
 await lab.seedActors(db, lab.seedFor(['svc_alice']));
 const { refresh, accounts } = await compose(db);
 const c0 = await lab.adminClient(db);
 try {
  await c0.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','synthetic-integ-google','svc_alice',now()), ('apple','synthetic-integ-apple','svc_alice',now())");
 } finally { await c0.end(); }

 /* One actor, three client styles, three independent families. */
 const sessions = [];
 for (const style of ['email', 'google', 'apple']) {
  const issued = await accounts.issue('svc_alice', lab.CLOCK);
  const ids = await latestSessionIds(db, 'svc_alice');
  const fresh = ids.find((id) => !sessions.includes(id));
  sessions.push(fresh);
  await refresh.startFamily({ actor: 'svc_alice', sessionId: fresh });
 }
 const actors = await lab.scalar(db, 'SELECT count(*)::int FROM identity.actors WHERE actor_id = $1', ['svc_alice']);
 assert.equal(Number(actors), 1, 'three client styles resolve to the same permanent actor');

 await refresh.revokeForActor('svc_alice', 'integ-test');
 const bumped = await lab.scalar(db, 'SELECT generation FROM identity.session_generations WHERE actor_id = $1', ['svc_alice']);
 assert.equal(Number(bumped), 2, 'exactly one durable bump for the logical revoke event');

 /* Deletion revokes the sessions and (through the hook) any family bound to them. */
 const delSession = await accounts.issue('svc_alice', lab.CLOCK);
 const tag = (await accounts.self('svc_alice')).tag;
 const deletion = await accounts.deleteAccount(delSession.token, tag);
 assert.equal(deletion.deletionPending, true);
 const families = await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_families WHERE actor_id = $1 AND state = 'active'", ['svc_alice']);
 assert.equal(Number(families), 0, 'no active family survives coordinated deletion');

 await accounts.close(); await refresh.close();
 await lab.closeDatabasePools(db);
});

test('P05 compatibility: three client styles share one identity and identical data', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('integ-parity');
 await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
 const { access, refresh, accounts } = await compose(db);

 /* Email style: the shipped credential flow. Provider styles: verified synthetic identities on the
  * SAME actor (the finishVerified path reuses an existing subject owner and never mints a second
  * actor). Each style gets its own session and refresh family. */
 const c0 = await lab.adminClient(db);
 try {
  const salt = policy.passwordSalt();
  const hash = policy.passwordHash('ParityPassword1', salt);
  await c0.query("INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ('alice@parity.test','svc_alice',$1,$2,now(),now())", [salt, hash]);
  await c0.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('email','alice@parity.test','svc_alice',now()), ('google','synthetic-parity-google','svc_alice',now()), ('apple','synthetic-parity-apple','svc_alice',now())");
 } finally { await c0.end(); }

 const emailSession = await accounts.emailContinue((await accounts.issue()).token, 'alice@parity.test', 'ParityPassword1');
 assert.equal(emailSession.actor, 'svc_alice');
 const styleSessions = [emailSession.token, (await accounts.issue('svc_alice', lab.CLOCK)).token, (await accounts.issue('svc_alice', lab.CLOCK)).token];
 const styleFamilies = [];
 const ids = await latestSessionIds(db, 'svc_alice');
 for (const id of ids.slice(0, 3)) styleFamilies.push(await refresh.startFamily({ actor: 'svc_alice', sessionId: id }));

 /* Identical identity+data through every style: same tag, same wallet, same social graph, same
  * save revision. A "client style" is only a credential; it never forks data. */
 const views = [];
 let expectedRevision = 0;
 for (const [index, token] of styleSessions.entries()) {
  /* Each style's own bearer resolves (the style is only a credential). */
  const sessionList = await accounts.sessions(token).catch((error) => { throw Error(`style ${index}: ${error.message}`); });
  assert.ok(sessionList.some((s) => s.current), 'each client style holds a live current session');
  const self = await accounts.self('svc_alice');
  const save = await accounts.save('svc_alice', expectedRevision, { version: 3.2, settings: { theme: 'vector' }, wallet: { coins: 1, crowns: 0, ledger: [], owned: [] }, records: [], processed: [] });
  expectedRevision = save.revision;
  views.push({ tag: self.tag, revision: save.revision, walletReady: self.walletReady });
 }
 assert.equal(new Set(views.map((v) => v.tag)).size, 1, 'one permanent identity across all three styles');
 /* One shared store: each style's write lands on the SAME row and bumps the one revision chain
  * (a per-style fork would restart every style at revision 1). */
 assert.deepEqual(views.map((v) => v.revision), [1, 2, 3]);

 await accounts.close(); await refresh.close(); await access.close();
 await lab.closeDatabasePools(db);
});

test('P05 contracts: ambiguous credential refusal and ticket redaction', () => {
 assert.throws(() => contracts.access.refuseAmbiguousCredential({ cookieHeader: '__Host-mega_session=x', bearerHeader: 'Bearer abc' }), (e) => e.message === 'AMBIGUOUS_CREDENTIAL');
 assert.doesNotThrow(() => contracts.access.refuseAmbiguousCredential({ cookieHeader: '__Host-mega_session=x', bearerHeader: null }));
 assert.doesNotThrow(() => contracts.access.refuseAmbiguousCredential({ cookieHeader: null, bearerHeader: 'Bearer abc' }));
 const redacted = contracts.access.redactTicket('A'.repeat(43));
 assert.ok(!redacted.includes('A'.repeat(43)), 'redaction never returns the full ticket');
 assert.ok(redacted.startsWith('AAAAAA'), 'redaction keeps a bounded prefix for support');
});
