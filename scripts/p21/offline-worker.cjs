'use strict';

const crypto = require('node:crypto');

const OFFLINE_CACHE_PREFIX = 'mega-xoxo-web-offline-v1:';
const MAX_CACHE_BYTES = 5_900_000;
const PRIVATE_PATH_PARTS = new Set([
  'account', 'accounts', 'admin', 'api', 'auth', 'callback', 'callbacks', 'login',
  'oauth', 'profile', 'profiles', 'private', 'session', 'sessions', 'settings', 'user', 'users',
]);

function validatePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) {
    throw new TypeError(`${label} must be a short root-relative path`);
  }
  if (!value.startsWith('/') || value.startsWith('//') || /[?#\\%\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a plain same-origin path without query or fragment`);
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(value)) {
    throw new TypeError(`${label} contains unsupported path characters`);
  }
  const parts = value.split('/').slice(1);
  if (parts.some((part) => part === '.' || part === '..' || PRIVATE_PATH_PARTS.has(part.toLowerCase()))) {
    throw new TypeError(`${label} contains a private or non-static path segment`);
  }
  return value;
}

function createOfflineWorker(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Offline worker configuration must be an object');
  }
  const { version, assets, navigations, fallback } = input;
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(version)) {
    throw new TypeError('version must be a short safe identifier');
  }
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 160) {
    throw new TypeError('assets must contain between 1 and 160 entries');
  }

  const normalizedAssets = [];
  const seen = new Set();
  for (const [index, asset] of assets.entries()) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new TypeError(`assets[${index}] must be an object`);
    }
    const url = validatePath(asset.url, `assets[${index}].url`);
    if (typeof asset.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(asset.sha256)) {
      throw new TypeError(`assets[${index}].sha256 must be a SHA-256 hex digest`);
    }
    if (seen.has(url)) throw new TypeError(`Duplicate offline asset: ${url}`);
    seen.add(url);
    normalizedAssets.push({ url, sha256: asset.sha256.toLowerCase() });
  }

  if (!navigations || typeof navigations !== 'object' || Array.isArray(navigations)) {
    throw new TypeError('navigations must be a route-to-document object');
  }
  const normalizedNavigations = {};
  for (const [route, documentPath] of Object.entries(navigations)) {
    const safeRoute = validatePath(route, 'navigation route');
    const safeDocument = validatePath(documentPath, `navigation document for ${safeRoute}`);
    if (!seen.has(safeDocument)) {
      throw new TypeError(`Navigation document must be listed in assets: ${safeDocument}`);
    }
    normalizedNavigations[safeRoute] = safeDocument;
  }
  if (Object.keys(normalizedNavigations).length === 0) {
    throw new TypeError('At least one guest navigation route is required');
  }
  const safeFallback = validatePath(fallback, 'fallback');
  if (!seen.has(safeFallback)) throw new TypeError('fallback must be listed in assets');

  const config = {
    version,
    assets: normalizedAssets,
    navigations: normalizedNavigations,
    fallback: safeFallback,
  };
  const configDigest = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const embedded = JSON.stringify(config);
const cacheName = `${OFFLINE_CACHE_PREFIX}${version}:${configDigest}:verified`;

  return `'use strict';
const CONFIG = ${embedded};
const CACHE_NAMESPACE_PREFIX = ${JSON.stringify(OFFLINE_CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const MAX_CACHE_BYTES = ${MAX_CACHE_BYTES};
const ASSET_BY_PATH = new Map(CONFIG.assets.map((asset) => [asset.url, asset]));
const ROUTE_BY_PATH = new Map(Object.entries(CONFIG.navigations));
const ORIGIN = self.location.origin;

function safeHeaders(source) {
  const headers = new Headers(source || undefined);
  for (const name of ['content-length', 'content-encoding', 'set-cookie', 'vary', 'age']) headers.delete(name);
  return headers;
}

async function verifyResponse(response, asset, expectedUrl) {
  if (!response || response.status !== 200 || !response.ok || response.redirected) throw new Error('Offline asset response rejected');
  if (response.type !== 'basic' && response.type !== 'default') throw new Error('Offline asset must be same-origin');
  const actualUrl = response.url || expectedUrl;
  if (new URL(actualUrl, ORIGIN).href !== expectedUrl) throw new Error('Offline asset redirect rejected');
  const cacheControl = (response.headers.get('cache-control') || '').toLowerCase();
  if (/(?:^|,)\\s*(?:no-store|private)(?:\\s*(?:,|$))/.test(cacheControl)) throw new Error('Offline asset cache policy rejected');
  if (response.headers.get('set-cookie')) throw new Error('Offline asset cookie rejected');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CACHE_BYTES)) {
    throw new Error('Offline asset size rejected');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_CACHE_BYTES) throw new Error('Offline asset size rejected');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actualDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actualDigest !== asset.sha256) throw new Error('Offline asset integrity check failed');
  return new Response(bytes, { status: 200, headers: safeHeaders(response.headers) });
}

function assetUrl(asset) {
  return new URL(asset.url, ORIGIN).href;
}

async function readVerifiedCache(cache) {
  let totalBytes = 0;
  for (const asset of CONFIG.assets) {
    const response = await cache.match(new Request(assetUrl(asset), { method: 'GET', credentials: 'omit' }));
    if (!response) throw new Error('Offline cache is incomplete');
    const verified = await verifyResponse(response, asset, assetUrl(asset));
    totalBytes += (await verified.arrayBuffer()).byteLength;
    if (totalBytes > MAX_CACHE_BYTES) throw new Error('Offline cache size rejected');
  }
  const keys = await cache.keys();
  if (keys.length !== CONFIG.assets.length) throw new Error('Offline cache contains unexpected entries');
  return true;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const existing = (await caches.keys()).includes(CACHE_NAME);
    const verified = [];
    let totalBytes = 0;
    for (const asset of CONFIG.assets) {
      const url = assetUrl(asset);
      const response = await fetch(url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
      const safeResponse = await verifyResponse(response, asset, url);
      const size = (await safeResponse.clone().arrayBuffer()).byteLength;
      totalBytes += size;
      if (totalBytes > MAX_CACHE_BYTES) throw new Error('Offline cache size rejected');
      verified.push({ url, response: safeResponse });
    }
    if (existing) {
      const current = await caches.open(CACHE_NAME);
      await readVerifiedCache(current);
      return;
    }
    try {
      const current = await caches.open(CACHE_NAME);
      for (const item of verified) {
        await current.put(new Request(item.url, { method: 'GET', credentials: 'omit' }), item.response.clone());
      }
      await readVerifiedCache(current);
    } catch (error) {
      try { await caches.delete(CACHE_NAME); } catch (_) { /* best-effort removal of this failed candidate only */ }
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = await caches.open(CACHE_NAME);
    await readVerifiedCache(current);
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_NAMESPACE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
  })());
});

async function verifiedNetworkAsset(asset) {
  const url = assetUrl(asset);
  const response = await fetch(url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
  return verifyResponse(response, asset, url);
}

async function cachedAsset(asset) {
  const cache = await caches.open(CACHE_NAME);
  const url = assetUrl(asset);
  const cached = await cache.match(new Request(url, { method: 'GET', credentials: 'omit' }));
  if (cached) {
    try { return await verifyResponse(cached, asset, url); }
    catch (_) { /* Never serve a cache entry that no longer matches its build digest. */ }
  }
  return verifiedNetworkAsset(asset);
}

async function offlineFallback() {
  const asset = ASSET_BY_PATH.get(CONFIG.fallback);
  if (!asset) return new Response('Offline page unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  try {
    const response = await cachedAsset(asset);
    const headers = safeHeaders(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(await response.arrayBuffer(), { status: 503, headers });
  } catch (_) {
    return new Response('Offline page unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (url.origin !== ORIGIN) return;

  const hasQuery = url.search !== '' || url.href.includes('?');
  if (request.mode === 'navigate') {
    const documentPath = !hasQuery ? ROUTE_BY_PATH.get(url.pathname) : undefined;
    if (!documentPath) {
      event.respondWith(fetch(request).catch(() => offlineFallback()));
      return;
    }
    const asset = ASSET_BY_PATH.get(documentPath);
    event.respondWith((async () => {
      try { return await cachedAsset(asset); }
      catch (_) { return offlineFallback(); }
    })());
    return;
  }

  if (hasQuery) return;
  const asset = ASSET_BY_PATH.get(url.pathname);
  if (!asset) return;
  event.respondWith((async () => {
    try { return await cachedAsset(asset); }
    catch (_) { return new Response('Static resource unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } }); }
  })());
});
`;
}

module.exports = { createOfflineWorker, OFFLINE_CACHE_PREFIX, MAX_CACHE_BYTES };
