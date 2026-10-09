'use strict';

const corsMiddleware = require('./middleware/cors');
const csrfMiddleware = require('./middleware/csrf');
const compatRoutes = require('./routes/compat');
const accountRoutes = require('./routes/account');
const socialRoutes = require('./routes/social');
const competitiveRoutes = require('./routes/competitive');
const wellKnownRoutes = require('./routes/well-known');
const { sendError, sendJson } = require('./routes/helpers');

/**
 * Creates an HTTP request handler for the API control plane.
 * @param {Object} options Options containing pool, accounts, otpSecret, now, etc.
 * @returns {Function} async function handler(req, res)
 */
function createApiHandler(options = {}) {
  const context = { ...options };

  return async function handler(req, res) {
    try {
      // 1. CORS middleware: handles preflight OPTIONS and sets CORS headers
      const handledCors = await corsMiddleware.handleCors(context, req, res);
      if (handledCors) return;

      // 2. CSRF middleware: origin check for cookie-authenticated mutating requests
      const csrfPassed = await csrfMiddleware.handleCsrf(context, req, res);
      if (!csrfPassed) return;
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
module.exports.default = defaultHandler;
