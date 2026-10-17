'use strict';

const configuredLinks = require('./store-links.json');
const platforms = new Set(['ios', 'android']);

function invalidConfig() { throw Error('INVALID_STORE_LINKS'); }

function listingURL(value, platform) {
  if (value === null) return null;
  if (typeof value !== 'string' || value !== value.trim() || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) return invalidConfig();
  let url;
  try { url = new URL(value); } catch { return invalidConfig(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return invalidConfig();
  if (platform === 'android') {
    if (url.hostname !== 'play.google.com' || url.pathname !== '/store/apps/details') return invalidConfig();
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !['id', 'hl', 'gl'].includes(key)) || new Set(keys).size !== keys.length) return invalidConfig();
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(url.searchParams.get('id') || '')) return invalidConfig();
    if (url.searchParams.has('hl') && !/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(url.searchParams.get('hl'))) return invalidConfig();
    if (url.searchParams.has('gl') && !/^[A-Z]{2}$/.test(url.searchParams.get('gl'))) return invalidConfig();
  } else {
    if (url.hostname !== 'apps.apple.com' || !/^\/(?:[a-z]{2}\/)?app\/(?:[^/]+\/)?id[0-9]+$/.test(url.pathname) || url.search) return invalidConfig();
  }
  return url.href;
}

function validateStoreLinks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidConfig();
  const keys = Object.keys(value);
  if (!Object.hasOwn(value, 'ios') || !Object.hasOwn(value, 'android')) return invalidConfig();
  if (keys.some(key => key !== 'ios' && key !== 'android' && key !== 'androidApk')) return invalidConfig();
  const result = {ios: listingURL(value.ios, 'ios'), android: listingURL(value.android, 'android')};
  // Optional direct Android APK (owner decision: distribute the signed release APK from the
  // website until Play is live). The path is same-origin, the digest/size pin the exact
  // artifact, and the version is display metadata only — never parsed from the binary here.
  if (Object.hasOwn(value, 'androidApk')) {
    const apk = apkEntry(value.androidApk);
    if (apk === null) return invalidConfig();
    result.androidApk = apk;
  }
  return Object.freeze(result);
}

function apkEntry(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidConfig();
  const keys = Object.keys(value);
  if (keys.length !== 5 || !['path', 'sha256', 'versionName', 'versionCode', 'bytes'].every(key => Object.hasOwn(value, key))) return invalidConfig();
  const filePath = typeof value.path === 'string' ? value.path : '';
  if (!/^\/downloads\/android\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(filePath) || filePath.includes('..')) return invalidConfig();
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return invalidConfig();
  if (typeof value.versionName !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.versionName)) return invalidConfig();
  if (!Number.isInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2100000000) return invalidConfig();
  if (!Number.isInteger(value.bytes) || value.bytes < 1000000 || value.bytes > 200000000) return invalidConfig();
  return Object.freeze({path: filePath, sha256: value.sha256, versionName: value.versionName, versionCode: value.versionCode, bytes: value.bytes});
}

function resolveDownload({links = configuredLinks, userAgent = '', platform} = {}) {
  const checked = validateStoreLinks(links);
  if (platform !== undefined && !platforms.has(platform)) return {status: 400, location: null};
  const ua = typeof userAgent === 'string' ? userAgent : '';
  const device = platform || (/Android/i.test(ua) ? 'android' : /iPad|iPhone|iPod/i.test(ua) ? 'ios' : null);
  if (!device) return {status: 303, location: '/download'};
  return checked[device]
    ? {status: 302, location: checked[device]}
    : {status: 303, location: `/download?platform=${device}&unavailable=1`};
}

function createDownloadHandler({links = configuredLinks} = {}) {
  return function downloadHandler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'User-Agent');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const method = request.method || 'GET';
    const finish = (status, message) => {
      response.statusCode = status;
      response.setHeader('Content-Length', Buffer.byteLength(message));
      response.end(method === 'HEAD' ? undefined : message);
    };
    if (!['GET', 'HEAD'].includes(method)) {
      request.resume?.();
      response.setHeader('Allow', 'GET, HEAD');
      return finish(405, 'Use GET or HEAD for download links.\n');
    }
    let url;
    try {
      if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.length > 4096) throw Error('INVALID_QUERY');
      url = new URL(request.url, 'https://download.invalid');
      if ([...url.searchParams.keys()].some(key => key !== 'platform') || url.searchParams.getAll('platform').length > 1) throw Error('INVALID_QUERY');
    } catch { return finish(400, 'Choose ios or android, or omit the platform.\n'); }
    try {
      const result = resolveDownload({links, userAgent: request.headers?.['user-agent'], platform: url.searchParams.has('platform') ? url.searchParams.get('platform') : undefined});
      if (!result.location) return finish(result.status, 'Choose ios or android, or omit the platform.\n');
      response.setHeader('Location', result.location);
      return finish(result.status, 'Opening your download options.\n');
    } catch { return finish(500, 'Download configuration is unavailable.\n'); }
  };
}

module.exports = {validateStoreLinks, resolveDownload, createDownloadHandler};
