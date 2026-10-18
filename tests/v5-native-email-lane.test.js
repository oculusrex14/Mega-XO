'use strict';
/* Launch-fix tests (2026-10-18): the cookie-free native email lane
 * (POST /api/account/native/email). A fresh install presents no credential, so the route
 * bootstraps an anonymous session and returns its token for challenge/verify/reset continuity;
 * a linked result mints the frozen native credential family exactly like the provider grant.
 * Stubs stand in for the accounts service and P05 services; the durable emailContinue semantics
 * are covered by the PostgreSQL lanes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const accountRoutes = require('../apps/api/routes/account.js');

function makeReq(body, { bearer = null } = {}) {
  const stream = new PassThrough();
  stream.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  if (bearer) stream.headers.authorization = 'Bearer ' + bearer;
  stream.end(body);
  return stream;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    end(body) { this.body = body; },
  };
}

function stubContext({ emailResult, linked = false } = {}) {
  let bootstrapped = 0;
  const context = {
    checkNativeEmail: async () => {},
    accounts: {
      bootstrap: async () => { bootstrapped += 1; return { token: 'anon-session-token', actor: null }; },
      emailContinue: async (token, email, password) => {
        context.seen = { op: 'continue', token, email, password };
        if (linked) return { token: 'rotated-linked-token', profile: { id: 'u_actor1' } };
        return { linked: false, verificationRequired: true, challengeId: 'chal_1', maskedEmail: 'm***@x.co', expiresAt: 1, resendAt: 2 };
      },
      emailVerify: async (token) => { context.seen = { op: 'verify', token }; return { token: 'rotated-linked-token', profile: { id: 'u_actor1' } }; },
      emailResetStart: async () => ({ challengeId: 'chal_2' }),
      emailResetComplete: async () => { return { token: 'rotated-linked-token', profile: { id: 'u_actor1' } }; },
      accessBinding: async () => ({ actor: 'u_actor1', sessionId: 'sess1', generation: 3 }),
      session: async () => ({ authAt: 123 }),
      csrf: async () => {},
    },
    access: {
      verify: async () => ({}),
      issue: async (claims) => { context.issued = claims; return 'test-access-token'; },
    },
    refresh: {
      rotate: async () => ({}),
      startFamily: async (input) => { context.family = input; return { refreshSecret: 'test-refresh-secret' }; },
    },
    nativeAudiences: ['mega-android', 'mega-ios'],
    get bootstraps() { return bootstrapped; },
  };
  return context;
}

test('guest continue with an unverified/unknown address bootstraps a session and returns its token for continuity', async () => {
  const context = stubContext({ linked: false });
  const res = makeRes();
  await accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'continue', email: 'a@b.co', password: 'testingpass12' })), res);
  assert.equal(context.bootstraps, 1);
  assert.equal(context.seen.token, 'anon-session-token');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.verificationRequired, true);
  assert.equal(body.challengeId, 'chal_1');
  assert.equal(body.sessionToken, 'anon-session-token');
  assert.equal(body.accessToken, undefined, 'no credential family is minted before the flow links');
});

test('guest continue against an existing verified address mints the frozen native credential family', async () => {
  const context = stubContext({ linked: true });
  const res = makeRes();
  await accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'continue', email: 'a@b.co', password: 'testingpass12' })), res);
  assert.equal(context.family.actor, 'u_actor1');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.accessToken, 'test-access-token');
  assert.equal(body.refreshToken, 'test-refresh-secret');
  assert.equal(body.actorId, 'u_actor1');
  assert.equal(body.sessionToken, undefined, 'an authenticated family never rides with a bootstrap token');
  assert.deepEqual(context.issued.amr, ['pwd'], 'the password lane authenticates with the pwd amr');
});

test('verify continuation presents the challenge token as the bearer and mints the family on success', async () => {
  const context = stubContext({ linked: true });
  const res = makeRes();
  await accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'verify', challengeId: 'chal_1', code: '123456' }), { bearer: 'anon-session-token' }), res);
  assert.equal(context.bootstraps, 0, 'a presented bearer is never re-bootstrapped');
  assert.equal(context.seen.token, 'anon-session-token');
  const body = JSON.parse(res.body);
  assert.equal(body.accessToken, 'test-access-token');
  assert.equal(body.actorId, 'u_actor1');
  assert.deepEqual(context.issued.amr, ['otp'], 'verified email codes authenticate with the otp amr');
});

test('forgot answers with the challenge id and never discloses existence', async () => {
  const context = stubContext({});
  const res = makeRes();
  await accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'forgot', email: 'a@b.co' })), res);
  const body = JSON.parse(res.body);
  assert.equal(body.challengeId, 'chal_2');
  assert.match(body.message, /If this email has an account/);
  assert.equal(body.accessToken, undefined);
});

test('unknown actions are refused with a 409', async () => {
  const context = stubContext({});
  const res = makeRes();
  await assert.rejects(
    () => accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'delete-everything' })), res),
    /INVALID_OPERATION/,
  );
});

test('admission fails closed before allocating a guest session or checking credentials', async () => {
  const context = stubContext({ linked: true });
  context.checkNativeEmail = async () => { throw Error('RATE_LIMITED'); };
  await assert.rejects(() => accountRoutes.postNativeEmail(context,
    makeReq(JSON.stringify({ action: 'continue', email: 'a@b.co', password: 'testingpass12' })), makeRes()), /RATE_LIMITED/);
  assert.equal(context.bootstraps, 0);
  assert.equal(context.seen, undefined);
  delete context.checkNativeEmail;
  await assert.rejects(() => accountRoutes.postNativeEmail(context,
    makeReq(JSON.stringify({ action: 'continue', email: 'a@b.co', password: 'testingpass12' })), makeRes()), /RATE_LIMIT_UNAVAILABLE/);
});

test('reset mints an OTP-authenticated family after reset proof succeeds', async () => {
  const context = stubContext({ linked: true });
  await accountRoutes.postNativeEmail(context, makeReq(JSON.stringify({ action: 'reset', challengeId: 'chal_2', password: 'testingpass12' }),
    { bearer: 'anon-session-token' }), makeRes());
  assert.deepEqual(context.issued.amr, ['otp']);
});
