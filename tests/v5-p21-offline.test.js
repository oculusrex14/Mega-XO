'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { test } = require('node:test');
const { createOfflineWorker, OFFLINE_CACHE_PREFIX, MAX_CACHE_BYTES } = require('../scripts/p21/offline-worker.cjs');

const ORIGIN = 'https://offline.test';
const BODY = new Map([
  ['/pages/game.html', '<!doctype html><title>Guest game</title>'],
  ['/pages/offline.html', '<!doctype html><title>Offline</title>'],
  ['/pages/how-to-play.html', '<!doctype html><title>How to play</title>'],
  ['/assets/app.js', 'window.publicGame = true;'],
]);

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function config(version = 'p21-test', source = BODY) {
  const assets = [...source.entries()].map(([url, body]) => ({ url, sha256: digest(body) }));
  return {
    version,
    assets,
    navigations: {
      '/game': '/pages/game.html',
      '/offline': '/pages/offline.html',
      '/how-to-play': '/pages/how-to-play.html',
    },
    fallback: '/pages/offline.html',
  };
}

function responseFor(url, body, headers = {}) {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    ok: true,
    redirected: false,
    type: 'basic',
    url: new URL(url, ORIGIN).href,
    headers: new Headers(headers),
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

class FakeCache {
  constructor(name, failPut = false) {
    this.name = name;
    this.entries = new Map();
    this.failPut = failPut;
  }

  async match(request) {
    const key = typeof request === 'string' ? request : request.url;
    const response = this.entries.get(key);
    return response?.clone();
  }

  async put(request, response) {
    if (this.failPut) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    this.entries.set(typeof request === 'string' ? request : request.url, response.clone());
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class FakeCacheStorage {
  constructor({ failPutFor = '' } = {}) {
    this.values = new Map();
    this.failPutFor = failPutFor;
  }

  async open(name) {
    if (!this.values.has(name)) this.values.set(name, new FakeCache(name, name === this.failPutFor));
    return this.values.get(name);
  }

  async keys() { return [...this.values.keys()]; }
  async delete(name) { return this.values.delete(name); }
}

function makeHarness({ bodies = BODY, headers = {}, failNetwork = false, failPutFor = '' } = {}) {
  const listeners = new Map();
  const cacheStorage = new FakeCacheStorage({ failPutFor });
  const fetchCalls = [];
  const networkFetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN) : new URL(input.url);
    fetchCalls.push({ path: url.pathname, search: url.search, init });
    if (failNetwork) throw new TypeError('network unavailable');
    if (bodies.has(url.pathname)) return responseFor(url.href, bodies.get(url.pathname), headers[url.pathname] || {});
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/account') || url.pathname.startsWith('/auth/')) {
      return new Response('PRIVATE-SENTINEL', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('network guest page', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const source = createOfflineWorker(config());
  const sandbox = {
    self,
    caches: cacheStorage,
    fetch: networkFetch,
    crypto: crypto.webcrypto,
    Request,
    Response,
    Headers,
    URL,
    Uint8Array,
    Map,
    Object,
    Array,
    Error,
    TypeError,
    Promise,
  };
  vm.runInNewContext(source, sandbox, { filename: 'offline-sw.js' });
  return { listeners, cacheStorage, fetchCalls, networkFetch, source, bodies };
}

async function dispatch(harness, type, properties = {}) {
  const waits = [];
  let responsePromise;
  const event = {
    ...properties,
    waitUntil(promise) { waits.push(Promise.resolve(promise)); },
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
  };
  harness.listeners.get(type)(event);
  await Promise.all(waits);
  return responsePromise ? responsePromise : undefined;
}

async function installAndActivate(harness) {
  await dispatch(harness, 'install');
  await dispatch(harness, 'activate');
}

function fetchEvent(request) {
  return { request };
}

function navigationRequest(path) {
  const request = new Request(new URL(path, ORIGIN));
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

test('generator rejects malformed, external, dynamic, or unmanifested paths', () => {
  const valid = config();
  assert.throws(() => createOfflineWorker({ ...valid, version: '../bad' }), /version/);
  assert.throws(() => createOfflineWorker({ ...valid, assets: [{ url: 'https://evil.test/a.js', sha256: 'a'.repeat(64) }] }), /same-origin/);
  assert.throws(() => createOfflineWorker({ ...valid, assets: [{ url: '/assets/app.js?token=x', sha256: 'a'.repeat(64) }] }), /without query/);
  assert.throws(() => createOfflineWorker({ ...valid, assets: [{ url: '/api/profile', sha256: 'a'.repeat(64) }] }), /private/);
  assert.throws(() => createOfflineWorker({ ...valid, navigations: { '/game': '/pages/not-listed.html' } }), /listed in assets/);
  assert.throws(() => createOfflineWorker({ ...valid, assets: [{ url: '/assets/app.js', sha256: 'bad' }] }), /SHA-256/);
});

test('install verifies all static bytes before publishing one bounded cache', async () => {
  const harness = makeHarness();
  await dispatch(harness, 'install');
  const names = await harness.cacheStorage.keys();
  assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(OFFLINE_CACHE_PREFIX));
  const cache = await harness.cacheStorage.open(names[0]);
  assert.equal((await cache.keys()).length, BODY.size);
  assert.ok(harness.fetchCalls.every(({ init }) => init.cache === 'reload' && init.credentials === 'omit' && init.redirect === 'error'));
  assert.ok(MAX_CACHE_BYTES < 6_000_000);
  assert.doesNotMatch(harness.source, /skipWaiting\s*\(/);
  assert.doesNotMatch(harness.source, /clients\.claim\s*\(/);
  await dispatch(harness, 'activate');
});

test('mixed private/API/callback traffic stays network-only and is never cached', async () => {
  const harness = makeHarness();
  await installAndActivate(harness);
  const apiRequest = new Request(`${ORIGIN}/api/profile`);
  const apiResponse = await harness.networkFetch(apiRequest);
  assert.equal(await apiResponse.text(), 'PRIVATE-SENTINEL');
  assert.equal(await dispatch(harness, 'fetch', { request: apiRequest }), undefined);

  const accountResponse = await dispatch(harness, 'fetch', { request: navigationRequest('/account') });
  assert.equal(await accountResponse.text(), 'PRIVATE-SENTINEL');
  const callback = await dispatch(harness, 'fetch', { request: navigationRequest('/auth/callback?code=private-marker') });
  assert.equal(await callback.text(), 'PRIVATE-SENTINEL');
  const queryAsset = await dispatch(harness, 'fetch', { request: new Request(`${ORIGIN}/assets/app.js?profile=private-marker`) });
  assert.equal(queryAsset, undefined);

  const cacheName = (await harness.cacheStorage.keys()).find((name) => name.startsWith(OFFLINE_CACHE_PREFIX));
  const cachedUrls = (await (await harness.cacheStorage.open(cacheName)).keys()).map((request) => new URL(request.url).pathname);
  assert.deepEqual(cachedUrls.sort(), [...BODY.keys()].sort());
  assert.ok(!cachedUrls.some((path) => /api|account|auth|profile|callback/.test(path)));
});

test('known routes use the verified version; offline unknown navigation gets an honest guest 503', async () => {
  const bodies = new Map(BODY);
  const harness = makeHarness({ bodies });
  await installAndActivate(harness);
  harness.fetchCalls.length = 0;
  const game = await dispatch(harness, 'fetch', { request: navigationRequest('/game') });
  assert.match(await game.text(), /Guest game/);
  assert.equal(harness.fetchCalls.length, 0);
  bodies.set('/assets/app.js', 'changed online bytes must not replace the active version');
  const asset = await dispatch(harness, 'fetch', { request: new Request(`${ORIGIN}/assets/app.js`) });
  assert.equal(await asset.text(), BODY.get('/assets/app.js'));
  assert.equal(harness.fetchCalls.length, 0);
});

test('modified cached bytes are never served and are not written back over the prior cache', async () => {
  const harness = makeHarness();
  await installAndActivate(harness);
  const cacheName = (await harness.cacheStorage.keys())[0];
  const cache = await harness.cacheStorage.open(cacheName);
  const key = new Request(`${ORIGIN}/assets/app.js`);
  await cache.put(key, new Response('PRIVATE-SENTINEL', { status: 200 }));
  harness.fetchCalls.length = 0;
  const response = await dispatch(harness, 'fetch', { request: new Request(`${ORIGIN}/assets/app.js`) });
  assert.equal(await response.text(), BODY.get('/assets/app.js'));
  assert.equal(harness.fetchCalls.length, 1);
  const stillTampered = await cache.match(key);
  assert.equal(await stillTampered.text(), 'PRIVATE-SENTINEL');
});

test('offline fallback returns static guest content with status 503 and no-store; API errors remain network failures', async () => {
  const harness = makeHarness();
  await installAndActivate(harness);
  const originalFetch = harness.networkFetch;
  // Runtime failure only; installation has already completed from verified static bytes.
  const runtimeFetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input, ORIGIN) : new URL(input.url);
    if (url.pathname.startsWith('/api/')) throw new TypeError('network unavailable');
    if (url.pathname === '/unknown') throw new TypeError('network unavailable');
    return originalFetch(input, init);
  };
  const fetchListener = harness.listeners.get('fetch');
  const runtimeSandbox = {
    self: { location: { origin: ORIGIN }, registration: { scope: `${ORIGIN}/` }, addEventListener(type, listener) { this.listeners.set(type, listener); }, listeners: harness.listeners },
    caches: harness.cacheStorage,
    fetch: runtimeFetch,
    crypto: crypto.webcrypto,
    Request, Response, Headers, URL, Uint8Array, Map, Object, Array, Error, TypeError, Promise,
  };
  // Re-evaluate a worker bound to the runtime network seam, sharing only the known static cache.
  vm.runInNewContext(createOfflineWorker(config()), runtimeSandbox, { filename: 'offline-sw-runtime.js' });
  assert.ok(fetchListener);

  const unknown = await dispatch(harness, 'fetch', { request: navigationRequest('/unknown') });
  assert.equal(unknown.status, 503);
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.match(await unknown.text(), /Offline/);
  const api = new Request(`${ORIGIN}/api/profile`);
  const apiEvent = fetchEvent(api);
  let intercepted = false;
  apiEvent.respondWith = () => { intercepted = true; };
  harness.listeners.get('fetch')(apiEvent);
  assert.equal(intercepted, false);
});

test('digest, no-store, byte-limit, and cache-put failures remove only a failed new cache', async (t) => {
  const oldName = `${OFFLINE_CACHE_PREFIX}prior:abc:verified`;

  await t.test('digest mismatch preserves prior cache', async () => {
    const changed = new Map(BODY);
    changed.set('/assets/app.js', 'tampered public bytes');
    const harness = makeHarness({ bodies: changed });
    await harness.cacheStorage.open(oldName);
    await assert.rejects(dispatch(harness, 'install'), /integrity/);
    assert.deepEqual(await harness.cacheStorage.keys(), [oldName]);
  });

  await t.test('no-store response preserves prior cache', async () => {
    const harness = makeHarness({ headers: { '/assets/app.js': { 'cache-control': 'public, no-store' } } });
    await harness.cacheStorage.open(oldName);
    await assert.rejects(dispatch(harness, 'install'), /cache policy/);
    assert.deepEqual(await harness.cacheStorage.keys(), [oldName]);
  });

  await t.test('aggregate response size cap preserves prior cache', async () => {
    const large = new Map(BODY);
    const exact = 'x'.repeat(5_899_950);
    large.set('/assets/app.js', exact);
    const oversizedConfig = config();
    oversizedConfig.assets = [...large.entries()].map(([url, body]) => ({ url, sha256: digest(body) }));
    const harness = makeHarness({ bodies: large });
    // Build a worker from the alternate manifest and exercise its actual install handler.
    const old = await harness.cacheStorage.open(oldName);
    assert.ok(old);
    const listeners = harness.listeners;
    const source = createOfflineWorker(oversizedConfig);
    const sandbox = { self: { location: { origin: ORIGIN }, addEventListener: (type, listener) => listeners.set(type, listener) }, caches: harness.cacheStorage, fetch: harness.networkFetch, crypto: crypto.webcrypto, Request, Response, Headers, URL, Uint8Array, Map, Object, Array, Error, TypeError, Promise };
    vm.runInNewContext(source, sandbox);
    await assert.rejects(dispatch(harness, 'install'), /size/);
    assert.deepEqual((await harness.cacheStorage.keys()).filter((name) => name !== oldName), []);
  });

  await t.test('cache quota failure removes candidate and preserves prior cache', async () => {
    const manifest = config('quota-failure');
    const configDigest = digest(JSON.stringify({ version: manifest.version, assets: manifest.assets, navigations: manifest.navigations, fallback: manifest.fallback }));
    const candidateName = `${OFFLINE_CACHE_PREFIX}${manifest.version}:${configDigest}:verified`;
    const harness = makeHarness({ failPutFor: candidateName });
    await harness.cacheStorage.open(oldName);
    const source = createOfflineWorker(manifest);
    vm.runInNewContext(source, { self: { location: { origin: ORIGIN }, addEventListener: (type, listener) => harness.listeners.set(type, listener) }, caches: harness.cacheStorage, fetch: harness.networkFetch, crypto: crypto.webcrypto, Request, Response, Headers, URL, Uint8Array, Map, Object, Array, Error, TypeError, Promise });
    await assert.rejects(dispatch(harness, 'install'), /quota/i);
    assert.deepEqual(await harness.cacheStorage.keys(), [oldName]);
  });
});

test('new version preserves old cache until activation, then removes only this feature namespace', async () => {
  const harness = makeHarness();
  await installAndActivate(harness);
  const oldNames = await harness.cacheStorage.keys();
  const secondSource = createOfflineWorker(config('p21-next'));
  vm.runInNewContext(secondSource, { self: { location: { origin: ORIGIN }, addEventListener: (type, listener) => harness.listeners.set(type, listener) }, caches: harness.cacheStorage, fetch: harness.networkFetch, crypto: crypto.webcrypto, Request, Response, Headers, URL, Uint8Array, Map, Object, Array, Error, TypeError, Promise });
  await dispatch(harness, 'install');
  const beforeActivation = await harness.cacheStorage.keys();
  assert.equal(beforeActivation.length, 2);
  assert.ok(oldNames.every((name) => beforeActivation.includes(name)));
  assert.ok(beforeActivation.some((name) => name.includes(':p21-next:')));
  await dispatch(harness, 'activate');
  const currentNames = await harness.cacheStorage.keys();
  assert.equal(currentNames.length, 1);
  assert.ok(currentNames[0].includes(':p21-next:'));
});

function mockEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of [...(listeners.get(type) || [])]) listener({ type }); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

function mockWorker(script, state) {
  return Object.assign(mockEventTarget(), { scriptURL: new URL(script, ORIGIN).href, state });
}

function mockRegistration({ script = '/offline-sw.js', waiting = false, installing = false, active = true } = {}) {
  return Object.assign(mockEventTarget(), {
    scope: `${ORIGIN}/`,
    active: active ? mockWorker(script, 'activated') : null,
    waiting: waiting ? mockWorker(script, 'installed') : null,
    installing: installing ? mockWorker(script, 'installing') : null,
    unregisterCalls: 0,
    async unregister() { this.unregisterCalls += 1; return true; },
  });
}

function installClientGlobals({ registration = null, cacheNames = [], controller = null, secure = true } = {}) {
  const deleted = [];
  const registerCalls = [];
  const fakeCaches = {
    async keys() { return [...cacheNames]; },
    async delete(name) { deleted.push(name); return true; },
  };
  const serviceWorker = {
    controller,
    async getRegistration() { return registration; },
    async register(path, options) { registerCalls.push({ path, options }); return registration; },
  };
  const fakeWindow = {
    isSecureContext: secure,
    location: { href: `${ORIGIN}/game`, origin: ORIGIN, hostname: 'offline.test' },
    navigator: { serviceWorker },
    caches: fakeCaches,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow });
  return {
    fakeWindow, serviceWorker, deleted, registerCalls,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else delete globalThis.window;
    },
  };
}

test('client inspection is local and read-only; explicit preparation registers the exact root worker', async () => {
  const client = await import('../apps/web/offline.js');
  const stateEnv = installClientGlobals({ cacheNames: [`${OFFLINE_CACHE_PREFIX}p21:test:verified`] });
  try {
    const state = await client.getOfflineState();
    assert.equal(state.status, 'absent');
    assert.equal(state.canRemove, true);
    assert.equal(stateEnv.registerCalls.length, 0);

    let registration = null;
    stateEnv.serviceWorker.getRegistration = async () => registration;
    stateEnv.serviceWorker.register = async (path, options) => {
      stateEnv.registerCalls.push({ path, options });
      registration = mockRegistration();
      return registration;
    };
    const prepared = await client.prepareOffline();
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.reloadRequired, true);
    assert.match(prepared.message,/Reload this page once/);
    assert.deepEqual(stateEnv.registerCalls[0], { path: '/offline-sw.js', options: { scope: '/', updateViaCache: 'none' } });
  } finally {
    stateEnv.restore();
  }
});

test('client refuses to overwrite another root worker and reports an existing waiting update', async () => {
  const client = await import('../apps/web/offline.js');
  const conflict = mockRegistration({ script: '/other-worker.js' });
  const conflictEnv = installClientGlobals({ registration: conflict });
  try {
    const result = await client.prepareOffline();
    assert.equal(result.status, 'conflict');
    assert.equal(result.canRemove, false);
    assert.equal(conflictEnv.registerCalls.length, 0);
  } finally { conflictEnv.restore(); }

  const waiting = mockRegistration({ waiting: true });
  const waitingEnv = installClientGlobals({ registration: waiting, controller: {} });
  waitingEnv.serviceWorker.register = async () => waiting;
  try {
    const result = await client.prepareOffline();
    assert.equal(result.status, 'waiting');
    assert.equal(result.reloadRequired, false);
  } finally { waitingEnv.restore(); }

  const mixed = mockRegistration();
  mixed.waiting = { scriptURL: new URL('/another-worker.js', ORIGIN).href };
  const mixedEnv = installClientGlobals({ registration: mixed });
  try {
    const result = await client.prepareOffline();
    assert.equal(result.status, 'conflict');
    assert.equal(mixedEnv.registerCalls.length, 0);
    const removed = await client.removeOffline();
    assert.equal(removed.status, 'conflict');
    assert.equal(removed.canRemove, false);
    assert.equal(mixed.unregisterCalls, 0);
  } finally { mixedEnv.restore(); }
});

test('client removal unregisters only its own worker and deletes only its cache namespace', async () => {
  const client = await import('../apps/web/offline.js');
  const own = mockRegistration();
  const env = installClientGlobals({ registration: own, cacheNames: [
    `${OFFLINE_CACHE_PREFIX}p21:abc:verified`,
    'another-feature-cache',
  ] });
  try {
    const result = await client.removeOffline();
    assert.equal(result.status, 'absent');
    assert.equal(result.canRemove, false);
    assert.equal(own.unregisterCalls, 1);
    assert.deepEqual(env.deleted, [`${OFFLINE_CACHE_PREFIX}p21:abc:verified`]);
  } finally { env.restore(); }
});

test('owned worker without its verified cache stays removable and can recover through remove then explicit prepare', async () => {
  const client = await import('../apps/web/offline.js');
  const first = mockRegistration();
  let registration = first;
  const cacheNames = [];
  const env = installClientGlobals({ registration: first, cacheNames });
  env.serviceWorker.getRegistration = async () => registration;
  env.serviceWorker.register = async () => registration;
  first.unregister = async () => {
    first.unregisterCalls += 1;
    registration = null;
    return true;
  };

  try {
    const state = await client.getOfflineState();
    assert.equal(state.status, 'absent');
    assert.equal(state.canRemove, true);

    const attempted = await client.prepareOffline();
    assert.equal(attempted.status, 'unavailable');
    assert.equal(attempted.canRemove, true);

    const removed = await client.removeOffline();
    assert.equal(removed.status, 'absent');
    assert.equal(removed.canRemove, false);
    assert.equal(first.unregisterCalls, 1);

    const replacement = mockRegistration();
    env.serviceWorker.register = async () => {
      registration = replacement;
      cacheNames.push(`${OFFLINE_CACHE_PREFIX}p21-recovered:abc:verified`);
      return replacement;
    };
    const restored = await client.prepareOffline();
    assert.equal(restored.status, 'ready');
    assert.equal(restored.canRemove, true);
  } finally { env.restore(); }
});

test('failed unregister is not reported as cleanup and leaves owned cache in place', async () => {
  const client = await import('../apps/web/offline.js');
  const own = mockRegistration();
  own.unregister = async () => { own.unregisterCalls += 1; return false; };
  const cacheName = `${OFFLINE_CACHE_PREFIX}p21:abc:verified`;
  const env = installClientGlobals({ registration: own, cacheNames: [cacheName] });
  try {
    const result = await client.removeOffline();
    assert.equal(result.status, 'ready');
    assert.equal(result.canRemove, true);
    assert.match(result.message, /could not be removed/);
    assert.deepEqual(env.deleted, []);
  } finally { env.restore(); }
});

test('preparation errors inherit local removability without contacting the network', async () => {
  const client = await import('../apps/web/offline.js');
  const own = mockRegistration();
  const env = installClientGlobals({ registration: own });
  env.serviceWorker.register = async () => { throw new DOMException('registration blocked', 'NotAllowedError'); };
  try {
    const result = await client.prepareOffline();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.canRemove, true);
    assert.match(result.message, /did not allow/);
  } finally { env.restore(); }
});

test('first install may pass through waiting before it activates; it is never misreported as an update', async () => {
  const client = await import('../apps/web/offline.js');
  const candidate = mockRegistration({ active: false });
  const cacheNames = [`${OFFLINE_CACHE_PREFIX}p21-first:abc:verified`];
  const env = installClientGlobals({ cacheNames });
  let registration = null;
  env.serviceWorker.getRegistration = async () => registration;
  env.serviceWorker.register = async () => {
    registration = candidate;
    return candidate;
  };

  try {
    const preparing = client.prepareOffline();
    await new Promise((resolve) => setImmediate(resolve));
    const displaced = mockWorker('/offline-sw.js', 'installing');
    candidate.installing = displaced;
    candidate.dispatch('updatefound');
    const worker = mockWorker('/offline-sw.js', 'installing');
    candidate.installing = worker;
    candidate.dispatch('updatefound');
    assert.equal(displaced.listenerCount('statechange'), 0);
    assert.equal(worker.listenerCount('statechange'), 1);

    worker.state = 'installed';
    candidate.installing = null;
    candidate.waiting = worker;
    candidate.dispatch('updatefound');
    const intermediate = await client.getOfflineState();
    assert.equal(intermediate.status, 'preparing');
    assert.doesNotMatch(intermediate.message, /open tabs to close/);
    assert.equal(candidate.listenerCount('updatefound'), 1);

    candidate.waiting = null;
    candidate.active = worker;
    worker.state = 'activating';
    worker.dispatch('statechange');
    worker.state = 'activated';
    worker.dispatch('statechange');

    const result = await preparing;
    assert.equal(result.status, 'ready');
    assert.equal(result.reloadRequired, true);
    assert.equal(candidate.listenerCount('updatefound'), 0);
    assert.equal(worker.listenerCount('statechange'), 0);
  } finally { env.restore(); }
});

test('fast failed install with a disappeared registration is failure and preserves the prior verified copy', async () => {
  const client = await import('../apps/web/offline.js');
  const candidate = mockRegistration({ active: false });
  const priorCache = `${OFFLINE_CACHE_PREFIX}p21-prior:abc:verified`;
  const env = installClientGlobals({ cacheNames: [priorCache] });
  let registration = null;
  env.serviceWorker.getRegistration = async () => registration;
  env.serviceWorker.register = async () => {
    registration = candidate;
    // Model a fast failed install whose registration vanished before the UI can inspect it.
    registration = null;
    return candidate;
  };

  try {
    const result = await client.prepareOffline();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.canRemove, true);
    assert.equal(result.version, 'p21-prior');
    assert.match(result.message, /previously saved verified copy was left in place/);
    assert.deepEqual(env.deleted, []);
    assert.equal(candidate.listenerCount('updatefound'), 0);
  } finally { env.restore(); }
});

test('a known empty registration from a fast failed install remains removable', async () => {
  const client = await import('../apps/web/offline.js');
  const candidate = mockRegistration({ active: false });
  const env = installClientGlobals();
  let registration = null;
  env.serviceWorker.getRegistration = async () => registration;
  env.serviceWorker.register = async () => {
    registration = candidate;
    return candidate;
  };

  try {
    const failed = await client.prepareOffline();
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.canRemove, true);
    assert.match(failed.message, /failed its integrity or storage checks/);
    assert.equal(candidate.listenerCount('updatefound'), 0);

    const removed = await client.removeOffline();
    assert.equal(removed.status, 'absent');
    assert.equal(removed.canRemove, false);
    assert.equal(candidate.unregisterCalls, 1);
    assert.deepEqual(env.deleted, []);
  } finally { env.restore(); }
});

test('timeout rechecks local state to distinguish ready, preparing, and absent without deleting caches', async (t) => {
  const client = await import('../apps/web/offline.js');
  const nativeSetTimeout = globalThis.setTimeout;
  const withShortTimeouts = async (run) => {
    globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, Math.min(delay, 25), ...args);
    try { await run(); } finally { globalThis.setTimeout = nativeSetTimeout; }
  };

  await t.test('completed worker without a delivered statechange is ready and asks for manual reload', async () => {
    const candidate = mockRegistration({ active: false, installing: true });
    const worker = candidate.installing;
    const env = installClientGlobals({ cacheNames: [`${OFFLINE_CACHE_PREFIX}p21-complete:abc:verified`] });
    let registration = null;
    env.serviceWorker.getRegistration = async () => registration;
    env.serviceWorker.register = async () => { registration = candidate; return candidate; };
    try {
      await withShortTimeouts(async () => {
        const preparing = client.prepareOffline();
        await new Promise((resolve) => nativeSetTimeout(resolve, 5));
        candidate.installing = null;
        candidate.active = worker;
        worker.state = 'activated';
        // Intentionally omit statechange; the timeout path must read registration/cache state.
        const result = await preparing;
        assert.equal(result.status, 'ready');
        assert.equal(result.reloadRequired, true);
        assert.equal(worker.listenerCount('statechange'), 0);
      });
      assert.deepEqual(env.deleted, []);
    } finally { env.restore(); }
  });

  await t.test('pending first install stays preparing instead of waiting for other tabs', async () => {
    const candidate = mockRegistration({ active: false, installing: true });
    const env = installClientGlobals();
    let registration = null;
    env.serviceWorker.getRegistration = async () => registration;
    env.serviceWorker.register = async () => { registration = candidate; return candidate; };
    try {
      await withShortTimeouts(async () => {
        const result = await client.prepareOffline();
        assert.equal(result.status, 'preparing');
        assert.equal(result.canRemove, true);
        assert.match(result.message, /still being prepared/);
      });
      assert.equal(candidate.installing.listenerCount('statechange'), 0);
      assert.deepEqual(env.deleted, []);
    } finally { env.restore(); }
  });

  await t.test('disappeared registration reports failure while retaining the previous cache', async () => {
    const candidate = mockRegistration({ active: false, installing: true });
    const priorCache = `${OFFLINE_CACHE_PREFIX}p21-preserved:abc:verified`;
    const env = installClientGlobals({ cacheNames: [priorCache] });
    let registration = null;
    env.serviceWorker.getRegistration = async () => registration;
    env.serviceWorker.register = async () => { registration = candidate; return candidate; };
    try {
      await withShortTimeouts(async () => {
        const preparing = client.prepareOffline();
        await new Promise((resolve) => nativeSetTimeout(resolve, 5));
        candidate.installing = null;
        registration = null;
        const result = await preparing;
        assert.equal(result.status, 'unavailable');
        assert.equal(result.canRemove, true);
        assert.equal(result.version, 'p21-preserved');
        assert.match(result.message, /previously saved verified copy was left in place/);
      });
      assert.deepEqual(env.deleted, []);
    } finally { env.restore(); }
  });
});

