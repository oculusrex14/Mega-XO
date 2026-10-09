'use strict';

/**
 * packages/services/security.js
 *
 * Phase 13: Harden Distributed Trust Boundaries
 *
 * Implements:
 * 1. Credential mode separation: validateCredentials({ cookie, authorization, origin, method })
 * 2. Header sanitizer: sanitizeHeaders(headers, { isInternalGateway = false })
 * 3. Body size limits: enforceBodyLimit(bodyOrSize, maxBytes = 100 * 1024)
 * 4. Audit trail logger: createAuditLogger({ pool, secret, now = Date.now })
 * 5. Operator protection: isOperatorRoute(pathname), rejectOperatorRoute(req, res)
 */

const crypto = require('node:crypto');
const { isAllowedOrigin } = require('../../apps/api/middleware/cors');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const SESSION_COOKIE_NAMES = ['__Host-mega_session', 'mega_dev_session', 'session', 'token'];
const OPERATOR_PREFIXES = ['/admin', '/operator', '/metrics'];
const DEFAULT_MAX_BODY_BYTES = 100 * 1024; // 100KB

function fail(code, status = 400) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  throw err;
}

/**
 * Parses cookies from string if needed.
 */
function parseCookieHeader(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    out[key] = decodeURIComponent(val);
  }
  return out;
}

/**
 * Tests whether cookie input contains a session credential.
 */
function hasCookieCredential(cookie) {
  if (!cookie) return false;
  if (typeof cookie === 'string') {
    const parsed = parseCookieHeader(cookie);
    for (const name of SESSION_COOKIE_NAMES) {
      if (parsed[name] && typeof parsed[name] === 'string' && parsed[name].trim()) {
        return true;
      }
    }
    return false;
  }
  if (typeof cookie === 'object') {
    for (const name of SESSION_COOKIE_NAMES) {
      if (cookie[name] && typeof cookie[name] === 'string' && cookie[name].trim()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extracts bearer token string if authorization header present.
 */
function extractBearer(authorization) {
  if (typeof authorization !== 'string' || !authorization.trim()) return null;
  const trimmed = authorization.trim();
  if (trimmed.startsWith('Bearer ')) return trimmed.slice(7).trim();
  if (trimmed.startsWith('bearer ')) return trimmed.slice(7).trim();
  return null;
}

/**
 * Normalizes an origin/referer string.
 */
function extractOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Credential mode separation: validateCredentials({ cookie, authorization, origin, referer, method, allowedOrigins })
 * - Ambiguous hybrid (cookie AND bearer present) -> throws AMBIGUOUS_CREDENTIAL (401).
 * - Cookie with mutating method -> strictly enforces Origin / Referer check or throws CSRF_REJECTED (403).
 * - Bearer tokens bypass CSRF.
 */
function validateCredentials({
  cookie = null,
  authorization = null,
  origin = null,
  referer = null,
  method = 'GET',
  allowedOrigins = []
} = {}) {
  const hasCookie = hasCookieCredential(cookie);
  const bearer = extractBearer(authorization);
  const hasBearer = Boolean(bearer);

  // 1. Ambiguous hybrid check
  if (hasCookie && hasBearer) {
    fail('AMBIGUOUS_CREDENTIAL', 401);
  }

  const upperMethod = String(method || 'GET').toUpperCase();

  // 2. Bearer tokens bypass CSRF
  if (hasBearer) {
    return {
      mode: 'bearer',
      token: bearer,
      csrfExempt: true
    };
  }

  // 3. Cookie credentials
  if (hasCookie) {
    if (MUTATING_METHODS.has(upperMethod)) {
      const candidate = extractOrigin(origin) || extractOrigin(referer);
      if (!candidate || !isAllowedOrigin(candidate, allowedOrigins)) {
        fail('CSRF_REJECTED', 403);
      }
    }
    return {
      mode: 'cookie',
      token: null,
      csrfExempt: false
    };
  }

  // 4. Anonymous / Uncredentialed
  return {
    mode: 'anonymous',
    token: null,
    csrfExempt: !MUTATING_METHODS.has(upperMethod)
  };
}

/**
 * Header sanitizer: sanitizeHeaders(headers, { isInternalGateway = false })
 * Strips x-actor-id, x-test-actor, x-forwarded-for unless isInternalGateway === true.
 */
function sanitizeHeaders(headers = {}, { isInternalGateway = false } = {}) {
  if (!headers || typeof headers !== 'object') return {};
  const cleaned = { ...headers };

  if (!isInternalGateway) {
    const untrustedHeaders = ['x-actor-id', 'x-test-actor', 'x-forwarded-for'];
    for (const key of Object.keys(cleaned)) {
      if (untrustedHeaders.includes(key.toLowerCase())) {
        delete cleaned[key];
      }
    }
  }

  return cleaned;
}

/**
 * Body size limits: rejects bodies > 100KB with 413 BODY_TOO_LARGE.
 */
function enforceBodyLimit(bodyOrLength, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  let size = 0;
  if (typeof bodyOrLength === 'number') {
    size = bodyOrLength;
  } else if (Buffer.isBuffer(bodyOrLength)) {
    size = bodyOrLength.length;
  } else if (typeof bodyOrLength === 'string') {
    size = Buffer.byteLength(bodyOrLength, 'utf8');
  } else if (bodyOrLength !== null && typeof bodyOrLength === 'object') {
    size = Buffer.byteLength(JSON.stringify(bodyOrLength), 'utf8');
  }

  if (size > maxBytes) {
    fail('BODY_TOO_LARGE', 413);
  }
  return true;
}

/**
 * Operator route check:
 * Rejects any operator/admin routes on public Vercel API ingress (404 or 403 PRIVATE_OPERATOR_ROUTE).
 */
function isOperatorRoute(pathname = '') {
  if (!pathname || typeof pathname !== 'string') return false;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  for (const prefix of OPERATOR_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Audit trail logger: createAuditLogger({ pool, secret, now = Date.now })
 * Dedicated HMAC-SHA256 signature chain over audit.operator_audit / audit events using MEGA_AUDIT_SECRET.
 * Validates chain integrity and appends new audit entries.
 */
function createAuditLogger(options = {}) {
  if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED', 500);
  const secret = options.secret || process.env.MEGA_AUDIT_SECRET || process.env.AUDIT_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    fail('INVALID_AUDIT_SECRET', 500);
  }

  const pool = options.pool;
  if (!pool || typeof pool.query !== 'function') {
    fail('PG_POOL_REQUIRED', 500);
  }

  const clock = typeof options.now === 'function' ? options.now : Date.now;

  const hmacSign = (fields) => {
    return crypto.createHmac('sha256', secret).update(JSON.stringify(fields)).digest('hex');
  };

  return {
    hmacSign,

    /**
     * Appends a new audit record to audit.operator_audit, calculating prev_hash and entry_hash.
     */
    async append(operator, action, actor = null, reason, detail = {}) {
      if (!operator || typeof operator !== 'string') fail('INVALID_OPERATOR', 400);
      if (!action || typeof action !== 'string') fail('INVALID_ACTION', 400);
      if (!reason || typeof reason !== 'string') fail('INVALID_REASON', 400);

      const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
      if (detailText.length > 2000) fail('AUDIT_DETAIL_TOO_LARGE', 400);

      // Fetch current tail entry
      const lastRes = await pool.query(
        'SELECT entry_hash FROM audit.operator_audit ORDER BY at DESC, audit_id DESC LIMIT 1'
      );
      const prevHash = lastRes.rows[0]?.entry_hash || 'GENESIS';

      const atMs = clock();
      const atIso = new Date(atMs).toISOString();
      const auditId = 'op_' + crypto.randomUUID();

      const entryHash = hmacSign([prevHash, auditId, atMs, operator, action, actor || null, reason, detailText]);

      await pool.query(
        'INSERT INTO audit.operator_audit (audit_id, at, operator, action, actor_id, reason, detail, prev_hash, entry_hash) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [auditId, atIso, operator, action, actor || null, reason, detailText, prevHash, entryHash]
      );

      return {
        auditId,
        at: atMs,
        operator,
        action,
        actorId: actor || null,
        reason,
        prevHash,
        entryHash
      };
    },

    /**
     * Validates cryptographic chain integrity.
     */
    async verifyChain() {
      const res = await pool.query(
        'SELECT audit_id, at, operator, action, actor_id, reason, detail, prev_hash, entry_hash ' +
        'FROM audit.operator_audit ORDER BY at ASC, audit_id ASC'
      );

      let previous = 'GENESIS';
      let count = 0;

      for (const row of res.rows) {
        if (row.prev_hash !== previous) {
          return {
            valid: false,
            error: 'CHAIN_BROKEN_PREV_HASH_MISMATCH',
            atId: row.audit_id,
            count
          };
        }

        const atMs = new Date(row.at).getTime();
        const expectedHash = hmacSign([
          previous,
          row.audit_id,
          atMs,
          row.operator,
          row.action,
          row.actor_id || null,
          row.reason,
          row.detail
        ]);

        if (row.entry_hash !== expectedHash) {
          return {
            valid: false,
            error: 'TAMPER_DETECTED_HASH_MISMATCH',
            atId: row.audit_id,
            count
          };
        }

        previous = row.entry_hash;
        count++;
      }

      return {
        valid: true,
        count,
        lastHash: previous
      };
    }
  };
}

module.exports = {
  validateCredentials,
  sanitizeHeaders,
  enforceBodyLimit,
  isOperatorRoute,
  createAuditLogger,
  DEFAULT_MAX_BODY_BYTES,
  OPERATOR_PREFIXES
};
