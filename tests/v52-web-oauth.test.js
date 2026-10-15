'use strict';

/* Unit coverage for the V5.2 web OAuth lane: POST /api/account/start, the composed
 * completeWebSignIn the well-known callback calls, and the configured-but-unlinked provider
 * advertising on /api/account/session. Synthetic accounts service + IdentityProviders - no
 * database, no network. The redirect_uri exactness asserted here is what the Google/Apple
 * consoles must match, so a drift fails CI before a real sign-in can. */
const test = require('node:test');
const assert = require('node:assert/strict');

const accountRoutes = require('../apps/api/routes/account.js');

const HOST_COOKIE = '__Host-mega_session=cookie-1';

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    getHeader(key) { return this.headers[String(key).toLowerCase()] ?? null; },
    end(body) { this.body = body; },
  };
}

function mockReq({ url, method = 'POST', body, cookie = null, csrf = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (method === 'POST') headers['content-type'] = 'application/json';
  return { url, method, headers, body };
}

function makeAccounts({ actor = null } = {}) {
  const calls = { start: [], consume: [], finish: [] };
  return {
    calls,
    async bootstrap(cookie) { return { token: cookie || 'fresh-token', csrf: 'csrf-1', actor, expires: 999 }; },
    async csrf(token, header) { if (token === 'cookie-1' && header !== 'csrf-1') { const e = new Error('CSRF_REJECTED'); e.status = 403; throw e; } },
    async identities() { return [{ provider: 'google' }]; },
    async start(token, provider, intent, kind) { calls.start.push({ token, provider, intent, kind }); return { state: 'st-1', nonce: 'n-1', verifier: 'v-1', expires: 123 }; },
    async consume(token, state, provider, kind) {
      calls.consume.push({ token, state, provider, kind });
      if (state === 'bad') { throw new Error('INVALID_AUTH_STATE'); }
      return { state, nonce: 'n-1', verifier: 'v-1', provider, kind, intent: 'login', target: null, expires: 999 };
    },
    async finishVerified(token, attempt, identity) { calls.finish.push({ token, attempt, identity }); return { token: 'rotated-token', csrf: 'csrf-2', actor: 'a-1', created: false, profile: { id: 'a-1' } }; },
  };
}

function makeProviders({ googleWeb = true } = {}) {
  const calls = { authorization: [], exchange: [] };
  return {
    calls,
    /* resolveNativeProviders only accepts a client with the native verify() contract. */
    async verify() { return { provider: 'google', subject: 'sub-verify' }; },
    capabilities: () => ({ google: { web: googleWeb, native: false }, apple: { web: false, native: false } }),
    authorization(provider, attempt, redirect) { calls.authorization.push({ provider, redirect }); return 'https://accounts.google.test/authorize?redirect_uri=' + encodeURIComponent(redirect); },
    async exchange(provider, code, attempt, redirect) { calls.exchange.push({ provider, code, attempt, redirect }); return { provider, subject: 'sub-1' }; },
  };
}

function makeContext(options = {}) {
  return {
    accounts: makeAccounts(options),
    identityProviders: makeProviders(options),
    webCallbackOrigin: 'https://megaxo.test',
  };
}

test('POST /api/account/start returns the provider authorize URL bound to the canonical callback', async () => {
  const context = makeContext();
  const res = mockRes();
  const handled = await accountRoutes.handleAccountRoute(context, mockReq({ url: 'https://megaxo.test/api/account/start', body: { provider: 'google', intent: 'login' } }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.match(body.url, /redirect_uri=https%3A%2F%2Fmegaxo\.test%2Fauth%2Fcallback%2Fgoogle/);
  assert.equal(body.state, 'st-1');
  assert.deepEqual(context.accounts.calls.start, [{ token: 'fresh-token', provider: 'google', intent: 'login', kind: 'web' }]);
  assert.match(String(res.headers['set-cookie']), /__Host-mega_session=fresh-token/);
});

test('POST /api/account/start refuses a provider that is not web-configured', async () => {
  const context = makeContext();
  const res = mockRes();
  await assert.rejects(
    accountRoutes.handleAccountRoute(context, mockReq({ url: 'https://megaxo.test/api/account/start', body: { provider: 'apple' } }), res),
    (error) => error.message === 'PROVIDER_NOT_CONFIGURED' && error.status === 409,
  );
  assert.deepEqual(context.accounts.calls.start, []);
});

test('POST /api/account/start enforces session-bound CSRF for an existing cookie session', async () => {
  const context = makeContext();
  await assert.rejects(
    accountRoutes.handleAccountRoute(
      context,
      mockReq({ url: 'https://megaxo.test/api/account/start', body: { provider: 'google' }, cookie: HOST_COOKIE }),
      mockRes(),
    ),
    (error) => error.message === 'CSRF_REJECTED',
  );
  const res = mockRes();
  await accountRoutes.handleAccountRoute(
    context,
    mockReq({ url: 'https://megaxo.test/api/account/start', body: { provider: 'google' }, cookie: HOST_COOKIE, csrf: 'csrf-1' }),
    res,
  );
  assert.deepEqual(context.accounts.calls.start, [{ token: 'cookie-1', provider: 'google', intent: 'login', kind: 'web' }]);
});

test('createWebSignInLane consumes the attempt, exchanges with the exact redirect, and rotates the session', async () => {
  const context = makeContext();
  const lane = accountRoutes.createWebSignInLane(context);
  const outcome = await lane({ provider: 'google', state: 'st-9', code: 'code-1', cookie: HOST_COOKIE });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.setCookie, '__Host-mega_session=rotated-token; Path=/; HttpOnly; SameSite=Lax; Secure');
  assert.deepEqual(context.accounts.calls.consume, [{ token: 'cookie-1', state: 'st-9', provider: 'google', kind: 'web' }]);
  assert.equal(context.identityProviders.calls.exchange[0].redirect, 'https://megaxo.test/auth/callback/google');
  assert.deepEqual(context.accounts.calls.finish[0].identity, { provider: 'google', subject: 'sub-1' });
});

test('createWebSignInLane maps durable failures to their codes and refuses a cookieless callback', async () => {
  const context = makeContext();
  const lane = accountRoutes.createWebSignInLane(context);
  await assert.rejects(
    lane({ provider: 'google', state: 'bad', code: 'x', cookie: HOST_COOKIE }),
    (error) => error.code === 'INVALID_AUTH_STATE',
  );
  await assert.rejects(
    lane({ provider: 'google', state: 'st-1', code: 'x', cookie: null }),
    (error) => error.code === 'AUTH_REQUIRED',
  );
});

test('/api/account/session advertises configured-but-unlinked providers and preserves linked shape', async () => {
  const guest = makeContext();
  const guestRes = mockRes();
  await accountRoutes.handleAccountRoute(guest, mockReq({ url: 'https://megaxo.test/api/account/session', method: 'GET' }), guestRes);
  assert.deepEqual(JSON.parse(guestRes.body).providers, { google: { web: true, linked: false }, apple: { web: false, linked: false } });

  const linked = makeContext({ actor: 'a-1' });
  const linkedRes = mockRes();
  await accountRoutes.handleAccountRoute(linked, mockReq({ url: 'https://megaxo.test/api/account/session', method: 'GET' }), linkedRes);
  const body = JSON.parse(linkedRes.body);
  assert.equal(body.linked, true);
  assert.deepEqual(body.providers, { google: { web: true, linked: true }, apple: { web: false, linked: false } });

  const bare = { accounts: makeAccounts() };
  const bareRes = mockRes();
  await accountRoutes.handleAccountRoute(bare, mockReq({ url: 'https://megaxo.test/api/account/session', method: 'GET' }), bareRes);
  assert.deepEqual(JSON.parse(bareRes.body).providers, {});
});
