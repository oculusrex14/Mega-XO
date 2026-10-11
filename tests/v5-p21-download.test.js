'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {validateStoreLinks, resolveDownload, createDownloadHandler} = require('../apps/web/download-config.cjs');
const configuredLinks = require('../apps/web/store-links.json');
const api = import('../apps/web/api/download.js');
const browser = import('../apps/web/downloads.js');

// Synthetic URL-format fixtures only. No store URL is populated for launch.
const listings = {
  android: 'https://play.google.com/store/apps/details?id=test.example.synthetic',
  ios: 'https://apps.apple.com/us/app/synthetic-fixture/id1234567890',
};
const agents = {
  android: 'Mozilla/5.0 (Linux; Android 15; Synthetic Phone) AppleWebKit/537.36 Chrome/132.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132.0 Safari/537.36',
};
const text = value => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

async function loopback(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const port = server.address().port;
  return (route = '/api/download', options = {}) => new Promise((resolve, reject) => {
    const headers = { connection: 'close', ...(options.headers || {}) };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: options.method || 'GET',
      headers,
      agent: false
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: {
            get: name => res.headers[name.toLowerCase()] ?? null
          },
          text: async () => body
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('P21-DOWNLOAD-01 browser device detection handles mobile, desktop and iPadOS desktop Safari', async () => {
  const {detectDownloadPlatform, downloadHref} = await browser;
  assert.equal(detectDownloadPlatform({userAgent: agents.android, platform: 'Linux armv8l'}), 'android');
  for (const ua of [agents.iphone, agents.ipad]) assert.equal(detectDownloadPlatform({userAgent: ua}), 'ios');
  assert.equal(detectDownloadPlatform({userAgent: agents.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5}), 'ios');
  assert.equal(detectDownloadPlatform({userAgent: agents.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 0}), 'desktop');
  assert.equal(detectDownloadPlatform({userAgent: agents.desktop, platform: 'Win32', maxTouchPoints: 10}), 'desktop');
  assert.equal(detectDownloadPlatform(), 'desktop');
  assert.equal(downloadHref('android'), '/api/download?platform=android');
  assert.equal(downloadHref('ios'), '/api/download?platform=ios');
  for (const device of ['desktop', undefined, 'https://evil.example']) assert.equal(downloadHref(device), '/api/download');
});

test('P21-DOWNLOAD-02 chooser has truthful launch status and web play remains available', async () => {
  const {renderDownloadPage} = await browser;
  assert.deepEqual(configuredLinks, {ios: null, android: null});
  const html = renderDownloadPage({storeLinks: configuredLinks, query: new URLSearchParams('platform=ios&unavailable=1')});
  assert.equal((html.match(/<h1/g) || []).length, 1);
  assert.equal((html.match(/Coming soon/g) || []).length, 2);
  assert.match(html, /href="\/api\/download\?platform=ios"/);
  assert.match(html, /href="\/api\/download\?platform=android"/);
  assert.match(html, /href="\/game"/);
  assert.match(text(html), /iPhone and iPad store listing is not available yet/);
  assert.doesNotMatch(html, /href="https:|\.apk|\.ipa|Download on the App Store/);
  const ready = renderDownloadPage({storeLinks: listings, platform: 'android'});
  assert.doesNotMatch(ready, /Coming soon|href="https:/);
  assert.match(ready, /For your device/);
  assert.match(ready, /Store link available/);
});

test('P21-DOWNLOAD-03 only official listing configuration is accepted', () => {
  assert.deepEqual(validateStoreLinks(listings), listings);
  assert.deepEqual(validateStoreLinks(configuredLinks), configuredLinks);
  assert.equal(validateStoreLinks({ios: 'https://apps.apple.com/app/id1234567890', android: null}).ios, 'https://apps.apple.com/app/id1234567890');
  assert.equal(validateStoreLinks({ios: null, android: listings.android + '&hl=en&gl=IN'}).android, listings.android + '&hl=en&gl=IN');
  const refused = [
    null, [], {}, {ios: null}, {...configuredLinks, next: 'https://evil.example'},
    {ios: undefined, android: null},
    {ios: 'http://apps.apple.com/us/app/fixture/id123', android: null},
    {ios: 'https://apps.apple.com.evil.example/us/app/fixture/id123', android: null},
    {ios: 'https://evil.example@apps.apple.com/us/app/fixture/id123', android: null},
    {ios: 'https://apps.apple.com:444/us/app/fixture/id123', android: null},
    {ios: 'https://apps.apple.com/redirect?url=https://evil.example', android: null},
    {ios: 'https://apps.apple.com/us/app/fixture/id123?next=https://evil.example', android: null},
    {ios: 'https://apps.apple.com/us/app/fixture/id123#external', android: null},
    {ios: 'https://apps.apple.com/us/app/fixture/id-not-number', android: null},
    {ios: ' https://apps.apple.com/us/app/fixture/id123', android: null},
    {ios: null, android: 'https://play.google.com/store/apps/details'},
    {ios: null, android: listings.android + '&next=https://evil.example'},
    {ios: null, android: listings.android + '&id=other.example'},
    {ios: null, android: 'https://play.google.com/store/apps/details?id=https://evil.example'},
    {ios: null, android: 'https://play.google.com\\evil.example/store/apps/details?id=test.example'},
  ];
  for (const value of refused) assert.throws(() => validateStoreLinks(value), /INVALID_STORE_LINKS/);
});

test('P21-DOWNLOAD-04 mobile uses configured listing or explicit unavailable chooser; desktop chooses', () => {
  assert.deepEqual(resolveDownload({links: listings, userAgent: agents.android}), {status: 302, location: listings.android});
  assert.deepEqual(resolveDownload({links: listings, userAgent: agents.iphone}), {status: 302, location: listings.ios});
  assert.deepEqual(resolveDownload({links: listings, userAgent: agents.ipadDesktop}), {status: 303, location: '/download'});
  assert.deepEqual(resolveDownload({links: listings, userAgent: agents.desktop}), {status: 303, location: '/download'});
  assert.deepEqual(resolveDownload({links: listings, userAgent: agents.android, platform: 'ios'}), {status: 302, location: listings.ios});
  assert.deepEqual(resolveDownload({links: configuredLinks, platform: 'android'}), {status: 303, location: '/download?platform=android&unavailable=1'});
  assert.deepEqual(resolveDownload({links: configuredLinks, userAgent: agents.ipad}), {status: 303, location: '/download?platform=ios&unavailable=1'});
  for (const platform of ['', null, 'desktop', 'IOS', false, ['ios'], 'https://evil.example']) assert.deepEqual(resolveDownload({links: listings, platform}), {status: 400, location: null});
});

test('P21-DOWNLOAD-05 loopback redirects preserve method semantics and cache isolation', async t => {
  const request = await loopback(t, createDownloadHandler({links: listings}));
  const mobile = await request('/api/download', {headers: {'User-Agent': agents.android}});
  assert.equal(mobile.status, 302);
  assert.equal(mobile.headers.get('location'), listings.android);
  assert.equal(mobile.headers.get('cache-control'), 'no-store');
  assert.equal(mobile.headers.get('vary'), 'User-Agent');
  const desktop = await request('/api/download', {headers: {'User-Agent': agents.desktop}});
  assert.equal(desktop.status, 303);
  assert.equal(desktop.headers.get('location'), '/download');
  const head = await request('/api/download?platform=ios', {method: 'HEAD'});
  assert.equal(head.status, 302);
  assert.equal(head.headers.get('location'), listings.ios);
  assert.equal(await head.text(), '');
  const write = await request('/api/download?platform=ios', {method: 'POST', body: 'untrusted'});
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('allow'), 'GET, HEAD');
  assert.equal(write.headers.get('location'), null);
});

test('P21-DOWNLOAD-06 shipped handler never guesses launch links and refuses redirect input', async t => {
  const request = await loopback(t, (await api).default);
  for (const platform of ['ios', 'android']) {
    const response = await request('/api/download?platform=' + platform);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/download?platform=' + platform + '&unavailable=1');
  }
  for (const query of ['platform=windows', 'platform=', 'platform=ios&platform=android', 'next=https://evil.example', 'platform=ios&url=https://evil.example', 'platform=ios%0d%0aLocation%3ahttps%3a%2f%2fevil.example']) {
    const response = await request('/api/download?' + query);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
});

test('P21-DOWNLOAD-07 invalid deployment configuration fails closed without leaking its URL', async t => {
  const request = await loopback(t, createDownloadHandler({links: {ios: 'https://evil.example/secret', android: null}}));
  const response = await request('/api/download?platform=ios');
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('location'), null);
  assert.doesNotMatch(await response.text(), /evil\.example|secret/);
});
