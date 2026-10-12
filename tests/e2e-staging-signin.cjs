'use strict';
/* tests/e2e-staging-signin.cjs - controlled end-to-end sign-in against the RUNNING staging origin.
 *
 * This is an out-of-band acceptance probe, not a unit test: it talks to a live staging server over
 * loopback HTTP only (never a provider, never V4), drives the shared client's exact account routes,
 * and completes a real PostgreSQL email sign-in by reading the one-time code from the server's
 * staging OTP sink file. Usage:
 *
 *   node tests/e2e-staging-signin.cjs --origin http://127.0.0.1:8081 \
 *     --otp-file /path/to/staging-otp.jsonl --email e2e.<ts>@example.test
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }
const origin = arg('--origin', 'http://127.0.0.1:8081');
const otpFile = arg('--otp-file', null);
const email = arg('--email', `e2e.${Date.now()}@example.test`);
const password = 'staging-e2e-1A';
const ORIGIN = 'https://megaxo.online';

let cookie = null;
function cookieHeader() { return cookie ? cookie.split(';')[0] : null; }

async function call(pathname, { method = 'GET', body = null, withOrigin = true } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookieHeader()) headers.cookie = cookieHeader();
  if (withOrigin && method !== 'GET') headers.origin = ORIGIN;
  const res = await fetch(origin + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of setCookie) { const m = /^([^=]+)=([^;]*)/.exec(line); if (m && m[1] === 'mega_dev_session') cookie = line; }
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, setCookie };
}

function latestCode() {
  const lines = fs.readFileSync(otpFile, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = JSON.parse(lines[i]);
    if (row.to === email && /^[0-9]{6}$/.test(row.code)) return row;
  }
  return null;
}

(async () => {
  const results = [];
  const step = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log((ok ? 'PASS' : 'FAIL'), name, JSON.stringify(detail)); };

  const boot = await call('/api/account/session');
  step('1_bootstrap_session', boot.status === 200 && boot.data.linked === false && typeof boot.data.csrf === 'string' && Boolean(cookieHeader()),
    { status: boot.status, linked: boot.data?.linked, hasCsrf: typeof boot.data?.csrf === 'string', hasCookie: Boolean(cookieHeader()) });

  const before = fs.existsSync(otpFile) ? fs.readFileSync(otpFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const start = await call('/api/account/email', { method: 'POST', body: { action: 'continue', email, password } });
  step('2_signup_continue', start.status === 200 && start.data.verificationRequired === true && !('delivery' in (start.data || {})) && !('code' in (start.data || {})),
    { status: start.status, verificationRequired: start.data?.verificationRequired, leaked: Boolean(start.data && ('delivery' in start.data || 'code' in start.data)) });

  // Wait briefly for the sink line to land, then read the code out of band.
  let delivery = null;
  for (let i = 0; i < 20 && !delivery; i += 1) { delivery = latestCode(); if (!delivery) await new Promise((r) => setTimeout(r, 250)); }
  step('3_otp_delivered_out_of_band', Boolean(delivery), { sink: otpFile, after: before, purpose: delivery?.purpose });
  if (!delivery) { console.log('RESULT', JSON.stringify(results)); process.exit(1); }

  const verify = await call('/api/account/email', { method: 'POST', body: { action: 'verify', challengeId: start.data.challengeId, code: delivery.code } });
  step('4_verify_links_actor', verify.status === 200 && verify.data.linked === true && typeof verify.data.actorId === 'string' && verify.data.actorId.length > 0,
    { status: verify.status, linked: verify.data?.linked, actorId: verify.data?.actorId, csrfRotated: verify.data?.csrf !== undefined });

  const session = await call('/api/account/session');
  step('5_session_reports_linked', session.status === 200 && session.data.linked === true && session.data.actorId === verify.data.actorId && session.data.providers?.email?.linked === true,
    { status: session.status, linked: session.data?.linked, actorId: session.data?.actorId, providers: session.data?.providers });

  const profile = await call('/api/account/profile');
  step('6_linked_profile_readable', profile.status === 200 && profile.data.id === verify.data.actorId, { status: profile.status, id: profile.data?.id, tag: profile.data?.tag });

  const csrfRejected = await call('/api/account/email', { method: 'POST', withOrigin: false, body: { action: 'continue', email, password } });
  step('7_cookie_post_without_origin_rejected', csrfRejected.status === 403, { status: csrfRejected.status, error: csrfRejected.data?.error });

  const foreign = await fetch(origin + '/api/account/email', { method: 'POST', headers: { cookie: cookieHeader(), 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'continue', email, password }) });
  step('8_foreign_origin_rejected', foreign.status === 403, { status: foreign.status });

  const passed = results.filter((r) => r.ok).length;
  console.log('RESULT', JSON.stringify({ origin, email, actorId: verify.data?.actorId, passed, total: results.length }));
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error('E2E_FAILED', err && err.message); process.exit(1); });
