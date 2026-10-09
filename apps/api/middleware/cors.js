'use strict';

/**
 * apps/api/middleware/cors.js
 * Old-origin and multi-origin CORS middleware with preflight OPTIONS and credential support.
 *
 * Requirements:
 * - Allowed origins: https://play.antimatterinnovations.com, https://megaxo.online,
 *   https://api.megaxo.online, and local development origins (localhost, 127.0.0.1, [::1]).
 * - Supports preflight OPTIONS requests with 204 status.
 * - Supports credentials (Access-Control-Allow-Credentials: true).
 * - Exposes configurable allowed origins via context.allowedOrigins.
 */

const ALLOWED_ORIGINS = Object.freeze([
  'https://play.antimatterinnovations.com',
  'https://megaxo.online',
  'https://api.megaxo.online',
]);

const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

/**
 * Tests whether a given origin string is an authorized CORS origin.
 * @param {string|null|undefined} origin
 * @param {Array<string>|null} [extraOrigins]
 * @returns {boolean}
 */
function isAllowedOrigin(origin, extraOrigins = null) {
  if (!origin || typeof origin !== 'string') return false;

  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (!normalized) return false;

  // 1. Check pinned production / legacy origins
  for (const allowed of ALLOWED_ORIGINS) {
    if (normalized === allowed.toLowerCase()) return true;
  }

  // 2. Check extra custom origins from context / options
  if (Array.isArray(extraOrigins)) {
    for (const extra of extraOrigins) {
      if (typeof extra === 'string' && normalized === extra.trim().replace(/\/+$/, '').toLowerCase()) {
        return true;
      }
    }
  }

  // 3. Check local development origins
  if (LOCAL_ORIGIN_REGEX.test(normalized)) {
    return true;
  }

  return false;
}

/**
 * Applies standard CORS response headers.
 * @param {Object} res HTTP response object
 * @param {string|null} origin Request origin
 * @param {boolean} [isAllowed=true] Whether origin passed authorization check
 */
function applyCorsHeaders(res, origin, isAllowed = true) {
  if (!res || typeof res.setHeader !== 'function') return;

  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, X-Session-Token, X-CSRF-Token, X-Actor-ID, X-Test-Actor, X-Op-Key, Idempotency-Key, Cache-Control'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

/**
 * Middleware request handler for CORS and preflight requests.
 * @param {Object} context Handler context (options, allowedOrigins, etc.)
 * @param {Object} req Incoming request
 * @param {Object} res Server response
 * @returns {Promise<boolean>} True if request was handled (e.g. OPTIONS preflight), false to continue
 */
async function handleCors(context, req, res) {
  // Never echo a client-forged forwarded origin as a credentialed CORS origin.
  const originHeader = req.headers?.origin || null;
  const extraOrigins = context?.allowedOrigins || [];
  const originAllowed = originHeader ? isAllowedOrigin(originHeader, extraOrigins) : false;

  if (originHeader && originAllowed) {
    applyCorsHeaders(res, originHeader, true);
  } else if (!originHeader) {
    // If no origin header, still allow general CORS headers without Allow-Origin
    applyCorsHeaders(res, null, false);
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    if (typeof res.status === 'function') res.status(204);
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Length', '0');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (typeof res.end === 'function') {
      res.end();
    }
    return true; // Preflight request was handled
  }

  return false; // Continue request pipeline
}

// Aliases and module exports
handleCors.handleCors = handleCors;
handleCors.corsMiddleware = handleCors;
handleCors.applyCorsHeaders = applyCorsHeaders;
handleCors.isAllowedOrigin = isAllowedOrigin;
handleCors.ALLOWED_ORIGINS = ALLOWED_ORIGINS;

module.exports = handleCors;
module.exports.handleCors = handleCors;
module.exports.corsMiddleware = handleCors;
module.exports.applyCorsHeaders = applyCorsHeaders;
module.exports.isAllowedOrigin = isAllowedOrigin;
module.exports.ALLOWED_ORIGINS = ALLOWED_ORIGINS;
