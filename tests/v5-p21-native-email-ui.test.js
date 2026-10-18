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
