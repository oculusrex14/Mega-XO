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
const CREDENTIALS_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/credentials.json';
const CA_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/ca.pem';
const RUNTIME_ROLES_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/runtime-roles.json';
const UPSTASH_PATH = '/Users/oculus/Downloads/Mega-XO-private-evidence/p06-provider-credentials/upstash-staging.json';

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

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
});
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const GATEWAY_TIMEOUT_MS = 30000;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const safeError = (err) => (err && err.message) ? String(err.message).slice(0, 120) : 'ERROR';

async function main() {
  if (process.env.MEGA_V51_STAGING_SERVER !== 'lively-shadow-52629967/mega_xo_v5_staging') {
    throw new Error('EXPLICIT_STAGING_SERVER_OPT_IN_REQUIRED');
  }
  const host = arg('--host', '127.0.0.1');
  const port = Number(arg('--port', '8081'));
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

  const accounts = await createAccountService(apiPool, { deletionPolicy: { enabled: true, policyVersion: 'v51-staging' }, otpSecret: crypto.randomBytes(32).toString('hex') });
  const keyFile = path.join(path.dirname(CREDENTIALS_PATH), 'keys.sealed.json');
  if (!fs.existsSync(keyFile)) throw new Error('EXISTING_SIGNING_KEY_CUSTODY_REQUIRED');
  const activeKeys = await apiPool.query("SELECT kid FROM identity.signing_keys WHERE environment = 'stg' AND state = 'active'");
  if (activeKeys.rows.length !== 1) throw new Error('EXISTING_ACTIVE_SIGNING_KEY_REQUIRED');
  const access = await createAccessService(apiPool, {
    issuer: 'https://api.megaxo.online', environment: 'stg', keyFile,
    playerAudiences: ['mega-browser', 'mega-android', 'mega-ios'], serviceAudiences: ['mega-core'],
  });
  const core = await createCoreService(corePool);
  const ephemera = await createEphemeraService({ url: upstashCred.url, environment: 'stg', keyVersion: `s${crypto.randomBytes(3).toString('hex').slice(0, 7)}`, socket: { connectTimeout: 5000 } });
  if (!(await ephemera.healthy())) throw new Error('UPSTASH_STAGING_UNHEALTHY');
  const ticketIssuer = await createTicketIssuer(apiPool, { environment: 'stg', audience: 'mega-core' });
  const queue = await createQueueService({ ephemera, core, pool: corePool });
  const GATEWAY_SECRET = crypto.randomBytes(32).toString('hex');
  const coreIngress = createCoreServiceIngress({ coreService: core, ticketIssuer, queue, leaderboardPool: corePool, secret: GATEWAY_SECRET });
  const coreGateway = createCoreGateway({ coreUrl: `http://${host}:${port}`, secret: GATEWAY_SECRET, timeoutMs: GATEWAY_TIMEOUT_MS });

  let origin = `http://${host}:${port}`;
  const apiHandler = createApiHandler({
    pool: apiPool, accounts, coreGateway, access, nativeAudiences: ['mega-ios', 'mega-android'],
    queue: coreGateway, otpSecret: crypto.randomBytes(32).toString('hex'),
    allowedOrigins: ['https://megaxo.online', 'https://play.antimatterinnovations.com', origin],
  });

  const webRoot = path.join(ROOT, 'apps/web');
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', origin);
      const pathname = parsedUrl.pathname;
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (security.isOperatorRoute(pathname)) { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'PRIVATE_OPERATOR_ROUTE' })); return; }
      if (pathname === '/realtime/v1/snapshot' || pathname === '/realtime/v1/snapshot/' || pathname.startsWith('/realtime/v1/match/')) return;
      if (pathname.startsWith('/ingress/')) { await coreIngress(req, res); return; }
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/') || pathname.startsWith('/.well-known/')) { await apiHandler(req, res); return; }
      let filePath = path.resolve(webRoot, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
      if (!filePath.startsWith(webRoot + path.sep)) { res.statusCode = 403; res.end('Forbidden'); return; }
      if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) filePath = filePath + '.html';
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res); return;
      }
      const indexPath = path.join(webRoot, 'index.html');
      if (fs.existsSync(indexPath)) { res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); fs.createReadStream(indexPath).pipe(res); return; }
      res.statusCode = 404; res.end('Not Found');
    } catch (err) { if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); } res.end(JSON.stringify({ error: safeError(err) })); }
  });

  const realtime = createRealtimeTransport({
    server, pool: corePool, core, ephemera, environment: 'stg', audience: 'mega-core',
    authenticateHttp: async (req) => {
      security.validateCredentials({ cookie: req.headers.cookie, authorization: req.headers.authorization, method: req.method, allowedOrigins: [origin] });
      const { actor } = await resolveAuth({ accounts, access, nativeAudiences: ['mega-ios', 'mega-android'] }, req);
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    },
  });

  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, host, resolve); });
  origin = `http://${host}:${port}`;
  // Startup self-check: the website shell and the live API both answer on this origin.
  const shell = await fetch(`${origin}/`).then((r) => r.text()).catch(() => '');
  const livez = await fetch(`${origin}/livez`).then((r) => r.status).catch(() => 0);
  console.log(JSON.stringify({
    ok: true, origin, database: target.database, environment: 'staging', nonserving: target.nonserving,
    redisNamespace: ephemera.keyVersion, outbound: target.outbound,
    websiteServesShell: shell.includes('mx-web-shell'), livezStatus: livez,
    note: 'isolated loopback staging origin; noindex enforced; live V4 untouched',
  }, null, 2));

  const shutdown = async () => {
    try { await realtime.close(); } catch {}
    try { await new Promise((r) => server.close(r)); } catch {}
    for (const c of [() => queue.close(), () => ephemera.close(), () => ticketIssuer.close?.(), () => core.close(), () => accounts.close(), () => apiPool.end(), () => corePool.end()]) { try { await c(); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  setInterval(() => {}, 1 << 30); // keep the process alive
}

main().catch((err) => { console.error('STAGING_SERVER_FAILED', safeError(err)); process.exit(1); });
