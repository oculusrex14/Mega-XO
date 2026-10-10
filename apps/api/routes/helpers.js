'use strict';

const path = require('node:path');
const { createAccountService } = require(path.join(__dirname, '../../../packages/services/accounts.js'));

const STATUS_MAP = Object.freeze({
  AUTH_REQUIRED: 401,
  LINK_ACCOUNT_REQUIRED: 401,
  AMBIGUOUS_CREDENTIAL: 401,
  REAUTH_REQUIRED: 401,
  CSRF_REJECTED: 403,
  PRIVATE_OPERATOR_ROUTE: 403,
  PROFILE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  BODY_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INVALID_JSON: 409,
  IDEMPOTENCY_KEY_REQUIRED: 409,
  SAVE_CONFLICT: 409,
  LAST_LOGIN_METHOD: 409,
  DELETE_CONFIRMATION_REQUIRED: 409,
  SEARCH_TOO_SHORT: 409,
  INVALID_SEARCH: 409,
  INVALID_DISPLAY_NAME: 409,
  INVALID_AVATAR: 409,
  INVALID_PRIVACY: 409,
  INVALID_SOCIAL_ACTION: 409,
  INVALID_OPERATION: 409,
});

function parseCookies(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key && !(key in out)) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

async function parseJsonBody(req, limit = 100 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > limit) {
        const err = new Error('BODY_TOO_LARGE');
        err.status = 413;
        throw err;
      }
      try {
        return JSON.parse(req.body);
      } catch {
        const err = new Error('INVALID_JSON');
        err.status = 409;
        throw err;
      }
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > limit) {
        const err = new Error('BODY_TOO_LARGE');
        err.status = 413;
        throw err;
      }
      try {
        return JSON.parse(req.body.toString('utf8'));
      } catch {
        const err = new Error('INVALID_JSON');
        err.status = 409;
        throw err;
      }
    }
    if (typeof req.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > limit) {
        const err = new Error('BODY_TOO_LARGE');
        err.status = 413;
        throw err;
      }
      return req.body;
    }
  }
  // Stream read
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        const err = new Error('BODY_TOO_LARGE');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('INVALID_JSON');
        err.status = 409;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data, headers = {}) {
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const existingCacheControl = typeof res.getHeader === 'function'
      ? (res.getHeader('Cache-Control') || res.getHeader('cache-control'))
      : null;
    if (headers && (headers['Cache-Control'] || headers['cache-control'])) {
      res.setHeader('Cache-Control', headers['Cache-Control'] || headers['cache-control']);
    } else if (!existingCacheControl) {
      res.setHeader('Cache-Control', 'no-store');
    }
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() !== 'cache-control') res.setHeader(k, v);
      }
    }
  }
  if (typeof res.status === 'function') {
    res.status(statusCode);
  }
  const body = JSON.stringify(data);
  if (typeof res.json === 'function' && res.statusCode !== statusCode) {
    res.json(data);
    return;
  }
  res.end(body);
}

function sendError(res, error) {
  const message = error?.message || 'REQUEST_FAILED';
  const cleanCode = /^[A-Z0-9_]+$/.test(message) ? message : (error?.code || 'REQUEST_FAILED');
  const status = error?.status || STATUS_MAP[cleanCode] || 409;
  sendJson(res, status, { error: cleanCode });
}

async function resolveService(context) {
  if (context?.accounts) return context.accounts;
  if (context?._accountsPromise) return context._accountsPromise;
  if (typeof context?.getAccounts === 'function') return context.getAccounts();
  if (context?.pool) {
    // OTP hashes must use one deployment-owned secret, shared by every API
    // instance. A built-in fallback would make live codes predictable.
    const otpSecret = context.otpSecret || process.env.MEGA_OTP_SECRET || process.env.OTP_SECRET;
    if (typeof otpSecret !== 'string' || otpSecret.length < 16) {
      const error = new Error('OTP_SECRET_REQUIRED');
      error.status = 503;
      throw error;
    }
    context._accountsPromise = createAccountService(context.pool, {
      now: context.now || (() => Date.now()),
      deletionPolicy: context.deletionPolicy || { enabled: true, policyVersion: 'v5-policy-v1' },
      ...context,
      otpSecret,
    });
    context.accounts = await context._accountsPromise;
    return context.accounts;
  }
  throw new Error('NO_DATABASE_POOL_OR_ACCOUNTS_SERVICE');
}

// HTTP requests must prove the actor by presenting a live linked session.
// Request properties and x-actor-* headers are untrusted client input, even
// when passed through a proxy. Never mint sessions here from an actor ID.
async function resolveAuth(context, req) {
  const accounts = await resolveService(context);

  let token = req.token || req.sessionToken || null;
  const authorization = req.headers?.authorization;
  if (!token && typeof authorization === 'string' && /^Bearer /i.test(authorization)) {
    token = authorization.slice(7).trim();
  }
  if (!token && typeof req.headers?.['x-session-token'] === 'string') {
    token = req.headers['x-session-token'];
  }
  if (!token && req.headers?.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies['__Host-mega_session'] || cookies['mega_dev_session'] || cookies['session'] || cookies['token'] || null;
  }

  if (!token) return { actor: null, token: null, accounts };
  let session;
  try {
    session = await accounts.requireLinked(token);
  } catch {
    // Do not expose expiry, revocation or account state to the caller.
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  if (!session || typeof session.actor !== 'string' || !session.actor) {
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  return { actor: session.actor, token, accounts };
}

module.exports = {
  STATUS_MAP,
  parseCookies,
  parseJsonBody,
  sendJson,
  sendError,
  resolveService,
  resolveAuth,
};
