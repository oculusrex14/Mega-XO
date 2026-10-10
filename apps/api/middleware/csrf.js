'use strict';

/**
 * apps/api/middleware/csrf.js
 * CSRF origin validation middleware for cookie-authenticated mutating requests.
 *
 * Requirements:
 * - Cookie-authenticated mutating requests (POST, PUT, DELETE, PATCH) require a valid
 *   Origin or Referer header matching authorized origins.
 * - Rejects untrusted origins on cookie auth with 403 ORIGIN_OR_CONTENT_TYPE
 *   (preserving exact V4 perimeter error).
 * - Safe methods (GET, HEAD, OPTIONS) and non-cookie authenticated requests (e.g. Bearer auth)
 *   are not subject to cookie-based CSRF rejection.
 */

const { isAllowedOrigin } = require('./cors');
const { sendJson, parseCookies } = require('../routes/helpers');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const SESSION_COOKIE_NAMES = ['__Host-mega_session', 'mega_dev_session', 'session', 'token'];

/**
 * Tests whether an incoming request presents cookie-based session credentials.
 * @param {Object} req Incoming HTTP request
 * @returns {boolean} True if cookie auth is present
 */
function hasCookieAuth(req) {
  if (!req) return false;

  // 1. Direct cookie header string
  const cookieHeader = req.headers?.cookie;
  if (typeof cookieHeader === 'string' && cookieHeader.trim()) {
    const cookies = parseCookies(cookieHeader);
    for (const name of SESSION_COOKIE_NAMES) {
      if (cookies[name] && typeof cookies[name] === 'string' && cookies[name].trim()) {
        return true;
      }
    }
  }

  // 2. Pre-parsed cookies object (e.g. upstream middleware)
  if (req.cookies && typeof req.cookies === 'object') {
    for (const name of SESSION_COOKIE_NAMES) {
      if (req.cookies[name] && typeof req.cookies[name] === 'string' && req.cookies[name].trim()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts normalized origin (scheme://host[:port]) from a URL or header string.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function extractOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    // If it's already an origin without path, e.g. "https://play.antimatterinnovations.com"
    if (/^https?:\/\/[^/]+/i.test(trimmed)) {
      try {
        const url = new URL(trimmed.replace(/\/+$/, '') + '/');
        return `${url.protocol}//${url.host}`.toLowerCase();
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Validates request Origin or Referer for mutating requests with cookie auth.
 * @param {Object} req Incoming HTTP request
 * @param {Object} [options] Context options (allowedOrigins, etc.)
 * @returns {boolean} True if request passes CSRF check, false if untrusted
 */
function checkCsrf(req, options = {}) {
  const method = (req.method || 'GET').toUpperCase();

  // 1. Safe HTTP methods never mutate state
  if (!MUTATING_METHODS.has(method)) {
    return true;
  }

  // 2. Only cookie-authenticated mutating requests are vulnerable to cross-site request forgery
  if (!hasCookieAuth(req)) {
    return true;
  }

  // 3. Inspect Origin or Referer header
  const originHeader = req.headers?.origin;
  const refererHeader = req.headers?.referer || req.headers?.referrer;

  // Only use Referer as a fallback when Origin is genuinely absent. A
  // present invalid/foreign Origin must never be overridden by Referer.
  const candidate = typeof originHeader === 'string'
    ? extractOrigin(originHeader)
    : extractOrigin(refererHeader);
  if (!candidate) {
    return false; // Cookie-authenticated mutation with missing or unparseable origin
  }

  const extraOrigins = options?.allowedOrigins || [];
  return isAllowedOrigin(candidate, extraOrigins);
}

/**
 * Middleware request handler for CSRF verification.
 * Sends 403 ORIGIN_OR_CONTENT_TYPE if verification fails.
 * @param {Object} context Handler context
 * @param {Object} req Incoming request
 * @param {Object} res Server response
 * @returns {Promise<boolean>} True if CSRF check passed, false if rejected
 */
async function handleCsrf(context, req, res) {
  const ok = checkCsrf(req, context);
  if (!ok) {
    sendJson(res, 403, { error: 'ORIGIN_OR_CONTENT_TYPE' });
    return false;
  }
  return true;
}

handleCsrf.handleCsrf = handleCsrf;
handleCsrf.csrfMiddleware = handleCsrf;
handleCsrf.checkCsrf = checkCsrf;
handleCsrf.hasCookieAuth = hasCookieAuth;
handleCsrf.extractOrigin = extractOrigin;

module.exports = handleCsrf;
module.exports.handleCsrf = handleCsrf;
module.exports.csrfMiddleware = handleCsrf;
module.exports.checkCsrf = checkCsrf;
module.exports.hasCookieAuth = hasCookieAuth;
module.exports.extractOrigin = extractOrigin;
