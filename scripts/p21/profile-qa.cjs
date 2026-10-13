'use strict';

// Browser acceptance for the protected four-field profile editor. The runner
// serves a checksum-verified snapshot of an explicitly named build and uses
// fresh Playwright contexts plus synthetic same-origin API fixtures only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { ROOT, MANIFEST } = require('./build-web.js');
const { createPreviewServer } = require('./serve-web.js');

const EXPECTED_PROFILE_FIELDS = ['displayName', 'presenceVisibility', 'statsVisibility', 'username'];
const SAFE_ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const shellQuote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

function refuse(message) { throw new Error('P21_PROFILE_QA_REFUSED: ' + message); }

function parseArgs(argv) {
  const values = {};
  const names = new Set(['--bundle', '--expect-source', '--expect-bundle', '--browser', '--output-root']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      refuse('usage: node scripts/p21/profile-qa.cjs --bundle STATIC-ARTIFACT --expect-source COMMIT --expect-bundle SHA256 [--browser chromium|firefox|webkit] [--output-root PATH]');
    }
    values[name.slice(2)] = argv[++i];
  }
  for (const name of ['bundle', 'expect-source', 'expect-bundle']) if (!values[name]) refuse('--' + name + ' is required; the runner never builds or guesses an artifact');
  values.browser ||= 'chromium';
  if (!SAFE_ENGINES.has(values.browser)) refuse('--browser must be chromium, firefox, or webkit');
  if (!/^[a-f\d]{40}$/i.test(values['expect-source'])) refuse('--expect-source must be a full 40-character commit SHA');
  if (!/^[a-f\d]{64}$/i.test(values['expect-bundle'])) refuse('--expect-bundle must be a full SHA-256 digest');
  return values;
}

function safePayloadPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) refuse('manifest contains an unsafe payload path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) refuse('manifest path escapes the artifact');
  return target;
}

function verifyArtifact(bundleArgument, sourceCommit, bundleDigest) {
  const bundle = path.resolve(bundleArgument);
  if (!fs.existsSync(bundle) || fs.realpathSync(bundle) !== bundle || !fs.lstatSync(bundle).isDirectory()) refuse('--bundle must be an existing, unlinked artifact directory');
  const manifestPath = path.join(bundle, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) refuse('unrecognized P21 build manifest');
  if (manifest.source_commit !== sourceCommit || manifest.bundle_sha256 !== bundleDigest) refuse('artifact identity does not match the explicit expected commit and digest');
  if (manifest.api?.configured !== false || manifest.api?.preview_read_seam !== 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding') refuse('artifact must have the public read seam disabled');
  const seen = new Set(), rows = [];
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes)) refuse('artifact inventory is malformed');
    if (seen.has(file.path)) refuse('artifact inventory contains a duplicate path');
    seen.add(file.path);
    const target = safePayloadPath(bundle, file.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) refuse('artifact payload is missing or linked');
    const bytes = fs.readFileSync(target);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) refuse('artifact payload checksum mismatch: ' + file.path);
    rows.push(file.path + '\0' + file.bytes + '\0' + file.sha256);
  }
  if (sha256(Buffer.from(rows.join('\0'))) !== bundleDigest) refuse('recomputed build digest does not match');
  return { bundle, manifest };
}

function copySnapshot(artifact, destination) {
  for (const file of artifact.manifest.files) {
    const source = safePayloadPath(artifact.bundle, file.path);
    const target = safePayloadPath(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(destination, MANIFEST), JSON.stringify(artifact.manifest, null, 2) + '\n', { flag: 'wx' });
}

function makeProfile(id, username, displayName, tag) {
  return {
    id, username, displayName, name: displayName, avatar: 'rook',
    statsVisibility: 'friends', presenceVisibility: 'hidden', tag,
    tier: 'wood', rating: 1234, games: 10, region: 'IN',
    season: { qualified: true }, wallet: { coins: 321, crowns: 4 },
  };
}

function createFixture() {
  const actors = {
    'fixture-actor-one': makeProfile('fixture-actor-one', 'one_player', 'Fixture Player One', 'MEGA-FIXT1'),
    'fixture-actor-two': makeProfile('fixture-actor-two', 'second_player', 'Fixture Player Two', 'MEGA-FIXT2'),
  };
  const fixture = {
    actors,
    currentActor: 'fixture-actor-one',
    queuedSaveResponses: [],
    wireEvents: [],
    successfulFieldSets: [],
    pendingGate: null,
  };

  fixture.holdNext = (method, pathname) => {
    if (fixture.pendingGate) throw new Error('A synthetic API gate is already pending.');
    let observedResolve, replyResolve;
    const observed = new Promise(resolve => { observedResolve = resolve; });
    const reply = new Promise(resolve => { replyResolve = resolve; });
    const gate = {
      method, pathname, observed,
      release: outcome => replyResolve(outcome),
      announce: () => observedResolve(),
      reply,
    };
    fixture.pendingGate = gate;
    return gate;
  };

  fixture.handle = async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    const headers = request.headers();
    let body;
    try { if (request.postData()) body = JSON.parse(request.postData()); } catch {}
    const event = {
      method, path: pathname,
      field_names: body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [],
      csrf_header_present: Boolean(headers['x-csrf-token']),
      idempotency_header_present: Boolean(headers['idempotency-key']),
      cookie_header_present: Boolean(headers.cookie),
      reply_cache_control: 'private, no-store',
    };
    fixture.wireEvents.push(event);

    const gate = fixture.pendingGate;
    if (gate && gate.method === method && gate.pathname === pathname) {
      fixture.pendingGate = null;
      gate.announce();
      const held = await gate.reply;
      return route.fulfill({
        status: held.status,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
        body: JSON.stringify(held.body),
      });
    }

    let status = 200, result = { error: 'WEB_API_NOT_CONFIGURED' };
    if (method === 'GET' && pathname === '/api/v1/profile') result = { ...fixture.actors[fixture.currentActor] };
    else if (method === 'GET' && pathname === '/api/account/profile') result = { ...fixture.actors[fixture.currentActor] };
    else if (method === 'GET' && pathname === '/api/account/session') result = { csrf: 'synthetic-csrf-fixture', linked: true, providers: {} };
    else if (method === 'POST' && pathname === '/api/account/profile') {
      const actor = fixture.currentActor;
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
      fixture.successfulFieldSets.push(keys);
      const queued = fixture.queuedSaveResponses.shift();
      if (queued) {
        status = queued.status;
        result = { error: queued.error };
      } else if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_PROFILE_FIELDS)) {
        status = 400;
        result = { error: 'INVALID_PROFILE_FIXTURE' };
      } else {
        const current = fixture.actors[actor];
        fixture.actors[actor] = {
          ...current,
          username: body.username,
          displayName: body.displayName,
          name: body.displayName,
          statsVisibility: body.statsVisibility,
          presenceVisibility: body.presenceVisibility,
        };
        result = { ...fixture.actors[actor] };
      }
    } else if (method === 'POST' && pathname === '/api/account/logout') result = { ok: true };
    else status = 503;

    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      body: JSON.stringify(result),
    });
  };
  return fixture;
}

function check(report, id, passed, evidence = {}) {
  const row = { id, result: passed ? 'PASS' : 'FAIL', ...evidence };
  report.checks.push(row);
  if (!passed) report.failures.push(row);
  return passed;
}

async function waitForVisible(page, selector) {
  await page.locator(selector).waitFor({ state: 'visible', timeout: 8000 });
}

async function navigateFromMobileMenu(page, href) {
  const link = page.locator('#mobile-menu a[href="' + href + '"]');
  if (!await link.isVisible()) await page.locator('.mx-menu-button').click();
  await link.click();
}

async function navigateByHistory(page, href) {
  await page.evaluate(pathname => {
    history.pushState({}, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, href);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let playwright;
  try { playwright = require('playwright'); }
  catch { refuse('Playwright is unavailable; set NODE_PATH to the installed runtime node_modules directory'); }
  let playwrightVersion = 'unknown';
  try { playwrightVersion = require('playwright/package.json').version || 'unknown'; } catch {}

  const artifact = verifyArtifact(args.bundle, args['expect-source'], args['expect-bundle']);
  const outputBase = path.resolve(args['output-root'] || path.join(ROOT, 'tests-output/p21-web'));
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
  const output = path.join(outputBase, artifact.manifest.bundle_sha256.slice(0, 12), 'profile-' + args.browser, runStamp);
  fs.mkdirSync(output, { recursive: true });
  const snapshot = fs.mkdtempSync(path.join(ROOT, '.artifacts/.p21-profile-qa-'));
  let browser, server;
  const report = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    source_commit: artifact.manifest.source_commit,
    bundle_sha256: artifact.manifest.bundle_sha256,
    browser_engine: args.browser,
    runtime_version: process.version,
    playwright_version: playwrightVersion,
    command: 'env -u NODE_OPTIONS NODE_PATH=' + shellQuote(process.env.NODE_PATH || '') + ' ' + shellQuote(process.execPath) + ' scripts/p21/profile-qa.cjs --bundle ' + shellQuote(args.bundle) + ' --expect-source ' + args['expect-source'] + ' --expect-bundle ' + args['expect-bundle'] + ' --browser ' + args.browser,
    qa_script_sha256: sha256(fs.readFileSync(__filename)),
    environment: 'Local loopback only; checksum-verified immutable build snapshot; fresh unauthenticated browser context; synthetic linked actor fixtures; all other origins blocked.',
    fixture_boundary: 'The linked profile, account session, profile GET/POST, logout and all actor changes are synthetic browser route fixtures. No account, credential, provider, production or user browser was used.',
    isolated_payload_snapshot: true,
    checks: [],
    failures: [],
    api_fixture_summary: null,
    screenshots: [],
    limitations: ['Synthetic browser software acceptance only; no live API, authenticated user profile, physical device or production acceptance.'],
  };

  const screenshot = async (page, name) => {
    const target = path.join(output, name + '.png');
    await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
    report.screenshots.push(path.relative(ROOT, target));
  };

  try {
    copySnapshot(artifact, snapshot);
    server = createPreviewServer({ directory: snapshot, readApiOrigin: null });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await playwright[args.browser].launch({ headless: true });
    report.browser_version = browser.version();

    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const blockedExternal = new Set();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      blockedExternal.add(url.origin);
      return route.abort('blockedbyclient');
    });
    const fixture = createFixture();
    await context.route(origin + '/api/**', route => fixture.handle(route));
    const page = await context.newPage();
    const javascriptErrors = [];
    const apiResponseHeaders = [];
    page.on('pageerror', error => javascriptErrors.push(String(error.message).slice(0, 240)));
    page.on('response', async response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/')) {
        const headers = await response.allHeaders();
        apiResponseHeaders.push({ path: url.pathname, cache_control: headers['cache-control'] || '' });
      }
    });
    await page.addInitScript(() => {
      const audit = { reads: [], writes: [], removals: [] };
      Object.defineProperty(window, '__p21StorageAudit', { value: audit, configurable: false });
      const originals = { getItem: Storage.prototype.getItem, setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem };
      Storage.prototype.getItem = function(key) {
        if (this === window.localStorage) audit.reads.push(String(key));
        return originals.getItem.call(this, key);
      };
      Storage.prototype.setItem = function(key, value) {
        if (this === window.localStorage) audit.writes.push(String(key));
        return originals.setItem.call(this, key, value);
      };
      Storage.prototype.removeItem = function(key) {
        if (this === window.localStorage) audit.removals.push(String(key));
        return originals.removeItem.call(this, key);
      };
    });

    await page.goto(origin + '/profile', { waitUntil: 'networkidle' });
    await waitForVisible(page, '#profile-editor [data-profile-form]');
    const formState = await page.evaluate(() => {
      const form = document.querySelector('[data-profile-form]');
      const controls = [...form.elements].filter(element => element.name);
      return {
        fieldNames: controls.map(element => element.name).sort(),
        labels: controls.map(element => ({ name: element.name, labelCount: element.labels?.length || 0, describedBy: element.getAttribute('aria-describedby') })),
        forbiddenFields: [...form.querySelectorAll('[name="avatar"], [name="password"], [name="email"], [name="tag"], [name="coins"], [name="crowns"], [name="rating"], [name="games"]')].map(element => element.name),
        busy: document.querySelector('#profile-editor').getAttribute('aria-busy'),
        status: (() => { const element = form.querySelector('[data-profile-message]'); return { role: element.getAttribute('role'), live: element.getAttribute('aria-live'), tabIndex: element.tabIndex }; })(),
      };
    });
    check(report, 'P21-PROFILE-SYNTHETIC-LINKED-LOAD', formState.fieldNames.join(',') === EXPECTED_PROFILE_FIELDS.join(',') && formState.forbiddenFields.length === 0 && fixture.wireEvents.some(row => row.method === 'GET' && row.path === '/api/account/profile'), {
      fixture: 'synthetic linked actor; protected profile GET observed', field_names: formState.fieldNames, protected_fields_present: formState.forbiddenFields.length === 0,
    });
    check(report, 'P21-PROFILE-ACCESSIBLE-FIELDS-AND-STATUS', formState.labels.every(row => row.labelCount === 1 && row.describedBy) && formState.status.role === 'status' && formState.status.live === 'polite' && formState.status.tabIndex === -1, {
      field_label_count: formState.labels.map(row => row.labelCount), described_help_count: formState.labels.filter(row => row.describedBy).length,
      status_role: formState.status.role, live_region: formState.status.live, status_tab_index: formState.status.tabIndex,
    });
    check(report, 'P21-PROFILE-INITIAL-REFLOW-390', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), {
      viewport_width: 390, scroll_width: await page.evaluate(() => document.documentElement.scrollWidth),
    });
    await page.setViewportSize({ width: 320, height: 740 });
    const narrowProfileLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    check(report, 'P21-PROFILE-REFLOW-320', narrowProfileLayout.scrollWidth <= narrowProfileLayout.width + 1, {
      viewport_width: narrowProfileLayout.width, scroll_width: narrowProfileLayout.scrollWidth, route: '/profile', fixture: 'synthetic linked actor',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'profile-editor-ready-390');

    // Native browser validation must prevent a network write for malformed usernames.
    const writesBeforeInvalid = fixture.wireEvents.filter(row => row.method === 'POST' && row.path === '/api/account/profile').length;
    await page.getByLabel('Username').fill('1bad_name');
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    const invalidState = await page.getByLabel('Username').evaluate(input => ({ valid: input.validity.valid, focused: input === document.activeElement }));
    const writesAfterInvalid = fixture.wireEvents.filter(row => row.method === 'POST' && row.path === '/api/account/profile').length;
    check(report, 'P21-PROFILE-NATIVE-VALIDATION', !invalidState.valid && writesBeforeInvalid === writesAfterInvalid, {
      username_invalid: !invalidState.valid, invalid_field_received_focus: invalidState.focused, profile_posts_before: writesBeforeInvalid, profile_posts_after: writesAfterInvalid,
    });

    await page.getByLabel('Username').fill('taken_name');
    await page.getByLabel('Display name').fill('Fixture Edited Name');
    await page.getByLabel('Stats visibility').selectOption('private');
    await page.getByLabel('Online presence').selectOption('friends');
    fixture.queuedSaveResponses.push({ status: 409, error: 'USERNAME_TAKEN' });
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await page.getByText('That username is already in use. Choose another.', { exact: true }).waitFor();
    const takenDraft = await page.evaluate(() => ({
      fields: ['username', 'displayName', 'statsVisibility', 'presenceVisibility'].map(name => document.querySelector(`[name="${name}"]`).value),
      statusFocused: document.activeElement.matches('[data-profile-message][role="status"]'),
      status: document.querySelector('[data-profile-message]').textContent,
    }));
    check(report, 'P21-PROFILE-VALIDATION-DRAFT-RECOVERY', takenDraft.fields.join('|') === 'taken_name|Fixture Edited Name|private|friends' && takenDraft.statusFocused && /already in use/.test(takenDraft.status), {
      all_four_draft_fields_retained: true, error_status_focused: takenDraft.statusFocused, status_role: 'status',
    });

    await page.getByLabel('Username').fill('available_name');
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await page.getByText('Your profile changes are saved.', { exact: true }).waitFor();
    const firstSave = fixture.wireEvents.filter(row => row.method === 'POST' && row.path === '/api/account/profile').at(-1);
    const savedStatusFocused = await page.locator('[data-profile-message][role="status"]').evaluate(element => element === document.activeElement);
    check(report, 'P21-PROFILE-SAVE-FOUR-FIELD-WHITELIST', JSON.stringify(firstSave?.field_names) === JSON.stringify(EXPECTED_PROFILE_FIELDS) && firstSave?.csrf_header_present && firstSave?.idempotency_header_present && savedStatusFocused, {
      submitted_field_names: firstSave?.field_names || [], csrf_header_present: Boolean(firstSave?.csrf_header_present),
      idempotency_header_present: Boolean(firstSave?.idempotency_header_present), saved_status_focused: savedStatusFocused,
    });

    await page.getByLabel('Username').fill('recent_name');
    await page.getByLabel('Display name').fill('Fixture Privacy Edit');
    await page.getByLabel('Stats visibility').selectOption('private');
    await page.getByLabel('Online presence').selectOption('hidden');
    fixture.queuedSaveResponses.push({ status: 409, error: 'USERNAME_COOLDOWN' });
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await page.getByText(/Your username can change once every 7 days/).waitFor();
    const cooldownVisible = await page.locator('[data-profile-action="keep-username"]').isVisible();
    const cooldownDraftRetained = await page.evaluate(() => [...document.querySelectorAll('[data-profile-form] input, [data-profile-form] select')].map(element => element.value).join('|') === 'recent_name|Fixture Privacy Edit|private|hidden');
    check(report, 'P21-PROFILE-COOLDOWN-DRAFT-RECOVERY', cooldownVisible && cooldownDraftRetained, {
      keep_current_username_action: cooldownVisible, all_four_draft_fields_retained: cooldownDraftRetained,
    });
    await page.locator('[data-profile-action="keep-username"]').click();
    const keptDraft = await page.evaluate(() => ({
      username: document.querySelector('[name="username"]').value,
      displayName: document.querySelector('[name="displayName"]').value,
      statsVisibility: document.querySelector('[name="statsVisibility"]').value,
      presenceVisibility: document.querySelector('[name="presenceVisibility"]').value,
      focusRestored: document.querySelector('[name="username"]') === document.activeElement,
    }));
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await page.getByText('Your profile changes are saved.', { exact: true }).waitFor();
    const cooldownRecoveryPost = fixture.wireEvents.filter(row => row.method === 'POST' && row.path === '/api/account/profile').at(-1);
    const cooldownRecoveryPassed = keptDraft.username === 'available_name' && keptDraft.displayName === 'Fixture Privacy Edit' && keptDraft.statsVisibility === 'private' && keptDraft.presenceVisibility === 'hidden' && keptDraft.focusRestored && JSON.stringify(cooldownRecoveryPost?.field_names) === JSON.stringify(EXPECTED_PROFILE_FIELDS);
    check(report, 'P21-PROFILE-COOLDOWN-KEEP-AND-SAVE', cooldownRecoveryPassed, {
      current_username_restored: keptDraft.username === 'available_name', other_three_edits_retained: keptDraft.displayName === 'Fixture Privacy Edit' && keptDraft.statsVisibility === 'private' && keptDraft.presenceVisibility === 'hidden',
      focus_restored_to_username: keptDraft.focusRestored, submitted_field_names: cooldownRecoveryPost?.field_names || [],
    });

    // A focus refresh keeps the in-memory draft visible and locks the controls
    // until the same actor is re-confirmed by the protected profile GET.
    await page.getByLabel('Username').fill('unsaved_name');
    await page.getByLabel('Display name').fill('Unsaved Fixture Draft');
    await page.getByLabel('Stats visibility').selectOption('friends');
    await page.getByLabel('Online presence').selectOption('hidden');
    const sameActorGet = fixture.holdNext('GET', '/api/account/profile');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sameActorGet.observed;
    const refreshPending = await page.evaluate(() => ({
      busy: document.querySelector('#profile-editor')?.getAttribute('aria-busy'),
      fields: ['username', 'displayName', 'statsVisibility', 'presenceVisibility'].map(name => {
        const element = document.querySelector(`[name="${name}"]`); return { value: element?.value, disabled: element?.disabled };
      }),
      message: document.querySelector('[data-profile-message]')?.textContent || '',
    }));
    const pendingLocked = refreshPending.busy === 'true' && refreshPending.fields.every(field => field.disabled) && refreshPending.fields.map(field => field.value).join('|') === 'unsaved_name|Unsaved Fixture Draft|friends|hidden';
    check(report, 'P21-PROFILE-SAME-ACTOR-REFRESH-LOCKS-DRAFT', pendingLocked, {
      controls_disabled_during_refresh: refreshPending.fields.every(field => field.disabled), draft_visible_in_memory: refreshPending.fields.map(field => field.value).join('|') === 'unsaved_name|Unsaved Fixture Draft|friends|hidden',
      aria_busy: refreshPending.busy, confirming_status: /Confirming your account/.test(refreshPending.message),
    });
    sameActorGet.release({ status: 200, body: { ...fixture.actors[fixture.currentActor] } });
    await page.waitForFunction(() => {
      const form = document.querySelector('[data-profile-form]');
      return form && !form.querySelector('[name="username"]').disabled && form.querySelector('[name="username"]').value === 'unsaved_name';
    });
    const afterSameActor = await page.evaluate(() => [...document.querySelectorAll('[data-profile-form] input, [data-profile-form] select')].map(element => element.value).join('|'));
    check(report, 'P21-PROFILE-SAME-ACTOR-REFRESH-RETAINS-DRAFT', afterSameActor === 'unsaved_name|Unsaved Fixture Draft|friends|hidden', {
      all_four_fields_retained_after_refresh: afterSameActor === 'unsaved_name|Unsaved Fixture Draft|friends|hidden',
    });

    // A late AUTH_REQUIRED from the former actor must not retire the newly
    // linked actor or replace the second actor's rendered profile.
    const actorStalePost = fixture.holdNext('POST', '/api/account/profile');
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await actorStalePost.observed;
    fixture.currentActor = 'fixture-actor-two';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('[data-profile-form] [name="username"]')?.value === 'second_player');
    actorStalePost.release({ status: 401, body: { error: 'AUTH_REQUIRED' } });
    await page.waitForTimeout(120);
    const actorFence = await page.evaluate(() => ({
      username: document.querySelector('[data-profile-form] [name="username"]')?.value,
      editorPresent: Boolean(document.querySelector('[data-profile-form]')),
      authMessage: /Sign in to edit your profile|Sign in to play online/.test(document.querySelector('#main')?.textContent || ''),
    }));
    check(report, 'P21-PROFILE-ACTOR-STALE-AUTH-FENCED', actorFence.editorPresent && actorFence.username === 'second_player' && !actorFence.authMessage, {
      new_actor_editor_preserved: actorFence.editorPresent, new_actor_profile_remains_linked: actorFence.username === 'second_player', stale_auth_did_not_sign_out: !actorFence.authMessage,
    });

    // A request that finishes after SPA navigation away from /profile is also
    // fenced; returning to the route loads the still-linked synthetic actor.
    const routeStalePost = fixture.holdNext('POST', '/api/account/profile');
    await page.getByLabel('Display name').fill('Route Fixture Draft');
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await routeStalePost.observed;
    await navigateFromMobileMenu(page, '/');
    await page.locator('#hero-title').waitFor();
    routeStalePost.release({ status: 401, body: { error: 'AUTH_REQUIRED' } });
    await page.waitForTimeout(120);
    await navigateByHistory(page, '/profile');
    await waitForVisible(page, '#profile-editor [data-profile-form]');
    const routeFence = await page.evaluate(() => ({ username: document.querySelector('[data-profile-form] [name="username"]')?.value, status: document.querySelector('[data-profile-message]')?.textContent || '' }));
    check(report, 'P21-PROFILE-ROUTE-STALE-AUTH-FENCED', routeFence.username === 'second_player' && !/Sign in|could not be loaded/i.test(routeFence.status), {
      linked_actor_loaded_after_return: routeFence.username === 'second_player', stale_auth_error_not_rendered: !/Sign in|could not be loaded/i.test(routeFence.status),
    });

    // Logout while a profile save is pending, then deliver its stale auth
    // response. The route remains signed out and no profile details return.
    const logoutStalePost = fixture.holdNext('POST', '/api/account/profile');
    await page.getByLabel('Display name').fill('Logout Fixture Draft');
    await page.getByRole('button', { name: 'Save profile changes' }).click();
    await logoutStalePost.observed;
    await navigateByHistory(page, '/account');
    await page.locator('[data-account-action="logout"]').click();
    await page.getByRole('heading', { name: 'Continue to Mega XOXO' }).waitFor();
    logoutStalePost.release({ status: 401, body: { error: 'AUTH_REQUIRED' } });
    await page.waitForTimeout(120);
    const logoutPageState = await page.evaluate(() => ({
      guestTitle: document.querySelector('#main h2')?.textContent?.trim(),
      profileForm: Boolean(document.querySelector('[data-profile-form]')),
      syntheticPrivateTextVisible: /one_player|second_player|Fixture Player Two|MEGA-FIXT2/.test(document.querySelector('#main')?.textContent || ''),
    }));
    await navigateByHistory(page, '/profile');
    const signedOutState = await page.evaluate(() => ({
      form: Boolean(document.querySelector('[data-profile-form]')),
      signInLink: [...document.querySelectorAll('#profile-editor a[href="/account"]')].some(anchor => /Sign in to edit your profile/.test(anchor.textContent)),
      privateTextVisible: /one_player|second_player|Fixture Player Two|MEGA-FIXT2/.test(document.querySelector('#main')?.textContent || ''),
    }));
    check(report, 'P21-PROFILE-LOGOUT-STALE-AUTH-FENCED', logoutPageState.guestTitle === 'Continue to Mega XOXO' && !logoutPageState.profileForm && !logoutPageState.syntheticPrivateTextVisible && !signedOutState.form && signedOutState.signInLink && !signedOutState.privateTextVisible, {
      signed_out_account_surface_retained: logoutPageState.guestTitle === 'Continue to Mega XOXO', profile_details_absent_after_late_auth: !logoutPageState.syntheticPrivateTextVisible && !signedOutState.privateTextVisible,
      profile_editor_hidden_while_signed_out: !signedOutState.form, sign_in_path_available: signedOutState.signInLink,
    });

    // The editor does not persist profile drafts or cached private responses.
    const privacy = await page.evaluate(async () => ({
      storage: window.__p21StorageAudit,
      keys: Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)),
      cacheNames: await caches.keys(),
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    }));
    await page.waitForTimeout(120);
    const privateCacheHeader = fixture.wireEvents.length > 0 && apiResponseHeaders.length === fixture.wireEvents.length && apiResponseHeaders.every(row => row.cache_control === 'private, no-store');
    const profileStorageKeys = [...privacy.storage.reads, ...privacy.storage.writes, ...privacy.storage.removals, ...privacy.keys].filter(key => /profile|actor|player|session|account|auth|csrf|token|wallet|coin|crown/i.test(key));
    check(report, 'P21-PROFILE-NO-LOCALSTORAGE', privacy.storage.writes.length === 0 && privacy.storage.removals.length === 0 && profileStorageKeys.length === 0, {
      local_storage_write_count: privacy.storage.writes.length, local_storage_remove_count: privacy.storage.removals.length,
      profile_or_auth_storage_keys: profileStorageKeys.length,
    });
    check(report, 'P21-PROFILE-NO-PRIVATE-CACHE', privateCacheHeader && privacy.cacheNames.length === 0 && !privacy.serviceWorkerControlled, {
      protected_api_cache_control: privateCacheHeader ? 'private, no-store' : 'unexpected', cache_storage_entries: privacy.cacheNames.length,
      service_worker_controls_page: privacy.serviceWorkerControlled,
    });
    check(report, 'P21-PROFILE-REFLOW-390-SIGNED-OUT', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), {
      viewport_width: 390, scroll_width: await page.evaluate(() => document.documentElement.scrollWidth), route: '/profile', session: 'signed-out fixture',
    });
    check(report, 'P21-PROFILE-JAVASCRIPT-ERRORS', javascriptErrors.length === 0, { error_count: javascriptErrors.length, errors: javascriptErrors });

    report.api_fixture_summary = {
      synthetic_api_requests: fixture.wireEvents.length,
      observed_profile_reads: fixture.wireEvents.filter(row => row.method === 'GET' && row.path === '/api/account/profile').length,
      observed_profile_writes: fixture.wireEvents.filter(row => row.method === 'POST' && row.path === '/api/account/profile').length,
      profile_write_field_sets: fixture.successfulFieldSets,
      all_profile_write_field_sets_whitelisted: fixture.successfulFieldSets.every(fields => JSON.stringify(fields) === JSON.stringify(EXPECTED_PROFILE_FIELDS)),
      private_no_store_responses: apiResponseHeaders.length,
      requests_with_cookie_headers: fixture.wireEvents.filter(row => row.cookie_header_present).length,
      requests_missing_csrf_header: fixture.wireEvents.filter(row => row.method === 'POST' && row.path.startsWith('/api/account/') && !row.csrf_header_present).length,
      requests_missing_idempotency_header: fixture.wireEvents.filter(row => row.method === 'POST' && row.path.startsWith('/api/account/') && !row.idempotency_header_present).length,
      other_origins_blocked: blockedExternal.size,
    };
  } catch (error) {
    const message = String(error?.message || error).replace(/https?:\/\/[^\s)]+/g, '[local-url]').slice(0, 600);
    check(report, 'P21-PROFILE-EXECUTION', false, { error: message });
  } finally {
    try { await browser?.close(); } catch {}
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(snapshot, { recursive: true, force: true });
  }

  report.result = report.failures.length === 0 ? 'PASS_AUTOMATED_LOCAL_ONLY' : 'FAIL';
  const reportPath = path.join(output, 'profile-qa.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ result: report.result, checks: report.checks.length, failures: report.failures.length, report: path.relative(ROOT, reportPath) }, null, 2) + '\n');
  if (report.result !== 'PASS_AUTOMATED_LOCAL_ONLY') process.exitCode = 1;
}

main().catch(error => { process.stderr.write(String(error?.message || error) + '\n'); process.exitCode = 1; });
