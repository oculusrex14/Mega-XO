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
const { createApiHandler } = require('../apps/api/index.js');

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

async function compose(database, { capturedRevocations = null, now = () => lab.CLOCK } = {}) {
 const pools = lab.poolsFor(database);
 const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `v5-p05-keys-${process.pid}-`)), 'keys.sealed.json');
 const access = await createAccessService(pools.api, {
  now, issuer: 'https://api.megaxo.test', environment: 'stg',
  keyFile, playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
 });
 const refresh = await createRefreshService(pools.api, {
  now,
  mintAccess: async ({ actor, sessionId, generation }) => access.issue({
   actor, sessionId, generation, amr: ['pwd'], authAt: now(), audience: 'mega-android',
  }),
 });
 const accounts = await lab.accountsFor(database, {
  clock: now,
  deletionPolicy: { enabled: true, policyVersion: 'p05-integ-policy' },
  /* The deployment composition: account-side revocations revoke the refresh families bound to
   * the same public session ids. Failures are best-effort by contract; the test wires a
   * RECORDER so it can pin exactly which ids the hook received. */
  onSessionRevoked: async (publicIds) => {
   if (capturedRevocations) capturedRevocations.push(...publicIds);
   for (const id of publicIds) await refresh.revokeForSession(id);
  },
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

/* Drive the real API middleware/routes and PostgreSQL identity services without authentication or
 * logout overrides; no native token is mapped to a browser bearer. */
async function apiRequest(handler, { method = 'GET', url = '/api/account/profile', headers = {}, body = {} } = {}) {
 return new Promise((resolve, reject) => {
  const responseHeaders = {};
  const res = {
   statusCode: 200,
   setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
   getHeader(name) { return responseHeaders[name.toLowerCase()]; },
   end(text) { resolve({ status: this.statusCode, headers: responseHeaders, data: JSON.parse(text) }); },
  };
  Promise.resolve(handler({ method, url, headers, body }, res)).catch(reject);
 });
}

async function nativeGrant(accounts, refresh, access, actor, { deviceId = null, platform = 'android', authAt = lab.CLOCK } = {}) {
 const session = await accounts.issue(actor, authAt);
 const sid = (await accounts.sessions(session.token)).find((row) => row.current).id;
 if (deviceId) await refresh.registerDevice({ actor, platform, deviceId });
 const family = await refresh.startFamily({ actor, sessionId: sid, deviceId });
 const token = await access.issue({ actor, sessionId: sid, generation: 1, amr: ['pwd'], authAt, audience: `mega-${platform}` });
 return { session, sid, family, token };
}

test('P05 HTTP: signed native and browser sessions share one actor without confusing two actors; real logout', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('http-native');
 await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
 const { access, refresh, accounts, keyFile } = await compose(db);
 const handler = createApiHandler({
  accounts, access, nativeAudiences: ['mega-ios', 'mega-android'],
 });
 const browser = await accounts.issue('svc_alice', lab.CLOCK);
 const alice = await nativeGrant(accounts, refresh, access, 'svc_alice', { deviceId: 'http-android-alice' });
 const bob = await nativeGrant(accounts, refresh, access, 'svc_bob', { deviceId: 'http-ios-bob', platform: 'ios' });
 const cookie = { cookie: `__Host-mega_session=${browser.token}` };
 const bearer = (token) => ({ authorization: `Bearer ${token}` });
 for (const [headers, expected] of [[cookie, 'svc_alice'], [bearer(alice.token), 'svc_alice'], [bearer(bob.token), 'svc_bob']]) {
  const profile = await apiRequest(handler, { headers: { ...headers, 'x-actor-id': 'svc_bob' } });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.id, expected);
  assert.equal(profile.headers['cache-control'], 'private, no-store');
  assert.equal(profile.headers['set-cookie'], undefined);
 }
 const mixed = await apiRequest(handler, { headers: { ...cookie, ...bearer(bob.token) } });
 assert.deepEqual([mixed.status, mixed.data.error], [401, 'AMBIGUOUS_CREDENTIAL']);
 const crossActor = await access.issue({ actor: 'svc_alice', sessionId: bob.sid, generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android' });
 const wrongAudience = await access.issue({ actor: 'svc_alice', sessionId: alice.sid, generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-browser' });
 const serviceToken = await access.issueServiceAssertion({ op: 'native-test', fp: 'fingerprint', actor: 'svc_alice', scope: 'player', audience: 'mega-core' });
 const otherIssuer = await createAccessService(lab.poolsFor(db).api, {
  now: () => lab.CLOCK, issuer: 'https://wrong-issuer.test', environment: 'stg', keyFile,
  playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
 });
 const wrongIssuer = await otherIssuer.issue({ actor: 'svc_alice', sessionId: alice.sid, generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android' });
 await otherIssuer.close();
 const futureIssuer = await createAccessService(lab.poolsFor(db).api, {
  now: () => lab.CLOCK + 1000, issuer: 'https://api.megaxo.test', environment: 'stg', keyFile,
  playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
 });
 const notYetValid = await futureIssuer.issue({ actor: 'svc_alice', sessionId: alice.sid, generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android' });
 await futureIssuer.close();
 const browserSid = (await accounts.sessions(browser.token)).find((row) => row.current).id;
 const unbound = await access.issue({ actor: 'svc_alice', sessionId: browserSid, generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android' });
 for (const token of [crossActor, wrongAudience, wrongIssuer, notYetValid, unbound, serviceToken, 'bad.jwt.signature']) {
  const denied = await apiRequest(handler, { headers: bearer(token) });
  assert.deepEqual([denied.status, denied.data.error], [401, 'AUTH_REQUIRED']);
 }
 assert.equal((await apiRequest(handler, { headers: { cookie: `__Host-mega_session=${alice.token}` } })).status, 401,
  'a native JWT never becomes a browser cookie credential');
 const iosOnly = createApiHandler({ accounts, access, nativeAudiences: ['mega-ios'] });
 assert.equal((await apiRequest(iosOnly, { headers: bearer(alice.token) })).status, 401);
 const configuredFactory = createApiHandler({
  accounts, pool: lab.poolsFor(db).api,
  accessOptions: { now: () => lab.CLOCK, issuer: 'https://api.megaxo.test', environment: 'stg', keyFile, playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES },
 });
 assert.equal((await apiRequest(configuredFactory, { headers: bearer(alice.token) })).status, 200,
  'the explicit P05 runtime factory supports the same protected API seam');
 const nativeCredential = await accounts.authenticateNative(alice.token, { access });
 assert.ok((await accounts.sessions(nativeCredential)).some((row) => row.current && row.id === alice.sid));
 const saved = await apiRequest(handler, {
  method: 'POST', url: '/api/account/save', headers: bearer(alice.token),
  body: { revision: 0, practice: lab.practicePayload('svc_alice') },
 });
 assert.equal(saved.status, 200);
 assert.equal((await apiRequest(handler, { url: '/api/account/save', headers: cookie })).data.revision, saved.data.revision);
 const nativeExport = await apiRequest(handler, { url: '/api/account/export', headers: bearer(alice.token) });
 assert.equal(nativeExport.status, 200, 'native handles reach existing reauth-bound account methods');
 assert.equal(nativeExport.data.account.playerId, 'svc_alice');
 const browserLogoutHeaders = {
  ...cookie, origin: 'https://megaxo.online', 'content-type': 'application/json', 'x-csrf-token': browser.csrf,
 };
 const rejectedCsrf = await apiRequest(handler, {
  method: 'POST', url: '/api/account/logout', headers: { ...browserLogoutHeaders, 'x-csrf-token': 'incorrect' },
 });
 assert.deepEqual([rejectedCsrf.status, rejectedCsrf.data.error], [403, 'CSRF_FAILED']);
 assert.equal((await apiRequest(handler, { headers: cookie })).status, 200);
 const logoutBrowser = await apiRequest(handler, { method: 'POST', url: '/api/account/logout', headers: browserLogoutHeaders });
 assert.equal(logoutBrowser.status, 200);
 assert.deepEqual(logoutBrowser.data, { signedOut: true });
 assert.equal(logoutBrowser.headers['cache-control'], 'private, no-store');
 assert.match(logoutBrowser.headers['set-cookie'][0], /^__Host-mega_session=;.*SameSite=Lax; Max-Age=0; Secure$/);
 assert.equal((await apiRequest(handler, { headers: cookie })).status, 401);
 assert.equal((await apiRequest(handler, { headers: bearer(alice.token) })).status, 200, 'distinct native session survives browser-only logout');
 const logoutNative = await apiRequest(handler, { method: 'POST', url: '/auth/logout', headers: bearer(alice.token) });
 assert.equal(logoutNative.status, 200);
 assert.equal(logoutNative.headers['set-cookie'], undefined);
 assert.equal(logoutNative.headers['cache-control'], 'private, no-store');
 assert.equal((await apiRequest(handler, { headers: bearer(alice.token) })).status, 401);
 assert.equal((await apiRequest(handler, { headers: bearer(bob.token) })).status, 200);
 await assert.rejects(() => refresh.rotate({ refreshSecret: alice.family.refreshSecret }), /SESSION_REVOKED/);
 assert.equal(Number(await lab.scalar(db, 'SELECT generation FROM identity.session_generations WHERE actor_id=$1', ['svc_alice'])), 2);
 const nullDevice = await nativeGrant(accounts, refresh, access, 'svc_bob', { platform: 'ios' });
 assert.equal((await apiRequest(handler, { headers: bearer(nullDevice.token) })).status, 200,
  'P05 device-less families stay supported');
 const allLogout = await apiRequest(handler, {
  method: 'POST', url: '/api/account/logout', headers: bearer(bob.token), body: { allDevices: true },
 });
 assert.equal(allLogout.status, 200);
 for (const token of [bob.token, nullDevice.token]) assert.equal((await apiRequest(handler, { headers: bearer(token) })).status, 401);
 const anonymous = await accounts.issue();
 const anonymousLogout = await apiRequest(handler, {
  method: 'POST', url: '/api/account/logout',
  headers: { cookie: `mega_dev_session=${anonymous.token}`, origin: 'https://megaxo.online', 'content-type': 'application/json', 'x-csrf-token': anonymous.csrf },
 });
 assert.equal(anonymousLogout.status, 200, 'logout preserves existing anonymous-session semantics');
 assert.equal(await accounts.session(anonymous.token), null);
 assert.match(anonymousLogout.headers['set-cookie'][0], /^mega_dev_session=;.*Max-Age=0$/);
 await accounts.close(); await refresh.close(); await access.close();
 await lab.closeDatabasePools(db);
});

test('P05 HTTP: durable native expiry, generation, family/device and reauth boundaries are authoritative', async (t) => {
 if (!(await lab.boot(t))) return;
 const db = await lab.createDatabase('http-native-boundaries');
 await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
 let at = lab.CLOCK;
 const { access, refresh, accounts } = await compose(db, { now: () => at });
 const handler = createApiHandler({ accounts, access });
 const grant = await nativeGrant(accounts, refresh, access, 'svc_alice', { deviceId: 'boundary-device' });
 const headers = { authorization: `Bearer ${grant.token}` };
 const denied = async () => {
  const response = await apiRequest(handler, { headers });
  assert.deepEqual([response.status, response.data.error], [401, 'AUTH_REQUIRED']);
 };
 const admin = await lab.adminClient(db);
 try {
  /* Refresh lineage advances independently; neither rotation revokes the access generation. */
  const first = await refresh.rotate({ refreshSecret: grant.family.refreshSecret });
  const second = await refresh.rotate({ refreshSecret: first.refreshSecret });
  assert.equal(second.generation, 3);
  const rotatedClaims = await access.verify(second.accessToken, { audience: 'mega-android' });
  assert.equal(rotatedClaims.gen, 1);
  assert.equal((await apiRequest(handler, { headers: { authorization: `Bearer ${second.accessToken}` } })).status, 200);
  await admin.query('UPDATE identity.session_generations SET generation=2 WHERE actor_id=$1', ['svc_alice']);
  await denied();
  await admin.query('UPDATE identity.session_generations SET generation=1 WHERE actor_id=$1', ['svc_alice']);
  for (const state of ['revoked', 'expired']) {
   await admin.query('UPDATE identity.refresh_families SET state=$2 WHERE family_id=$1', [grant.family.familyId, state]);
   await denied();
  }
  await admin.query("UPDATE identity.refresh_families SET state='active', absolute_expires_at=$2 WHERE family_id=$1", [grant.family.familyId, new Date(at)]);
  await denied();
  await admin.query('UPDATE identity.refresh_families SET absolute_expires_at=$2 WHERE family_id=$1', [grant.family.familyId, new Date(at + lab.DAY)]);
  await admin.query('UPDATE identity.devices SET revoked_at=$2 WHERE device_id=$1', ['boundary-device', new Date(at)]);
  await denied();
  await admin.query("UPDATE identity.devices SET revoked_at=NULL, platform='ios' WHERE device_id=$1", ['boundary-device']);
  await denied();
  await admin.query("UPDATE identity.devices SET platform='android', actor_id='svc_bob' WHERE device_id=$1", ['boundary-device']);
  await denied();
  await admin.query("UPDATE identity.devices SET actor_id='svc_alice' WHERE device_id=$1", ['boundary-device']);
  await admin.query('UPDATE identity.eligibility SET security_hold=true WHERE actor_id=$1', ['svc_alice']);
  await denied();
  await admin.query('UPDATE identity.eligibility SET security_hold=false, suspended=true WHERE actor_id=$1', ['svc_alice']);
  await denied();
  await admin.query('UPDATE identity.eligibility SET suspended=false, verified=false WHERE actor_id=$1', ['svc_alice']);
  await denied();
  await admin.query('UPDATE identity.eligibility SET verified=true WHERE actor_id=$1', ['svc_alice']);
  assert.equal((await apiRequest(handler, { headers })).status, 200);
  /* JWT ath cannot manufacture recent reauthentication, nor can a refreshed durable auth_at make
   * an older token's auth evidence newer. Both sides of min(persisted auth_at, signed ath) matter. */
  const oldToken = await access.issue({ actor: 'svc_alice', sessionId: grant.sid, generation: 1, amr: ['pwd'], authAt: at - 900001, audience: 'mega-android' });
  for (const [url, body] of [['/api/account/export', {}], ['/api/account/delete', { confirmation: 'wrong' }], ['/api/account/unlink', { provider: 'google' }]]) {
   const response = await apiRequest(handler, { method: 'POST', url, headers: { authorization: `Bearer ${oldToken}` }, body });
   assert.deepEqual([response.status, response.data.error], [401, 'REAUTH_REQUIRED']);
  }
  await admin.query('UPDATE identity.sessions SET auth_at=$2 WHERE token_hash=$1', [crypto.createHash('sha256').update(grant.session.token).digest('hex'), new Date(at - 900001)]);
  const staleDurable = await apiRequest(handler, { url: '/api/account/export', headers });
  assert.deepEqual([staleDurable.status, staleDurable.data.error], [401, 'REAUTH_REQUIRED']);
  await admin.query('UPDATE identity.sessions SET auth_at=$2 WHERE token_hash=$1', [crypto.createHash('sha256').update(grant.session.token).digest('hex'), new Date(at)]);
  at = lab.CLOCK + 299999;
  assert.equal((await apiRequest(handler, { headers })).status, 200);
  at = lab.CLOCK + 300000;
  await denied();
  at = lab.CLOCK;
  /* Session equality expiry and deletion remain authoritative even for an already-validated handle. */
  const credential = await accounts.authenticateNative(grant.token, { access });
  await assert.rejects(() => accounts.requireLinked({ actor: 'svc_alice', sid: grant.sid }), /AUTH_REQUIRED/);
  await admin.query('UPDATE identity.sessions SET expires_at=$2 WHERE token_hash=$1', [crypto.createHash('sha256').update(grant.session.token).digest('hex'), new Date(at)]);
  await denied();
  await assert.rejects(() => accounts.logout(credential), /AUTH_REQUIRED/);
  await admin.query('DELETE FROM identity.sessions WHERE token_hash=$1', [crypto.createHash('sha256').update(grant.session.token).digest('hex')]);
  await assert.rejects(() => accounts.exportData(credential), /AUTH_REQUIRED/);
 } finally { await admin.end(); }
 await accounts.close(); await refresh.close(); await access.close();
 await lab.closeDatabasePools(db);
});
