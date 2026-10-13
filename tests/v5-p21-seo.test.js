'use strict';

// Presentation/crawl acceptance only. Builds a separate local artifact and uses
// synthetic official-format listing URLs; no provider or production calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const { once } = require('node:events');
const { buildWeb, ROOT, WEBSITE_ROUTES, LEGAL_NAMES } = require('../scripts/p21/build-web.js');
const { createPreviewServer } = require('../scripts/p21/serve-web.js');

let seo, build;
test.before(async () => {
  seo = await import(pathToFileURL(path.join(ROOT, 'apps/web/seo.js')).href);
  fs.mkdirSync(path.join(ROOT, '.artifacts'), { recursive: true });
  const parent = fs.mkdtempSync(path.join(ROOT, '.artifacts/.p21-seo-test-'));
  try { build = { ...buildWeb({ output: path.join(parent, 'bundle') }), parent }; }
  catch (error) { fs.rmSync(parent, { recursive: true, force: true }); throw error; }
});
test.after(() => { if (build?.parent) fs.rmSync(build.parent, { recursive: true, force: true }); });

function request(port, pathname, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

async function serve(t, options = {}) {
  const server = createPreviewServer({ directory: build.output, readApiOrigin: null, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

function decode(value = '') {
  return value.replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity]);
}
function text(value) { return decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function attrs(tag) { return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1].toLowerCase(), decode(match[3])])); }
function documentInfo(html) {
  const tags = [...html.matchAll(/<(?:meta|link)\b[^>]*>/gi)].map(match => attrs(match[0]));
  const get = (name, property = 'name') => tags.filter(tag => tag[property] === name).map(tag => tag.content);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '';
  const schema = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => attrs(match[1]).type === 'application/ld+json').flatMap(match => {
    const data = JSON.parse(match[2]); return Array.isArray(data) ? data : data['@graph'] || [data];
  });
  return { title: text(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''), description: get('description'), canonical: tags.filter(tag => tag.rel === 'canonical').map(tag => tag.href), robots: get('robots'), get, main, schema };
}

test('P21-SEO-01: each deep link returns its complete prerendered chrome and route metadata without JavaScript', async t => {
  const { metadataFor, SITE_ORIGIN } = await seo;
  const port = await serve(t, { indexable: true });
  assert.equal(SITE_ORIGIN, 'https://megaxo.online');
  assert.ok(WEBSITE_ROUTES.includes('/download'));
  assert.ok(WEBSITE_ROUTES.includes('/faq'));
  for (const route of WEBSITE_ROUTES) {
    const response = await request(port, route + '?utm_source=synthetic-crawl');
    assert.equal(response.status, route === '/404' ? 404 : 200, route);
    assert.match(response.headers['content-type'], /^text\/html/, route);
    const info = documentInfo(response.body), expected = metadataFor(route);
    assert.equal((info.main.match(/<h1\b/gi) || []).length, 1, route + ' exactly one main heading');
    assert.ok(text(info.main).length > 80, route + ' useful content precedes JavaScript execution');
    assert.match(response.body, /<header\b[^>]*id=["']header["'][^>]*>[\s\S]+?<\/header>/i, route + ' header chrome');
    assert.match(response.body, /<footer\b[^>]*id=["']footer["'][^>]*>[\s\S]+?<\/footer>/i, route + ' footer chrome');
    assert.equal(info.title, expected.title, route);
    assert.deepEqual(info.description, [expected.description], route + ' one description');
    assert.deepEqual(info.canonical, [expected.canonical], route + ' one canonical');
    assert.deepEqual(info.robots, [expected.robots], route + ' robots policy');
    assert.deepEqual(info.get('og:title', 'property'), [expected.title], route);
    assert.deepEqual(info.get('og:description', 'property'), [expected.description], route);
    assert.deepEqual(info.get('og:url', 'property'), [expected.canonical], route);
    assert.deepEqual(info.get('og:image', 'property'), [expected.image], route);
    assert.deepEqual(info.get('twitter:card'), ['summary_large_image'], route);
    assert.deepEqual(info.get('twitter:title'), [expected.title], route);
    assert.deepEqual(info.get('twitter:description'), [expected.description], route);
    assert.deepEqual(info.get('twitter:image'), [expected.image], route);
    assert.ok(info.schema.length > 0, route + ' valid JSON-LD');
    assert.ok(!/aggregateRating|ratingValue|reviewCount|priceCurrency|datePublished/.test(JSON.stringify(info.schema)), route + ' no invented publication/rating/price claims');
    assert.ok(!/play\.antimatterinnovations\.com|github\.com/i.test(JSON.stringify(info.schema) + info.canonical.join('') + info.get('og:url', 'property').join('')), route + ' public metadata uses the game canonical domain');
    assert.ok(!/noindex/i.test(response.headers['x-robots-tag'] || '') || !expected.indexable, route + ' no global production noindex');
    if (!expected.indexable) assert.match(response.headers['x-robots-tag'], /noindex/, route + ' private header policy');
    assert.ok(build.manifest.routes[route]?.endsWith('.html'), route + ' mapped document');
    if (route !== '/') assert.notEqual(build.manifest.routes[route], 'index.html', route + ' no generic home fallback');
  }
});

test('P21-SEO-02: unique public metadata and sitemap include only eligible canonical pages', async t => {
  const { publicRoutes, metadataFor, SITE_ORIGIN, sitemapXml, robotsTxt } = await seo;
  const required = ['/', '/how-to-play', '/themes', '/download', '/faq', '/about', '/privacy', '/terms'];
  for (const route of required) assert.ok(publicRoutes.includes(route), route + ' public crawl route');
  assert.equal(new Set(publicRoutes).size, publicRoutes.length);
  const titles = new Set(), descriptions = new Set(), canonicals = new Set();
  for (const route of publicRoutes) {
    const metadata = metadataFor(route);
    assert.equal(metadata.indexable, true, route);
    assert.ok(metadata.title.length >= 12 && metadata.title.length <= 100, route);
    assert.ok(metadata.description.length >= 50 && metadata.description.length <= 220, route);
    assert.ok(!titles.has(metadata.title), route + ' unique title'); titles.add(metadata.title);
    assert.ok(!descriptions.has(metadata.description), route + ' unique description'); descriptions.add(metadata.description);
    assert.equal(new URL(metadata.canonical).origin, SITE_ORIGIN, route);
    assert.equal(new URL(metadata.canonical).search, '', route);
    assert.ok(!canonicals.has(metadata.canonical), route + ' unique canonical'); canonicals.add(metadata.canonical);
  }
  for (const route of ['/game', '/play', '/legacy-game', '/account', '/profile', '/settings', '/friends', '/challenge', '/offline', '/status', '/404']) {
    assert.equal(metadataFor(route).indexable, false, route);
    assert.match(metadataFor(route).robots, /noindex/, route);
    assert.ok(!publicRoutes.includes(route), route);
  }
  for (const route of ['/help', '/legal/privacy', '/ads']) assert.ok(!publicRoutes.includes(route), route + ' alias excluded from sitemap');
  const port = await serve(t, { indexable: true });
  const sitemap = await request(port, '/sitemap.xml');
  assert.equal(sitemap.status, 200); assert.match(sitemap.headers['content-type'], /xml/);
  assert.equal(sitemap.body, sitemapXml());
  const locations = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decode(match[1]));
  assert.deepEqual(locations.slice().sort(), [...canonicals].sort());
  const robots = await request(port, '/robots.txt');
  assert.equal(robots.status, 200); assert.match(robots.headers['content-type'], /^text\/plain/);
  assert.equal(robots.body, robotsTxt());
  assert.match(robots.body, /User-agent:\s*\*/i);
  assert.match(robots.body, /Sitemap:\s*https:\/\/megaxo\.online\/sitemap\.xml/i);
  assert.ok(!/^Disallow:\s*\/\s*$/m.test(robots.body), 'production public crawl is not globally blocked');
  for (const blocked of ['/api', '/legacy-game', '/game', '/play', '/account']) assert.match(robots.body, new RegExp('^Disallow:\\s*' + blocked + '/?\\s*$', 'm'), blocked);
});

test('P21-SEO-03: FAQ schema answers match visible content and aliases retain their main canonical policy', async t => {
  const { metadataFor } = await seo;
  const port = await serve(t, { indexable: true });
  const faq = documentInfo((await request(port, '/faq')).body);
  const entries = faq.schema.filter(entry => entry['@type'] === 'FAQPage');
  assert.equal(entries.length, 1);
  assert.ok(entries[0].mainEntity.length >= 3);
  const visible = text(faq.main);
  for (const question of entries[0].mainEntity) {
    assert.equal(question['@type'], 'Question');
    assert.ok(visible.includes(text(question.name)), question.name);
    assert.equal(question.acceptedAnswer['@type'], 'Answer');
    assert.ok(visible.includes(text(question.acceptedAnswer.text)), question.name + ' complete answer');
  }
  for (const route of ['/', '/how-to-play', '/themes', '/support', '/download']) {
    assert.ok(!documentInfo((await request(port, route)).body).schema.some(entry => entry['@type'] === 'FAQPage'), route + ' no unrelated FAQ markup');
  }
  for (const name of LEGAL_NAMES) {
    const canonical = documentInfo((await request(port, '/' + name)).body);
    const alias = documentInfo((await request(port, '/legal/' + name)).body);
    assert.equal(text(alias.main), text(canonical.main), name + ' legal wording parity');
    assert.deepEqual(alias.canonical, canonical.canonical, name + ' alias canonical');
    assert.deepEqual(alias.robots, [metadataFor('/legal/' + name).robots]);
    assert.equal(metadataFor('/legal/' + name).indexable, metadataFor('/' + name).indexable);
    assert.deepEqual(alias.robots, canonical.robots, name + ' canonical-equivalent crawl policy');
    const raw = await request(port, '/legal/' + name + '.html');
    assert.match(raw.headers['x-robots-tag'], /noindex/, name + ' retained raw HTML alias');
    assert.ok(String(raw.headers.link).includes(canonical.canonical[0]), name + ' retained raw HTML canonical header');
  }
});

test('P21-SEO-04: preview remains noindex while unknown documents really return 404', async t => {
  const port = await serve(t);
  for (const route of ['/', '/how-to-play', '/download', '/faq']) {
    const response = await request(port, route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers['x-robots-tag'], /noindex/, route);
  }
  for (const route of ['/404', '/missing-synthetic-page', '/pages/missing-synthetic.html']) {
    const response = await request(port, route);
    assert.equal(response.status, 404, route);
    assert.match(documentInfo(response.body).robots[0], /noindex/, route);
    assert.match(text(documentInfo(response.body).main), /page.*not.*found|lost.*board|404/i, route);
  }
});

test('P21-DOWNLOAD-01: unavailable device listings redirect to the themed chooser with no fabricated storefront', async t => {
  const port = await serve(t);
  for (const platform of ['', 'android', 'ios']) {
    const response = await request(port, '/api/download' + (platform ? '?platform=' + platform : ''));
    assert.equal(response.status, 303, platform || 'desktop');
    const location = new URL(response.headers.location, 'http://127.0.0.1');
    assert.equal(location.pathname, '/download');
    assert.ok(!/play\.google\.com|apps\.apple\.com/.test(response.headers.location));
    if (platform) assert.equal(location.searchParams.get('platform'), platform);
  }
  const head = await request(port, '/api/download?platform=ios', 'HEAD');
  assert.equal(head.status, 303); assert.equal(head.body, '');
  assert.equal((await request(port, '/api/download', 'POST')).status, 405);
  const chooser = documentInfo((await request(port, '/download')).body);
  assert.match(text(chooser.main), /unavailable|not.*available|not.*published|not.*configured|coming/i);
  assert.ok(!/href=["']https:\/\/(?:play\.google\.com|apps\.apple\.com)/.test(chooser.main));
});

test('P21-DOWNLOAD-02: explicitly configured synthetic official listings redirect only to allowlisted store destinations', async t => {
  const storeLinks = { android: 'https://play.google.com/store/apps/details?id=com.example.synthetic.megaxoxo', ios: 'https://apps.apple.com/app/id1234567890' };
  const port = await serve(t, { storeLinks });
  for (const platform of ['android', 'ios']) {
    const response = await request(port, '/api/download?platform=' + platform);
    assert.equal(response.status, 302, platform);
    assert.equal(response.headers.location, storeLinks[platform]);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const desktop = await request(port, '/api/download');
  assert.equal(desktop.status, 303); assert.equal(new URL(desktop.headers.location, 'http://127.0.0.1').pathname, '/download');
  const malicious = await request(port, '/api/download?platform=android&url=https%3A%2F%2Fevil.example%2F');
  assert.ok(malicious.status === 400 || malicious.headers.location === storeLinks.android, 'request cannot select an arbitrary redirect');
  assert.ok(!String(malicious.headers.location).includes('evil.example'));
});
