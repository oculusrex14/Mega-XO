'use strict';

// Local presentation acceptance. Install/resolve Playwright through NODE_PATH;
// no provider, production API, authenticated browser profile or trace is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { buildWeb, ROOT, MANIFEST, WEBSITE_ROUTES, LEGAL_NAMES } = require('./build-web.js');
const { createPreviewServer } = require('./serve-web.js');
const tournamentRules = require('../../src/tournament.js');

async function main() {
  const requestedBrowser = process.env.P21_QA_BROWSER;
  const browserEngine = requestedBrowser || 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(browserEngine)) {
    throw new Error('P21_QA_BROWSER must be one of chromium, firefox, or webkit.');
  }
  let playwright;
  try { playwright = require('playwright'); }
  catch { throw new Error('Playwright is unavailable. Point NODE_PATH to the installed runtime node_modules directory.'); }
  const outputRoot = path.join(ROOT, 'tests-output/p21-web');
  fs.mkdirSync(outputRoot, { recursive: true });
  if (process.argv.slice(2).some(arg => arg !== '--no-build')) throw new Error('usage: node scripts/p21/browser-qa.cjs [--no-build]');
  const build = process.argv.includes('--no-build')
    ? { output: path.join(ROOT, '.artifacts/p21-web'), manifest: JSON.parse(fs.readFileSync(path.join(ROOT, '.artifacts/p21-web', MANIFEST), 'utf8')) }
    : buildWeb();
  const bundleOutput = path.join(outputRoot, build.manifest.bundle_sha256.slice(0, 12));
  // Preserve the historical Chromium report location for existing consumers.
  // Other engines receive their own timestamped directory so their screenshots
  // and reports cannot overwrite or be mistaken for Chromium evidence.
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const output = browserEngine === 'chromium'
    ? bundleOutput
    : path.join(bundleOutput, browserEngine, runStamp + '-' + process.pid);
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
    browser_engine: browserEngine,
    source_commit: build.manifest.source_commit,
    bundle_sha256: build.manifest.bundle_sha256,
    environment: 'local loopback ' + browserEngine + '; new unauthenticated contexts; read proxy explicitly disabled; synthetic API fixtures only',
    report_directory: path.relative(ROOT, output),
    screenshots_directory: path.relative(ROOT, output),
    isolated_payload_snapshot: true,
    command: 'env -u NODE_OPTIONS ' + (requestedBrowser ? 'P21_QA_BROWSER=' + browserEngine + ' ' : '') + process.execPath + ' scripts/p21/browser-qa.cjs' + (process.argv.includes('--no-build') ? ' --no-build' : ''),
    runtime_version: process.version,
    qa_script_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    checks: [],
    failures: [],
    screenshots: [],
    requests: { missing_local_resources: [], javascript_errors: [], blocked_external_origins: [] },
  };
  let browser;
  const server = createPreviewServer({ directory: snapshotRoot, readApiOrigin: null });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await playwright[browserEngine].launch({ headless: true });
    report.browser = browser.version();
    const localOnly = async context => context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      // The retained client can reference its old font/icon CDNs. Blocking
      // every external request makes this acceptance independent of providers.
      if (!report.requests.blocked_external_origins.includes(url.origin)) report.requests.blocked_external_origins.push(url.origin);
      return route.abort('blockedbyclient');
    });
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
        const intentional404 = ['/404', '/settings'].includes(new URL(response.url()).pathname) && response.request().resourceType() === 'document' && response.status() === 404;
        if (response.url().startsWith(origin + '/') && response.status() >= 400 && !response.url().startsWith(origin + '/api/') && !intentional404) {
          report.requests.missing_local_resources.push({ path: new URL(response.url()).pathname, status: response.status() });
        }
      });
      page.on('pageerror', error => report.requests.javascript_errors.push(String(error.message).slice(0, 500)));
    };
    // Dashboard controls differ from home, but the owner's restored frame, mini boards,
    // cell grid and player marks must retain the same Neon presentation at each viewport.
    const neonStyle = page => page.locator('[data-gb-stage]').evaluate(stage => {
      const tokens = ['--gb-surface', '--gb-raised', '--gb-ink', '--gb-muted', '--gb-line', '--gb-mini-border', '--gb-x', '--gb-o', '--gb-route', '--gb-focus', '--gb-radius', '--gb-font'];
      const properties = ['backgroundColor', 'backgroundImage', 'borderTopColor', 'borderTopWidth', 'borderRightColor', 'borderRightWidth', 'borderBottomColor', 'borderBottomWidth', 'boxShadow', 'borderRadius', 'color', 'filter'];
      const selectors = ['.gb-frame', '.gb-mini--active', '.gb-cell', '.gb-avatar--x .gb-mark', '.gb-avatar--o .gb-mark', '.gb-move-dot'];
      const style = getComputedStyle(stage);
      return {
        tokens: Object.fromEntries(tokens.map(token => [token, style.getPropertyValue(token).trim()])),
        components: Object.fromEntries(selectors.map(selector => {
          const component = getComputedStyle(stage.querySelector(selector));
          return [selector, Object.fromEntries(properties.map(property => [property, component[property]]))];
        })),
        frameEdge: getComputedStyle(stage.querySelector('.gb-frame'), '::before').display,
      };
    });
    const metadata = page => page.evaluate(() => ({
      title: document.title,
      description: [...document.querySelectorAll('meta[name="description"]')].map(meta => meta.content),
      canonical: [...document.querySelectorAll('link[rel="canonical"]')].map(link => link.href),
      robots: [...document.querySelectorAll('meta[name="robots"]')].map(meta => meta.content),
      ogTitle: [...document.querySelectorAll('meta[property="og:title"]')].map(meta => meta.content),
      ogUrl: [...document.querySelectorAll('meta[property="og:url"]')].map(meta => meta.content),
      twitterTitle: [...document.querySelectorAll('meta[name="twitter:title"]')].map(meta => meta.content),
      schema: [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(script => {
        const value = JSON.parse(script.textContent); return Array.isArray(value) ? value : value['@graph'] || [value];
      }),
    }));
    const rawMetadata = new Map();
    const widths = [
      { name: 'desktop', width: 1672, height: 941 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile390', width: 390, height: 844 },
      { name: 'mobile320', width: 320, height: 740 },
    ];
    for (const viewport of widths) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce', timezoneId: 'Asia/Kolkata' });
      await localOnly(context);
      const page = await context.newPage();
      track(page);
      let homeNeon;
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
        check('P21-BROWSER-ROUTE', response?.status() === (route === '/404' ? 404 : 200) && Boolean(metrics.heading) && (route === '/404' || !metrics.renders404), { route, viewport: viewport.name, status: response?.status(), heading: metrics.heading });
        check('P21-BROWSER-REFLOW', metrics.scrollWidth <= metrics.width + 1, { route, viewport: viewport.name, width: metrics.width, scrollWidth: metrics.scrollWidth, overflowing: metrics.overflowing });
        check('P21-BROWSER-IMAGES', metrics.brokenImages.length === 0, { route, viewport: viewport.name, brokenImages: metrics.brokenImages });
        check('P21-BROWSER-LABELS', metrics.unlabeledButtons.length === 0, { route, viewport: viewport.name, unlabeledButtons: metrics.unlabeledButtons });
        if (viewport.name === 'desktop') {
          const raw = await context.request.get(origin + route);
          const content = await page.evaluate(html => {
            const document = new DOMParser().parseFromString(html, 'text/html');
            const get = (selector, property = 'content') => [...document.querySelectorAll(selector)].map(element => element[property] || element.getAttribute(property));
            const main = document.querySelector('#main');
            return {
              title: document.title, description: get('meta[name="description"]'), canonical: get('link[rel="canonical"]', 'href'), robots: get('meta[name="robots"]'),
              ogTitle: get('meta[property="og:title"]'), ogUrl: get('meta[property="og:url"]'), twitterTitle: get('meta[name="twitter:title"]'),
              headingCount: main?.querySelectorAll('h1').length || 0,
              contentLength: main?.textContent.replace(/\s+/g, ' ').trim().length || 0,
              header: Boolean(document.querySelector('#header a[href="/"]')), footer: Boolean(document.querySelector('#footer a')),
              schema: [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(script => {
                const value = JSON.parse(script.textContent); return Array.isArray(value) ? value : value['@graph'] || [value];
              }),
            };
          }, await raw.text());
          rawMetadata.set(route, content);
          check('P21-BROWSER-PRERENDERED-CONTENT', content.headingCount === 1 && content.contentLength > 80 && content.header && content.footer, { route, headingCount: content.headingCount, contentLength: content.contentLength, header: content.header, footer: content.footer });
          check('P21-BROWSER-RAW-METADATA', content.title.length > 10 && content.description.length === 1 && content.description[0].length >= 50 && content.canonical.length === 1 && content.canonical[0].startsWith('https://megaxo.online/') && content.robots.length === 1 && content.ogTitle[0] === content.title && content.ogUrl[0] === content.canonical[0] && content.twitterTitle[0] === content.title && content.schema.length > 0, { route, title: content.title, canonical: content.canonical, robots: content.robots });
          const live = await metadata(page);
          check('P21-BROWSER-METADATA-HYDRATION', ['title', 'description', 'canonical', 'robots', 'ogTitle', 'ogUrl', 'twitterTitle', 'schema'].every(key => JSON.stringify(content[key]) === JSON.stringify(live[key])), { route, title: live.title, canonical: live.canonical });
        }
        for (const href of metrics.links) snapshots.add(href.split('#')[0]);
        if (route === '/') {
          homeNeon = await neonStyle(page);
          check('P21-BROWSER-BOARD', await page.locator('.gb-cell').count() === 81, { route, viewport: viewport.name });
          check('P21-BROWSER-HOME-NO-GAME-WORKSPACE', await page.locator('.gb-dashboard').count() === 0, { route, viewport: viewport.name });
          await snapshot(page, 'home-' + viewport.name, false);
          await snapshot(page, 'home-' + viewport.name + '-full');
        } else {
          if (route === '/game') {
            check('P21-BROWSER-CINEMATIC-GAME', await page.locator('.gb-game-page').count() === 1 && await page.locator('[data-board-preview="false"] .gb-cell').count() === 81 && await page.locator('iframe').count() === 0 && await page.locator('.mx-header').count() === 1, { route, viewport: viewport.name });
            const selected = await page.locator('[data-gb-setting="theme"]').inputValue();
            const themes = await page.locator('[data-gb-setting="theme"] option').evaluateAll(options => options.map(option => option.value));
            check('P21-BROWSER-NEON-DEFAULT', selected === 'cinematic' && themes.join(',') === 'cinematic,vector,midnight,paperclub,afterhours', { route, viewport: viewport.name, selected, themes });
            const gameNeon = await neonStyle(page);
            const samePalette = JSON.stringify(homeNeon.tokens) === JSON.stringify(gameNeon.tokens);
            const markSelectors = ['.gb-avatar--x .gb-mark', '.gb-avatar--o .gb-mark'];
            const luminousMarks = markSelectors.every(selector => gameNeon.components[selector].filter !== 'none' && gameNeon.components[selector].color === homeNeon.components[selector].color);
            const activeBoardGlow = gameNeon.components['.gb-mini--active'].boxShadow !== 'none';
            check('P21-BROWSER-NEON-PALETTE-AND-MARKS', samePalette && luminousMarks && activeBoardGlow, { route, viewport: viewport.name, samePalette, luminousMarks, activeBoardGlow, homeNeon, gameNeon });
            const sharedComponentsMatch = JSON.stringify(homeNeon.components) === JSON.stringify(gameNeon.components) && homeNeon.frameEdge === gameNeon.frameEdge;
            check('P21-BROWSER-NEON-SHARED-COMPONENT-PARITY', sharedComponentsMatch, { route, viewport: viewport.name, components: Object.keys(gameNeon.components), homeNeon, gameNeon });
            check('P21-BROWSER-GAME-WORKSPACE', await page.locator('.gb-dashboard').count() === 1 && await page.locator('.gb-game-setup').count() === 1 && await page.locator('.gb-game-players').count() === 1 && await page.locator('.gb-game-right .gb-help-panel').count() === 1, { route, viewport: viewport.name });
            const modeMenu = await page.locator('[data-game-mode]').evaluate(select => {
              const style = getComputedStyle(select), option = getComputedStyle(select.options[0]);
              return { colorScheme:style.colorScheme, background:style.backgroundColor, color:style.color, optionBackground:option.backgroundColor, optionColor:option.color };
            });
            const dark = value => {
              const channels = value.match(/[\d.]+/g)?.map(Number);
              return channels?.length >= 3 && Math.max(...channels.slice(0,3)) < 100 && (channels.length < 4 || channels[3] > 0);
            };
            check('P21-BROWSER-GAME-DARK-MODE-MENU', modeMenu.colorScheme.includes('dark') && dark(modeMenu.background) && dark(modeMenu.optionBackground) && modeMenu.color === modeMenu.optionColor, {route, viewport:viewport.name, ...modeMenu, scope:'computed select/option styles; native popup rendering remains visual browser acceptance'});
            const guide = page.locator('details.gb-help-panel');
            check('P21-BROWSER-GUIDE-COLLAPSED', await guide.count() === 1 && !(await guide.evaluate(element => element.open)) && await guide.locator('> summary').isVisible() && !(await guide.locator('[data-gb-action="start-guided"]').isVisible()), {route,viewport:viewport.name});
            if (viewport.name !== 'desktop') await snapshot(page, 'game-neon-' + viewport.name);
          }
          if (viewport.name === 'desktop') await snapshot(page, 'page-' + route.slice(1).replaceAll('/', '-'));
        }
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
    // Exercise the narrowest accepted CSS width with a classic reserved
    // scrollbar. Overlay-scrollbar mobile browsers do not expose this gutter,
    // so this fixture catches the desktop-emulation case explicitly.
    const gutterContext = await browser.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' });
    await localOnly(gutterContext);
    const gutterPage = await gutterContext.newPage();
    track(gutterPage);
    for (const route of ['/', '/game', '/legal/privacy', '/account']) {
      await gutterPage.goto(origin + route, { waitUntil: 'networkidle' });
      await gutterPage.addStyleTag({ content: 'html { scrollbar-gutter: stable !important; }' });
      const geometry = await gutterPage.evaluate(() => ({
        viewportWidth: innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll('#header, #main, #footer, #main *')].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -1 || rect.right > document.documentElement.clientWidth + 1) && getComputedStyle(element).position !== 'absolute';
        }).slice(0, 8).map(element => ({ element: element.tagName.toLowerCase(), class: element.className?.baseVal ?? element.className })),
      }));
      check('P21-BROWSER-320-SCROLLBAR-GUTTER-REFLOW', geometry.scrollWidth <= geometry.clientWidth + 1, { route, fixture: 'scrollbar-gutter:stable', ...geometry });
      if (route === '/' || route === '/game') await snapshot(gutterPage, 'scrollbar-gutter-' + (route === '/' ? 'home' : 'game'), false);
    }
    await gutterContext.close();

    // CSS-variable fixture approximates cutout insets on a phone and in
    // landscape. It is deliberately reported as synthetic, never as device
    // safe-area acceptance. The practice board must survive both changes.
    const safeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await localOnly(safeContext);
    const safePage = await safeContext.newPage();
    track(safePage);
    await safePage.goto(origin + '/game', { waitUntil: 'networkidle' });
    await safePage.locator('[data-game-mode]').selectOption('local');
    await safePage.locator('[data-gb-cell="0:4"]').click();
    const safeFixtures = [
      { name: 'portrait', viewport: { width: 390, height: 844 }, insets: { top: 24, right: 18, bottom: 30, left: 18 } },
      { name: 'landscape', viewport: { width: 844, height: 390 }, insets: { top: 0, right: 44, bottom: 21, left: 44 } },
    ];
    for (const fixture of safeFixtures) {
      await safePage.setViewportSize(fixture.viewport);
      await safePage.evaluate(insets => {
        for (const [side, value] of Object.entries(insets)) document.documentElement.style.setProperty('--mx-web-safe-' + side, value + 'px');
        // The preceding legal move may scroll the taller game workspace. Measure the normal-flow
        // header at document origin; a scrolled-away header is not a cutout-padding failure.
        window.scrollTo(0, 0);
      }, fixture.insets);
      const geometry = await safePage.evaluate(() => {
        const rect = element => {
          const box = element?.getBoundingClientRect();
          return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null;
        };
        const inset = side => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mx-web-safe-' + side)) || 0;
        const header = document.querySelector('.mx-header');
        const frame = document.querySelector('.gb-frame');
        const cells = [...document.querySelectorAll('.gb-cell[aria-disabled="false"]')].map(cell => cell.getBoundingClientRect());
        return {
          viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
          safe: { top: inset('top'), right: inset('right'), bottom: inset('bottom'), left: inset('left') },
          bodyPadding: {
            top: parseFloat(getComputedStyle(document.body).paddingTop),
            right: parseFloat(getComputedStyle(document.body).paddingRight),
            bottom: parseFloat(getComputedStyle(document.body).paddingBottom),
            left: parseFloat(getComputedStyle(document.body).paddingLeft),
          },
          header: rect(header),
          board: rect(frame),
          legalCells: cells.map(box => ({ left: box.left, right: box.right })).slice(0, 9),
        };
      });
      const safeLeft = geometry.safe.left - 1;
      const safeRight = geometry.viewport.width - geometry.safe.right + 1;
      const headerInSafeArea = geometry.header && geometry.header.left >= safeLeft && geometry.header.right <= safeRight && geometry.header.top >= geometry.safe.top - 1;
      const boardInSafeArea = geometry.board && geometry.board.left >= safeLeft && geometry.board.right <= safeRight && geometry.legalCells.length > 0 && geometry.legalCells.every(cell => cell.left >= safeLeft && cell.right <= safeRight);
      const paddingMatches = ['top', 'right', 'bottom', 'left'].every(side => Math.abs(geometry.bodyPadding[side] - geometry.safe[side]) <= 1);
      const movePreserved = await safePage.locator('[data-gb-cell="0:4"]').getAttribute('aria-label').then(label => label.includes('X, occupied'))
        && (await safePage.locator('[data-gb-move-total]').textContent().catch(() => '')).trim() === '1';
      check('P21-BROWSER-SYNTHETIC-SAFE-AREA-HEADER', headerInSafeArea, { fixture: fixture.name, source: 'synthetic CSS variables; not physical-device evidence', ...geometry });
      check('P21-BROWSER-SYNTHETIC-SAFE-AREA-BOARD', boardInSafeArea, { fixture: fixture.name, source: 'synthetic CSS variables; not physical-device evidence', ...geometry });
      check('P21-BROWSER-SYNTHETIC-SAFE-AREA-PADDING', paddingMatches, { fixture: fixture.name, source: 'synthetic CSS variables; not physical-device evidence', ...geometry });
      check('P21-BROWSER-SYNTHETIC-SAFE-AREA-NO-OVERFLOW', geometry.viewport.scrollWidth <= geometry.viewport.clientWidth + 1, { fixture: fixture.name, source: 'synthetic CSS variables; not physical-device evidence', ...geometry });
      check('P21-BROWSER-SYNTHETIC-SAFE-AREA-STATE-PRESERVED', movePreserved, { fixture: fixture.name, move: '0:4', source: 'local two-player practice only' });
      await snapshot(safePage, 'safe-area-synthetic-' + fixture.name, false);
    }
    await safeContext.close();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await localOnly(context);
    const page = await context.newPage();
    track(page);
    for (const href of [...snapshots].sort()) {
      const response = await context.request.get(origin + href);
      check('P21-BROWSER-LINK', response.status() === (href.split('?')[0] === '/404' ? 404 : 200), { href, status: response.status() });
    }
    const crawlable = [...rawMetadata.entries()].filter(([route, value]) => !/noindex/i.test(value.robots[0]) && value.canonical[0] === 'https://megaxo.online' + route);
    check('P21-BROWSER-PUBLIC-METADATA-UNIQUE', new Set(crawlable.map(([, value]) => value.title)).size === crawlable.length && new Set(crawlable.map(([, value]) => value.description[0])).size === crawlable.length && new Set(crawlable.map(([, value]) => value.canonical[0])).size === crawlable.length, { pages: crawlable.length });
    for (const route of ['/game', '/play', '/account', '/profile', '/offline', '/status', '/404']) check('P21-BROWSER-PRIVATE-NOINDEX', /noindex/i.test(rawMetadata.get(route)?.robots[0] || ''), { route });
    const removedSettings = await page.goto(origin + '/settings', {waitUntil:'networkidle'});
    const settingsSeo = await metadata(page);
    check('P21-BROWSER-SETTINGS-REMOVED', removedSettings?.status() === 404 && /noindex/i.test(settingsSeo.robots[0] || '') && await page.locator('.pg-error-code').count() === 1 && await page.locator('a[href="/settings"],[data-offline-action]').count() === 0, {route:'/settings',status:removedSettings?.status()});
    const unknown = await context.request.get(origin + '/missing-synthetic-website-route');
    check('P21-BROWSER-REAL-404', unknown.status() === 404 && /noindex/i.test(await unknown.text()), { route: '/missing-synthetic-website-route', status: unknown.status() });
    for (const name of LEGAL_NAMES) {
      const response = await page.goto(origin + '/legal/' + name, { waitUntil: 'networkidle' });
      const main = await page.locator('#main').textContent();
      const raw = fs.readFileSync(path.join(snapshotRoot, 'legal', name + '.html'), 'utf8');
      // Comparing visible text after browser parsing verifies every retained
      // paragraphs without changing source-document wording.
      const expected = await page.evaluate(html => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        return document.querySelector('main').textContent.replace(/\s+/g, ' ').trim();
      }, raw);
      const text = main.replace(/\s+/g, ' ').trim();
      const chrome = await page.locator('.mx-header').count() === 1 && await page.locator('.mx-footer').count() === 1;
      check('P21-BROWSER-LEGAL', response?.status() === 200 && await page.locator('#main h1').count() === 1 && chrome && text.includes(expected), { route: '/legal/' + name, status: response?.status(), websiteChrome: chrome, completeSourceText: text.includes(expected) });
    }
    await page.goto(origin + '/', { waitUntil: 'networkidle' });
    const homeSeo = await metadata(page);
    const primary = page.getByRole('link', { name: 'Play Now', exact: true });
    check('P21-BROWSER-HERO-PLAY-DESTINATION', await primary.getAttribute('href') === '/play', { label: 'Play Now', href: await primary.getAttribute('href') });
    await primary.click();
    await page.waitForURL(origin + '/play');
    const modeSeo = await metadata(page);
    const practiceEntry = page.getByRole('link', {name:'Start practicing with bots',exact:true});
    check('P21-BROWSER-PLAY-MODE-PRESTEP', modeSeo.canonical[0] === 'https://megaxo.online/play' && await practiceEntry.getAttribute('href') === '/game?mode=bot' && await page.locator('.gb-game-page').count() === 0, {from:'/',to:'/play',practiceHref:await practiceEntry.getAttribute('href')});
    await practiceEntry.click();
    await page.waitForURL(origin + '/game?mode=bot');
    await page.locator('.gb-game-page').waitFor();
    const gameSeo = await metadata(page);
    check('P21-BROWSER-SPA-GAME-METADATA', gameSeo.canonical[0] === 'https://megaxo.online/game' && /noindex/i.test(gameSeo.robots[0]) && gameSeo.title !== homeSeo.title && gameSeo.ogTitle[0] === gameSeo.title && gameSeo.twitterTitle[0] === gameSeo.title && gameSeo.ogUrl[0] === gameSeo.canonical[0], { from: '/', to: '/game', title: gameSeo.title, canonical: gameSeo.canonical, robots: gameSeo.robots });
    await page.goBack();
    await page.waitForURL(origin + '/play');
    check('P21-BROWSER-SPA-MODE-METADATA-RESTORE', JSON.stringify(await metadata(page)) === JSON.stringify(modeSeo), {from:'/game?mode=bot',to:'/play',title:(await metadata(page)).title});
    await page.goBack();
    await page.waitForURL(origin + '/');
    await page.locator('#hero-title').waitFor();
    check('P21-BROWSER-SPA-METADATA-RESTORE', JSON.stringify(await metadata(page)) === JSON.stringify(homeSeo), { from: '/game', to: '/', title: (await metadata(page)).title });
    await page.goto(origin + '/game/', { waitUntil: 'networkidle' });
    check('P21-BROWSER-GAME-SLASH', await page.locator('.gb-game-page').count() === 1 && await page.locator('.mx-header').count() === 1, { route: '/game/' });
    await page.locator('[data-game-mode]').selectOption('local');
    check('P21-BROWSER-PRACTICE-INITIAL', await page.locator('.gb-cell[aria-disabled="false"]').count() === 81, { route: '/game/' });
    await page.locator('[data-gb-cell="0:4"]').click();
    const legalMoves = await page.locator('.gb-cell[aria-disabled="false"]').evaluateAll(cells => cells.map(cell => cell.dataset.gbCell));
    check('P21-BROWSER-PRACTICE-ROUTING', legalMoves.length === 9 && legalMoves.every(key => key.startsWith('4:')), { move: '0:4', nextBoard: 4, legalMoves });
    const occupied = await page.locator('[data-gb-cell="0:4"]').getAttribute('aria-label');
    check('P21-BROWSER-PRACTICE-OCCUPIED', occupied.includes('X, occupied'), { cell: '0:4', label: occupied });
    const tabStop = await page.locator('.gb-cell[tabindex="0"]').getAttribute('data-gb-cell');
    const playingSeo = await metadata(page);
    for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours', 'cinematic']) {
      await page.locator('[data-gb-setting="theme"]').selectOption(theme);
      check('P21-BROWSER-THEME', await page.locator('[data-gb-stage]').getAttribute('data-gb-theme') === theme, { theme });
      check('P21-BROWSER-THEME-STATE', (await page.locator('[data-gb-cell="0:4"]').getAttribute('aria-label')).includes('X, occupied'), { theme, cell: '0:4' });
      const afterThemeMoves = await page.locator('.gb-cell[aria-disabled="false"]').evaluateAll(cells => cells.map(cell => cell.dataset.gbCell));
      check('P21-BROWSER-THEME-ROUTING-FOCUS', JSON.stringify(afterThemeMoves) === JSON.stringify(legalMoves) && await page.locator('.gb-cell[tabindex="0"]').getAttribute('data-gb-cell') === tabStop, { theme, legalMoves: afterThemeMoves, tabStop });
      check('P21-BROWSER-THEME-SEO-STABILITY', JSON.stringify(await metadata(page)) === JSON.stringify(playingSeo), { theme, route: '/game/' });
      await snapshot(page, 'practice-' + theme);
    }
    await page.locator('[data-gb-cell="4:0"]').focus();
    await page.keyboard.press('ArrowRight');
    const focus = await page.evaluate(() => document.activeElement.dataset.gbCell);
    check('P21-BROWSER-GAME-KEYBOARD', focus === '4:1', { direction: 'ArrowRight', expectedCell: '4:1', focusedCell: focus });
    await page.keyboard.press('Space');
    const afterKeyboard = await page.locator('.gb-cell[aria-disabled="false"]').evaluateAll(cells => cells.map(cell => cell.dataset.gbCell));
    check('P21-BROWSER-GAME-KEYBOARD-MOVE', (await page.locator('[data-gb-cell="4:1"]').getAttribute('aria-label')).includes('O, occupied') && afterKeyboard.length === 9 && afterKeyboard.every(key => key.startsWith('1:')), { move: '4:1', nextBoard: 1 });
    await page.locator('[data-gb-action="fresh"]').click();
    check('P21-BROWSER-GAME-NEW', await page.locator('.gb-cell[aria-disabled="false"]').count() === 81 && await page.locator('.gb-cell[aria-label*="occupied"]').count() === 0, { route: '/game/' });
    await page.locator('[data-game-mode]').selectOption('bot');
    await page.locator('[data-gb-setting="difficulty"]').selectOption('Beginner');
    await page.locator('[data-gb-cell="0:4"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.gb-cell[aria-label*="occupied"]').length === 2);
    const botMove = await page.locator('.gb-cell[aria-label*="O, occupied"]').getAttribute('data-gb-cell');
    check('P21-BROWSER-GAME-BOT', botMove.startsWith('4:') && await page.locator('.gb-cell[aria-disabled="false"]').count() > 0, { difficulty: 'Beginner', botBoard: botMove.split(':')[0] });
    const guide = page.locator('details.gb-help-panel');
    if (!(await guide.evaluate(element => element.open))) {
      await guide.locator('> summary').focus();
      await page.keyboard.press('Space');
    }
    check('P21-BROWSER-GUIDE-KEYBOARD-EXPANSION', await guide.evaluate(element => element.open) && await guide.locator('[data-gb-action="start-guided"]').isVisible(), {route:'/game',interaction:'focused native details summary + Space'});
    await guide.locator('[data-gb-action="start-guided"]').click();
    await page.locator('.gb-guided-panel').waitFor();
    check('P21-BROWSER-GUIDE-ENTRY-AND-LOCK', await page.locator('#gb-guided-title').evaluate(element => element === document.activeElement) && await page.locator('[data-game-mode]').isDisabled() && await page.locator('[data-gb-setting="difficulty"]').isDisabled() && await page.locator('[data-gb-setting="difficulty"]').inputValue() === 'Beginner', {route:'/game',source:'existing six-move tutorial; real local browser interaction'});
    const guidedPlayerMoves = [];
    for (let actions=0; actions<16 && await page.locator('.gb-guided-panel').count(); actions++) {
      const phase = await page.locator('.gb-guided-panel').getAttribute('data-gb-guided-phase');
      if (phase === 'AWAIT_MOVE') {
        const target = page.locator('.gb-cell--guided-target');
        guidedPlayerMoves.push(await target.getAttribute('data-gb-cell'));
        await target.click();
      } else if (phase === 'PROMPT' || phase === 'AWAIT_CONTINUE') {
        await page.locator('[data-gb-guided="continue"]').click();
      } else break;
    }
    const guidedResult = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('mega_v51_practice_save') || 'null');
      return {moves:saved?.state?.moves?.length || 0, phase:saved?.lesson?.phase || '', total:document.querySelector('[data-gb-move-total]')?.textContent.trim() || '', claimed:document.querySelectorAll('.gb-claim .gb-mark--x').length};
    });
    check('P21-BROWSER-GUIDE-SIX-MOVE-HANDOFF', guidedPlayerMoves.join(',') === '0:4,0:3,0:5' && guidedResult.moves === 6 && guidedResult.phase === 'DONE' && guidedResult.total === '6' && guidedResult.claimed === 1, {route:'/game',guidedPlayerMoves,...guidedResult});
    await page.goto(origin + '/how-to-play', {waitUntil:'networkidle'});
    const tutorialEntry = page.getByRole('link', {name:'Play the guided tutorial',exact:true});
    check('P21-BROWSER-RULES-GUIDED-DESTINATION', await tutorialEntry.getAttribute('href') === '/game?tutorial=guided', {route:'/how-to-play',href:await tutorialEntry.getAttribute('href')});
    await tutorialEntry.click();
    await page.waitForURL(origin + '/game?tutorial=guided');
    await page.locator('.gb-guided-panel').waitFor();
    check('P21-BROWSER-RULES-GUIDED-ENTRY', await page.locator('.gb-guided-panel').getAttribute('data-gb-guided-phase') === 'PROMPT' && await page.locator('[data-gb-move-total]').textContent().then(value => value.trim() === '0'), {from:'/how-to-play',to:'/game?tutorial=guided'});
    await page.setViewportSize({ width: 1151, height: 865 });
    await page.goto(origin + '/game', { waitUntil: 'networkidle' });
    check('P21-BROWSER-NEON-ANNOTATION-VIEWPORT', await page.locator('[data-gb-setting="theme"]').inputValue() === 'cinematic' && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { width: 1151, height: 865 });
    await snapshot(page, 'game-neon-1151', false);
    await page.goto(origin + '/legacy-game/', { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor();
    check('P21-BROWSER-RETAINED-GAME', await page.locator('#app').count() === 1 && await page.locator('#board').count() === 1, { route: '/legacy-game/' });
    const retained = build.manifest.files.filter(file => file.path.startsWith('legacy-game/'));
    check('P21-BROWSER-RETAINED-PARITY', retained.every(file => file.source_sha256 === file.sha256), { files: retained.length, bytePreserved: retained.every(file => file.source_sha256 === file.sha256) });
    await context.close();
    for (const viewport of [widths[0], widths[2]]) {
      const fixtureContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: 'reduce' });
      await localOnly(fixtureContext);
      const reads = [];
      const friend = (number, relation = 'friend') => {
        const suffix = String(number).padStart(2, '0');
        return {id:'fixture-friend-' + suffix,username:'fixture_friend_' + suffix,name:'Fixture Friend ' + suffix,
          tag:'MEGA-F' + suffix,avatar:'rook',relation,presence:{state:'offline',online:false}};
      };
      const friends = Array.from({length:23}, (_, index) => friend(index + 1));
      const friendProjection = {friends,incoming:[friend(31,'incoming')],outgoing:[friend(32,'outgoing')],blocked:[],truncated:false};
      const tournamentCapabilities = {lan:false,online:true,publicEnabled:true,tables:Object.keys(tournamentRules.TABLES).map(tournamentRules.prize)};
      let profileGate = null;
      await fixtureContext.route(origin + '/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        reads.push({ method: request.method(), path: url.pathname, query: url.search });
        const profile = { id: 'fixture-player', tag: 'MEGA-FIXTURE', name: 'Fixture Player', tier: 'emerald', rating: 1968.25, games: 24, region: 'IN', season: { qualified: true }, wallet: { coins: 2450, crowns: 12 } };
        const rows = [{ id: 'fixture-rival', name: 'Fixture Rival', tier: 'gold', rating: 1591.25, games: 24, region: 'IN', wealth: 43210 }];
        const projections = {'/api/v1/profile':profile,'/api/v1/leaderboard':rows,'/api/community/friends':friendProjection,'/api/party/capabilities':tournamentCapabilities};
        const known = request.method() === 'GET' && Object.hasOwn(projections,url.pathname);
        if (url.pathname === '/api/v1/profile' && profileGate) {
          const gate = profileGate; profileGate = null;
          await gate;
        }
        await route.fulfill({ status: known ? 200 : 503, contentType: 'application/json', body: JSON.stringify(known ? projections[url.pathname] : { error: 'WEB_API_NOT_CONFIGURED' }) });
      });
      const fixturePage = await fixtureContext.newPage();
      track(fixturePage);
      await fixturePage.goto(origin + '/ranked', { waitUntil: 'networkidle' });
      await fixturePage.locator('.pg-personal-rating strong').waitFor();
      const wallet = await fixturePage.locator('.mx-wallet-pill b').allTextContents();
      check('P21-BROWSER-SYNTHETIC-PROFILE', (await fixturePage.locator('.pg-personal-rating strong').textContent()).replaceAll(',', '') === '1968.25' && wallet[0].replace(/\D/g, '') === '2450' && wallet[1].replace(/\D/g, '') === '12', { viewport: viewport.name, data: 'synthetic linked profile only' });
      await snapshot(fixturePage, 'synthetic-ranked-' + viewport.name);
      await fixturePage.goto(origin + '/leaderboard', { waitUntil: 'networkidle' });
      await fixturePage.locator('.pg-standings tbody tr').waitFor();
      check('P21-BROWSER-SYNTHETIC-STANDINGS', await fixturePage.locator('.pg-player-name').textContent() === 'Fixture Rival' && (await fixturePage.locator('.pg-score').textContent()).replaceAll(',', '') === '1591.25', { viewport: viewport.name, data: 'synthetic public rows only' });
      const playerCard = fixturePage.locator('.pg-player-id-card');
      const playerCardState = await playerCard.evaluate(element => ({
        text:element.textContent,
        rank:element.querySelector('.pg-player-card-rank')?.getAttribute('src'),
        progress:Number(element.querySelector('progress')?.value),
        maximum:Number(element.querySelector('progress')?.max),
      }));
      check('P21-BROWSER-SYNTHETIC-PLAYER-CARD', playerCardState.text.includes('Fixture Player') && playerCardState.text.includes('MEGA-FIXTURE') && playerCardState.rank === '/assets/art/ranks/emerald.webp' && playerCardState.maximum === 100 && Math.abs(playerCardState.progress - (1968.25 - 1900) / (2200 - 1900) * 100) < 0.01 && await playerCard.getByRole('link', {name:'Sign in to your profile',exact:true}).count() === 0, {viewport:viewport.name,data:'synthetic permanent profile and canonical rank floors only',...playerCardState});
      await fixturePage.locator('[data-leaderboard-filter="metric"]').selectOption('wealth');
      await fixturePage.waitForFunction(() => document.querySelector('.pg-score')?.textContent.replaceAll(',', '') === '43210');
      await fixturePage.locator('[data-leaderboard-filter="league"]').selectOption('gold');
      await fixturePage.waitForFunction(() => document.querySelector('[data-leaderboard-results]')?.getAttribute('aria-busy') === 'false');
      check('P21-BROWSER-SYNTHETIC-FILTERS', reads.some(read => read.path === '/api/v1/leaderboard' && new URLSearchParams(read.query).get('metric') === 'wealth' && new URLSearchParams(read.query).get('league') === 'gold'), { viewport: viewport.name, metric: 'wealth', league: 'gold' });
      await fixturePage.locator('[data-leaderboard-filter="scope"]').selectOption('region');
      await fixturePage.waitForFunction(() => document.querySelector('[data-leaderboard-results]')?.getAttribute('aria-busy') === 'false');
      check('P21-BROWSER-SYNTHETIC-REGION', reads.some(read => read.path === '/api/v1/leaderboard' && new URLSearchParams(read.query).get('scope') === 'local' && new URLSearchParams(read.query).get('region') === 'IN'), { viewport: viewport.name, scope: 'local', region: 'IN' });
      const reflow = await fixturePage.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
      check('P21-BROWSER-SYNTHETIC-REFLOW', reflow.scrollWidth <= reflow.width + 1, { viewport: viewport.name, ...reflow });
      await snapshot(fixturePage, 'synthetic-leaderboard-' + viewport.name);
      for (const route of ['/rewards', '/challenge', '/tournaments']) {
        await fixturePage.goto(origin + route, {waitUntil:'networkidle'});
        await fixturePage.locator('#main h1').waitFor();
        check('P21-BROWSER-SYNTHETIC-LINKED-PROMPTS-CLEARED', await fixturePage.locator('.pg-signin').count() === 0 && await fixturePage.getByRole('link', {name:'Open account',exact:true}).count() === 0, {route,viewport:viewport.name,data:'synthetic linked profile only'});
        if (route === '/tournaments') {
          await fixturePage.locator('[data-tournament-action="join"]').first().waitFor();
          check('P21-BROWSER-SYNTHETIC-TOURNAMENT-CATALOG', await fixturePage.locator('[data-tournament-action="join"]').count() === tournamentCapabilities.tables.length && await fixturePage.getByRole('link', {name:'Sign in to join a tournament',exact:true}).count() === 0, {route,viewport:viewport.name,data:'synthetic enabled table catalog only; no join, entry reservation or service acceptance'});
        }
        let releaseProfile;
        profileGate = new Promise(resolve => {releaseProfile = resolve;});
        const profileStarted = fixturePage.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/profile');
        await fixturePage.evaluate(() => window.dispatchEvent(new Event('focus')));
        await profileStarted;
        await fixturePage.waitForFunction(() => /Checking your account|Confirming your account/.test(document.querySelector('#main')?.textContent || ''));
        check('P21-BROWSER-SYNTHETIC-REFRESH-NEUTRAL-PROMPT', await fixturePage.locator('.pg-signin').count() === 0 && await fixturePage.getByRole('link', {name:'Open account',exact:true}).count() === 0 && await fixturePage.getByRole('link', {name:'Sign in to join a tournament',exact:true}).count() === 0, {route,viewport:viewport.name,data:'synthetic held profile refresh after focus; loading is not a signed-out transition'});
        const profileReturned = fixturePage.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/profile');
        releaseProfile();
        await profileReturned;
        await fixturePage.waitForFunction(() => !/Checking your account|Confirming your account/.test(document.querySelector('#main')?.textContent || ''));
        check('P21-BROWSER-SYNTHETIC-REFRESH-LINKED-PROMPT', await fixturePage.locator('.pg-signin').count() === 0 && await fixturePage.getByRole('link', {name:'Open account',exact:true}).count() === 0 && await fixturePage.getByRole('link', {name:'Sign in to join a tournament',exact:true}).count() === 0, {route,viewport:viewport.name,data:'same synthetic linked identity after profile refresh'});
      }
      await fixturePage.goto(origin + '/friends', {waitUntil:'networkidle'});
      await fixturePage.locator('#friend-list-rows').waitFor();
      const visibleFriends = () => fixturePage.locator('#friend-list-rows .pg-friend-identity strong').allTextContents();
      const friendIds = pageNumber => friends.slice((pageNumber-1)*10,pageNumber*10).map(player => player.name);
      const friendReads = () => reads.filter(read => read.path === '/api/community/friends').length;
      const listReadCount = friendReads();
      const requestsCollapsed = await fixturePage.locator('#friend-requests,#friend-outgoing').evaluateAll(elements => elements.length === 2 && elements.every(element => element.tagName === 'DETAILS' && !element.open));
      check('P21-BROWSER-SYNTHETIC-FRIENDS-FIRST-PAGE', JSON.stringify(await visibleFriends()) === JSON.stringify(friendIds(1)) && await fixturePage.getByRole('button',{name:'Previous',exact:true}).isDisabled() && requestsCollapsed && await fixturePage.locator('#friend-query').isVisible() && await fixturePage.locator('.pg-signin').count() === 0, {route:'/friends',viewport:viewport.name,rows:10,total:23,requestsCollapsed,data:'synthetic protected social projection; no authentication/provider claim'});
      let currentFriendPage = 1;
      for (const pageNumber of [2,3,2,1]) {
        const direction = pageNumber > currentFriendPage ? 'Next' : 'Previous';
        await fixturePage.getByRole('button',{name:direction,exact:true}).click();
        await fixturePage.waitForFunction(number => document.querySelector('.pg-friend-pagination')?.textContent.includes('Page ' + number + ' of 3'),pageNumber);
        currentFriendPage = pageNumber;
        const visible = await visibleFriends();
        check('P21-BROWSER-SYNTHETIC-FRIENDS-PAGINATION', JSON.stringify(visible) === JSON.stringify(friendIds(pageNumber)) && friendReads() === listReadCount && await fixturePage.locator('#friend-list-title').evaluate(element => element === document.activeElement) && (pageNumber !== 3 || await fixturePage.getByRole('button',{name:'Next',exact:true}).isDisabled()), {route:'/friends',viewport:viewport.name,page:pageNumber,rows:visible.length,names:visible,friendReads:friendReads(),source:'actual in-page controls over one synthetic 23-friend response; no writes'});
      }
      const friendGeometry = await fixturePage.evaluate(() => ({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth}));
      check('P21-BROWSER-SYNTHETIC-FRIENDS-REFLOW', friendGeometry.scrollWidth <= friendGeometry.width + 1, {route:'/friends',viewport:viewport.name,...friendGeometry});
      await snapshot(fixturePage, 'synthetic-friends-' + viewport.name);
      await fixturePage.goto(origin + '/store', { waitUntil: 'networkidle' });
      await fixturePage.locator('[data-store-products]').waitFor();
      check('P21-BROWSER-SYNTHETIC-STORE-UNAVAILABLE', await fixturePage.locator('[data-store-action="purchase"]').count() === 0, { viewport: viewport.name, source: 'synthetic unavailable provider response' });
      check('P21-BROWSER-NO-AUTOMATIC-WRITES', reads.every(read => read.method === 'GET') && !reads.some(read => read.path.startsWith('/api/account/')), { viewport: viewport.name, methods: [...new Set(reads.map(read => read.method))], sessionBootstrapRequests: reads.filter(read => read.path.startsWith('/api/account/')).length });
      await fixtureContext.close();
    }
    const authContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await localOnly(authContext);
    const authReads = [];
    await authContext.route(origin + '/api/**', async route => {
      authReads.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'AUTH_REQUIRED' }) });
    });
    const authPage = await authContext.newPage();
    track(authPage);
    await authPage.clock.install();
    await authPage.goto(origin + '/leaderboard', { waitUntil: 'networkidle' });
    const signIn = authPage.locator('[data-leaderboard-results] a[href="/account"]');
    await signIn.waitFor();
    const authText = await authPage.locator('[data-leaderboard-results]').textContent();
    check('P21-BROWSER-AUTH-STATE', /Sign in/i.test(authText) && !/could not be loaded|service.*unavailable/i.test(authText), { response: 'synthetic AUTH_REQUIRED', signInAction: await signIn.textContent() });
    await authPage.clock.fastForward(31000);
    check('P21-BROWSER-AUTH-NO-POLL', authReads.filter(read => read.path === '/api/v1/leaderboard').length === 1 && authReads.every(read => read.method === 'GET'), { response: 'synthetic AUTH_REQUIRED', leaderboardReads: authReads.filter(read => read.path === '/api/v1/leaderboard').length, simulatedMilliseconds: 31000 });
    await authContext.close();
    const downloadDevices = [
      { name: 'desktop', viewport: { width: 1280, height: 900 }, expectedPlatform: null },
      { name: 'android', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', expectedPlatform: 'android' },
      { name: 'ios', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', expectedPlatform: 'ios' },
    ];
    for (const device of downloadDevices) {
      const downloadContext = await browser.newContext({ viewport: device.viewport, userAgent: device.userAgent, reducedMotion: 'reduce' });
      await localOnly(downloadContext);
      const requests = [];
      const downloadPage = await downloadContext.newPage(); track(downloadPage);
      downloadPage.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname === '/api/download') {
          requests.push({ method: request.method(), pathname: url.pathname, platform: url.searchParams.get('platform'), documentNavigation: request.isNavigationRequest() });
        }
      });
      await downloadPage.goto(origin + '/', { waitUntil: 'networkidle' });
      const secondary = downloadPage.getByRole('link', { name: 'Download Now', exact: true });
      const href = await secondary.getAttribute('href');
      check('P21-BROWSER-HERO-DOWNLOAD-DESTINATION', new URL(href, origin).pathname === '/api/download', { device: device.name, href });
      await secondary.click();
      await downloadPage.waitForURL(url => url.pathname === '/download');
      await downloadPage.locator('#main h1').waitFor();
      check('P21-BROWSER-DOWNLOAD-NATIVE-NAVIGATION', requests.length === 1 && requests[0].method === 'GET' && requests[0].documentNavigation && requests[0].platform === device.expectedPlatform, { device: device.name, requests, source: 'local preview download handler with null store links' });
      check('P21-BROWSER-DOWNLOAD-CHOOSER', await downloadPage.locator('.mx-header').count() === 1 && await downloadPage.locator('.mx-footer').count() === 1 && await downloadPage.locator('a[href^="https://play.google.com"],a[href^="https://apps.apple.com"]').count() === 0, { device: device.name, externalListings: 'unconfigured' });
      await downloadContext.close();
    }
    const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await localOnly(noScriptContext);
    const noScriptPage = await noScriptContext.newPage();
    for (const route of ['/', '/how-to-play', '/themes', '/download', '/faq', '/privacy', '/terms', '/legal/support']) {
      const response = await noScriptPage.goto(origin + route, { waitUntil: 'networkidle' });
      const geometry = await noScriptPage.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
      check('P21-BROWSER-NOSCRIPT-PAGE', response?.status() === 200 && await noScriptPage.locator('#main h1').count() === 1 && await noScriptPage.locator('#main').innerText().then(text => text.trim().length > 80) && await noScriptPage.locator('.mx-header a').count() > 0 && await noScriptPage.locator('.mx-footer a').count() > 0, { route, javaScriptEnabled: false, status: response?.status() });
      check('P21-BROWSER-NOSCRIPT-REFLOW', geometry.scrollWidth <= geometry.width + 1, { route, javaScriptEnabled: false, ...geometry });
      const seo = await metadata(noScriptPage);
      check('P21-BROWSER-NOSCRIPT-METADATA', JSON.stringify(seo) === JSON.stringify(Object.fromEntries(['title', 'description', 'canonical', 'robots', 'ogTitle', 'ogUrl', 'twitterTitle', 'schema'].map(key => [key, rawMetadata.get(route)?.[key]]))), { route, title: seo.title, canonical: seo.canonical });
    }
    await noScriptPage.goto(origin + '/', { waitUntil: 'networkidle' });
    const supportHref = await noScriptPage.locator('.mx-noscript a').getAttribute('href');
    const supportResponse = await noScriptPage.goto(origin + supportHref, { waitUntil: 'networkidle' });
    check('P21-BROWSER-NOSCRIPT-SUPPORT', supportHref === '/support' && supportResponse?.status() === 200 && await noScriptPage.locator('main h1').count() === 1 && await noScriptPage.locator('.mx-header a').count() > 0, { javaScriptEnabled: false, href: supportHref, status: supportResponse?.status() });
    await noScriptContext.close();
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
    fs.writeFileSync(path.join(output, 'browser-qa-' + (report.source_commit || 'unversioned').slice(0, 12) + '-' + report.checked_at.replace(/[^0-9]/g, '') + '.json'), JSON.stringify(report, null, 2) + '\n');
    // Keep the compatibility pointer tied to Chromium's unchanged default.
    if (browserEngine === 'chromium') fs.writeFileSync(path.join(outputRoot, 'browser-qa.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ result: report.result, source_commit: report.source_commit, checks: report.checks.length, failures: report.failures.length, report: path.join(output, 'browser-qa.json') }) + '\n');
    if (report.result !== 'PASS') process.exitCode = 1;
  }
}

main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
