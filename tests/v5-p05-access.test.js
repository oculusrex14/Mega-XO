/* tests/v5-p05-access.test.js - V5 P05 Ed25519 access-signing acceptance.
 *
 * WHAT THIS PROVES
 *   The REAL createAccessService over caller-owned GUARDED pools (api_runtime) against a schema built
 *   by the REAL checksummed migration chain. Private keys live only in a sealed operator file; the
 *   database stores public JWK + custody reference + thumbprint; tokens carry EXACTLY the frozen
 *   minimal claim set and the frozen TTLs; player and service audiences are disjoint; rotation keeps
 *   the retiring key verifiable until it is retired; the public JWKS is bounded and public-only.
 *
 * Harness: the frozen tests/v5-pg-lab.js disposable PG16 lab (loopback only, synthetic actors).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lab = require('./v5-pg-lab.js');

lab.installCleanup(test);
test.after(() => { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); });

const ISSUER = 'https://api.megaxo.online';
const PLAYER_AUDIENCES = ['mega-browser', 'mega-android', 'mega-ios'];
const SERVICE_AUDIENCES = ['mega-core'];
const KID = /^mxv5-stg-\d{4}Q[1-4]-\d+-[0-9a-f]{2}$/;
const CLAIMS = ['amr', 'ath', 'aud', 'exp', 'gen', 'iat', 'iss', 'jti', 'nbf', 'sid', 'sub'];

let TMP = null;
const keyFiles = new Map();
const databases = new Map();

function tmpDir() {
 if (!TMP) TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-p05-access-'));
 return TMP;
}
function keyFileFor(family) {
 if (!keyFiles.has(family)) keyFiles.set(family, path.join(tmpDir(), `${family}.keys.json`));
 return keyFiles.get(family);
}
async function databaseFor(family) {
 if (!databases.has(family)) {
  const name = await lab.createDatabase(family);
  await lab.seedActors(name, lab.seedFor(['svc_alice', 'svc_bob']));
  databases.set(family, name);
 }
 return databases.get(family);
}

let nowMs = lab.CLOCK;
const clock = () => nowMs;

async function accessFor(family, overrides = {}) {
 const { createAccessService } = require('../packages/services/access.js');
 const database = await databaseFor(family);
 return createAccessService(lab.poolsFor(database).api, {
  now: clock,
  issuer: ISSUER,
  environment: 'stg',
  keyFile: keyFileFor(family),
  playerAudiences: PLAYER_AUDIENCES,
  serviceAudiences: SERVICE_AUDIENCES,
  ...overrides,
 });
}

const b64uJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeSegment = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
const decode = (token) => {
 const [h, p] = token.split('.');
 return { header: decodeSegment(h), payload: decodeSegment(p) };
};

/* Test-owned raw signer: the sealed file is read to forge a VALIDLY SIGNED token carrying a selected
 * claim/header, so wrong-issuer / expired / unknown-kid cases are isolated from signature failure. */
function signRaw(keyFile, kid, header, payload) {
 const map = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
 const pem = map[kid];
 assert.ok(pem, `sealed key file must contain ${kid}`);
 const input = `${b64uJson(header)}.${b64uJson(payload)}`;
 const signature = crypto.sign(null, Buffer.from(input), crypto.createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' }));
 return `${input}.${signature.toString('base64url')}`;
}
function sealedKids(keyFile) {
 const map = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
 return Object.keys(map);
}
async function keyRows(database) {
 const c = await lab.adminClient(database);
 try {
  const r = await c.query('SELECT kid, environment, algorithm, state, public_jwk, private_ref, thumbprint, retire_at FROM identity.signing_keys ORDER BY created_at');
  return r.rows;
 } finally { await c.end(); }
}
const codeIs = (code) => (e) => e.message === code;

/* ======================================================== 1. ISSUED CLAIM SET */

test('P05 access: issued token carries exactly the frozen claim set, kid grammar and TTLs', async (t) => {
 if (!(await lab.boot(t))) return;
 nowMs = lab.CLOCK;
 const database = await databaseFor('main');
 const access = await accessFor('main');
 try {
  const token = await access.issue({ actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-browser' });
  const { header, payload } = decode(token);

  assert.equal(header.alg, 'EdDSA');
  assert.equal(header.typ, 'JWT');
  assert.match(header.kid, KID, 'kid follows mxv5-<env>-<yyyyqq>-<seq>-<crc8>');
  assert.deepEqual(Object.keys(header).sort(), ['alg', 'kid', 'typ']);

  assert.deepEqual(Object.keys(payload).sort(), CLAIMS, 'the issued claim set is EXACTLY the frozen set');
  for (const forbidden of ['wallet', 'coins', 'balance', 'rank', 'rating', 'role', 'entitlements', 'scope', 'provider', 'subject', 'email']) {
   assert.equal(Object.prototype.hasOwnProperty.call(payload, forbidden), false, `a token never carries ${forbidden}`);
  }
  assert.equal(payload.iss, ISSUER);
  assert.equal(payload.aud, 'mega-browser');
  assert.equal(payload.sub, 'svc_alice');
  assert.equal(payload.sid, 'a'.repeat(24));
  assert.equal(payload.gen, 1);
  assert.deepEqual(payload.amr, ['pwd']);
  assert.equal(payload.ath, Math.floor(lab.CLOCK / 1000));
  assert.equal(payload.nbf, payload.iat);
  assert.equal(payload.exp - payload.iat, 300, 'access token TTL is 300 s');
  assert.match(payload.jti, /^[0-9a-f-]{36}$/);

  const verified = await access.verify(token, { audience: 'mega-browser' });
  assert.deepEqual(Object.keys(verified).sort(), CLAIMS);
  assert.equal(verified.sub, 'svc_alice');

  const assertion = await access.issueServiceAssertion({ op: 'op-1', fp: 'fp-1', actor: 'svc_alice', scope: 'command:player', audience: 'mega-core' });
  const claims = decode(assertion).payload;
  assert.equal(claims.sub, 'service:api_runtime');
  assert.equal(claims.exp - claims.iat, 15, 'service assertion TTL is 15 s');
  assert.equal(claims.aud, 'mega-core');
  assert.equal(claims.op, 'op-1');

  /* The kid's crc8 is a checksum of the public JWK thumbprint, and seq is per-environment. */
  const rows = await keyRows(database);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].algorithm, 'EdDSA');
  assert.equal(rows[0].state, 'active');
  assert.equal(rows[0].environment, 'stg');
  assert.equal(rows[0].private_ref, keyFileFor('main'));
  assert.deepEqual(rows[0].public_jwk, { kty: 'OKP', crv: 'Ed25519', x: rows[0].public_jwk.x });
  assert.equal(rows[0].kid.slice(-2), require('../packages/services/access.js').crc8Hex(rows[0].thumbprint));
 } finally { access.close(); }
});

/* ================================================ 2. VERIFICATION REJECTIONS */

test('P05 access: verification rejects wrong audience/issuer/alg, unknown kid, malformed and stale tokens', async (t) => {
 if (!(await lab.boot(t))) return;
 await databaseFor('main');
 const access = await accessFor('main');
 try {
  const kid = sealedKids(keyFileFor('main'))[0];
  const base = { iss: ISSUER, aud: 'mega-browser', sub: 'svc_alice', sid: 'a'.repeat(24), gen: 1, amr: ['pwd'], ath: 0, iat: Math.floor(lab.CLOCK / 1000), nbf: Math.floor(lab.CLOCK / 1000), exp: Math.floor(lab.CLOCK / 1000) + 300, jti: crypto.randomUUID() };

  const good = await access.issue({ actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-browser' });
  await assert.rejects(() => access.verify(good, { audience: 'mega-android' }), codeIs('AUDIENCE_MISMATCH'));

  const wrongIssuer = signRaw(keyFileFor('main'), kid, { alg: 'EdDSA', typ: 'JWT', kid }, { ...base, iss: 'https://evil.example' });
  await assert.rejects(() => access.verify(wrongIssuer, { audience: 'mega-browser' }), codeIs('ISSUER_MISMATCH'));

  const expired = signRaw(keyFileFor('main'), kid, { alg: 'EdDSA', typ: 'JWT', kid }, { ...base, iat: base.iat - 400, nbf: base.nbf - 400, exp: base.iat - 100 });
  await assert.rejects(() => access.verify(expired, { audience: 'mega-browser' }), codeIs('TOKEN_EXPIRED'));

  const notYet = signRaw(keyFileFor('main'), kid, { alg: 'EdDSA', typ: 'JWT', kid }, { ...base, nbf: base.nbf + 60, exp: base.exp + 60 });
  await assert.rejects(() => access.verify(notYet, { audience: 'mega-browser' }), codeIs('TOKEN_EXPIRED'));

  const algNone = `${b64uJson({ alg: 'none', typ: 'JWT', kid })}.${b64uJson(base)}.`;
  await assert.rejects(() => access.verify(algNone, { audience: 'mega-browser' }), codeIs('ALGORITHM_REJECTED'));
  const algHs = signRaw(keyFileFor('main'), kid, { alg: 'HS256', typ: 'JWT', kid }, base);
  await assert.rejects(() => access.verify(algHs, { audience: 'mega-browser' }), codeIs('ALGORITHM_REJECTED'));
  const jku = signRaw(keyFileFor('main'), kid, { alg: 'EdDSA', typ: 'JWT', kid, jku: 'https://evil.example/jwks' }, base);
  await assert.rejects(() => access.verify(jku, { audience: 'mega-browser' }), codeIs('ALGORITHM_REJECTED'));

  const unknownKid = signRaw(keyFileFor('main'), kid, { alg: 'EdDSA', typ: 'JWT', kid: 'mxv5-stg-2026Q4-999-ff' }, base);
  await assert.rejects(() => access.verify(unknownKid, { audience: 'mega-browser' }), codeIs('UNKNOWN_SIGNING_KEY'));

  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
   await assert.rejects(() => access.verify(bad, { audience: 'mega-browser' }), codeIs('MALFORMED_TOKEN'), `malformed: ${bad}`);
  }
 } finally { access.close(); }
});

/* ============================================ 3. PLAYER/SERVICE DISJOINTNESS */

test('P05 access: player and service audiences are disjoint in both directions', async (t) => {
 if (!(await lab.boot(t))) return;
 await databaseFor('main');
 const access = await accessFor('main');
 try {
  const player = await access.issue({ actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1, amr: ['google'], authAt: lab.CLOCK, audience: 'mega-browser' });
  const service = await access.issueServiceAssertion({ op: 'op-1', fp: 'fp-1', actor: 'svc_alice', scope: 'command:player', audience: 'mega-core' });

  await assert.rejects(() => access.verify(player, { audience: 'mega-core' }), codeIs('AUDIENCE_MISMATCH'), 'a player token never verifies as a service assertion');
  await assert.rejects(() => access.verify(service, { audience: 'mega-browser' }), codeIs('AUDIENCE_MISMATCH'), 'a service assertion never verifies as a player token');

  await assert.rejects(() => access.issue({ actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-core' }), codeIs('AUDIENCE_MISMATCH'));
  await assert.rejects(() => access.issueServiceAssertion({ op: 'op-1', fp: 'fp-1', actor: 'svc_alice', scope: 'command:player', audience: 'mega-browser' }), codeIs('AUDIENCE_MISMATCH'));
 } finally { access.close(); }
});

/* ============================================================ 4. ROTATION */

test('P05 access: rotation overlap keeps the retiring key verifiable, then retires it', async (t) => {
 if (!(await lab.boot(t))) return;
 nowMs = lab.CLOCK;
 const database = await databaseFor('rotate');
 const access = await accessFor('rotate');
 try {
  const old = await access.issue({ actor: 'svc_alice', sessionId: 'b'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-ios' });
  const oldKid = decode(old).header.kid;

  await access.rotateKeys();
  const rows = await keyRows(database);
  const retiring = rows.find((r) => r.kid === oldKid);
  assert.equal(retiring.state, 'retiring');
  assert.equal(new Date(retiring.retire_at).getTime(), lab.CLOCK + 360000, 'retiring residence is now+360000');

  assert.equal((await access.verify(old, { audience: 'mega-ios' })).sub, 'svc_alice', 'the retiring key still verifies during the overlap');
  const set = await access.jwks();
  assert.equal(set.keys.some((k) => k.kid === oldKid), true, 'the retiring key stays servable');

  const fresh = await access.issue({ actor: 'svc_alice', sessionId: 'b'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-ios' });
  const freshKid = decode(fresh).header.kid;
  assert.notEqual(freshKid, oldKid, 'a new active key signs');
  assert.ok(Number(freshKid.split('-')[3]) > Number(oldKid.split('-')[3]), 'seq increases monotonically per environment');
  assert.equal((await access.verify(fresh, { audience: 'mega-ios' })).sub, 'svc_alice', 'the new key verifies under the overlap');

  nowMs = lab.CLOCK + 360000;
  const retired = await access.retireDueKeys();
  assert.equal(retired, 1);
  await assert.rejects(() => access.verify(old, { audience: 'mega-ios' }), codeIs('UNKNOWN_SIGNING_KEY'), 'a retired key no longer verifies');
  const after = await access.jwks();
  assert.equal(after.keys.some((k) => k.kid === oldKid), false, 'a retired key leaves the JWKS');
  /* The active key keeps signing and verifying after the overlap ends. */
  const post = await access.issue({ actor: 'svc_alice', sessionId: 'b'.repeat(24), generation: 1, amr: ['pwd'], authAt: nowMs, audience: 'mega-ios' });
  assert.equal((await access.verify(post, { audience: 'mega-ios' })).sub, 'svc_alice', 'the new key keeps working');
 } finally { access.close(); }
});

/* ================================================================ 5. JWKS */

test('P05 access: jwks is bounded to <=8 public active+retiring keys', async (t) => {
 if (!(await lab.boot(t))) return;
 nowMs = lab.CLOCK;
 const database = await databaseFor('jwks');
 const access = await accessFor('jwks');
 try {
  for (let i = 0; i < 10; i += 1) await access.rotateKeys();
  const set = await access.jwks();
  assert.ok(set.keys.length <= 8, 'the JWKS is bounded to at most 8 keys');
  assert.equal(set.keys.length, 8, 'with 10 rotations the JWKS holds the newest 8 servable keys');
  for (const key of set.keys) {
   assert.deepEqual(Object.keys(key).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x']);
   assert.equal(key.kty, 'OKP');
   assert.equal(key.crv, 'Ed25519');
   assert.equal(key.use, 'sig');
   assert.equal(key.alg, 'EdDSA');
   assert.equal(typeof key.x, 'string');
  }
  const rows = await keyRows(database);
  const servable = rows.filter((r) => r.state === 'active' || r.state === 'retiring').map((r) => r.kid);
  for (const key of set.keys) assert.equal(servable.includes(key.kid), true, 'every published key is active or retiring');
  const body = JSON.stringify(set);
  assert.equal(/\"d\"/.test(body), false, 'the JWKS never contains private key material');
  assert.ok(Buffer.byteLength(body) <= 16384, 'the JWKS stays under 16 KiB');
 } finally { access.close(); }
});

/* ========================================================= 6. KEY CUSTODY */

test('P05 access: production refuses to boot without its sealed key; stg creates one on first boot', async (t) => {
 if (!(await lab.boot(t))) return;
 nowMs = lab.CLOCK;
 const database = await databaseFor('main');
 const { createAccessService } = require('../packages/services/access.js');
 const missing = path.join(tmpDir(), `prd-missing-${crypto.randomBytes(4).toString('hex')}.json`);
 assert.equal(fs.existsSync(missing), false);

 await assert.rejects(
  () => createAccessService(lab.poolsFor(database).api, {
   now: clock, issuer: ISSUER, environment: 'prd', keyFile: missing,
   playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
  }),
  codeIs('KEY_CUSTODY_REQUIRED'),
  'production must never auto-generate signing keys');

 const stgFile = path.join(tmpDir(), `stg-fresh-${crypto.randomBytes(4).toString('hex')}.json`);
 const freshDb = await databaseFor('fresh');
 const access = await createAccessService(lab.poolsFor(freshDb).api, {
  now: clock, issuer: ISSUER, environment: 'stg', keyFile: stgFile,
  playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
 });
 try {
  assert.equal(fs.existsSync(stgFile), true, 'stg creates the sealed file on first boot');
  assert.equal(fs.statSync(stgFile).mode & 0o777, 0o600, 'the sealed file is owner-only');
  const token = await access.issue({ actor: 'svc_alice', sessionId: 'c'.repeat(24), generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android' });
  const kid = decode(token).header.kid;
  assert.equal(Boolean(JSON.parse(fs.readFileSync(stgFile, 'utf8'))[kid]), true, 'the signing key is sealed under its kid');
 } finally { access.close(); }

 /* A stg service whose environment already HAS an active row (from a sibling node that sealed a
  * different file) must refuse with the custody code rather than silently re-minting over it. */
 const strayFile = path.join(tmpDir(), `stg-stray-${crypto.randomBytes(4).toString('hex')}.json`);
 await assert.rejects(
  () => createAccessService(lab.poolsFor(freshDb).api, {
   now: clock, issuer: ISSUER, environment: 'stg', keyFile: strayFile,
   playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
  }),
  codeIs('KEY_CUSTODY_REQUIRED'),
  'a recorded active key with no private half is a custody failure, not a re-mint');
});

/* ==================================================== 7. ACCESS DTO + CONTRACTS */

test('P05 access: DTO guards refuse ambiguous credentials and never leak a ticket', async () => {
 const dto = require('../packages/contracts/access-dto.js');
 const guards = require('../packages/contracts/http-guards.js');
 const routes = require('../packages/contracts/routes.js');

 assert.throws(() => dto.refuseAmbiguousCredential({ cookieHeader: '__Host-mega_session=abc', bearerHeader: 'Bearer xyz' }), codeIs('AMBIGUOUS_CREDENTIAL'));
 assert.deepEqual(dto.refuseAmbiguousCredential({ cookieHeader: '__Host-mega_session=abc' }), { cookie: '__Host-mega_session=abc', bearer: null });
 assert.deepEqual(dto.refuseAmbiguousCredential({ bearerHeader: 'Bearer xyz' }), { cookie: null, bearer: 'Bearer xyz' });
 assert.deepEqual(dto.refuseAmbiguousCredential({ cookieHeader: '  ', bearerHeader: '' }), { cookie: null, bearer: null });

 const ticket = 'abcdefghijklmnopqrstuvwxyz0123456789';
 const redacted = dto.redactTicket(ticket);
 assert.equal(redacted, 'abcdef\u2026');
 assert.equal(redacted.includes(ticket), false, 'redaction never exposes the full ticket');
 assert.equal(dto.redactTicket(''), '');
 assert.equal(dto.redactTicket('short'), '\u2026', 'a short ticket is fully withheld');

 assert.equal(dto.validateNativeTokenGrant({ provider: 'google', state: 's', idToken: 'aaa.bbb.ccc' }).kind, 'provider');
 assert.deepEqual(dto.validateNativeTokenGrant({ grant: 'refresh_token', refreshToken: 'r'.repeat(43) }), { kind: 'refresh', refreshToken: 'r'.repeat(43), deviceId: null });
 assert.throws(() => dto.validateNativeTokenGrant({ provider: 'google', state: 's', idToken: 'aaa.bbb.ccc', refreshToken: 'r'.repeat(43) }), codeIs('INVALID_AUTH_REQUEST'));
 assert.throws(() => dto.validateNativeTokenGrant({ provider: 'google', state: 's', idToken: 'not-a-token' }), codeIs('INVALID_ID_TOKEN'));

 assert.equal(guards.ACCOUNT_STATUS.AMBIGUOUS_CREDENTIAL, 401);
 assert.equal(guards.accountStatus('AMBIGUOUS_CREDENTIAL'), 401);
 assert.equal(guards.realtimeStatus('TICKET_INVALID'), 403);
 assert.equal(guards.realtimeStatus('TICKET_EXPIRED'), 403);
 assert.equal(guards.realtimeStatus('TICKET_REDEEMED'), 403);
 assert.equal(guards.realtimeStatus('TICKET_LIMIT'), 429);

 assert.equal(routes.routeById('account.jwks').cache, routes.CACHE_PUBLIC);
 assert.equal(routes.routeById('account.jwks').auth, routes.AUTH.PUBLIC);
 assert.equal(routes.routeById('account.native.token').auth, routes.AUTH.BEARER);
 assert.equal(routes.routeById('account.native.refresh').csrf, false);
 assert.equal(routes.routeById('v1.realtime.ticket').csrf, true);
 assert.equal(routes.routeById('v1.realtime.ticket').auth, routes.AUTH.LINKED);
 assert.equal(routes.routeMatches('account.jwks', 'GET', '/.well-known/jwks.json'), true);
});
