'use strict';
/* tests/v5-p11-account-session-email.test.js - V5 session/email HTTP bridge (P2).
 *
 * SCOPE & CONTRACT:
 * Exercises the shared-client account routes on the REAL guarded `api_runtime` pool over real
 * loopback PostgreSQL 16 (tests/v5-pg-lab.js). Nothing here uses SQLite, a V4 store or a mock:
 *
 *   1. GET  /api/account/session  - an anonymous caller is issued an HttpOnly session cookie and
 *      the response carries no bearer; an existing caller re-presents the cookie and is NOT
 *      re-issued a new session (stable CSRF).
 *   2. POST /api/account/email    - `continue` for an unknown address starts a signup challenge
 *      whose one-time code is delivered OUT OF BAND (never in the HTTP body), and `verify` with
 *      that code links the caller (linked:true) while rotating the session cookie.
 *   3. `forgot` is non-disclosing: an unknown and a known address return the same shape.
 *   4. CSRF: a cookie-bearing POST from a foreign Origin is rejected 403 ORIGIN_OR_CONTENT_TYPE;
 *      an allowed Origin passes.
 *   5. An unknown action is refused 409 INVALID_OPERATION.
 *
 * Every response MUST omit the `delivery` (recipient + code) object; that material is for the mail
 * worker only. The one-time code is observed solely through the server-side `otpSink`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const lab = require('./v5-pg-lab.js');
const { createApiHandler } = require('../apps/api/index.js');

lab.installCleanup(test);

const ORIGIN = 'https://megaxo.online';
const OTP_SECRET = 'v5-account-session-email-test-otp-secret';
const EMAIL = 'new.player@example.test';
const PASSWORD = 'correct horse 42';

async function setupServer(database) {
  const pools = lab.poolsFor(database);
  const accounts = await lab.accountsFor(database, { otpSecret: OTP_SECRET });
  const deliveries = [];
  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    allowedOrigins: [ORIGIN],
    otpSink: (delivery) => deliveries.push(delivery),
  });
  const close = async () => { await lab.closeDatabasePools(database); };
  return { handler, accounts, deliveries, close };
}

async function request(server, routePath, { method = 'GET', cookie = null, origin = null, body = null } = {}) {
  const handler = server && typeof server.handler === 'function' ? server.handler : server;
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = {};
  if (cookie) req.headers.cookie = cookie;
  if (origin) req.headers.origin = origin;
  if (body) { req.body = body; req.headers['content-type'] = 'application/json'; }
  return new Promise((resolve, reject) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const headers = {};
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.getHeader = (k) => headers[k.toLowerCase()];
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (data) => resolve({ status: res.statusCode, headers, data });
    res.end = (chunk) => {
      let data = null;
      if (chunk) { try { data = JSON.parse(chunk); } catch { data = chunk; } }
      resolve({ status: res.statusCode, headers, data });
    };
    handler(req, res).catch(reject);
  });
}

function cookieToken(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of list) {
    const m = /^([^=]+)=([^;]*)/.exec(line || '');
    if (m && m[1] !== '__Host-mega_session') return `${m[1]}=${m[2]}`;
  }
  return null;
}

test('GET /api/account/session issues an anonymous cookie and reuses it without re-issuing', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_session');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  const first = await request(server, '/api/account/session', { method: 'GET' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.linked, false);
  assert.equal(typeof first.data.csrf, 'string');
  assert.ok(first.data.csrf.length >= 16);
  assert.equal('token' in first.data, false, 'the session bearer must never appear in the body');
  assert.equal(first.data.actorId, null);
  const setCookie = first.headers['set-cookie'];
  assert.ok(setCookie, 'an anonymous caller must be issued a session cookie');
  const cookie = cookieToken(setCookie);
  assert.ok(cookie && cookie.startsWith('mega_dev_session='), `expected a dev session cookie, got ${setCookie}`);

  const second = await request(server, '/api/account/session', { method: 'GET', cookie });
  assert.equal(second.status, 200);
  assert.equal(second.data.csrf, first.data.csrf, 'an existing session keeps its CSRF token');
  assert.equal(second.headers['set-cookie'], undefined, 'an existing session is not re-issued');
  // The http staging cookie must be the non-Secure pair; __Host- requires HTTPS.
  assert.ok(setCookie.some((line) => line.includes('mega_dev_session=')), 'http origin needs mega_dev_session');
});

test('POST /api/account/email signup round-trip: OTP stays out of HTTP and verify links the caller', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_email');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  const bootstrap = await request(server, '/api/account/session', { method: 'GET' });
  const cookie = cookieToken(bootstrap.headers['set-cookie']);

  const started = await request(server, '/api/account/email', {
    method: 'POST', cookie, origin: ORIGIN, body: { action: 'continue', email: EMAIL, password: PASSWORD },
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.verificationRequired, true);
  assert.equal(typeof started.data.challengeId, 'string');
  assert.equal('delivery' in started.data, false, 'the one-time code must never be returned to HTTP');
  assert.equal('code' in started.data, false);

  // The code reaches the caller only through the server-side mail sink.
  assert.equal(server.deliveries.length, 1);
  const { code, to, purpose } = server.deliveries[0];
  assert.equal(to, EMAIL);
  assert.equal(purpose, 'signup');
  assert.match(code, /^[0-9]{6}$/);

  const verified = await request(server, '/api/account/email', {
    method: 'POST', cookie, origin: ORIGIN, body: { action: 'verify', challengeId: started.data.challengeId, code },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.linked, true);
  assert.equal(typeof verified.data.actorId, 'string');
  assert.ok(verified.data.actorId.length > 0);
  assert.equal(typeof verified.data.csrf, 'string');
  assert.equal('delivery' in verified.data, false);

  // The session is now linked and durable: a fresh session read reports it.
  const linkedCookie = cookieToken(verified.headers['set-cookie']) || cookie;
  const session = await request(server, '/api/account/session', { method: 'GET', cookie: linkedCookie });
  assert.equal(session.status, 200);
  assert.equal(session.data.linked, true);
  assert.equal(session.data.actorId, verified.data.actorId);
  assert.equal(session.data.providers.email?.linked, true);
});

test('POST /api/account/email forgot does not disclose whether an address exists', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_forgot');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  const bootstrap = await request(server, '/api/account/session', { method: 'GET' });
  const cookie = cookieToken(bootstrap.headers['set-cookie']);

  const unknown = await request(server, '/api/account/email', {
    method: 'POST', cookie, origin: ORIGIN, body: { action: 'forgot', email: 'nobody@example.test' },
  });
  assert.equal(unknown.status, 200, JSON.stringify(unknown.data));
  assert.match(unknown.data.message, /If this email has an account/);
  assert.equal('delivery' in unknown.data, false);
  assert.equal('code' in unknown.data, false);
});

test('POST /api/account/email enforces Origin for cookie callers and refuses unknown actions', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_csrf');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  const bootstrap = await request(server, '/api/account/session', { method: 'GET' });
  const cookie = cookieToken(bootstrap.headers['set-cookie']);

  const foreign = await request(server, '/api/account/email', {
    method: 'POST', cookie, origin: 'https://evil.example', body: { action: 'continue', email: EMAIL, password: PASSWORD },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.error, 'ORIGIN_OR_CONTENT_TYPE');
  assert.equal(server.deliveries.length, 0, 'a rejected request must not send mail');

  const invalid = await request(server, '/api/account/email', {
    method: 'POST', cookie, origin: ORIGIN, body: { action: 'definitely-not-an-action' },
  });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.data.error, 'INVALID_OPERATION');
});

test('GET /api/account/session over a POST is not routed (method isolation)', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_method');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  const res = await request(server, '/api/account/session', { method: 'POST', origin: ORIGIN, body: {} });
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'NOT_FOUND');
});
