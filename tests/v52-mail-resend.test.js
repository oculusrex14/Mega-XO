'use strict';

/* Offline unit proof for the LR10 transactional email slice: the Resend transport, the policy
 * factory (enabled requires a secret; disabled stays the fail-closed stub), the composability
 * capability map, and the durable OTP sink (seal -> envelope -> INSERT, opened by the SAME worker
 * key). No network, no database: the fetcher and pool are captured fakes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createResendMailTransport, RESEND_ENDPOINT } = require('../packages/services/mail-resend.js');
const { createOtpSink } = require('../packages/services/mail-enqueue.js');
const { sealMessage, openMessage } = require('../packages/services/worker-workflows.js');
const deploy = require('../scripts/v51/v5-production-server.cjs');

const KEY = 're_test_key_1234567890';
function fakeFetcher(response) {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return response; };
  return { fetcher, calls };
}
const okResponse = { ok: true, json: async () => ({ id: 'email-1' }) };

test('resend transport: construction refuses a missing key or fetcher', () => {
  assert.throws(() => createResendMailTransport({}), /RESEND_API_KEY_REQUIRED/);
  assert.throws(() => createResendMailTransport({ apiKey: KEY }), /RESEND_FETCHER_REQUIRED/);
});

test('resend transport: sendOtp posts the brand copy with the idempotency key header', async () => {
  const { fetcher, calls } = fakeFetcher(okResponse);
  const transport = createResendMailTransport({ apiKey: KEY, fetcher });
  assert.equal(transport.enabled(), true);
  await transport.sendOtp({ to: 'player@example.com', code: '123456', purpose: 'signup', idempotencyKey: 'mega-xo/signup/abc' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'mega-xo/signup/abc');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['player@example.com']);
  assert.match(body.subject, /Verify your Mega XOXO email/);
  assert.match(body.text, /123456/);
  assert.match(body.html, /123456/);
  /* The reset purpose flips the subject without leaking the purpose elsewhere. */
  await transport.sendOtp({ to: 'player@example.com', code: '654321', purpose: 'reset', idempotencyKey: 'k2' });
  assert.match(JSON.parse(calls[1].init.body).subject, /Reset your Mega XOXO password/);
});

test('resend transport: a non-ok provider reply fails closed as EMAIL_DELIVERY_FAILED', async () => {
  const { fetcher } = fakeFetcher({ ok: false, json: async () => ({ message: 'denied' }) });
  const transport = createResendMailTransport({ apiKey: KEY, fetcher });
  await assert.rejects(() => transport.sendOtp({ to: 'p@example.com', code: '1', purpose: 'signup', idempotencyKey: 'k' }), /EMAIL_DELIVERY_FAILED/);
});

test('resend transport: every method validates its recipient and required fields', async () => {
  const { fetcher } = fakeFetcher(okResponse);
  const transport = createResendMailTransport({ apiKey: KEY, fetcher });
  await assert.rejects(() => transport.sendOtp({ code: '1', purpose: 'signup' }), /EMAIL_RECIPIENT_REQUIRED/);
  await assert.rejects(() => transport.sendOtp({ to: 'p@example.com' }), /EMAIL_CODE_REQUIRED/);
  await assert.rejects(() => transport.sendPasswordChanged({}), /EMAIL_RECIPIENT_REQUIRED/);
  await assert.rejects(() => transport.sendMail({ to: 'p@example.com', subject: 'x' }), /EMAIL_TEXT_REQUIRED/);
});

test('policy factory: disabled keeps the fail-closed stub; enabled requires the secret', () => {
  const disabled = deploy.createMailTransportForPolicy({ email: 'disabled' });
  assert.equal(disabled.enabled(), false);
  assert.throws(() => disabled.sendOtp({}), /OUTBOUND_DISABLED_BY_TARGET/);
  assert.throws(() => deploy.createMailTransportForPolicy({ email: 'enabled' }), /OUTBOUND_EMAIL_KEY_REQUIRED/);
  assert.throws(() => deploy.createMailTransportForPolicy({ email: 'enabled' }, { resendApiKey: KEY, emailFetch: 'invalid' }), /OUTBOUND_EMAIL_FETCH_REQUIRED/);
});

test('policy factory: enabled transport falls back to global fetch when caller omits an override', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return okResponse; };
  try {
    /* The main composition supplies fetch explicitly; preserve the factory's safe default too. */
    const enabled = deploy.createMailTransportForPolicy({ email: 'enabled' }, { resendApiKey: KEY });
    assert.equal(enabled.enabled(), true);
    await enabled.sendOtp({ to: 'player@example.com', code: '123456', purpose: 'reset', idempotencyKey: 'k' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RESEND_ENDPOINT);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('policy factory: explicit fetch injection remains supported', async () => {
  const calls = [];
  const enabled = deploy.createMailTransportForPolicy({ email: 'enabled' }, {
    resendApiKey: KEY,
    emailFetch: async (url, init) => { calls.push({ url, init }); return okResponse; },
  });
  assert.equal(enabled.enabled(), true);
  await enabled.sendOtp({ to: 'player@example.com', code: '123456', purpose: 'signup', idempotencyKey: 'k2' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_ENDPOINT);
});

test('composability: an enabled class is legal only with a declared capability', () => {
  assert.doesNotThrow(() => deploy.assertProviderClassesComposable({ email: 'disabled', storeNotifications: 'disabled', adRewards: 'disabled' }));
  assert.doesNotThrow(() => deploy.assertProviderClassesComposable({ email: 'enabled', storeNotifications: 'disabled', adRewards: 'disabled' }, { email: 'resend' }));
  assert.throws(() => deploy.assertProviderClassesComposable({ email: 'enabled', storeNotifications: 'disabled', adRewards: 'disabled' }), /OUTBOUND_CLASS_UNIMPLEMENTED/);
  assert.throws(() => deploy.assertProviderClassesComposable({ email: 'enabled', storeNotifications: 'enabled', adRewards: 'disabled' }, { email: 'resend' }), /storeNotifications/);
});

test('otp sink: seals the delivery into a versioned envelope with a deterministic id', async () => {
  const SECRET = 'unit-test-mail-secret-0123456789abcdef';
  const inserts = [];
  const pool = { query: async (text, params) => { inserts.push({ text, params }); return { rowCount: 1 }; } };
  const sink = createOtpSink({ pool, secret: SECRET, now: () => 1750000000000 });
  const outcome = await sink({ to: 'player@example.com', code: '998877', purpose: 'signup', idempotencyKey: 'mega-xo/signup/ch1', challengeId: 'ch1' });
  assert.equal(outcome.id, 'mail:otp:signup:ch1');
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].text, /INSERT INTO ops\.outbox/);
  const params = inserts[0].params;
  assert.equal(params[0], 'mail:otp:signup:ch1');
  assert.equal(params[2], 'otp');
  /* The envelope decodes to the sealed body, and the WORKER key (same secret) opens it. */
  const envelope = JSON.parse(params[1]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.businessKey, 'mail:otp:signup:ch1');
  const opened = openMessage(SECRET, envelope.payload);
  assert.deepEqual(opened, { to: 'player@example.com', code: '998877', purpose: 'signup', idempotencyKey: 'mega-xo/signup/ch1' });
  /* A different secret cannot open it - the API and worker must share the configured secret. */
  assert.throws(() => openMessage('unit-test-mail-secret-fedcba9876543210', envelope.payload));
});

test('otp sink: validates the delivery shape before any statement runs', async () => {
  const inserts = [];
  const pool = { query: async (text, params) => { inserts.push(1); return { rowCount: 1 }; } };
  const sink = createOtpSink({ pool, secret: 'unit-test-mail-secret-0123456789abcdef' });
  await assert.rejects(() => sink(null), /MAIL_DELIVERY_REQUIRED/);
  await assert.rejects(() => sink({ code: '1', purpose: 'signup', idempotencyKey: 'k', challengeId: 'c' }), /MAIL_RECIPIENT_REQUIRED/);
  await assert.rejects(() => sink({ to: 'not-an-email', code: '1', purpose: 'signup', idempotencyKey: 'k', challengeId: 'c' }), /MAIL_RECIPIENT_INVALID/);
  await assert.rejects(() => sink({ to: 'p@example.com', purpose: 'signup', idempotencyKey: 'k', challengeId: 'c' }), /MAIL_CODE_REQUIRED/);
  await assert.rejects(() => sink({ to: 'p@example.com', code: '1', purpose: 'signup', challengeId: 'c' }), /MAIL_IDEMPOTENCY_REQUIRED/);
  await assert.rejects(() => sink({ to: 'p@example.com', code: '1', purpose: 'signup', idempotencyKey: 'k' }), /MAIL_CHALLENGE_REQUIRED/);
  assert.equal(inserts.length, 0);
});

test('source integrity: the composition wires the sink and the capability map', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'v5-production-server.cjs'), 'utf8');
  assert.match(source, /otpSink,/);
  assert.match(source, /createOtpSink\(\{ pool: apiPool, secret: otpSecret \}\)/);
  assert.match(source, /providerCapabilities = emailEnabled \? \{ email: 'resend' \} : \{\}/);
  assert.match(source, /createMailTransportForPolicy\(boundary\.outbound,\s*\{\s*resendApiKey,\s*emailFetch: globalThis\.fetch,/);
});
