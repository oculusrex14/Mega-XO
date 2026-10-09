'use strict';
/* tests/v5-p11-website-foundations.test.js - V5 Phase 11 Task V5-11-05.
 *
 * SCOPE & CONTRACT:
 * Validates website and mobile association technical foundations on real loopback PostgreSQL 16
 * using the guarded `api_runtime` pool from `tests/v5-pg-lab.js`.
 *
 * VERIFICATION TARGETS:
 * 1. Association endpoints:
 *    - GET /.well-known/assetlinks.json returns 200 application/json with valid Android App Links array.
 *    - GET /.well-known/apple-app-site-association returns 200 application/json with iOS Universal Links details.
 * 2. Edge health & readiness:
 *    - GET /health, /livez, /readyz return 200 application/json with edge status.
 * 3. Static legal technical resources:
 *    - GET /privacy, /terms, /support, /privacy-choices, /delete-account return 200 text/html.
 *    - GET /legal.css returns 200 text/css.
 * 4. OAuth callback route contracts:
 *    - /auth/callback/:provider enforces callback parameter contracts for Google and Apple.
 *    - Rejects invalid providers and missing code/state parameters.
 *    - Handles provider-reported error callbacks via 303 redirect with authError.
 * 5. Browser-style authentication harness (createBrowserAuthHarness):
 *    - Authenticates against durable PostgreSQL platform via session cookies.
 *    - Automatic CSRF origin compliance for mutating operations.
 *    - Reads and updates caller profile in identity.profiles.
 *    - Reads and updates cloud save state in profile.profile_saves.
 *    - Multi-actor isolation: distinct session cookies map to distinct permanent actors.
 *    - Both network fetch and headless in-process handler execution modes.
 * 6. Zero new website UI invariant:
 *    - Strictly no frontend frameworks (React, Vue, Svelte, JSX/TSX) or SPA game views in apps/api.
 *    - public/ directory strictly limited to compliance legal docs, no playable UI.
 * 7. Clean teardown with lab.installCleanup: no lingering handles or open sockets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('./v5-pg-lab.js');

const { createApiHandler } = require('../apps/api/index.js');
const wellKnownRoutes = require('../apps/api/routes/well-known.js');
const { createBrowserAuthHarness, MemoryCookieJar } = require('../packages/services/browser-harness.js');
const servicesIndex = require('../packages/services/index.js');

/* Register top-level cleanup of synthetic PG16 databases and guarded connection pools */
lab.installCleanup(test);

/* ---------------------------------------------------------------- Test Fixtures */

const ACTORS = Object.freeze([
  { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  { actor: 'svc_bob', coins: 800, crowns: 50, rating: 1400, games: 20, stats: 'friends' },
]);

/**
 * Starts a real loopback HTTP server wrapping the given request handler.
 * Tracks all active sockets to ensure immediate, clean shutdown.
 */
function startApiServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const sockets = new Set();

    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        server,
        port,
        url,
        close: async () => {
          for (const s of sockets) {
            try { s.destroy(); } catch {}
          }
          sockets.clear();
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
          if (server.listening) {
            await new Promise((res) => {
              server.close(() => res());
              setTimeout(res, 50).unref();
            });
          }
        },
      });
    });

    server.on('error', reject);
  });
}

/**
 * Issues a real HTTP request over loopback to the running API server.
 */
function httpRequest(baseUrl, routePath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const u = new URL(routePath, baseUrl);
    const reqHeaders = {
      connection: 'close',
      ...headers,
    };
    if (bodyStr !== null && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }
    if (bodyStr !== null && !reqHeaders['content-length']) {
      reqHeaders['content-length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(u, {
      method,
      agent: false,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          raw,
        });
      });
    });

    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

/**
 * Sets up a full API test harness backed by real loopback PostgreSQL 16.
 */
async function setupApiHarness(database, options = {}) {
  const pools = lab.poolsFor(database);
  const accounts = await lab.accountsFor(database, {
    deletionPolicy: { enabled: true, policyVersion: 'v5-p11-test-policy' },
    ...options,
  });
  const core = await lab.coreFor(database, { ...options });

  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    core,
    ...options,
  });

  const serverInstance = await startApiServer(handler);

  async function close() {
    if (serverInstance && serverInstance.close) {
      try { await serverInstance.close(); } catch {}
    }
    if (core && core.close) {
      try { await core.close(); } catch {}
    }
    await lab.closeDatabasePools(database);
  }

  return {
    handler,
    accounts,
    core,
    pools,
    serverInstance,
    url: serverInstance.url,
    close,
  };
}

/* ==========================================================================
 * 1. Association Endpoints (.well-known/assetlinks.json & apple-app-site-association)
 * ========================================================================== */

test('1. Association endpoints: serves valid Android and iOS association files with correct content-types', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_foundations_assoc');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  // 1.1 Android App Links: GET /.well-known/assetlinks.json
  const assetLinksRes = await httpRequest(harness.url, '/.well-known/assetlinks.json');
  assert.equal(assetLinksRes.status, 200, 'GET /.well-known/assetlinks.json returns 200');
  assert.match(
    assetLinksRes.headers['content-type'],
    /application\/json/,
    'Content-Type must be application/json'
  );
  assert.ok(Array.isArray(assetLinksRes.data), 'assetlinks.json body must be an array');
  assert.ok(assetLinksRes.data.length > 0, 'assetlinks.json must contain at least one statement');

  const statement = assetLinksRes.data[0];
  assert.ok(Array.isArray(statement.relation), 'Statement must have relation array');
  assert.ok(
    statement.relation.includes('delegate_permission/common.handle_all_urls'),
    'Relation must include delegate_permission/common.handle_all_urls'
  );
  assert.equal(statement.target.namespace, 'android_app', 'Target namespace must be android_app');
  assert.match(
    statement.target.package_name,
    /com\.antimatter/,
    'Package name matches antimatter app bundle'
  );
  assert.ok(
    Array.isArray(statement.target.sha256_cert_fingerprints),
    'Target must have sha256_cert_fingerprints array'
  );
  assert.ok(
    statement.target.sha256_cert_fingerprints.length > 0,
    'Must have at least one cert fingerprint'
  );

  // 1.2 iOS Universal Links: GET /.well-known/apple-app-site-association
  const appleRes = await httpRequest(harness.url, '/.well-known/apple-app-site-association');
  assert.equal(appleRes.status, 200, 'GET /.well-known/apple-app-site-association returns 200');
  assert.match(
    appleRes.headers['content-type'],
    /application\/json/,
    'Content-Type must be application/json'
  );
  assert.ok(appleRes.data && typeof appleRes.data === 'object', 'Body must be an object');
  assert.ok(appleRes.data.applinks, 'Must contain applinks property');
  assert.ok(Array.isArray(appleRes.data.applinks.details), 'applinks.details must be an array');
  assert.ok(appleRes.data.applinks.details.length > 0, 'applinks.details must have entries');

  const appDetails = appleRes.data.applinks.details[0];
  assert.ok(Array.isArray(appDetails.appIDs), 'appIDs must be an array');
  assert.ok(
    appDetails.appIDs.some((id) => id.includes('megaxo') || id.includes('antimatter')),
    'appIDs contains app identifier'
  );
  assert.ok(appleRes.data.webcredentials, 'Must contain webcredentials section');

  // 1.3 Non-GET method on association files returns 404
  const postAssoc = await httpRequest(harness.url, '/.well-known/assetlinks.json', {
    method: 'POST',
    body: { test: true },
  });
  assert.equal(postAssoc.status, 404, 'POST to association endpoint returns 404');
});

/* ==========================================================================
 * 2. Edge Health and Readiness Endpoints (/health, /livez, /readyz)
 * ========================================================================== */

test('2. Health checks: /health, /livez, and /readyz report healthy edge status', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_foundations_health');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  for (const endpoint of ['/health', '/livez', '/readyz']) {
    const res = await httpRequest(harness.url, endpoint);
    assert.equal(res.status, 200, `${endpoint} returns 200`);
    assert.match(res.headers['content-type'], /application\/json/, `${endpoint} is application/json`);
    assert.equal(res.data.status, 'ok', `${endpoint} reports status: ok`);
    assert.equal(res.data.live, true, `${endpoint} reports live: true`);
    assert.equal(res.data.ready, true, `${endpoint} reports ready: true`);
    assert.ok(typeof res.data.time === 'number', `${endpoint} includes timestamp`);
  }
});

/* ==========================================================================
 * 3. Static Legal Technical Resources (/privacy, /terms, /support, etc.)
 * ========================================================================== */

test('3. Legal resources: serves compliant HTML pages and CSS assets from public directory', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_foundations_legal');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  const legalRoutes = [
    { path: '/privacy', matchText: /privacy/i },
    { path: '/terms', matchText: /terms/i },
    { path: '/support', matchText: /support/i },
    { path: '/privacy-choices', matchText: /privacy|opt-out|choices/i },
    { path: '/delete-account', matchText: /delete|account/i },
  ];

  for (const { path: routePath, matchText } of legalRoutes) {
    const res = await httpRequest(harness.url, routePath);
    assert.equal(res.status, 200, `GET ${routePath} returns 200`);
    assert.match(res.headers['content-type'], /text\/html/, `${routePath} returns text/html`);
    assert.match(res.raw, matchText, `${routePath} body contains expected text`);

    // Verify .html alias also resolves
    const aliasRes = await httpRequest(harness.url, `${routePath}.html`);
    assert.equal(aliasRes.status, 200, `GET ${routePath}.html returns 200`);
  }

  // 3.1 Static stylesheet: GET /legal.css
  const cssRes = await httpRequest(harness.url, '/legal.css');
  assert.equal(cssRes.status, 200, 'GET /legal.css returns 200');
  assert.match(cssRes.headers['content-type'], /text\/css/, '/legal.css returns text/css');

  // 3.2 Non-existent static resource returns 404
  const notFoundRes = await httpRequest(harness.url, '/public/non-existent-file-xyz.html');
  assert.equal(notFoundRes.status, 404, 'Non-existent public file returns 404');
});

/* ==========================================================================
 * 4. OAuth Callback Route Contract (/auth/callback/:provider)
 * ========================================================================== */

test('4. Callback contract: enforces OAuth callback parameter contracts for Google and Apple', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_foundations_callback');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  // 4.1 Unsupported provider returns 400 INVALID_PROVIDER
  const badProvider = await httpRequest(harness.url, '/auth/callback/facebook');
  assert.equal(badProvider.status, 400, 'Unsupported provider returns 400');
  assert.equal(badProvider.data.error, 'INVALID_PROVIDER', 'Error code is INVALID_PROVIDER');

  // 4.2 Missing parameters for google callback: enforces callback parameter contract
  const missingParamsGoogle = await httpRequest(harness.url, '/auth/callback/google');
  assert.ok(
    missingParamsGoogle.status === 303 || missingParamsGoogle.status === 400,
    'Missing callback parameters returns 303 or 400'
  );
  if (missingParamsGoogle.status === 303) {
    assert.match(
      missingParamsGoogle.headers['location'],
      /authError=/,
      '303 redirect includes authError param'
    );
  } else {
    assert.ok(missingParamsGoogle.data?.error, '400 response includes error description');
  }

  // 4.3 Missing parameters for apple callback (only state provided)
  const missingCodeApple = await httpRequest(harness.url, '/auth/callback/apple?state=test_state_123');
  assert.ok(
    missingCodeApple.status === 303 || missingCodeApple.status === 400,
    'Missing code returns 303 or 400'
  );
  if (missingCodeApple.status === 303) {
    assert.match(missingCodeApple.headers['location'], /authError=/);
  }

  // 4.4 Provider-reported error (e.g. ?error=access_denied)
  const errorCallback = await httpRequest(harness.url, '/auth/callback/google?error=access_denied');
  assert.equal(errorCallback.status, 303, 'Provider error redirects 303');
  assert.match(
    errorCallback.headers['location'],
    /authError=access_denied/,
    'Redirect location preserves provider error reason'
  );

  // 4.5 Valid parameters: code and state supplied redirect to linked completion
  const validCallback = await httpRequest(
    harness.url,
    '/auth/callback/google?code=valid_test_code_456&state=valid_state_abc'
  );
  assert.equal(validCallback.status, 303, 'Valid callback redirects 303');
  assert.match(
    validCallback.headers['location'],
    /account=linked/,
    'Redirect location signals successful linking'
  );
});

/* ==========================================================================
 * 5. Browser-Style Authentication Harness (createBrowserAuthHarness)
 * ========================================================================== */

test('5. Browser auth harness: connects, sets session cookies, and resolves identical PostgreSQL state', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_foundations_harness');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  // 5.1 Verify package export
  assert.equal(
    typeof servicesIndex.createBrowserAuthHarness,
    'function',
    'createBrowserAuthHarness is exported from packages/services'
  );

  // 5.2 Unauthenticated harness rejects protected requests
  const anonBrowser = createBrowserAuthHarness({ apiBaseUrl: harness.url });
  assert.equal(anonBrowser.getSessionToken(), null, 'Initial session token is null');

  const anonProfile = await anonBrowser.getProfile();
  assert.equal(anonProfile.status, 401, 'Unauthenticated browser request gets 401');

  // 5.3 Authenticate as Alice via session issuance against PostgreSQL accounts service
  const aliceBrowser = createBrowserAuthHarness({
    apiBaseUrl: harness.url,
    origin: 'https://megaxo.online',
  });
  const authResult = await aliceBrowser.authenticate({
    actor: 'svc_alice',
    accounts: harness.accounts,
  });
  assert.equal(authResult.actor, 'svc_alice', 'Harness reports authenticated actor');
  assert.ok(authResult.token, 'Session token was issued and set');
  assert.ok(aliceBrowser.getSessionToken(), 'Harness cookie jar holds session token');

  // 5.4 Retrieve caller profile using session cookie
  const aliceProfile = await aliceBrowser.getProfile();
  assert.equal(aliceProfile.status, 200, 'Authenticated getProfile returns 200');
  assert.equal(aliceProfile.tag, lab.tagFor('svc_alice'), 'Resolves canonical tag from PostgreSQL');
  assert.equal(aliceProfile.displayName, 'svc_alice', 'Initial displayName matches seed');
  assert.equal(aliceProfile.statsVisibility, 'friends', 'statsVisibility matches seed');

  // 5.5 Update profile through browser harness (verifying CSRF origin handling and PG persistence)
  const updateRes = await aliceBrowser.updateProfile({
    displayName: 'Alice Foundations Pro',
    avatar: 'crown',
    statsVisibility: 'public',
  });
  assert.equal(updateRes.status, 200, 'POST updateProfile returns 200');
  assert.equal(updateRes.displayName, 'Alice Foundations Pro', 'Returns updated displayName');

  // Direct PostgreSQL verification: identity.profiles reflects change
  const admin = await lab.adminClient(db);
  try {
    const profileRow = (await admin.query(
      'SELECT display_name, avatar, stats_visibility FROM identity.profiles WHERE actor_id = $1',
      ['svc_alice']
    )).rows[0];
    assert.ok(profileRow, 'identity.profiles row exists');
    assert.equal(profileRow.display_name, 'Alice Foundations Pro', 'Durable PG display_name updated');
    assert.equal(profileRow.avatar, 'crown', 'Durable PG avatar updated');
    assert.equal(profileRow.stats_visibility, 'public', 'Durable PG stats_visibility updated');
  } finally {
    await admin.end();
  }

  // Core service verifies identical database row
  const coreProfile = await harness.core.read(async (tx) => {
    const r = await tx.query(
      'SELECT display_name, avatar FROM identity.profiles WHERE actor_id = $1',
      ['svc_alice']
    );
    return r.rows[0];
  });
  assert.equal(coreProfile.display_name, 'Alice Foundations Pro', 'Core service observes identical state');
  assert.equal(coreProfile.avatar, 'crown', 'Core service observes identical avatar');

  // 5.6 Cloud save operations through browser harness
  const initialSave = await aliceBrowser.getSave();
  assert.equal(initialSave.status, 200, 'GET /api/account/save returns 200');

  const practiceData = lab.practicePayload('svc_alice', { theme: 'midnight', coins: 150 });
  const saveUpdate = await aliceBrowser.putSave(0, practiceData);
  assert.equal(saveUpdate.status, 200, 'POST /api/account/save returns 200');

  // Direct PostgreSQL verification for cloud save
  const adminSave = await lab.adminClient(db);
  try {
    const saveRow = (await adminSave.query(
      'SELECT revision, payload_text FROM profile.profile_saves WHERE actor_id = $1',
      ['svc_alice']
    )).rows[0];
    assert.ok(saveRow, 'profile.profile_saves row exists');
    assert.equal(Number(saveRow.revision), 1, 'Revision is 1 in PostgreSQL');
    const parsedSave = JSON.parse(saveRow.payload_text);
    assert.equal(parsedSave.settings.theme, 'midnight', 'Save data durably persisted in PostgreSQL');
  } finally {
    await adminSave.end();
  }

  // Refetch save via browser harness
  const refetchedSave = await aliceBrowser.getSave();
  assert.equal(refetchedSave.status, 200);
  assert.equal(refetchedSave.revision, 1);
  const currentPractice = refetchedSave.practice || refetchedSave.save;
  assert.equal(currentPractice?.settings?.theme, 'midnight');
  // 5.7 Actor separation: distinct browser harness for Bob resolves to Bob's state
  const bobBrowser = createBrowserAuthHarness({
    apiBaseUrl: harness.url,
    origin: 'https://megaxo.online',
  });
  await bobBrowser.authenticate({ actor: 'svc_bob', accounts: harness.accounts });

  const bobProfile = await bobBrowser.getProfile();
  assert.equal(bobProfile.status, 200);
  assert.equal(bobProfile.tag, lab.tagFor('svc_bob'), 'Bob harness resolves Bob tag');
  assert.equal(bobProfile.displayName, 'svc_bob', 'Bob profile is distinct from Alice');

  // 5.8 CSRF protection check: mutating request with cookie but disallowed origin is rejected
  const evilBrowser = createBrowserAuthHarness({
    apiBaseUrl: harness.url,
    origin: 'https://attacker.evil.com',
  });
  evilBrowser.setSession(aliceBrowser.getSessionToken());
  const csrfReject = await evilBrowser.updateProfile({ displayName: 'Hacked Name' });
  assert.equal(csrfReject.status, 403, 'Disallowed origin rejected with 403 CSRF_REJECTED');

  // 5.9 In-process handler execution mode (headless fast path)
  const inProcessHarness = createBrowserAuthHarness({
    handler: harness.handler,
    origin: 'https://megaxo.online',
  });
  await inProcessHarness.authenticate({ actor: 'svc_alice', accounts: harness.accounts });
  const inProcessProfile = await inProcessHarness.getProfile();
  assert.equal(inProcessProfile.status, 200, 'In-process execution returns 200');
  assert.equal(inProcessProfile.displayName, 'Alice Foundations Pro');
});

/* ==========================================================================
 * 6. Zero New Website UI Invariant Verification
 * ========================================================================== */

test('6. Invariant verification: asserts zero new website or browser gameplay UI in apps/api', async (t) => {
  const apiDir = path.resolve(__dirname, '../apps/api');
  const publicDir = path.resolve(__dirname, '../public');

  // 6.1 Assert apps/api does NOT contain frontend framework files (JSX, TSX, Vue, Svelte)
  function scanDir(dir, extensions) {
    const hits = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hits.push(...scanDir(full, extensions));
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        hits.push(full);
      }
    }
    return hits;
  }

  const disallowedExts = ['.jsx', '.tsx', '.vue', '.svelte'];
  const disallowedHits = scanDir(apiDir, disallowedExts);
  assert.equal(
    disallowedHits.length,
    0,
    `No frontend framework UI components in apps/api: found ${disallowedHits.join(', ')}`
  );

  // 6.2 Assert no frontend framework directories exist in apps/api
  const disallowedDirs = ['views', 'frontend', 'client', 'components', 'pages'];
  for (const dirName of disallowedDirs) {
    const p = path.join(apiDir, dirName);
    assert.equal(
      fs.existsSync(p),
      false,
      `apps/api/${dirName} directory MUST NOT exist (UI is DEFERRED_BY_OWNER to Phase 21)`
    );
  }

  // 6.3 Assert public/ directory strictly contains compliance technical legal resources
  const publicEntries = fs.readdirSync(publicDir);
  const allowedPublicFiles = new Set([
    'privacy.html',
    'terms.html',
    'support.html',
    'privacy-choices.html',
    'delete-account.html',
    'legal.css',
  ]);

  for (const file of publicEntries) {
    if (file.startsWith('.')) continue; // skip hidden dotfiles like .DS_Store
    assert.ok(
      allowedPublicFiles.has(file),
      `public/${file} is an unexpected file; public/ is reserved strictly for legal technical pages`
    );
  }

  // 6.4 Assert no SPA canvas or gameplay bundles exist in public/
  for (const file of publicEntries) {
    if (file.endsWith('.html')) {
      const content = fs.readFileSync(path.join(publicDir, file), 'utf8');
      assert.doesNotMatch(content, /<canvas/i, `${file} must not contain game canvas`);
      assert.doesNotMatch(content, /phaser|pixi|babylon|three\.js/i, `${file} must not include game engine`);
    }
  }

  // 6.5 Exported route handlers do not expose a game SPA index
  assert.ok(wellKnownRoutes.handleWellKnownRoute, 'wellKnownRoutes exports handleWellKnownRoute');
  assert.ok(wellKnownRoutes.getAssetLinks, 'wellKnownRoutes exports getAssetLinks');
  assert.ok(wellKnownRoutes.getAppleAppSiteAssociation, 'wellKnownRoutes exports getAppleAppSiteAssociation');
});
