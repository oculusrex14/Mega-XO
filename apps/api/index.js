'use strict';

const corsMiddleware = require('./middleware/cors');
const csrfMiddleware = require('./middleware/csrf');
const compatRoutes = require('./routes/compat');
const accountRoutes = require('./routes/account');
const socialRoutes = require('./routes/social');
const competitiveRoutes = require('./routes/competitive');
const tournamentRoutes = require('./routes/tournaments');
const wellKnownRoutes = require('./routes/well-known');
const monetizationRoutes = require('./routes/monetization');
const metricsRoutes = require('./routes/metrics');
const { sendError, sendJson, collectRawBody } = require('./routes/helpers');
const path = require('node:path');
const { createReadCache } = require(path.join(__dirname, '../../packages/services/read-cache.js'));
const security = require(path.join(__dirname, '../../packages/services/security.js'));

/**
 * Creates an HTTP request handler for the API control plane.
 * @param {Object} options Options containing pool, accounts, otpSecret, now, etc.
 * Signed native authorization uses the caller-owned P05 `access` service (or pool + explicit
 * `accessOptions` factory configuration) and `nativeAudiences` (mega-ios/mega-android by default).
 * Provider token issuance is separate; never infer issuer/key custody from a presented JWT.
 * @returns {Function} async function handler(req, res)
 */
function createApiHandler(options = {}) {
  const context = { ...options };
  if (!context.readCache) {
    context.readCache = createReadCache(context.readCacheOptions || {});
  }
  if (!context.queue) {
    // The public API holds only API-role credentials. Queue admission and
    // ephemeral status execute in the Core-owned service over signed ingress.
    context.queue = {
      join: (input) => competitiveRoutes.resolveGateway(context).join(input),
      cancel: (input) => competitiveRoutes.resolveGateway(context).cancel(input),
      status: (actor) => competitiveRoutes.resolveGateway(context).status(actor),
    };
  }
  if (typeof context.leaderboard !== 'function') {
    // The public leaderboard needs `economy.ratings`, which the API-role pool is
    // denied. Like queue admission it is served by the Core-owned ingress; the
    // deployed API gains no Core credentials and holds no core pool.
    //
    // The gateway is resolved eagerly so a genuinely UNCONFIGURED deployment (no
    // Core URL/secret) leaves `context.leaderboard` absent and keeps the existing
    // empty projection - only a CONFIGURED transport surfaces a real failure.
    let gateway = null;
    try {
      gateway = competitiveRoutes.resolveGateway(context);
    } catch {
      gateway = null;
    }
    if (gateway) {
      context.leaderboard = (query) => gateway.leaderboard(query);
    }
  }

  return async function handler(req, res) {
    try {
      // 0. Operator protection: public Vercel API ingress rejects operator/admin/metrics routes
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (security.isOperatorRoute(parsedUrl.pathname)) {
        sendJson(res, 403, { error: 'PRIVATE_OPERATOR_ROUTE' });
        return;
      }

      // 1. Header sanitizer: untrusted callers cannot spoof internal actor headers
      if (req.headers) {
        req.headers = security.sanitizeHeaders(req.headers, {
          isInternalGateway: Boolean(context.isInternalGateway || req.isInternalGateway)
        });
      }

      // 2. CORS middleware: handles preflight OPTIONS and sets CORS headers
      const handledCors = await corsMiddleware.handleCors(context, req, res);
      if (handledCors) return;

      // 3. Credential separation & CSRF enforcement
      // Only browser-controlled Origin and Referer are admissible CSRF signals.
      // X-Forwarded-Origin is a client-settable header, not proof of origin.
      const originHeader = req.headers?.origin ?? null;
      const refererHeader = req.headers?.referer || req.headers?.referrer || null;
      const cookieHeader = req.headers?.cookie || null;
      const authHeader = req.headers?.authorization || null;

      // Validates credential separation & CSRF (throws AMBIGUOUS_CREDENTIAL 401 or CSRF_REJECTED 403)
      let credResult;
      try {
        credResult = security.validateCredentials({
          cookie: cookieHeader,
          authorization: authHeader,
          origin: originHeader,
          referer: refererHeader,
          method: req.method,
          allowedOrigins: context.allowedOrigins || []
        });
      } catch (error) {
        // G13 keeps its internal CSRF_REJECTED signal, but the existing
        // browser/client HTTP contract is ORIGIN_OR_CONTENT_TYPE (403).
        // Preserve old-origin clients without allowing the request through.
        if (error?.code === 'CSRF_REJECTED') {
          sendJson(res, 403, { error: 'ORIGIN_OR_CONTENT_TYPE' });
          return;
        }
        throw error;
      }
      req.credentialMode = credResult.mode;

      // CSRF legacy middleware compat check (if not bearer exempt)
      if (!credResult.csrfExempt) {
        const csrfPassed = await csrfMiddleware.handleCsrf(context, req, res);
        if (!csrfPassed) return;
      }

      // Raw-body collection for stream requests: the production listener passes a plain Node
      // request and nothing pre-reads it, so routes that need the exact bytes (the SSV
      // callback and the provider webhooks) or any JSON body would otherwise see undefined.
      // Bounded at the LARGEST declared route contract (native challenge/finish/token 300000),
      // so a body no route accepts is refused 413 here, while a body a route does accept reaches
      // that route, which enforces its own precise limit.
      if (req.body === undefined && ['POST', 'PUT', 'PATCH'].includes((req.method || '').toUpperCase())) {
        try {
          req.body = await collectRawBody(req, 300000);
        } catch (error) {
          if (error && error.status === 413) { sendJson(res, 413, { error: 'BODY_TOO_LARGE' }); return; }
          throw error;
        }
      }

      // 4. Body size limit: the pipeline ceiling is the largest declared route contract, NOT a
      //    blanket 100KB. A per-request 100KB cap here wrongly rejected the native challenge/
      //    finish/token bodies the contract allows up to 300000 (and rejected them 413 instead
      //    of letting the route answer). Routes enforce their own limits below.
      if (req.body !== undefined && req.body !== null) {
        security.enforceBodyLimit(req.body, 300000);
      }
      // 3. Try Well-known & technical foundation routes (app links, health, legal, callback)
      const handledWellKnown = await wellKnownRoutes.handleWellKnownRoute(context, req, res);
      if (handledWellKnown) return;

      // 4. Try Compatibility routes (/api/v1 legacy browser endpoints)
      const handledCompat = await compatRoutes.handleCompatRoute(context, req, res);
      if (handledCompat) return;

      // 4. Try Account routes
      const handledAccount = await accountRoutes.handleAccountRoute(context, req, res);
      if (handledAccount) return;

      // 5. Try Social routes
      const handledSocial = await socialRoutes.handleSocialRoute(context, req, res);
      if (handledSocial) return;

      const handledTournament = await tournamentRoutes.handleTournamentRoute(context, req, res);
      if (handledTournament) return;

      // 6b. Monetization routes (LR12): authenticated surface + the actor-free AdMob SSV callback.
      const handledMonetization = await monetizationRoutes.handleMonetizationRoute(context, req, res);
      if (handledMonetization) return;

      // 6c. Metrics routes (LR19): anonymous daily aggregates, opt-in client-side.
      const handledMetrics = await metricsRoutes.handleMetricsRoute(context, req, res);
      if (handledMetrics) return;

      // 6. Try Competitive routes
      const handledCompetitive = await competitiveRoutes.handleCompetitiveRoute(context, req, res);
      if (handledCompetitive) return;

      // 7. Not found
      sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      sendError(res, err);
    }
  };
}

/**
 * Convenience request handler that takes options per invocation.
 */
async function handleRequest(req, res, options = {}) {
  const handler = createApiHandler(options);
  return handler(req, res);
}

// Global default handler for Vercel Serverless Function entrypoint
let defaultHandlerInstance = null;
/* Deployment-owned P05 native session plumbing from the environment (issuer, key file, audiences).
 * A partial configuration stays null, so the bearer routes answer their honest 503 instead of
 * accepting a token signed by a key nobody published. */
function nativeSessionOptions(env) {
  try {
    return require('./config.js').nativeSessionConfig(env);
  } catch {
    return { nativeAudiences: ['mega-ios', 'mega-android'], accessOptions: null, refreshOptions: null };
  }
}
async function defaultHandler(req, res) {
  if (!defaultHandlerInstance) {
    let pool = null;
    const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (dbUrl) {
      try {
      const { createPgPool, fromEnvironment } = require('../../packages/db/pg/pool.js');
      // Build a COMPLETE guard config from the environment (host/port/db/user/password/role/label/
      // TLS/budget), then assert the api_runtime role. The DB label MUST match the target
      // inventory's environment: the target file names the environment it belongs to, so the label
      // is read from it when available (a preview deployment that binds the staging inventory is
      // coherent as 'staging'), else from an explicit override. A misconfigured deployment fails
      // closed rather than silently serving without a pool. The API holds only API-role credentials.
      let label = process.env.MEGA_ENV_LABEL || process.env.MEGA_DB_LABEL || 'preview';
      // The target inventory names the environment it belongs to; the DB label MUST equal it. Under
      // a Vercel lambda the docs/ tree may not be bundled, so the inventory is accepted inline via
      // MEGA_PG_TARGET (JSON) or from the file when present. A coherent explicit label is honoured
      // if neither is available (the guards still fail closed on host/db/user mismatch).
      let target;
      if (process.env.MEGA_PG_TARGET_B64) {
        try { target = JSON.parse(Buffer.from(process.env.MEGA_PG_TARGET_B64, 'base64').toString('utf8')); } catch { target = undefined; }
      }
      if (!target && process.env.MEGA_PG_TARGET) {
        try { target = JSON.parse(process.env.MEGA_PG_TARGET); } catch { target = undefined; }
      }
      if (target && target.environment) label = target.environment;
      if (!target) {
        const targetRel = process.env.MEGA_PG_TARGET_FILE || 'docs/v5/environments/staging.json';
        for (const base of [process.cwd(), path.join(__dirname, '..', '..'), path.join(__dirname, '..', '..', '..')]) {
          try { target = require(path.join(base, targetRel)); label = target.environment || label; break; } catch { /* next candidate */ }
        }
      }
      // Application-name segments (role/service/revision) must each be a <=32-char token. A raw
      // 40-char commit SHA fails the segment check, so the revision is shortened to 12 chars.
      const rawRevision = process.env.VERCEL_GIT_COMMIT_SHA || process.env.MEGA_RELEASE_REVISION || 'vercel';
      const revision = String(rawRevision).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12) || 'vercel';
      const config = fromEnvironment({ ...process.env, MEGA_PG_URL: dbUrl }, {
        role: 'api_runtime',
        label,
        target,
        service: 'mega-xo-api-vercel',
        revision,
      });
      if (process.env.MEGA_API_DEBUG === '1') console.error('API_POOL_CFG', JSON.stringify({ revision: config.revision, service: config.service, role: config.role, label: config.label, user: config.user, host: config.host, db: config.database, targetEnv: target && target.environment }));
      pool = createPgPool(config);
      } catch (error) {
        // A misconfigured pool must not crash the function on every cold start: construct the
        // handler with no pool so routes return their honest 503 (e.g. OTP/session unavailable)
        // instead of FUNCTION_INVOCATION_FAILED. The guard code/message never contains a secret.
        if (process.env.MEGA_API_DEBUG === '1') console.error('API_POOL_INIT_FAILED', (error && error.code) || '', String((error && error.message) || '').slice(0, 200));
        pool = null;
      }
    }
    defaultHandlerInstance = createApiHandler({
      pool,
      otpSecret: process.env.MEGA_OTP_SECRET || process.env.OTP_SECRET,
      ticketEnvironment: process.env.MEGA_TICKET_ENV,
      ticketAudience: process.env.MEGA_TICKET_AUDIENCE,
      ...nativeSessionOptions(process.env),
    });
  }
  return defaultHandlerInstance(req, res);
}

defaultHandler.createApiHandler = createApiHandler;
defaultHandler.handleRequest = handleRequest;
defaultHandler.cors = corsMiddleware;
defaultHandler.csrf = csrfMiddleware;
defaultHandler.compat = compatRoutes;
defaultHandler.account = accountRoutes;
defaultHandler.social = socialRoutes;
defaultHandler.competitive = competitiveRoutes;
defaultHandler.wellKnown = wellKnownRoutes;
defaultHandler.security = security;
module.exports = defaultHandler;
module.exports.createApiHandler = createApiHandler;
module.exports.handleRequest = handleRequest;
module.exports.cors = corsMiddleware;
module.exports.csrf = csrfMiddleware;
module.exports.compat = compatRoutes;
module.exports.account = accountRoutes;
module.exports.social = socialRoutes;
module.exports.competitive = competitiveRoutes;
module.exports.wellKnown = wellKnownRoutes;
module.exports.security = security;
module.exports.default = defaultHandler;
