'use strict';

// Local presentation acceptance. Install/resolve Playwright through NODE_PATH;
// no provider, production API, authenticated browser profile or trace is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { buildWeb, ROOT, MANIFEST, WEBSITE_ROUTES, LEGAL_NAMES } = require('./build-web.js');
const { createPreviewServer } = require('./serve-web.js');

async function main() {
  let playwright;
  try { playwright = require('playwright'); }
  catch { throw new Error('Playwright is unavailable. Point NODE_PATH to the installed runtime node_modules directory.'); }
  const outputRoot = path.join(ROOT, 'tests-output/p21-web');
  fs.mkdirSync(outputRoot, { recursive: true });
  if (process.argv.slice(2).some(arg => arg !== '--no-build')) throw new Error('usage: node scripts/p21/browser-qa.cjs [--no-build]');
  const build = process.argv.includes('--no-build')
    ? { output: path.join(ROOT, '.artifacts/p21-web'), manifest: JSON.parse(fs.readFileSync(path.join(ROOT, '.artifacts/p21-web', MANIFEST), 'utf8')) }
    : buildWeb();
  const output = path.join(outputRoot, build.manifest.bundle_sha256.slice(0, 12));
  fs.mkdirSync(output, { recursive: true });
  // Capture an isolated checksum-verified snapshot. Another developer can
  // rebuild the preview during this matrix without changing the tested bytes.
  const snapshotRoot = fs.mkdtempSync(path.join(ROOT, '.artifacts/.p21-browser-qa-'));
  try {
    for (const file of build.manifest.files) {
      const source = path.resolve(build.output, file.path);
      const target = path.resolve(snapshotRoot, file.path);
      if (!source.startsWith(build.output + path.sep) || !target.startsWith(snapshotRoot + path.sep)) throw new Error('Build manifest contains an invalid payload path.');
      const bytes = fs.readFileSync(source);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Build changed during snapshot capture: ' + file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    fs.writeFileSync(path.join(snapshotRoot, MANIFEST), JSON.stringify(build.manifest, null, 2) + '\n');
  } catch (error) { fs.rmSync(snapshotRoot, { recursive: true, force: true }); throw error; }
  const report = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    source_commit: build.manifest.source_commit,
    bundle_sha256: build.manifest.bundle_sha256,
    environment: 'local loopback Chromium; new unauthenticated contexts; static presentation only',
    isolated_payload_snapshot: true,
    command: 'env -u NODE_OPTIONS ' + process.execPath + ' scripts/p21/browser-qa.cjs' + (process.argv.includes('--no-build') ? ' --no-build' : ''),
    runtime_version: process.version,
    checks: [],
    failures: [],
    screenshots: [],
    requests: { missing_local_resources: [], javascript_errors: [] },
  };
  let browser;
  const server = createPreviewServer({ directory: snapshotRoot });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await playwright.chromium.launch({ headless: true });
    report.browser = browser.version();
    const check = (id, condition, details) => {
      const result = { id, result: condition ? 'PASS' : 'FAIL', ...details };
      report.checks.push(result);
      if (!condition) report.failures.push(result);
      return condition;
    };
    const snapshots = new Set();
    const snapshot = async (page, name, fullPage = true) => {
      const target = path.join(output, name + '.png');
      await page.screenshot({ path: target, fullPage, animations: 'disabled' });
      report.screenshots.push(path.relative(ROOT, target));
    };
    const track = page => {
      page.on('response', response => {
        if (response.url().startsWith(origin + '/') && response.status() >= 400 && !response.url().startsWith(origin + '/api/')) {
          report.requests.missing_local_resources.push({ path: new URL(response.url()).pathname, status: response.status() });
        }
      });
      page.on('pageerror', error => report.requests.javascript_errors.push(String(error.message).slice(0, 500)));
    };
    const widths = [
      { name: 'desktop', width: 1672, height: 941 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile390', width: 390, height: 844 },
      { name: 'mobile320', width: 320, height: 740 },
    ];
    for (const viewport of widths) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce', timezoneId: 'Asia/Kolkata' });
      const page = await context.newPage();
      track(page);
      for (const route of WEBSITE_ROUTES) {
        const response = await page.goto(origin + route, { waitUntil: 'networkidle' });
        await page.locator('#main').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const metrics = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          heading: document.querySelector('#main h1')?.textContent?.trim(),
          renders404: Boolean(document.querySelector('#main .pg-error-code')),
          brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).map(image => image.getAttribute('src')),
          unlabeledButtons: [...document.querySelectorAll('button')].filter(button => !button.getAttribute('aria-label') && !button.getAttribute('aria-labelledby') && !button.textContent.trim()).map(button => button.className),
          overflowing: [...document.querySelectorAll('#main *')].filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1) && getComputedStyle(element).position !== 'absolute';
          }).slice(0, 8).map(element => ({ element: element.tagName.toLowerCase(), class: element.className?.baseVal ?? element.className })),
          links: [...document.querySelectorAll('a[href]')].map(anchor => anchor.getAttribute('href')).filter(href => href.startsWith('/') && !href.startsWith('//')),
        }));
        check('P21-BROWSER-ROUTE', response?.status() === 200 && Boolean(metrics.heading) && (route === '/404' || !metrics.renders404), { route, viewport: viewport.name, status: response?.status(), heading: metrics.heading });
        check('P21-BROWSER-REFLOW', metrics.scrollWidth <= metrics.width + 1, { route, viewport: viewport.name, width: metrics.width, scrollWidth: metrics.scrollWidth, overflowing: metrics.overflowing });
        check('P21-BROWSER-IMAGES', metrics.brokenImages.length === 0, { route, viewport: viewport.name, brokenImages: metrics.brokenImages });
        check('P21-BROWSER-LABELS', metrics.unlabeledButtons.length === 0, { route, viewport: viewport.name, unlabeledButtons: metrics.unlabeledButtons });
        for (const href of metrics.links) snapshots.add(href.split('#')[0]);
        if (route === '/') {
          check('P21-BROWSER-BOARD', await page.locator('.gb-cell').count() === 81, { route, viewport: viewport.name });
          await snapshot(page, 'home-' + viewport.name, false);
          await snapshot(page, 'home-' + viewport.name + '-full');
        } else if (viewport.name === 'desktop') await snapshot(page, 'page-' + route.slice(1));
      }
      // The mobile drawer opens and Escape restores keyboard focus.
      if (viewport.width < 1000) {
        await page.goto(origin + '/', { waitUntil: 'networkidle' });
        const menu = page.locator('.mx-menu-button');
        if (await menu.isVisible()) {
          await menu.click();
          check('P21-BROWSER-MENU', await page.locator('#mobile-menu').isVisible() && await menu.getAttribute('aria-expanded') === 'true', { viewport: viewport.name });
          await page.keyboard.press('Escape');
          check('P21-BROWSER-MENU-ESCAPE', !await page.locator('#mobile-menu').isVisible() && await menu.evaluate(element => element === document.activeElement), { viewport: viewport.name });
        }
      }
      await context.close();
      process.stdout.write(JSON.stringify({ stage: 'viewport-complete', viewport: viewport.name, checks: report.checks.length, failures: report.failures.length }) + '\n');
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    track(page);
    for (const href of [...snapshots].sort()) {
      const response = await context.request.get(origin + href);
      check('P21-BROWSER-LINK', response.status() === 200, { href, status: response.status() });
    }
    for (const name of LEGAL_NAMES) {
      const response = await page.goto(origin + '/legal/' + name, { waitUntil: 'networkidle' });
      check('P21-BROWSER-LEGAL', response?.status() === 200 && await page.locator('h1').count() > 0, { route: '/legal/' + name, status: response?.status() });
    }
    await page.goto(origin + '/play?mode=practice', { waitUntil: 'networkidle' });
    await page.locator('[data-gb-setting="mode"]').selectOption('local');
    check('P21-BROWSER-PRACTICE-INITIAL', await page.locator('.gb-cell[aria-disabled="false"]').count() === 81, { route: '/play?mode=practice' });
    await page.locator('[data-gb-cell="0:4"]').click();
    const legalMoves = await page.locator('.gb-cell[aria-disabled="false"]').evaluateAll(cells => cells.map(cell => cell.dataset.gbCell));
    check('P21-BROWSER-PRACTICE-ROUTING', legalMoves.length === 9 && legalMoves.every(key => key.startsWith('4:')), { move: '0:4', nextBoard: 4, legalMoves });
    const occupied = await page.locator('[data-gb-cell="0:4"]').getAttribute('aria-label');
    check('P21-BROWSER-PRACTICE-OCCUPIED', occupied.includes('X, occupied'), { cell: '0:4', label: occupied });
    for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) {
      await page.locator('[data-gb-setting="theme"]').selectOption(theme);
      check('P21-BROWSER-THEME', await page.locator('[data-gb-stage]').getAttribute('data-gb-theme') === theme, { theme });
      check('P21-BROWSER-THEME-STATE', (await page.locator('[data-gb-cell="0:4"]').getAttribute('aria-label')).includes('X, occupied'), { theme, cell: '0:4' });
      await snapshot(page, 'practice-' + theme);
    }
    await page.goto(origin + '/game/', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor();
    check('P21-BROWSER-RETAINED-GAME', await page.locator('#app').count() === 1 && await page.locator('#board').count() === 1, { route: '/game/' });
    await context.close();
    check('P21-BROWSER-ASSET-HTTP', report.requests.missing_local_resources.length === 0, { errors: report.requests.missing_local_resources });
    check('P21-BROWSER-JAVASCRIPT', report.requests.javascript_errors.length === 0, { errors: report.requests.javascript_errors });
    report.result = report.failures.length === 0 ? 'PASS' : 'FAIL';
  } catch (error) {
    report.result = 'FAIL';
    report.failures.push({ id: 'P21-BROWSER-EXECUTION', result: 'FAIL', message: String(error.message).slice(0, 1000) });
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
    fs.writeFileSync(path.join(output, 'browser-qa.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(outputRoot, 'browser-qa.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ result: report.result, source_commit: report.source_commit, checks: report.checks.length, failures: report.failures.length, report: path.join(output, 'browser-qa.json') }) + '\n');
    if (report.result !== 'PASS') process.exitCode = 1;
  }
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
