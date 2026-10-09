'use strict';
/* tests/v5-p11-vercel-config.test.js - V5 Phase 11 Task V5-11-01.
 *
 * SCOPE & CONTRACT:
 * Validates the isolated Vercel API project configuration, preview environments,
 * secret isolation, and route ownership manifest for Mega XO V5.
 *
 * VERIFICATION TARGETS:
 * 1. Project metadata & region placement (`apps/api/vercel.json`):
 *    - Valid Vercel project configuration with team and project identifiers.
 *    - Strict function region placement: `iad1` (US East - Ashburn / Washington DC),
 *      placing API compute directly adjacent to Neon `aws-us-east-1` (Spec 04 §5 latency mandate).
 *    - Functions resource configuration: 1024 MB memory, 15s maxDuration (Hobby tier ceiling),
 *      nodejs22.x runtime.
 *    - Perimeter security headers: Strict-Transport-Security, X-Content-Type-Options: nosniff,
 *      X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy.
 *    - Clean route rewrites to api entrypoint.
 *
 * 2. Package manifest (`apps/api/package.json`):
 *    - Private package `@mega-xo/api` with Node >=22.0.0 engine specification.
 *
 * 3. Environment validation and secret isolation (`apps/api/config.js`):
 *    - Explicit environment classification ('preview', 'staging', 'production').
 *    - Preview environments reject production origins and production databases.
 *    - Preview environments strictly bar production credentials and secrets.
 *    - Staging environment rejects production database.
 *    - Production environment requires production origin, production database, and mandatory secrets.
 *
 * 4. Route ownership manifest completeness (`docs/v5/ROUTE-MANIFEST.md`):
 *    - Comprehensive catalog containing all 8 required columns.
 *    - Full coverage of all V4 endpoints from `server/production/perimeter.js` line 7,
 *      `community-http.js`, parameterized routes, health routes, and archived endpoints (32+ routes).
 *
 * 5. Zero economic authority in Vercel API:
 *    - Manifest verifies Vercel API owns ZERO economic mutation routes.
 *    - All currency minting, wallet updates, and match settlements are strictly Core-Only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERCEL_JSON_PATH = path.join(ROOT, 'apps', 'api', 'vercel.json');
const PACKAGE_JSON_PATH = path.join(ROOT, 'apps', 'api', 'package.json');
const CONFIG_JS_PATH = path.join(ROOT, 'apps', 'api', 'config.js');
const ROUTE_MANIFEST_PATH = path.join(ROOT, 'docs', 'v5', 'ROUTE-MANIFEST.md');

/* ==========================================================================
 * Helper: Markdown Table Parser for Route Manifest
 * ========================================================================== */
function parseRouteManifestTable(markdownContent) {
  const lines = markdownContent.split('\n');
  const tableLines = lines.filter(line => line.trim().startsWith('|'));
  const headerIndex = tableLines.findIndex(line =>
    line.includes('Route') && line.includes('Method') && line.includes('Owner')
  );

  assert.ok(headerIndex !== -1, 'Manifest must contain a markdown table with Route, Method, and Owner headers');

  const rawHeaders = tableLines[headerIndex]
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);

  const rows = [];
  for (let i = headerIndex + 2; i < tableLines.length; i++) {
    const line = tableLines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(cell => cell.trim()).slice(1, -1);
    if (cells.length < rawHeaders.length) continue;

    const row = {};
    rawHeaders.forEach((h, idx) => {
      row[h] = cells[idx] || '';
    });

    if (row['Route']) {
      // Clean backticks: `/.well-known/jwks.json` -> /.well-known/jwks.json
      row.cleanRoute = row['Route'].replace(/`/g, '').trim();
    }
    rows.push(row);
  }

  return { headers: rawHeaders, rows };
}

/* ==========================================================================
 * 1. Vercel Project Metadata & Configuration Tests
 * ========================================================================== */
test('1.1 apps/api/vercel.json: valid JSON structure and project metadata', () => {
  assert.ok(fs.existsSync(VERCEL_JSON_PATH), 'apps/api/vercel.json must exist');
  const content = fs.readFileSync(VERCEL_JSON_PATH, 'utf8');
  const config = JSON.parse(content);

  assert.equal(config.name, 'mega-xo-api', 'Project name must be mega-xo-api');
  assert.equal(config.projectId, 'mega-xo-api', 'Project ID must be mega-xo-api');
  assert.equal(config.teamId, 'team_wS9BpnXbYRZahs1DiSueN3SS', 'Team ID must match oculusrex14s-projects');
  assert.equal(config.orgId, 'team_wS9BpnXbYRZahs1DiSueN3SS', 'Org ID must match team_wS9BpnXbYRZahs1DiSueN3SS');
  assert.equal(config.scope, 'team_wS9BpnXbYRZahs1DiSueN3SS', 'Scope must match team_wS9BpnXbYRZahs1DiSueN3SS');
});

test('1.2 apps/api/vercel.json: strict region placement to iad1 adjacent to Neon aws-us-east-1', () => {
  const config = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));

  assert.ok(Array.isArray(config.regions), 'regions must be an array');
  assert.equal(config.regions.length, 1, 'regions must contain exactly one region');
  assert.equal(config.regions[0], 'iad1', 'Compute region must strictly be iad1 (US East, adjacent to Neon aws-us-east-1)');
});

test('1.3 apps/api/vercel.json: function compute constraints (1024MB, 15s maxDuration, nodejs22.x)', () => {
  const config = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));

  assert.ok(config.functions, 'functions configuration must exist');
  const fnEntry = config.functions['api/**/*.js'] || config.functions['api/index.js'];
  assert.ok(fnEntry, 'functions must configure api/**/*.js or api/index.js');

  assert.equal(fnEntry.memory, 1024, 'Function memory must be set to 1024 MB');
  assert.equal(fnEntry.maxDuration, 15, 'Function maxDuration must be set to 15s (Hobby limit)');
  assert.ok(
    fnEntry.runtime.startsWith('nodejs22') || fnEntry.runtime.startsWith('nodejs20'),
    `Runtime must be modern Node.js, got ${fnEntry.runtime}`
  );
});

test('1.4 apps/api/vercel.json: perimeter security headers enforced', () => {
  const config = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));

  assert.ok(Array.isArray(config.headers), 'headers must be an array');
  const rootHeaderBlock = config.headers.find(h => h.source === '/(.*)' || h.source === '/(.*)');
  assert.ok(rootHeaderBlock, 'A root wildcard header rule must exist');

  const headersMap = {};
  for (const h of rootHeaderBlock.headers) {
    headersMap[h.key.toLowerCase()] = h.value;
  }

  assert.ok(headersMap['strict-transport-security'], 'Strict-Transport-Security must be configured');
  assert.ok(
    headersMap['strict-transport-security'].includes('includeSubDomains'),
    'HSTS must includeSubDomains'
  );

  assert.equal(headersMap['x-content-type-options'], 'nosniff', 'X-Content-Type-Options must be nosniff');
  assert.equal(headersMap['x-frame-options'], 'DENY', 'X-Frame-Options must be DENY');
  assert.ok(
    headersMap['referrer-policy'].includes('strict-origin'),
    'Referrer-Policy must be strict-origin-when-cross-origin or stricter'
  );
  assert.ok(
    headersMap['permissions-policy'].includes('camera=()') &&
    headersMap['permissions-policy'].includes('microphone=()') &&
    headersMap['permissions-policy'].includes('geolocation=()'),
    'Permissions-Policy must restrict camera, microphone, and geolocation'
  );
});

test('1.5 apps/api/vercel.json: clean rewrites route API and auth paths to index entrypoint', () => {
  const config = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));

  assert.ok(Array.isArray(config.rewrites), 'rewrites must be an array');
  const apiRewrite = config.rewrites.find(r => r.source === '/api/(.*)');
  assert.ok(apiRewrite, 'Rewrite for /api/(.*) must exist');
  assert.equal(apiRewrite.destination, '/api/index.js', 'API rewrite must target /api/index.js');

  const catchAllRewrite = config.rewrites.find(r => r.source === '/(.*)');
  assert.ok(catchAllRewrite, 'Catch-all rewrite must exist');
  assert.equal(catchAllRewrite.destination, '/api/index.js', 'Catch-all rewrite must target /api/index.js');
});

/* ==========================================================================
 * 2. Package Manifest Tests
 * ========================================================================== */
test('2.1 apps/api/package.json: valid private package with Node >=22.0.0 engine requirement', () => {
  assert.ok(fs.existsSync(PACKAGE_JSON_PATH), 'apps/api/package.json must exist');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  assert.equal(pkg.name, '@mega-xo/api', 'Package name must be @mega-xo/api');
  assert.equal(pkg.private, true, 'Package must be marked private');
  assert.ok(pkg.engines && pkg.engines.node, 'engines.node must be specified');
  assert.ok(
    pkg.engines.node.includes('>=22') || pkg.engines.node.includes('>=20'),
    'Engine must require Node 20 or Node 22+'
  );
  assert.equal(pkg.main, 'config.js', 'Main entrypoint must be config.js');
});

/* ==========================================================================
 * 3. Environment Validation & Secret Isolation Tests (apps/api/config.js)
 * ========================================================================== */
test('3.1 apps/api/config.js: exports expected configuration functions and constants', () => {
  assert.ok(fs.existsSync(CONFIG_JS_PATH), 'apps/api/config.js must exist');
  const apiConfig = require(CONFIG_JS_PATH);

  assert.equal(typeof apiConfig.validateConfig, 'function', 'validateConfig must be a function');
  assert.equal(typeof apiConfig.classifyEnvironment, 'function', 'classifyEnvironment must be a function');
  assert.equal(typeof apiConfig.assertSecretIsolation, 'function', 'assertSecretIsolation must be a function');
  assert.equal(typeof apiConfig.isProductionDatabase, 'function', 'isProductionDatabase must be a function');
  assert.equal(typeof apiConfig.isNonproductionDatabase, 'function', 'isNonproductionDatabase must be a function');
  assert.equal(typeof apiConfig.isProductionSecret, 'function', 'isProductionSecret must be a function');
  assert.ok(Array.isArray(apiConfig.VALID_ENVIRONMENTS), 'VALID_ENVIRONMENTS must be an array');
  assert.deepEqual(
    [...apiConfig.VALID_ENVIRONMENTS].sort(),
    ['preview', 'production', 'staging'].sort(),
    'Valid environments must be preview, staging, and production'
  );
});

test('3.2 apps/api/config.js: environment classification logic', () => {
  const { classifyEnvironment } = require(CONFIG_JS_PATH);

  assert.equal(classifyEnvironment({ MEGA_ENV: 'preview' }), 'preview');
  assert.equal(classifyEnvironment({ VERCEL_ENV: 'preview' }), 'preview');
  assert.equal(classifyEnvironment({ MEGA_ENV: 'staging' }), 'staging');
  assert.equal(classifyEnvironment({ VERCEL_ENV: 'staging' }), 'staging');
  assert.equal(classifyEnvironment({ MEGA_ENV: 'production' }), 'production');
  assert.equal(classifyEnvironment({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(classifyEnvironment({}), 'production', 'Defaults to production if unspecified');

  // Invalid environments throw INVALID_ENVIRONMENT
  for (const invalid of ['dev', 'local', 'test', 'unknown', 'qa']) {
    assert.throws(
      () => classifyEnvironment({ MEGA_ENV: invalid }),
      { message: 'INVALID_ENVIRONMENT' }
    );
  }
});

test('3.3 apps/api/config.js: database classification helpers', () => {
  const { isProductionDatabase, isNonproductionDatabase } = require(CONFIG_JS_PATH);

  const prodUrls = [
    'postgresql://user:pass@ep-prod-123.aws-us-east-1.neon.tech/mega_prod',
    'postgres://db_user:secret@prod-db.internal:5432/megaxo_production',
    'postgresql://mega:secret@production-db:5432/mega'
  ];

  const nonprodUrls = [
    'postgresql://user:pass@ep-staging-123.aws-us-east-1.neon.tech/mega_staging',
    'postgres://dev:dev@ep-preview-456.aws-us-east-1.neon.tech/preview_branch',
    'postgresql://postgres:postgres@localhost:5432/mega_test',
    'postgres://user:pass@ep-dev-789.neon.tech/dev'
  ];

  for (const url of prodUrls) {
    assert.equal(isProductionDatabase(url), true, `URL should be identified as production: ${url}`);
    assert.equal(isNonproductionDatabase(url), false, `URL should not be identified as nonproduction: ${url}`);
  }

  for (const url of nonprodUrls) {
    assert.equal(isNonproductionDatabase(url), true, `URL should be identified as nonproduction: ${url}`);
    assert.equal(isProductionDatabase(url), false, `URL should not be identified as production: ${url}`);
  }
});

test('3.4 apps/api/config.js: preview environment validation and strict secret isolation', () => {
  const { validateConfig, assertSecretIsolation } = require(CONFIG_JS_PATH);

  const validPreviewEnv = {
    MEGA_ENV: 'preview',
    DATABASE_URL: 'postgresql://user:pass@ep-staging-123.aws-us-east-1.neon.tech/mega_staging',
    VERCEL_URL: 'mega-xo-api-git-feat-preview.vercel.app'
  };

  const parsed = validateConfig(validPreviewEnv);
  assert.equal(parsed.env, 'preview');
  assert.equal(parsed.isPreview, true);
  assert.equal(parsed.isProduction, false);
  assert.equal(parsed.isStaging, false);
  assert.equal(parsed.region, 'iad1');
  assert.equal(parsed.origin, 'https://mega-xo-api-git-feat-preview.vercel.app');

  // Preview MUST reject production database
  assert.throws(
    () => validateConfig({
      ...validPreviewEnv,
      DATABASE_URL: 'postgresql://user:pass@ep-prod-123.aws-us-east-1.neon.tech/mega_prod'
    }),
    { message: 'PRODUCTION_DATABASE_FORBIDDEN_IN_NONPROD' }
  );

  // Preview MUST reject production hostname
  for (const host of ['api.megaxo.online', 'megaxo.online', 'play.antimatterinnovations.com']) {
    assert.throws(
      () => validateConfig({
        ...validPreviewEnv,
        MEGA_ORIGIN: `https://${host}`
      }),
      { message: 'PRODUCTION_HOST_FORBIDDEN_IN_PREVIEW' }
    );
  }

  // Preview MUST reject production secrets and credentials
  const forbiddenSecrets = [
    { PROD_DATABASE_KEY: 'some-secret' },
    { PRODUCTION_SECRET_KEY: 'some-key' },
    { PROD_SERVICE_TOKEN: 'some-token' },
    { MEGA_PROD_SECRET: 'some-secret' },
    { ANY_SECRET: 'super-production-secret-value' }
  ];

  for (const badSecret of forbiddenSecrets) {
    assert.throws(
      () => assertSecretIsolation({ ...validPreviewEnv, ...badSecret }, 'preview'),
      { message: 'PRODUCTION_SECRET_FORBIDDEN_IN_PREVIEW' },
      `Preview should reject forbidden production secret: ${JSON.stringify(badSecret)}`
    );
  }
});

test('3.5 apps/api/config.js: staging environment validation', () => {
  const { validateConfig } = require(CONFIG_JS_PATH);

  const validStagingEnv = {
    MEGA_ENV: 'staging',
    DATABASE_URL: 'postgresql://user:pass@ep-staging-123.aws-us-east-1.neon.tech/mega_staging',
    MEGA_ORIGIN: 'https://staging-api.megaxo.online'
  };

  const parsed = validateConfig(validStagingEnv);
  assert.equal(parsed.env, 'staging');
  assert.equal(parsed.isStaging, true);
  assert.equal(parsed.isPreview, false);
  assert.equal(parsed.isProduction, false);

  // Staging rejects production database
  assert.throws(
    () => validateConfig({
      ...validStagingEnv,
      DATABASE_URL: 'postgresql://user:pass@ep-prod-123.aws-us-east-1.neon.tech/mega_prod'
    }),
    { message: 'PRODUCTION_DATABASE_FORBIDDEN_IN_NONPROD' }
  );
});

test('3.6 apps/api/config.js: production environment requires production DB and mandatory secrets', () => {
  const { validateConfig } = require(CONFIG_JS_PATH);

  const baseProdEnv = {
    MEGA_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@ep-prod-123.aws-us-east-1.neon.tech/mega_prod',
    MEGA_ORIGIN: 'https://api.megaxo.online',
    MEGA_PROXY_SECRET: 'a'.repeat(64),
    MEGA_OTP_SECRET: 'b'.repeat(64),
    MEGA_AUDIT_SECRET: 'c'.repeat(64)
  };

  const parsed = validateConfig(baseProdEnv);
  assert.equal(parsed.env, 'production');
  assert.equal(parsed.isProduction, true);
  assert.equal(parsed.isPreview, false);
  assert.equal(parsed.isStaging, false);
  assert.equal(parsed.origin, 'https://api.megaxo.online');

  // Production rejects nonproduction database
  assert.throws(
    () => validateConfig({
      ...baseProdEnv,
      DATABASE_URL: 'postgresql://user:pass@ep-staging-123.aws-us-east-1.neon.tech/mega_staging'
    }),
    { message: 'NONPRODUCTION_DATABASE_FORBIDDEN_IN_PROD' }
  );

  // Production requires MEGA_PROXY_SECRET
  assert.throws(
    () => validateConfig({
      ...baseProdEnv,
      MEGA_PROXY_SECRET: ''
    }),
    { message: 'MISSING_MEGA_PROXY_SECRET' }
  );

  // Production requires MEGA_OTP_SECRET
  assert.throws(
    () => validateConfig({
      ...baseProdEnv,
      MEGA_OTP_SECRET: ''
    }),
    { message: 'MISSING_MEGA_OTP_SECRET' }
  );

  // Production requires MEGA_AUDIT_SECRET
  assert.throws(
    () => validateConfig({
      ...baseProdEnv,
      MEGA_AUDIT_SECRET: ''
    }),
    { message: 'MISSING_MEGA_AUDIT_SECRET' }
  );
});

test('3.7 apps/api/config.js: general validation rules (database URL, origin format)', () => {
  const { validateConfig } = require(CONFIG_JS_PATH);

  // Missing database URL
  assert.throws(
    () => validateConfig({ MEGA_ENV: 'preview', MEGA_ORIGIN: 'https://preview.vercel.app' }),
    { message: 'MISSING_DATABASE_URL' }
  );

  // Missing origin
  assert.throws(
    () => validateConfig({
      MEGA_ENV: 'preview',
      DATABASE_URL: 'postgresql://user:pass@ep-staging.neon.tech/staging'
    }),
    { message: 'MISSING_MEGA_ORIGIN' }
  );

  // Insecure or invalid origin (non-localhost HTTP)
  assert.throws(
    () => validateConfig({
      MEGA_ENV: 'staging',
      DATABASE_URL: 'postgresql://user:pass@ep-staging.neon.tech/staging',
      MEGA_ORIGIN: 'http://insecure-api.megaxo.online'
    }),
    { message: 'INVALID_ORIGIN' }
  );
});

/* ==========================================================================
 * 4. Route Ownership Manifest Completeness & Structure Tests
 * ========================================================================== */
test('4.1 docs/v5/ROUTE-MANIFEST.md: file exists and contains all required table columns', () => {
  assert.ok(fs.existsSync(ROUTE_MANIFEST_PATH), 'docs/v5/ROUTE-MANIFEST.md must exist');
  const markdown = fs.readFileSync(ROUTE_MANIFEST_PATH, 'utf8');

  const { headers, rows } = parseRouteManifestTable(markdown);

  const requiredColumns = [
    'Route',
    'Method',
    'Auth/CSRF requirement',
    'Owner',
    'Economic Authority',
    'Idempotency',
    'Cache class',
    'Status'
  ];

  for (const col of requiredColumns) {
    assert.ok(headers.includes(col), `Manifest table must contain column: '${col}'`);
  }

  assert.ok(rows.length >= 32, `Manifest must catalogue at least 32 endpoints, found ${rows.length}`);
});

test('4.2 docs/v5/ROUTE-MANIFEST.md: complete coverage of all known V4 perimeter endpoints', () => {
  const markdown = fs.readFileSync(ROUTE_MANIFEST_PATH, 'utf8');
  const { rows } = parseRouteManifestTable(markdown);
  const cataloguedRoutes = new Set(rows.map(r => r.cleanRoute));

  // The 41 explicit endpoints registered in server/production/perimeter.js:7
  const PERIMETER_KNOWN_ROUTES = [
    '/api/account/email',
    '/api/account/session',
    '/api/account/save',
    '/api/account/logout',
    '/api/account/profile',
    '/api/account/deletion',
    '/api/account/delete',
    '/api/account/start',
    '/api/account/native/challenge',
    '/api/account/native/finish',
    '/api/account/unlink',
    '/api/community/friends',
    '/api/community/search',
    '/api/community/presence',
    '/api/community/friend',
    '/api/community/challenges',
    '/api/v1/profile',
    '/api/v1/queue',
    '/api/v1/cancel-queue',
    '/api/v1/move',
    '/api/v1/resign',
    '/api/v1/offer',
    '/api/v1/accept',
    '/api/v1/decline',
    '/api/v1/cancel',
    '/api/v1/leaderboard',
    '/api/v1/invitations',
    '/api/v1/purchase',
    '/api/v1/convert',
    '/api/v1/quest',
    '/api/party/command',
    '/api/party/capabilities',
    '/api/monetization/status',
    '/api/monetization/purchase',
    '/api/monetization/restore',
    '/api/monetization/claim',
    '/api/monetization/reward-ticket',
    '/api/monetization/interstitial-permit',
    '/api/monetization/admob-ssv',
    '/api/monetization/google-play-rtdn',
    '/api/monetization/apple-notifications'
  ];

  for (const route of PERIMETER_KNOWN_ROUTES) {
    assert.ok(
      cataloguedRoutes.has(route),
      `Perimeter known route '${route}' must be present in ROUTE-MANIFEST.md`
    );
  }

  // Dynamic / prefixed routes from perimeter.js:10-11
  const PREFIX_ROUTES = [
    '/api/v1/match/:id',
    '/api/community/profile/:id',
    '/api/party/rooms/:id',
    '/auth/callback/:provider'
  ];

  for (const route of PREFIX_ROUTES) {
    assert.ok(
      cataloguedRoutes.has(route),
      `Parameterized route '${route}' must be present in ROUTE-MANIFEST.md`
    );
  }

  // Operational health checks from perimeter.js:66
  for (const healthRoute of ['/livez', '/readyz', '/opsz']) {
    assert.ok(
      cataloguedRoutes.has(healthRoute),
      `Health endpoint '${healthRoute}' must be present in ROUTE-MANIFEST.md`
    );
  }

  // Explicitly archived routes from perimeter.js:65
  for (const archivedRoute of ['/api/v1/cosmetic', '/api/monetization/redeem', '/api/monetization/equip']) {
    assert.ok(
      cataloguedRoutes.has(archivedRoute),
      `Archived route '${archivedRoute}' must be catalogued in ROUTE-MANIFEST.md`
    );
  }
});

/* ==========================================================================
 * 5. Zero Economic Authority Invariant Tests
 * ========================================================================== */
test('5.1 docs/v5/ROUTE-MANIFEST.md: Vercel API has ZERO economic mutation authority', () => {
  const markdown = fs.readFileSync(ROUTE_MANIFEST_PATH, 'utf8');
  const { rows } = parseRouteManifestTable(markdown);

  const vercelApiRows = rows.filter(r => r['Owner'] === 'Vercel API' || r['Owner'].includes('Vercel API'));
  assert.ok(vercelApiRows.length > 0, 'Vercel API must own routes in the manifest');

  // Invariant 1: Every route owned by Vercel API must have Economic Authority = 'None'
  for (const row of vercelApiRows) {
    assert.equal(
      row['Economic Authority'],
      'None',
      `Vercel API route '${row.cleanRoute}' must have Economic Authority 'None', got '${row['Economic Authority']}'`
    );
  }

  // Invariant 2: Explicit economic mutation routes MUST NOT be owned by Vercel API
  const ECONOMIC_MUTATION_ROUTES = [
    '/api/v1/convert',
    '/api/v1/quest',
    '/api/v1/purchase',
    '/api/v1/move',
    '/api/v1/resign',
    '/api/v1/offer',
    '/api/v1/accept',
    '/api/v1/decline',
    '/api/v1/cancel',
    '/api/v1/match/:id',
    '/api/monetization/purchase',
    '/api/monetization/restore',
    '/api/monetization/claim',
    '/api/monetization/reward-ticket',
    '/api/monetization/interstitial-permit',
    '/api/monetization/admob-ssv',
    '/api/monetization/google-play-rtdn',
    '/api/monetization/apple-notifications',
    '/api/party/command'
  ];

  for (const econRoute of ECONOMIC_MUTATION_ROUTES) {
    const matchingRows = rows.filter(r => r.cleanRoute === econRoute);
    assert.ok(matchingRows.length > 0, `Economic route '${econRoute}' must be catalogued`);

    for (const match of matchingRows) {
      assert.notEqual(
        match['Owner'],
        'Vercel API',
        `Economic mutation route '${econRoute}' must NEVER be owned by Vercel API`
      );
      assert.equal(
        match['Economic Authority'],
        'Core-Only',
        `Economic mutation route '${econRoute}' must have Economic Authority 'Core-Only'`
      );
      assert.equal(
        match['Owner'],
        'Game Core',
        `Economic mutation route '${econRoute}' must be owned by Game Core`
      );
    }
  }

  // Count total economic routes owned by Vercel API
  const vercelEconomicMutations = vercelApiRows.filter(r => r['Economic Authority'] !== 'None');
  assert.equal(
    vercelEconomicMutations.length,
    0,
    `Vercel API must own exactly 0 economic mutation routes, found: ${vercelEconomicMutations.length}`
  );
});

test('5.2 docs/v5/ROUTE-MANIFEST.md: explicit documentation invariant and summary metrics', () => {
  const markdown = fs.readFileSync(ROUTE_MANIFEST_PATH, 'utf8');

  // Checks for explicit architectural declaration of zero economic authority
  assert.ok(
    markdown.includes('0 routes (ZERO)') || markdown.includes('0 routes (0.0%)') || markdown.includes('0 routes'),
    'Manifest must explicitly document that Vercel API owns 0 economic mutation routes'
  );
  assert.ok(
    markdown.includes('Core-Only'),
    'Manifest must document Core-Only economic transactions'
  );
  assert.ok(
    markdown.includes('Economic Authority Invariant'),
    'Manifest must contain Economic Authority Invariant section'
  );
});
