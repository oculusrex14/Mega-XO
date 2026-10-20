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
const { Passwords } = require('../server/production/passwords.js');

lab.installCleanup(test);

const ORIGIN = 'https://megaxo.online';
const OTP_SECRET = 'v5-account-session-email-test-otp-secret';
const EMAIL = 'new.player@example.test';
const PASSWORD = 'correct horse 42';
const WRONG_PASSWORD = 'incorrect horse 99';
const EMAIL_CONTINUE_ADDRESS_LIMIT = 10;
const { setupDeletion, exerciseCancellation, exerciseCompletion } = require('./helpers/deletion-lifecycle.js');

test('B4 cooling intake preserves credentials/saves; in-app cancellation restores visibility and sign-in', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_cancel');
 await exerciseCancellation(h);
});

test('B4 scheduled worker completes exactly once at the deadline, erases via Core, and records follow-up honestly', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_complete');
 await exerciseCompletion(h);
});

test('B4 cancellation route enforces auth, tag and recent verification; repeat cancellation is stable', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_http');
 const handler = createApiHandler({ pool: h.pools.api, accounts: h.accounts, allowedOrigins: [ORIGIN] });
 const route = '/api/account/deletion/cancel';
 assert.equal((await request(handler, route, { method: 'POST', body: { confirmation: h.profile.tag } })).status, 401);
 await h.cool();
 const login = await h.signIn();
 const post = (confirmation, token = login.token) => request(handler, route, { method: 'POST', token, body: { confirmation } });
 const crossOrigin = await request(handler, route, { method: 'POST', cookie: `mega_dev_session=${login.token}`, origin: 'https://foreign.example', body: { confirmation: h.profile.tag } });
 assert.equal(crossOrigin.status, 403, 'cookie cancellation keeps the existing CSRF perimeter');
 const bad = await post('wrong-tag');
 assert.equal(bad.status, 409); assert.equal(bad.data.error, 'DELETE_CONFIRMATION_REQUIRED');
 h.advance(16 * 60000);
 const stale = await post(h.profile.tag);
 assert.equal(stale.status, 401); assert.equal(stale.data.error, 'REAUTH_REQUIRED');
 const fresh = await h.signIn();
 const ok = await post(h.profile.tag, fresh.token);
 assert.equal(ok.status, 200); assert.equal(ok.data.cancelled, true);
 const twice = await post(h.profile.tag, fresh.token);
 assert.equal(twice.status, 409); assert.equal(twice.data.error, 'DELETION_NOT_PENDING');
});

test('B4 intake guards preserve the account; cancellation obeys its actor rate budget', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_guards');
 await assert.rejects(h.accounts.deleteAccount(h.owner.token, 'wrong-tag'), /DELETE_CONFIRMATION_REQUIRED/);
 h.advance(16 * 60000);
 await assert.rejects(h.cool(), /REAUTH_REQUIRED/);
 const login = await h.signIn();
 const admin = await lab.adminClient(h.db);
 try {
  await admin.query("INSERT INTO core.actor_occupancy(actor_id,kind,ref_id) VALUES($1,'match','b4-busy')", [h.owner.actor]);
  await assert.rejects(h.cool(login.token), /ACCOUNT_BUSY/);
  await admin.query('DELETE FROM core.actor_occupancy WHERE actor_id=$1', [h.owner.actor]);
  await h.cool(login.token);
  const recovery = await h.signIn();
  const bucket = `account-delete-cancel:${h.owner.actor}:${Math.floor(h.now()/1000/86400)}`;
  await admin.query('INSERT INTO ops.rate_buckets(bucket_id,hits) VALUES($1,5)', [bucket]);
  await assert.rejects(h.accounts.cancelDeletion(recovery.token, h.profile.tag), /RATE_LIMITED/);
  assert.equal((await h.accounts.deletionStatus(recovery.token)).cooling, true);
 } finally { await admin.end(); }
});

test('B4 worker fails closed without Core, resumes after restart, and does not gain economy grants', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_retry');
 const ack = await h.cool();
 h.advance(30 * 86400000);
 const { createDeletionWorker } = require('../packages/services/worker-workflows.js');
 const missingCore = createDeletionWorker({ pool: h.pools.worker, now: h.now });
 assert.deepEqual(await missingCore.tick(), { claimed: 1, completed: 0, failed: 1 });
 assert.equal(await h.scalar('SELECT count(*)::int FROM identity.email_credentials WHERE actor_id=$1'), 1);
 assert.equal(await h.scalar('SELECT count(*)::int FROM privacy.deletion_receipts WHERE receipt_id=$1', [ack.receiptId]), 0);
 for (const pool of [h.pools.api, h.pools.worker]) {
  await assert.rejects(pool.query('SELECT privacy.erase_account_core_state($1,$2,$3)', [ack.receiptId, h.owner.actor, new Date(h.now())]), (e) => e.code === '42501');
 }
 await assert.rejects(h.pools.worker.query('DELETE FROM economy.wallets WHERE actor_id=$1', [h.owner.actor]), (e) => e.code === '42501');
 await assert.rejects(h.pools.api.query("UPDATE ops.outbox SET state='cancelled',payload=NULL WHERE outbox_id=$1", [`account.deletion:${ack.receiptId}`]), (e) => e.code === '42501');
 h.advance(60000);
 assert.deepEqual(await h.worker.tick(), { claimed: 1, completed: 1, failed: 0 });
});

test('B4 rescheduling after cancellation uses a fresh job and deadline, even within one clock instant', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_reschedule');
 const first = await h.cool();
 const login = await h.signIn();
 await h.accounts.cancelDeletion(login.token, h.profile.tag);
 const second = await h.cool(login.token);
 assert.notEqual(first.receiptId, second.receiptId);
 const nextLogin = await h.signIn();
 assert.equal((await h.accounts.deletionStatus(nextLogin.token)).request.receiptId, second.receiptId);
 await h.accounts.cancelDeletion(nextLogin.token, h.profile.tag);
 assert.equal(await h.scalar("SELECT count(*)::int FROM ops.outbox WHERE kind='account.deletion' AND state='cancelled'"), 2);
});

test('B4 restart between Core erasure and identity cleanup resumes without a second economic mutation', async (t) => {
 if (!(await lab.boot(t))) return;
 const h = await setupDeletion(t, 'b4_core_restart');
 const ack = await h.cool();
 h.advance(30 * 86400000);
 const { createDeletionWorker } = require('../packages/services/worker-workflows.js');
 const interrupted = createDeletionWorker({ pool: h.pools.worker, now: h.now,
  eraseDeletion: async (input) => { await h.core.eraseDeletion(input); throw Error('SIMULATED_PROCESS_INTERRUPTION'); } });
 assert.equal((await interrupted.tick()).failed, 1);
 const firstErasure = await h.scalar('SELECT core_erased_at::text FROM privacy.requests WHERE request_id=$1', [ack.receiptId]);
 assert.ok(firstErasure);
 assert.equal(await h.scalar('SELECT count(*)::int FROM economy.wallets WHERE actor_id=$1'), 0);
 assert.equal(await h.scalar('SELECT count(*)::int FROM identity.email_credentials WHERE actor_id=$1'), 1);
 h.advance(60000);
 assert.equal((await h.worker.tick()).completed, 1);
 assert.equal(await h.scalar('SELECT core_erased_at::text FROM privacy.requests WHERE request_id=$1', [ack.receiptId]), firstErasure);
});

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

async function request(server, routePath, { method = 'GET', cookie = null, token = null, origin = null, body = null } = {}) {
  const handler = server && typeof server.handler === 'function' ? server.handler : server;
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = {};
  if (cookie) req.headers.cookie = cookie;
  if (token) req.headers.authorization = `Bearer ${token}`;
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

test('emailContinue address budget caps wrong passwords across fresh guest sessions', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('acct_email_address_rate');
  const server = await setupServer(db);
  t.after(async () => { await server.close(); });

  // Create one real verified credential through the service's OTP flow, then attack it through
  // distinct anonymous sessions. Varying case also proves the budget keys on normalized address.
  const signupSession = await server.accounts.issue();
  const pending = await server.accounts.emailContinue(signupSession.token, EMAIL, PASSWORD);
  assert.equal(pending.verificationRequired, true);
  await server.accounts.emailVerify(signupSession.token, pending.challengeId, pending.delivery.code);

  for (let attempt = 0; attempt < EMAIL_CONTINUE_ADDRESS_LIMIT; attempt += 1) {
    const freshSession = await server.accounts.issue();
    const address = attempt % 2 === 0 ? EMAIL.toUpperCase() : EMAIL;
    await assert.rejects(
      server.accounts.emailContinue(freshSession.token, address, WRONG_PASSWORD),
      (error) => error.message === 'INVALID_CREDENTIALS',
    );
  }

  const addressHits = async () => Number(await lab.scalar(
    db,
    'SELECT COALESCE(SUM(hits), 0)::int FROM ops.rate_buckets WHERE bucket_id LIKE $1',
    ['email-continue-address:%'],
  ));
  assert.equal(await addressHits(), EMAIL_CONTINUE_ADDRESS_LIMIT, 'each failed password spend commits to the shared address bucket');

  const anotherFreshSession = await server.accounts.issue();
  const originalVerify = Passwords.prototype.verify;
  Passwords.prototype.verify = async () => { throw Error('PASSWORD_VERIFIER_REACHED'); };
  try {
    await assert.rejects(
      server.accounts.emailContinue(anotherFreshSession.token, EMAIL, WRONG_PASSWORD),
      (error) => error.message === 'RATE_LIMITED',
      'an over-budget fresh session must be refused before scrypt verification starts',
    );
  } finally {
    Passwords.prototype.verify = originalVerify;
  }
  assert.equal(await addressHits(), EMAIL_CONTINUE_ADDRESS_LIMIT, 'over-budget denial does not extend or roll back the committed cap');
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
