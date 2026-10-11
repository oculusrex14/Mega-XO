'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const appSource = fs.readFileSync(path.join(__dirname, '../apps/web/app.js'), 'utf8').replace(/^import[^;]+;\s*/gm, '');
const accountSource = fs.readFileSync(path.join(__dirname, '../src/account-client.js'), 'utf8');
const helpers = Promise.all([import('../apps/web/ui.js'), import('../apps/web/pages.js'), import('../apps/web/data.js')]);
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Runs the actual website controller and retained cookie/CSRF client against
 * synthetic service replies. The DOM adapter covers controller dispatch only;
 * layout and browser rendering are verified by the separate browser QA. */
async function fixture(handler) {
  const [ui, pages, data] = await helpers;
  const calls = [], listeners = new Map(), nodes = new Map(), storage = new Map();
  const location = { href: 'https://website.test/account', origin: 'https://website.test', pathname: '/account', search: '', assign(url) { this.assigned = url; } };
  const node = () => ({ innerHTML: '', content: '', textContent: '', hidden: false, focus() {}, querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML() {} });
  for (const key of ['#main', '#header', '#footer', '#notification', 'meta[name="description"]']) nodes.set(key, node());
  const document = {
    body: { dataset: {} }, hidden: false,
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [], dispatchEvent() {},
    addEventListener(type, callback) { const list = listeners.get(type) || []; list.push(callback); listeners.set(type, list); },
  };
  const sandbox = {
    ...ui, ...pages, ...data, document, location,
    legalDocuments: {},
    renderPreview: () => '', renderPractice: () => '', renderGame: () => '', mountBoard: () => ({ destroy() {} }),
    AbortController, Headers, URL, URLSearchParams, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { onLine: true }, crypto,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } getAll(key) { return [this.get(key)].filter(Boolean); } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener() {}, scrollTo() {},
    history: { pushState(_state, _title, href) { const url = new URL(href, location.href); Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search }); } },
    async fetch(resource, options = {}) {
      const request = { path: String(resource), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {}, credentials: options.credentials };
      calls.push(request);
      const result = await handler(request);
      return new Response(JSON.stringify(result.body), { status: result.status || 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  sandbox.window = sandbox;
  // Imported read-model functions live in the host realm; inject the sandbox
  // transport so every real controller request reaches this isolated service.
  sandbox.readJSON = (resource, options = {}) => data.readJSON(resource, { ...options, fetcher: sandbox.fetch });
  sandbox.createReadModel = options => data.createReadModel({ ...options, request: sandbox.readJSON });
  const context = vm.createContext(sandbox);
  vm.runInContext(accountSource, context, { filename: 'src/account-client.js' });
  vm.runInContext(appSource, context, { filename: 'apps/web/app.js' });
  async function settle() { for (let i = 0; i < 8; i++) await tick(); }
  await settle();
  const send = (type, element, selector) => {
    const event = { button: 0, preventDefault() { this.defaultPrevented = true; }, target: { closest: candidate => candidate === selector ? element : null } };
    for (const callback of listeners.get(type) || []) callback(event);
  };
  return {
    calls, location,
    state: () => JSON.parse(vm.runInContext('JSON.stringify(context)', context)),
    async submit(view, values) { send('submit', { dataset: { accountForm: view }, values }, '[data-account-form]'); await settle(); },
    async action(action, extra = {}) { send('click', { dataset: { accountAction: action, ...extra } }, '[data-account-action]'); await settle(); },
    destroy() { vm.runInContext('model.destroy();clearInterval(leaderboardTimer);clearInterval(onlineTimer);', context); },
  };
}

const account = { id: 'synthetic-account', name: 'Synthetic player', tag: 'MEGA-SYNTHETIC', tier: 'wood', rating: 600, wallet: { coins: 150, crowns: 0 } };
const guest = { status: 401, body: { error: 'AUTH_REQUIRED' } };
const capabilities = { linked: false, csrf: 'synthetic-csrf', providers: { google: { web: true }, apple: { web: false } } };

test('P21-ACCOUNT-01 browsing only reads the protected profile; sign-in options explicitly bootstrap', async t => {
  const f = await fixture(request => request.path === '/api/account/session' ? { body: capabilities } : guest);
  t.after(() => f.destroy());
  assert.deepEqual(f.calls.map(call => call.path), ['/api/v1/profile']);
  assert.equal(f.state().sessionStatus, 'guest');
  await f.action('options');
  assert.deepEqual(f.calls.map(call => call.path), ['/api/v1/profile', '/api/account/session']);
  assert.equal(f.state().providers.google.web, true);
  assert.equal(f.state().providers.apple.web, false);
});

test('P21-ACCOUNT-02 new email continuation verifies the retained challenge and restores the same profile', async t => {
  let linked = false;
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return linked ? { body: account } : guest;
    if (request.path === '/api/account/session') return { body: capabilities };
    if (request.body?.action === 'continue') return { body: { linked: false, verificationRequired: true, challengeId: 'synthetic-challenge' } };
    if (request.body?.action === 'verify') { linked = true; return { body: { linked: true, profile: account, csrf: 'linked-csrf' } }; }
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  await f.submit('email', { email: 'synthetic@example.test', password: 'synthetic-password-42' });
  assert.equal(f.state().accountView, 'verify');
  const continuation = f.calls.find(call => call.body?.action === 'continue');
  assert.equal(continuation.headers['X-CSRF-Token'], 'synthetic-csrf');
  assert.equal(continuation.credentials, 'same-origin');
  await f.submit('verify', { code: '123456' });
  const verification = f.calls.find(call => call.body?.action === 'verify');
  assert.deepEqual(verification.body, { action: 'verify', challengeId: 'synthetic-challenge', code: '123456' });
  assert.equal(f.state().sessionStatus, 'linked');
  assert.equal(f.state().profile.id, account.id);
  assert.equal(f.state().accountView, 'email');
});

test('P21-ACCOUNT-03 existing email login and logout use the retained client, without a second identity', async t => {
  let linked = false;
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return linked ? { body: account } : guest;
    if (request.path === '/api/account/session') return { body: { ...capabilities, linked, csrf: linked ? 'linked-csrf' : capabilities.csrf } };
    if (request.body?.action === 'continue') { linked = true; return { body: { linked: true, profile: account, csrf: 'linked-csrf' } }; }
    if (request.path === '/api/account/logout') { linked = false; return { body: { linked: false } }; }
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  await f.submit('email', { email: 'synthetic@example.test', password: 'synthetic-password-42' });
  assert.equal(f.state().profile.id, account.id);
  await f.action('logout');
  assert.equal(f.state().profile, null);
  assert.equal(f.state().sessionStatus, 'guest');
  const logout = f.calls.find(call => call.path === '/api/account/logout');
  assert.equal(logout.headers['X-CSRF-Token'], 'linked-csrf');
  assert.deepEqual(logout.body, {});
});

test('P21-ACCOUNT-04 recovery preserves a verified challenge when correcting a rejected password', async t => {
  let linked = false, verified = false;
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return linked ? { body: account } : guest;
    if (request.path === '/api/account/session') return { body: capabilities };
    if (request.body?.action === 'forgot') return { body: { verificationRequired: true, challengeId: 'reset-challenge', message: 'If this email has an account, a recovery code has been requested.' } };
    if (request.body?.action === 'verify') {
      // Matches retained EmailAuth.verify: verified_at challenges cannot verify twice.
      if (verified) return { status: 400, body: { error: 'INVALID_OTP' } };
      verified = true; return { body: { resetReady: true, challengeId: 'reset-challenge' } };
    }
    if (request.body?.action === 'reset') {
      // Production password policy requires both a letter and a number.
      if (!/\d/.test(request.body.password)) return { status: 400, body: { error: 'INVALID_PASSWORD' } };
      linked = true; return { body: { linked: true, profile: account, csrf: 'linked-csrf' } };
    }
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  await f.submit('recover', { email: 'synthetic@example.test' });
  await f.submit('reset', { code: '123456', password: 'letters-only-password', confirmPassword: 'letters-only-password' });
  assert.equal(f.state().sessionStatus, 'guest');
  assert.match(f.state().accountMessage, /ten characters/);
  await f.submit('reset', { code: '123456', password: 'corrected-password-42', confirmPassword: 'corrected-password-42' });
  assert.equal(f.state().sessionStatus, 'linked', 'correcting the password must not reconsume OTP verification');
  assert.equal(f.calls.filter(call => call.body?.action === 'verify').length, 1);
});

test('P21-ACCOUNT-05 provider starts require published capability and use the existing authorization redirect', async t => {
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return guest;
    if (request.path === '/api/account/session') return { body: capabilities };
    if (request.path === '/api/account/start') return { body: { url: 'https://accounts.google.com/synthetic-authorize' } };
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  await f.action('options');
  await f.action('provider', { provider: 'apple' });
  assert.equal(f.calls.filter(call => call.path === '/api/account/start').length, 0);
  await f.action('provider', { provider: 'google' });
  assert.deepEqual(f.calls.find(call => call.path === '/api/account/start').body, { provider: 'google', intent: 'login' });
  assert.equal(f.location.assigned, 'https://accounts.google.com/synthetic-authorize');
});

test('P21-ACCOUNT-06 account continuation does not claim success when the protected profile cannot load', async t => {
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return guest;
    if (request.path === '/api/account/session') return { body: capabilities };
    if (request.body?.action === 'continue') return { body: { linked: true, profile: account, csrf: 'linked-csrf' } };
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  await f.submit('email', { email: 'synthetic@example.test', password: 'synthetic-password-42' });
  assert.equal(f.state().profile, null);
  assert.equal(f.state().sessionStatus, 'guest');
  assert.doesNotMatch(f.state().accountMessage, /profile is ready/, 'a failed protected read must retain its actual account state');
});

test('P21-ACCOUNT-07 explicit options discovers a session linked in another tab', async t => {
  let linked = false;
  const f = await fixture(request => {
    if (request.path === '/api/v1/profile') return linked ? { body: account } : guest;
    if (request.path === '/api/account/session') { linked = true; return { body: { ...capabilities, linked: true, profile: account } }; }
    throw Error('Unexpected fixture request');
  });
  t.after(() => f.destroy());
  assert.equal(f.state().sessionStatus, 'guest');
  await f.action('options');
  assert.equal(f.state().sessionStatus, 'linked', 'an actual linked session should replace the stale guest continuation state');
  assert.equal(f.state().profile.id, account.id);
});
