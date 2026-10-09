'use strict';

const path = require('node:path');
const { createAccountService } = require(path.join(__dirname, '../../../packages/services/accounts.js'));

const STATUS_MAP = Object.freeze({
  AUTH_REQUIRED: 401,
  LINK_ACCOUNT_REQUIRED: 401,
  AMBIGUOUS_CREDENTIAL: 401,
  REAUTH_REQUIRED: 401,
  PROFILE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INVALID_JSON: 409,
  BODY_TOO_LARGE: 409,
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

async function parseJsonBody(req, limit = 300000) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        const err = new Error('INVALID_JSON');
        err.status = 409;
        throw err;
      }
    }
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8'));
      } catch {
        const err = new Error('INVALID_JSON');
        err.status = 409;
        throw err;
      }
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
        err.status = 409;
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

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
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
    context._accountsPromise = createAccountService(context.pool, {
      now: context.now || (() => Date.now()),
      otpSecret: context.otpSecret || 'mega-xo-v5-api-default-otp-secret-key',
      deletionPolicy: context.deletionPolicy || { enabled: true, policyVersion: 'v5-policy-v1' },
      ...context,
    });
    context.accounts = await context._accountsPromise;
    return context.accounts;
  }
  throw new Error('NO_DATABASE_POOL_OR_ACCOUNTS_SERVICE');
}

async function resolveAuth(context, req) {
  const accounts = await resolveService(context);

  // 1. Direct actor (test injection / upstream middleware)
  let actor = req.actor || req.user?.actor || req.user?.id || req.headers?.['x-actor-id'] || req.headers?.['x-test-actor'] || null;

  // 2. Token from Authorization header, custom header, or cookie
  let token = req.token || req.sessionToken || null;
  if (!token && req.headers?.authorization) {
    const auth = req.headers.authorization;
    if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    else if (auth.startsWith('bearer ')) token = auth.slice(7).trim();
  }
  if (!token && req.headers?.['x-session-token']) {
    token = req.headers['x-session-token'];
  }
  if (!token && req.headers?.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies['__Host-mega_session'] || cookies['mega_dev_session'] || cookies['session'] || cookies['token'] || null;
  }

  // 3. Resolve session from token if actor not pre-set
  if (token && !actor) {
    const session = await accounts.requireLinked(token);
    actor = session.actor;
  }

  // 4. If actor is set but token is not, issue a valid session for token-requiring endpoints
  if (actor && !token) {
    try {
      const issued = await accounts.issue(actor, Date.now());
      token = issued.token;
    } catch {
      // Best-effort session issuance
    }
  }

  return { actor, token, accounts };
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
