'use strict';

const corsMiddleware = require('./middleware/cors');
const csrfMiddleware = require('./middleware/csrf');
const compatRoutes = require('./routes/compat');
const accountRoutes = require('./routes/account');
const socialRoutes = require('./routes/social');
const competitiveRoutes = require('./routes/competitive');
const wellKnownRoutes = require('./routes/well-known');
const { sendError, sendJson } = require('./routes/helpers');
const path = require('node:path');
const { createReadCache } = require(path.join(__dirname, '../../packages/services/read-cache.js'));
const security = require(path.join(__dirname, '../../packages/services/security.js'));

/**
 * Creates an HTTP request handler for the API control plane.
 * @param {Object} options Options containing pool, accounts, otpSecret, now, etc.
 * @returns {Function} async function handler(req, res)
 */
function createApiHandler(options = {}) {
  const context = { ...options };
  if (!context.readCache) {
    context.readCache = createReadCache(context.readCacheOptions || {});
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

      // 4. Body size limit (100KB)
      if (req.body !== undefined && req.body !== null) {
        security.enforceBodyLimit(req.body, 100 * 1024);
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
async function defaultHandler(req, res) {
  if (!defaultHandlerInstance) {
    let pool = null;
    const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (dbUrl) {
      try {
        const { createPgPool } = require('../../packages/db/pg/pool.js');
        pool = createPgPool({
          url: dbUrl,
          role: 'api_runtime',
          applicationName: 'mega_xo_api_vercel',
        });
      } catch {
        // Fall back to no default pool; requests will require context injection
      }
    }
    defaultHandlerInstance = createApiHandler({ pool });
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
