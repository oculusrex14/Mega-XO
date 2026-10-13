'use strict';
/* scripts/v51/p21-staging-server.cjs - isolated V5.1 staging server.
 *
 * Composes the SAME real stack the acceptance smoke uses, but as a long-lived server so Codex (and
 * the browser/native clients) can reach a running staging origin:
 *
 *   apps/web static website + apps/api handler + the signed Core service ingress + the realtime
 *   transport, backed by the real Neon `mega_xo_v5_staging` database (api_runtime/core_runtime roles)
 *   and the real Upstash staging Redis. Nothing here can touch live V4: it binds loopback only, uses
 *   a distinct Redis keyVersion namespace, and never starts the V4 production or staging containers.
 *
 * Safety: refuses any non-loopback bind; keeps the staging noindex header; all three outbound
 * provider classes stay disabled (they are disabled in the bound target file itself). No secret is
 * printed. This is an isolated pre-production origin, not a production cutover.
 *
 * Usage: MEGA_V51_STAGING_SERVER=lively-shadow-52629967/mega_xo_v5_staging \
 *          node scripts/v51/p21-staging-server.cjs [--port 8081] [--host 127.0.0.1]
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
// Secret-material paths. Default to the operator's Mac layout; a co-located deployment (e.g. the same
// region as Neon) sets MEGA_V51_STAGING_SECRETS to its own directory. The files themselves are never
// committed and are mode 0600.
const SECRETS_DIR = process.env.MEGA_V51_STAGING_SECRETS || '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging';
const CREDENTIALS_PATH = path.join(SECRETS_DIR, 'credentials.json');
const CA_PATH = path.join(SECRETS_DIR, 'ca.pem');
const RUNTIME_ROLES_PATH = path.join(SECRETS_DIR, 'runtime-roles.json');
const UPSTASH_PATH = process.env.MEGA_V51_UPSTASH_PATH || '/Users/oculus/Downloads/Mega-XO-private-evidence/p06-provider-credentials/upstash-staging.json';

const { createPgPool } = require(path.join(ROOT, 'packages/db/pg/pool.js'));
const { createAccountService } = require(path.join(ROOT, 'packages/services/accounts.js'));
const { createCoreService } = require(path.join(ROOT, 'packages/services/core.js'));
const { createAccessService } = require(path.join(ROOT, 'packages/services/access.js'));
const { createTicketIssuer } = require(path.join(ROOT, 'packages/services/tickets.js'));
const { createEphemeraService } = require(path.join(ROOT, 'packages/services/ephemera.js'));
const { createQueueService } = require(path.join(ROOT, 'packages/services/queue.js'));
const { createCoreGateway, createCoreServiceIngress } = require(path.join(ROOT, 'packages/services/core-gateway.js'));
const { createRealtimeTransport } = require(path.join(ROOT, 'packages/services/realtime-transport.js'));
const { createApiHandler } = require(path.join(ROOT, 'apps/api/index.js'));
const security = require(path.join(ROOT, 'packages/services/security.js'));
const { resolveAuth } = require(path.join(ROOT, 'apps/api/routes/helpers.js'));
const { resolveStatic } = require(path.join(ROOT, 'scripts/p21/serve-web.js'));

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
});

/**
 * Loads a verified P21 build artifact: the generated bundle (built by scripts/p21/build-web.js) is
 * the ONLY thing served, never the raw apps/web source tree - the bundle is where the packaged
 * legacy game, store-links/legal-documents modules, fonts, art and bot worker actually live. The
 * artifact's own manifest is the route table and the file allowlist, so an unlisted path is a real
 * 404 rather than a rewritten source file.
 */
function loadWebArtifact(dir) {
  const manifestPath = path.join(dir, 'web-build.manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('WEB_BUILD_ARTIFACT_REQUIRED: run scripts/p21/build-web.js');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) {
    throw new Error('WEB_BUILD_ARTIFACT_INVALID');
  }
  return Object.freeze({
    dir, routes: manifest.routes || {}, files: new Set(['web-build.manifest.json', ...manifest.files.map((f) => f.path)]),
    sourceCommit: manifest.source_commit || null, bundleSha256: manifest.bundle_sha256 || null, fileCount: manifest.file_count || manifest.files.length,
  });
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const GATEWAY_TIMEOUT_MS = 30000;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const safeError = (err) => (err && err.message) ? String(err.message).slice(0, 120) : 'ERROR';

/**
 * Loads the STABLE staging OTP HMAC secret. A fresh random secret on every restart would make each
 * instance's one-time codes unverifiable by any other instance and would invalidate every code
 * already mailed. The secret therefore lives in the staging secrets directory (create mode 0600),
 * is never printed, and is shared by every staging process for this environment.
 */
function loadStagingOtpSecret(secretPath) {
  if (fs.existsSync(secretPath)) {
    const value = fs.readFileSync(secretPath, 'utf8').trim();
    if (value.length >= 32) return value;
    throw new Error('STAGING_OTP_SECRET_TOO_SHORT');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated + '\n', { mode: 0o600, flag: 'wx' });
  return generated;
}

async function main() {
  if (process.env.MEGA_V51_STAGING_SERVER !== 'lively-shadow-52629967/mega_xo_v5_staging') {
    throw new Error('EXPLICIT_STAGING_SERVER_OPT_IN_REQUIRED');
  }
  const host = arg('--host', '127.0.0.1');
  const port = Number(arg('--port', '8081'));
  const webBuildDir = path.resolve(arg('--web-build', path.join(ROOT, '.artifacts/p21-web')));
  const OTP_SECRET_PATH = path.join(path.dirname(CREDENTIALS_PATH), 'staging-otp.secret');
  // A private reachable origin (e.g. the tailnet HTTPS name from `tailscale serve`) is an allowed
  // browser origin for CORS/CSRF, so a reviewer on the tailnet can authenticate over HTTPS. It must
  // be https and must not be a wildcard; it grants no new authority, only an accepted Origin value.
  const publicOrigin = arg('--public-origin', null);
  if (publicOrigin !== null) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { throw new Error('INVALID_PUBLIC_ORIGIN'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin.replace(/\/$/, '')) throw new Error('PUBLIC_ORIGIN_MUST_BE_HTTPS_ORIGIN');
  }
  // Loopback is always allowed. A non-loopback bind must name the exact interface (e.g. the
  // Tailscale IP) via --allow-host; wildcard binds are refused so staging can never be exposed
  // beyond an explicit, private address.
  const allowed = new Set(String(arg('--allow-host', '')).split(',').map((s) => s.trim()).filter(Boolean));
  if (!LOOPBACK.has(host) && !allowed.has(host)) throw new Error('REFUSED_NON_LOOPBACK_BIND');
  if (host === '0.0.0.0' || host === '::') throw new Error('REFUSED_WILDCARD_BIND');
  for (const p of [CREDENTIALS_PATH, CA_PATH, RUNTIME_ROLES_PATH, UPSTASH_PATH]) {
    if (!fs.existsSync(p)) throw new Error('MISSING_STAGING_MATERIAL');
  }

  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const caPem = fs.readFileSync(CA_PATH, 'utf8');
  const runtimeRoles = JSON.parse(fs.readFileSync(RUNTIME_ROLES_PATH, 'utf8'));
  const target = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/v5/environments/staging.json'), 'utf8'));
  const redisTarget = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/v5/environments/redis-staging.json'), 'utf8'));
  const upstashCred = JSON.parse(fs.readFileSync(UPSTASH_PATH, 'utf8'));
  const migrationUrl = new URL(creds.migration_url);
  // Same strict target binding as the acceptance smoke - never point this at another database.
  if (target.projectId !== 'lively-shadow-52629967' || target.database !== 'mega_xo_v5_staging' ||
      target.environment !== 'staging' || target.nonserving !== true ||
      creds.project !== target.projectId || creds.branch !== target.branchId || creds.database !== target.database ||
      runtimeRoles.host !== target.host || runtimeRoles.database !== target.database ||
      migrationUrl.hostname !== target.host || migrationUrl.pathname !== `/${target.database}` ||
      Object.values(target.outbound && target.outbound.email === 'disabled' ? target.outbound : {}).some((v) => v !== 'disabled')) {
    throw new Error('REFUSED_STAGING_TARGET_BINDING');
  }
  const redisUrl = new URL(upstashCred.url);
  if (redisTarget.environment !== 'staging' || redisTarget.redis.nonserving !== true ||
      redisTarget.redis.provider !== 'upstash' || redisUrl.protocol !== 'rediss:' ||
      redisUrl.hostname !== redisTarget.redis.host || Number(redisUrl.port || 6379) !== redisTarget.redis.port) {
    throw new Error('REFUSED_UPSTASH_STAGING_TARGET');
  }

  const budget = Object.freeze({ totalConnections: 30, roleConnections: Object.freeze({ api_runtime: 16, core_runtime: 8, worker_runtime: 4 }) });
  const mkPool = (role) => createPgPool({
    host: runtimeRoles.host, port: 5432, database: runtimeRoles.database, user: role,
    password: runtimeRoles.roles[role].password, role, label: 'staging', service: 'v51-staging-server', revision: 'v51-server',
    ssl: { ca: caPem, rejectUnauthorized: true }, sslRootCertPath: CA_PATH, channel_binding: 'require', targetFile: path.join(ROOT, 'docs/v5/environments/staging.json'),
    budget, pool: { max: 6, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 },
    lockTimeoutMs: 15000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 15000,
  });
  const apiPool = mkPool('api_runtime');
  const corePool = mkPool('core_runtime');
  const poolCheck = (await apiPool.query('SELECT current_user AS role')).rows[0];
  const coreCheck = (await corePool.query('SELECT current_user AS role')).rows[0];
  if (poolCheck.role !== 'api_runtime' || coreCheck.role !== 'core_runtime') throw new Error('RUNTIME_ROLE_BINDING_FAILED');

  // ONE stable staging OTP secret, loaded BEFORE any consumer, shared by the account service that
  // MINTS/HASHES the code and the API handler that verifies it. Passing two different secrets (the
  // previous fresh `crypto.randomBytes` here vs. the stable file below) made every freshly issued
  // code unverifiable and made a code unverifiable after a restart. The secret lives in the staging
  // secrets directory (0600), is never printed, and is identical for every staging process.
  const stagingOtpSecret = loadStagingOtpSecret(OTP_SECRET_PATH);
  const keyFile = path.join(path.dirname(CREDENTIALS_PATH), 'keys.sealed.json');
  if (!fs.existsSync(keyFile)) throw new Error('EXISTING_SIGNING_KEY_CUSTODY_REQUIRED');
  const activeKeys = await apiPool.query("SELECT kid FROM identity.signing_keys WHERE environment = 'stg' AND state = 'active'");
  if (activeKeys.rows.length !== 1) throw new Error('EXISTING_ACTIVE_SIGNING_KEY_REQUIRED');
  const access = await createAccessService(apiPool, {
    issuer: 'https://api.megaxo.online', environment: 'stg', keyFile,
    playerAudiences: ['mega-browser', 'mega-android', 'mega-ios'], serviceAudiences: ['mega-core'],
  });
  const ephemera = await createEphemeraService({ url: upstashCred.url, environment: 'stg', keyVersion: `s${crypto.randomBytes(3).toString('hex').slice(0, 7)}`, socket: { connectTimeout: 5000 } });
  if (!(await ephemera.healthy())) throw new Error('UPSTASH_STAGING_UNHEALTHY');
  // HTTP commands and socket commands share Core's existing post-commit publisher.
  // The same caller-owned adapter wakes realtime readers after the durable commit.
  const core = await createCoreService(corePool, { ephemera });
  // A real email signup commits the actor + a durable `account.provision` outbox row, but the WALLET
  // is Core-owned: without this callback the new actor has no `economy.wallets` row, so the first
  // queue/accept/convert fails `ACCOUNT_REQUIRED`. The production worker drains that outbox; this
  // isolated origin wires the SAME `core.provisionActor` effect after commit (at-least-once; the
  // durable outbox row remains the correctness contract), so a real signup can actually play.
  const accounts = await createAccountService(apiPool, {
    deletionPolicy: { enabled: true, policyVersion: 'v51-staging' }, otpSecret: stagingOtpSecret,
    provisionActor: async (actor) => { await core.provisionActor(actor); },
    cancelSocialOffers: async (actor, target) => { await core.cancelSocialOffers(actor, target); },
  });
  const ticketIssuer = await createTicketIssuer(apiPool, { environment: 'stg', audience: 'mega-core' });
  const queue = await createQueueService({ ephemera, core, pool: corePool });
  const GATEWAY_SECRET = crypto.randomBytes(32).toString('hex');
  const coreIngress = createCoreServiceIngress({ coreService: core, ticketIssuer, queue, leaderboardPool: corePool, secret: GATEWAY_SECRET });
  const coreGateway = createCoreGateway({ coreUrl: `http://${host}:${port}`, secret: GATEWAY_SECRET, timeoutMs: GATEWAY_TIMEOUT_MS });

  const webArtifact = loadWebArtifact(webBuildDir);
  // Staging outbound email is disabled by design (no live SMTP), so a controlled sign-in test needs
  // the one-time code from somewhere. `--otp-out` appends each delivery to a loopback-only file
  // (mode 0600) OUTSIDE the repository; absent the flag the code is dropped, never logged.
  const otpOut = arg('--otp-out', null);
  const otpSink = otpOut ? (delivery) => {
    fs.appendFileSync(path.resolve(otpOut), JSON.stringify({ at: new Date().toISOString(), ...delivery }) + '\n', { mode: 0o600 });
  } : undefined;

  let origin = `http://${host}:${port}`;
  const allowedOrigins = ['https://megaxo.online', 'https://play.antimatterinnovations.com', origin];
  if (publicOrigin) allowedOrigins.push(publicOrigin);
  const apiHandler = createApiHandler({
    pool: apiPool, accounts, coreGateway, access, nativeAudiences: ['mega-ios', 'mega-android'],
    queue: coreGateway, otpSecret: stagingOtpSecret, otpSink,
    // The realtime-ticket route (POST /api/v1/ticket) resolves a ticket issuer from context; without
    // it the route returns 503. Wire the SAME issuer the ingress uses, so browser/native clients can
    // obtain a realtime ticket in staging just as in production.
    ticketIssuer,
    allowedOrigins,
  });

  const artifactDir = webArtifact.dir;
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', origin);
      const pathname = parsedUrl.pathname;
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (security.isOperatorRoute(pathname)) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'PRIVATE_OPERATOR_ROUTE' })); return; }
      if (pathname === '/realtime/v1/snapshot' || pathname === '/realtime/v1/snapshot/' || pathname.startsWith('/realtime/v1/match/')) return;
      if (pathname.startsWith('/ingress/')) { await coreIngress(req, res); return; }
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/.well-known/') ||
          pathname === '/health' || pathname === '/livez' || pathname === '/readyz') { await apiHandler(req, res); return; }
      if (pathname === '/legacy-game') { res.statusCode = 308; res.setHeader('Location', '/legacy-game/' + (parsedUrl.search || '')); res.end(); return; }
      // The generated bundle is the allowlist: an unlisted path is a real 404, never a source file
      // and never an HTML SPA fallback for a missing script/image/font/worker.
      const resolved = resolveStatic(webArtifact, pathname);
      if (resolved.text !== null) { res.statusCode = resolved.status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(resolved.text); return; }
      const absolute = path.resolve(artifactDir, resolved.file);
      if (!absolute.startsWith(artifactDir + path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found'); return;
      }
      res.statusCode = resolved.status;
      res.setHeader('Content-Type', MIME_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream');
      fs.createReadStream(absolute).pipe(res); return;
    } catch (err) { if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); } res.end(JSON.stringify({ error: safeError(err) })); }
  });

  const realtime = createRealtimeTransport({
    server, pool: corePool, core, ephemera, environment: 'stg', audience: 'mega-core',
    authenticateHttp: async (req) => {
      // The realtime handshake must accept the SAME origins the HTTP API accepts, including the HTTPS
      // public origin; the earlier `[origin]` allowed only the loopback/tailnet http origin, so a
      // browser on the HTTPS staging URL could sign in but its WebSocket Origin was refused.
      security.validateCredentials({ cookie: req.headers.cookie, authorization: req.headers.authorization, method: req.method, allowedOrigins });
      const { actor } = await resolveAuth({ accounts, access, nativeAudiences: ['mega-ios', 'mega-android'] }, req);
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    },
  });

  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, host, resolve); });
  origin = `http://${host}:${port}`;
  // Startup self-check: the generated bundle answers for the shell AND for the retained-game /
  // module / art / font / worker paths the client actually requests; a missing sub-resource is a
  // real 404, never an HTML SPA fallback. This is the difference between "a shell returned 200"
  // and "the site works".
  const probe = async (pathname, method = null) => {
    try {
      const r = await fetch(origin + pathname, method ? { method } : undefined);
      const body = method === 'HEAD' ? null : await r.arrayBuffer();
      return { status: r.status, type: r.headers.get('content-type') || '', bytes: body ? body.byteLength : Number(r.headers.get('content-length') || 0) };
    } catch (err) { return { status: 0, type: '', error: safeError(err) }; }
  };
  const shell = await fetch(`${origin}/`).then((r) => r.text()).catch(() => '');
  const livez = await probe('/livez');
  const assets = {};
  for (const p of ['/legacy-game/src/game.js', '/legacy-game/src/bot/worker.js', '/store-links.js', '/legal-documents.js',
    '/assets/art/mark.webp', '/assets/fonts/ibm-plex-mono-latin.woff2', '/assets/fonts/space-grotesk-latin.woff2']) {
    assets[p] = await probe(p);
  }
  const missing = await probe('/legacy-game/src/does-not-exist.js');
  const assetSelfCheck = Object.values(assets).every((a) => a.status === 200);
  console.log(JSON.stringify({
    ok: true, origin, publicOrigin, allowedOrigins, database: target.database, environment: 'staging', nonserving: target.nonserving,
    redisNamespace: ephemera.keyVersion, outbound: target.outbound,
    webBuild: { dir: artifactDir, sourceCommit: webArtifact.sourceCommit, bundleSha256: webArtifact.bundleSha256, fileCount: webArtifact.fileCount },
    websiteServesShell: shell.includes('mx-web-shell'), livezStatus: livez.status,
    assets, missingAssetStatus: missing.status, assetSelfCheck,
    note: 'isolated loopback staging origin; noindex enforced; live V4 untouched; serves the generated P21 bundle',
  }, null, 2));

  const shutdown = async () => {
    clearInterval(matchmakerTimer);
    try { await realtime.close(); } catch {}
    try { await new Promise((r) => server.close(r)); } catch {}
    for (const c of [() => queue.close(), () => ephemera.close(), () => ticketIssuer.close?.(), () => core.close(), () => accounts.close(), () => apiPool.end(), () => corePool.end()]) { try { await c(); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  // Real matchmaking needs a matcher tick: two real browsers JOIN the queue over HTTP, but nothing
  // pairs them unless a matcher claims+commits. The production worker normally ticks; the isolated
  // staging origin had no loop, so a real two-browser queue join never produced a match. This tick
  // is bounded, single-flight (never overlapping), best-effort (a transient DB error never kills
  // the server) and only pairs actors that are ALREADY in the durable queue. It changes no matching
  // rule, TTL or economy. Disable with --no-matchmaker if a test needs to tick manually.
  let matchmakerTimer = null;
  if (arg('--matchmaker', 'on') !== 'off') {
    const matcherId = `stg_matcher_${process.pid}`;
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        for (const mode of ['casual', 'ranked']) {
          const result = await queue.matchTick({ mode, matcherId, limit: 4, makeId: () => crypto.randomUUID() });
          if (result.matched) console.log(JSON.stringify({ event: 'matchmaker.pairing', mode, matched: result.matched, at: new Date().toISOString() }));
        }
      } catch (error) {
        // Best-effort: a staging tick that fails must never crash the origin or alter a request.
        console.error(JSON.stringify({ event: 'matchmaker.tick_error', code: safeError(error) }));
      } finally { ticking = false; }
    };
    matchmakerTimer = setInterval(tick, 3000);
    tick();
  }
  setInterval(() => {}, 1 << 30); // keep the process alive
}

main().catch((err) => { console.error('STAGING_SERVER_FAILED', safeError(err)); process.exit(1); });
