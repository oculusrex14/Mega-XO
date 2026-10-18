'use strict';
/* The embedded APK and website share src/community.js, but the APK does not use browser cookies.
 * Guard the real email/OTP UI functions against lost native fields and misleading generic errors. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../src/community.js'), 'utf8');
function extract(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'function markers remain available');
  return source.slice(a, b);
}

test('native email challenge displays the server-masked recipient, never undefined', () => {
  const calls = [];
  const sandbox = {
    emailChallenge: null,
    frame: (...args) => calls.push(args),
    esc: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    btn: label => '<button>' + label + '</button>',
  };
  vm.runInNewContext(extract('function otpForm(', 'function forgotForm('), sandbox);
  sandbox.otpForm({challengeId: 'cid', email: 'a***@example.com'}, 'verify', 'actual@example.com');
  assert.match(calls.at(-1)[1], /a\*\*\*@example\.com/);
  assert.doesNotMatch(calls.at(-1)[1], /actual@example\.com|undefined/);
  sandbox.otpForm({challengeId: 'cid'}, 'reset', 'typed@example.com');
  assert.match(calls.at(-1)[1], /typed@example\.com/);
  sandbox.otpForm({challengeId: 'cid', email: '<img>'}, 'verify');
  assert.match(calls.at(-1)[1], /&lt;img&gt;/);
  assert.doesNotMatch(calls.at(-1)[1], /<img>/);
});

test('embedded app shows actionable safe error codes for native email failures', () => {
  const sandbox = {};
  vm.runInNewContext(extract('function error(e)', 'function announce('), sandbox);
  assert.match(sandbox.error(Error('INVALID_CREDENTIALS')), /Email or password/);
  assert.match(sandbox.error(Error('EMAIL_RESPONSE_INVALID')), /unexpected response/);
  assert.match(sandbox.error(Error('RATE_LIMIT_UNAVAILABLE')), /temporarily unavailable/);
  assert.match(sandbox.error(Error('UPSTREAM_SIGNIN_FAULT')), /code: UPSTREAM_SIGNIN_FAULT/);
  assert.doesNotMatch(sandbox.error(Error('bad response from user@example.com')), /user@example.com/);
});

test('native UI passes the typed recipient only as a privacy-safe fallback', () => {
  assert.match(source, /otpForm\(out,action==='link'\?'link':action==='change'\?'change':'verify',email\)/);
  assert.match(source, /otpForm\(out,'reset',email\)/);
  assert.match(source, /if\(ne&&out\.ok!==true\)throw Error\(out\.error\|\|'NATIVE_SIGNIN_FAILED'\)/);
});

test('APK Continue with email uses the cookie-free native bridge for a first registration', async () => {
  const calls = [], status = [];
  const sandbox = {
    APP: { getContext: () => ({ playing: false }) },
    $: id => ({ '#cEmailAddress': { value: 'first@example.com' }, '#cEmailPassword': { value: 'securepass123' } })[id] || null,
    window: { MegaNativeApi: { email: async input => {
      calls.push(input);
      return { ok: true, verificationRequired: true, challengeId: 'challenge', email: 'f***@example.com' };
    } } },
    API: { request: () => { throw Error('BROWSER_COOKIE_REQUEST_USED'); }, reset: () => calls.push('reset') },
    archiveCurrent: () => calls.push('archive'),
    announce: (...args) => status.push(args),
    otpForm: (...args) => calls.push({ otp: args }),
    error: e => e.message,
    boot: async () => calls.push('boot'),
  };
  vm.runInNewContext(extract('async function emailAuth(', 'async function verifyEmailOtp('), sandbox);
  await sandbox.emailAuth('continue');
  assert.equal(calls[0], 'archive');
  assert.equal(JSON.stringify(calls[1]), JSON.stringify({ action:'continue', email:'first@example.com', password:'securepass123' }));
  assert.equal(calls[2].otp[0].challengeId, 'challenge');
  assert.equal(calls[2].otp[2], 'first@example.com');
  assert.deepEqual(status.map(row => row[1]), [undefined]);
});

test('APK Continue with email restores the linked native session after a password login', async () => {
  const events = [];
  const sandbox = {
    APP: { getContext: () => ({ playing: false }) },
    $: id => ({ '#cEmailAddress': { value: 'existing@example.com' }, '#cEmailPassword': { value: 'securepass123' } })[id] || null,
    window: { MegaNativeApi: { email: async input => {
      events.push(input.action);
      return { ok: true, linked: true, actorId: 'u_existing' };
    } } },
    API: { request: () => { throw Error('BROWSER_COOKIE_REQUEST_USED'); }, reset: () => events.push('reset') },
    archiveCurrent: () => {},
    announce: () => {},
    error: e => e.message,
    boot: async () => events.push('boot'),
    otpForm: () => { throw Error('UNEXPECTED_OTP'); },
  };
  vm.runInNewContext(extract('async function emailAuth(', 'async function verifyEmailOtp('), sandbox);
  await sandbox.emailAuth('continue');
  assert.deepEqual(events, ['continue', 'reset', 'boot']);
});

test('APK email route errors show a coded failure without exposing the destination or password', async () => {
  const failures = [];
  const sandbox = {
    APP: { getContext: () => ({ playing: false }) },
    $: id => ({ '#cEmailAddress': { value: 'hidden@example.com' }, '#cEmailPassword': { value: 'securepass123' } })[id] || null,
    window: { MegaNativeApi: { email: async () => ({ ok: false, error: 'EMAIL_RESPONSE_INVALID', status: 503 }) } },
    API: { request: () => { throw Error('BROWSER_COOKIE_REQUEST_USED'); } },
    archiveCurrent: () => {},
    announce: (...args) => failures.push(args),
    otpForm: () => { throw Error('UNEXPECTED_OTP'); },
    error: e => 'sign-in failed (' + e.message + ')',
  };
  vm.runInNewContext(extract('async function emailAuth(', 'async function verifyEmailOtp('), sandbox);
  await sandbox.emailAuth('continue');
  assert.deepEqual(failures.at(-1), ['sign-in failed (EMAIL_RESPONSE_INVALID)', true]);
  assert.doesNotMatch(failures.at(-1)[0], /hidden@example.com|securepass123/);
});

test('revocation blocks old access refresh but never blocks a new email sign-in', () => {
  const manager = fs.readFileSync(path.resolve(__dirname,
    '../native/android/app/src/main/java/online/megaxo/prototype/MegaNativeSessionManager.kt'), 'utf8');
  const emailStart = manager.indexOf('fun email(body: JSONObject');
  const challengeStart = manager.indexOf('fun challenge(provider:', emailStart);
  assert.ok(emailStart >= 0 && challengeStart > emailStart);
  const emailHandler = manager.slice(emailStart, challengeStart);
  assert.doesNotMatch(emailHandler, /if\s*\(revoked\)/,
    'a revoked previous session cannot lock out a fresh email/password or OTP flow');
  assert.match(manager, /fun refresh\(complete: \(Outcome\) -> Unit\)[\s\S]*?if \(revoked\)/,
    'old revoked credentials must remain blocked on refresh');
  assert.match(manager, /private fun revokeEverything\(\)[\s\S]*?revoked = true/,
    'terminal refresh revocation must still clear and fence the old credentials');
  assert.match(manager, /session = Session\(access, refresh,[\s\S]*?revoked = false/,
    'a successful verified login clears the stale revocation state');
});
