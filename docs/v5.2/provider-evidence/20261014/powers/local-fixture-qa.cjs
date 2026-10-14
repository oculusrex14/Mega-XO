'use strict';
// Isolated source presentation fixture: no build, server, provider or auth session.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../../../..');
const load = name => fs.readFileSync(path.join(root, name), 'utf8');
const sourceFiles = ['apps/web/board.js', 'apps/web/board.css', 'apps/web/powers.js', 'apps/web/powers.css'];
const report = { environment: 'LOCAL STATIC SOURCE FIXTURE ONLY; no network, provider, Core, signed device or released bundle', checkedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries(sourceFiles.map(name => [name, crypto.createHash('sha256').update(load(name)).digest('hex')])), browser: 'Chromium', checks: [], failures: [], screenshots: [] };
const check = (id, pass, observed) => { const item = { id, pass: !!pass, observed }; report.checks.push(item); if (!pass) report.failures.push(item); };
const output = path.join(__dirname, 'local-fixture-screenshots');
fs.mkdirSync(output, { recursive: true });
let css = load('apps/web/styles.css');
css = css.replace(/url\(\/assets\/fonts\/([a-z]+)-([^\)]+)\)/g, (_all, family, filename) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, 'assets/vendor/fonts', family, filename)).toString('base64')})`);
css += '\n' + load('apps/web/board.css') + '\n' + load('apps/web/powers.css') + '\nbody{margin:0;background:#030917}.fixture-label{padding:12px;background:#fff;color:#171a1f;font:600 12px system-ui,sans-serif;text-align:center}';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ['cinematic', 'vector', 'midnight', 'paperclub', 'afterhours']) {
      for (const width of [320, 390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route('**/*', route => route.abort());
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div class="fixture-label">LOCAL PRESENTATION FIXTURE · powers unavailable · no provider or backend</div><main id="fixture"></main>`);
        await page.addScriptTag({ content: load('src/game.js') });
        await page.addScriptTag({ content: load('apps/web/powers.js') });
        await page.addScriptTag({ content: load('apps/web/board.js').replace(/^export /gm, '') + '\nglobalThis.FixtureBoard = { renderGame, mountBoard };' });
        await page.evaluate(theme => {
          document.querySelector('#fixture').innerHTML = FixtureBoard.renderGame({ theme });
          globalThis.fixtureMount = FixtureBoard.mountBoard(document.querySelector('[data-board-host]'), { preview: false, theme });
        }, theme);
        await page.evaluate(() => document.fonts.ready);
        const prefix = `${theme}-${width}`;
        check(prefix + '-disabled', await page.locator('[data-gb-power="request"]').isDisabled() && await page.locator('[data-gb-power="apply"]').isDisabled(), 'Rewarded/use controls disabled with absent contract');
        check(prefix + '-unknown', (await page.locator('.gb-powers').innerText()).includes('Earned charges unavailable'), 'Missing authority shows unknown charges');
        await page.locator('.gb-powers summary').focus(); await page.keyboard.press('Enter');
        check(prefix + '-drawer-keyboard', await page.locator('.gb-powers details').evaluate(el => el.open), 'Keyboard opens bank drawer');
        await page.locator('[data-gb-power="refresh"]').focus(); await page.keyboard.press('Enter');
        check(prefix + '-refresh-focus', await page.evaluate(() => document.activeElement?.dataset.gbPower === 'refresh'), 'Refresh restores keyboard focus');
        check(prefix + '-drawer-retained', await page.locator('.gb-powers details').evaluate(el => el.open), 'Refresh retains expanded drawer');
        check(prefix + '-casual-disabled', await page.locator('.gb-powers-casual select').isDisabled(), 'Casual ruleset activation unavailable');
        check(prefix + '-counters-disabled', await page.locator('.gb-powers-counters button').evaluateAll(items => items.every(item => item.disabled)), 'Counter and hint controls remain disabled');
        const clipping = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, panelWidth: document.querySelector('.gb-powers').getBoundingClientRect().width }));
        check(prefix + '-no-clipping', clipping.scroll <= clipping.client + 1, clipping);
        const contrasts = await page.locator('.gb-powers').evaluate(el => {
          const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
          const lum = color => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          const background = getComputedStyle(el).backgroundColor;
          return [...el.querySelectorAll('h2,p,small,dt,dd,summary,.gb-powers-badge,.gb-powers-eyebrow')].map(item => {
            const fg = lum(getComputedStyle(item).color), bg = lum(background);
            return { element: item.tagName.toLowerCase() + (item.className ? '.' + item.className : ''), ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
          });
        });
        check(prefix + '-text-contrast', contrasts.every(item => item.ratio >= 4.5), { minimumRatio: Math.min(...contrasts.map(item => item.ratio)), samples: contrasts.length });
        const focus = await page.locator('.gb-powers summary').evaluate(el => { el.focus(); const style = getComputedStyle(el); return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }; });
        check(prefix + '-focus-visible', focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) >= 3, focus);
        await page.locator('.gb-powers').evaluate(el => el.insertAdjacentHTML('afterbegin', '<p style="font:600 10px system-ui,sans-serif;border-bottom:1px solid currentColor;padding-bottom:8px">LOCAL PRESENTATION FIXTURE · NO POWER AUTHORITY</p>'));
        await page.locator('.gb-powers').screenshot({ path: path.join(output, prefix + '-expanded.png') });
        report.screenshots.push('local-fixture-screenshots/' + prefix + '-expanded.png');
        if (width === 1280) {
          await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
          const zoom = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, panelRight: document.querySelector('.gb-powers').getBoundingClientRect().right }));
          check(prefix + '-zoom-200-no-clipping', zoom.scroll <= zoom.client + 1 && zoom.panelRight <= zoom.client * 2 + 1, zoom);
          await page.locator('.gb-powers').screenshot({ path: path.join(output, theme + '-zoom-200-expanded.png') });
          report.screenshots.push('local-fixture-screenshots/' + theme + '-zoom-200-expanded.png');
        }
        await page.locator('[data-gb-setting="mode"]').selectOption('local');
        check(prefix + '-same-screen-hidden', await page.locator('.gb-powers').count() === 0, 'Same-screen mode has no powers');
        check(prefix + '-no-script-errors', errors.length === 0, errors);
        await page.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(__dirname, 'local-fixture-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures.length, screenshots: report.screenshots.length, report: path.join(__dirname, 'local-fixture-report.json') }));
  if (report.failures.length) { console.log(JSON.stringify(report.failures)); process.exitCode = 1; }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
