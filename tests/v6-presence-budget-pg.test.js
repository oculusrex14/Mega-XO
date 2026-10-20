 'use strict';
 /* Behavioral coverage for the A4 root-cause fix (decision log 15:05/16:00 IST 2026-10-20):
  * the presence heartbeat spends its fine-grained budget through the Redis-class ephemera
  * path and touches the durable ops.rate_buckets table ONLY when Redis is unavailable.
  * Runs against the real disposable loopback PostgreSQL 16 lab - no SQL mocks. */
 const test = require('node:test');
 const assert = require('node:assert/strict');
 const http = require('node:http');
 const fs = require('node:fs');
 const os = require('node:os');
 const path = require('node:path');
 const { Client } = require('pg');
 const lab = require('./v5-pg-lab.js');
 const { createApiHandler } = require('../apps/api/index.js');
 const { createAccessService } = require('../packages/services/access.js');
 const { createRefreshService } = require('../packages/services/refresh.js');
 const { IdentityProviders } = require('../server/identity-provider.js');
 const { jwk, sign } = require('./helpers/identity-fixture.js');

lab.installCleanup(test);

const PLAYER_AUDIENCES = ['mega-browser', 'mega-android', 'mega-ios'];
const SERVICE_AUDIENCES = ['mega-core'];
const NATIVE_AUDIENCES = ['mega-android', 'mega-ios'];
const ORIGIN = 'https://megaxo.online';

function startApiServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + server.address().port }));
    server.on('error', reject);
  });
}

function httpRequest(baseUrl, routePath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const requestHeaders = { connection: 'close', ...headers };
    if (payload !== null) requestHeaders['content-type'] = 'application/json';
    const req = http.request(new URL(routePath, baseUrl), { method, agent: false, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, data, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function adminClient(database) {
  const c = new Client({ connectionString: lab.dbUrl(database) });
  await c.connect();
  return c;
}

/* A configurable fake ephemera adapter: rateHit behavior is injected per test; the presence
 * families answer conservatively-successfully so the flow reaches the assertions. */
function fakeEphemera(rateHit) {
  return {
    presenceTouch: async () => ({ stored: true, available: true }),
    presenceRead: async () => ({ presence: [], available: true }),
    rateHit,
  };
}

async function composePresence(database, ephemera) {
  const pools = lab.poolsFor(database);
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'v6-presence-keys-')), 'keys.sealed.json');
  const now = () => lab.CLOCK;
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
    ephemera,
  });
  const providers = new IdentityProviders({
    config: { google: { nativeAudiences: ['test-native'] }, apple: { nativeAudiences: ['test-native'] } },
    now,
    keysForTest: () => [jwk],
  });
  return { access, refresh, accounts, providers };
}

async function harness(database, context) {
  const handler = createApiHandler({
    accounts: context.accounts,
    access: context.access,
    refresh: context.refresh,
    providers: context.providers,
    nativeAudiences: NATIVE_AUDIENCES,
    allowedOrigins: [ORIGIN],
  });
  return { ...(await startApiServer(handler)) };
}

const idTokenFor = (subject, nonce) => sign('google', subject, nonce, lab.CLOCK);

/* Native sign-in (challenge -> finish) and returns the rotated session bearer. */
async function nativeSignIn(url, context) {
  const challenge = await httpRequest(url, '/api/account/native/challenge', {
    method: 'POST', headers: { origin: ORIGIN }, body: { provider: 'google', intent: 'login' },
  });
  assert.equal(challenge.status, 200, challenge.raw);
  const finish = await httpRequest(url, '/api/account/native/finish', {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: 'Bearer ' + challenge.data.sessionToken },
    body: { provider: 'google', state: challenge.data.state, idToken: idTokenFor('presence-subject-1', challenge.data.nonce) },
  });
  assert.equal(finish.status, 200, finish.raw);
  return finish.data.sessionToken;
}

function heartbeat(url, sessionToken) {
  return httpRequest(url, '/api/community/presence', {
    method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer ' + sessionToken }, body: { foreground: true },
  });
}

async function durablePresenceRows(database) {
  const c = await adminClient(database);
  try {
    const r = await c.query("SELECT count(*)::int AS n FROM ops.rate_buckets WHERE bucket_id LIKE 'presence:%'");
    return r.rows[0].n;
  } finally { await c.end(); }
}

test('presence heartbeat: a permitted Redis budget never writes the durable table', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('v6_presence_permit');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const api = await harness(db, await composePresence(db, fakeEphemera(async () => ({ allowed: true, count: 1, available: true }))));
  try {
    const token = await nativeSignIn(api.url);
    const beat = await heartbeat(api.url, token);
    assert.equal(beat.status, 200, beat.raw);
    assert.equal(await durablePresenceRows(db), 0, 'no durable presence row may be written when Redis rules');
  } finally { await api.server.close(); }
});

test('presence heartbeat: a denied Redis budget is refused without a durable write', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('v6_presence_deny');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const api = await harness(db, await composePresence(db, fakeEphemera(async () => ({ allowed: false, count: 13, available: true }))));
  try {
    const token = await nativeSignIn(api.url);
    const beat = await heartbeat(api.url, token);
    assert.equal(beat.status, 429, beat.raw);
    assert.equal(await durablePresenceRows(db), 0, 'a denial must not fall back to the durable spend');
  } finally { await api.server.close(); }
});

test('presence heartbeat: an unavailable Redis budget spends the durable fallback', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('v6_presence_unavailable');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const api = await harness(db, await composePresence(db, fakeEphemera(async () => ({ available: false }))));
  try {
    const token = await nativeSignIn(api.url);
    const beat = await heartbeat(api.url, token);
    assert.equal(beat.status, 200, beat.raw);
    assert.equal(await durablePresenceRows(db), 1, 'the outage fallback must spend the durable budget');
  } finally { await api.server.close(); }
});

test('presence heartbeat: a Redis error falls back to the durable spend', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('v6_presence_error');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const api = await harness(db, await composePresence(db, fakeEphemera(async () => { throw Error('REDIS_DOWN'); })));
  try {
    const token = await nativeSignIn(api.url);
    const beat = await heartbeat(api.url, token);
    assert.equal(beat.status, 200, beat.raw);
    assert.equal(await durablePresenceRows(db), 1, 'an erroring Redis must fall back to the durable budget');
  } finally { await api.server.close(); }
});
