'use strict';

const crypto = require('node:crypto');

/**
 * Constant-time comparison of two 64-character hex strings to protect against timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeTimingCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== 64 || b.length !== 64) return false;
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== 32 || bufB.length !== 32) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Normalizes header lookups across standard Node HTTP and mock requests.
 * @param {Object} headers
 * @param {string} name
 * @returns {string|undefined}
 */
function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/**
 * Reads request body from a stream, buffer, or pre-parsed object.
 * @param {Object} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    if (typeof req.body === 'object') return JSON.stringify(req.body);
    return String(req.body);
  }
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');

  if (typeof req.on !== 'function') return '';

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Helper to write JSON responses for ingress.
 */
function sendIngressJson(res, statusCode, data) {
  if (typeof res.status === 'function') res.status(statusCode);
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  }
  const body = JSON.stringify(data);
  if (typeof res.json === 'function' && res.statusCode !== statusCode) {
    res.json(data);
    return;
  }
  if (typeof res.end === 'function') {
    res.end(body);
  }
}

/**
 * Helper to write error JSON responses for ingress.
 */
function sendIngressError(res, statusCode, code, message) {
  sendIngressJson(res, statusCode, {
    ok: false,
    error: code,
    message: message || code,
  });
}

/**
 * Generates an HMAC-SHA256 signature for service requests.
 * @param {Object} params
 * @param {string} params.secret
 * @param {string|number} params.timestamp
 * @param {string} [params.method='POST']
 * @param {string} params.path
 * @param {string} [params.actor='']
 * @param {string} [params.opKey='']
 * @param {string} [params.bodyString='']
 * @returns {string} hex signature
 */
function signRequest({
  secret,
  timestamp,
  method = 'POST',
  path,
  actor = '',
  opKey = '',
  bodyString = '',
}) {
  const normMethod = (method || 'POST').toUpperCase();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const bodyHash = crypto.createHash('sha256').update(bodyString || '').digest('hex');
  const payload = `${timestamp}:${normMethod}:${cleanPath}:${actor || ''}:${opKey || ''}:${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies request signature and timestamp drift.
 */
function verifyRequest({
  secret,
  timestamp,
  method = 'POST',
  path,
  actor = '',
  opKey = '',
  bodyString = '',
  signature,
  maxDriftMs = 30000,
  now = Date.now,
}) {
  const currentTime = (typeof now === 'function' ? now() : Date.now)();
  const reqTime = Number(timestamp);

  // 1. Check timestamp drift
  if (!timestamp || !Number.isFinite(reqTime) || Math.abs(currentTime - reqTime) > maxDriftMs) {
    return { valid: false, code: 'REQUEST_EXPIRED', status: 401 };
  }

  // 2. Check signature
  if (!signature || typeof signature !== 'string') {
    return { valid: false, code: 'INVALID_SERVICE_SIGNATURE', status: 403 };
  }

  const expectedSig = signRequest({
    secret,
    timestamp,
    method,
    path,
    actor,
    opKey,
    bodyString,
  });

  if (!safeTimingCompare(signature, expectedSig)) {
    return { valid: false, code: 'INVALID_SERVICE_SIGNATURE', status: 403 };
  }

  return { valid: true };
}

/**
 * Creates a client gateway for dispatching signed requests from Vercel API to Game Core ingress.
 * @param {Object} options
 * @param {string} [options.coreUrl]
 * @param {string} options.secret
 * @param {number} [options.timeoutMs=5000]
 * @param {Function} [options.fetcher=fetch]
 * @param {Function} [options.now=Date.now]
 */
function createCoreGateway({
  coreUrl,
  secret,
  timeoutMs = 5000,
  fetcher,
  now = Date.now,
} = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('GATEWAY_SECRET_REQUIRED');
  }

  const baseUrl = (coreUrl || process.env.CORE_URL || process.env.GAME_CORE_URL || '').replace(/\/+$/, '');
  const clock = typeof now === 'function' ? now : Date.now;
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 5000;
  const fetchFn = fetcher || (typeof fetch === 'function' ? fetch : globalThis.fetch);

  return {
    baseUrl,
    timeoutMs: timeout,

    /**
     * Forwards an economic or competitive command to Game Core ingress.
     * @param {Object} params
     * @param {string} params.actor
     * @param {string} params.opKey
     * @param {Object} params.command
     * @param {string} [params.path='/ingress/command']
     * @returns {Promise<Object>} committed result
     */
    async forwardCommand({ actor, opKey, command, path = '/ingress/command' }) {
      if (!actor) throw new Error('ACTOR_REQUIRED');
      if (!opKey) throw new Error('OPKEY_REQUIRED');
      if (!command) throw new Error('COMMAND_REQUIRED');

      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const url = baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
      const timestamp = String(clock());
      const bodyObj = { actor, opKey, command };
      const bodyString = JSON.stringify(bodyObj);

      const signature = signRequest({
        secret,
        timestamp,
        method: 'POST',
        path: cleanPath,
        actor,
        opKey,
        bodyString,
      });

      const headers = {
        'content-type': 'application/json',
        'x-service-timestamp': timestamp,
        'x-service-actor': actor,
        'x-service-opkey': opKey,
        'x-service-signature': signature,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error('CORE_GATEWAY_TIMEOUT'));
      }, timeout);
      if (typeof timer?.unref === 'function') timer.unref();

      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: controller.signal,
        });

        const status = res.status ?? res.statusCode ?? 200;
        let text = '';
        let parsed = null;

        if (typeof res.text === 'function') {
          text = await res.text();
          if (text) {
            try { parsed = JSON.parse(text); } catch {}
          }
        } else if (typeof res.json === 'function') {
          try {
            parsed = await res.json();
            text = JSON.stringify(parsed);
          } catch {}
        } else if (typeof res.body === 'string') {
          text = res.body;
          try { parsed = JSON.parse(text); } catch {}
        } else if (res.body && typeof res.body === 'object') {
          parsed = res.body;
          text = JSON.stringify(parsed);
        } else if (res.data && typeof res.data === 'object') {
          parsed = res.data;
          text = JSON.stringify(parsed);
        }

        if (status < 200 || status >= 300) {
          const errCode = parsed?.error || parsed?.code || (text && text.length < 120 ? text : 'REQUEST_FAILED');
          const err = new Error(errCode);
          err.status = status;
          err.statusCode = status;
          err.code = errCode;
          err.data = parsed;
          throw err;
        }

        if (parsed && typeof parsed === 'object') {
          if ('result' in parsed) return parsed.result;
        }
        return parsed;
      } catch (err) {
        if (err.name === 'AbortError' || err.message === 'CORE_GATEWAY_TIMEOUT') {
          const timeoutErr = new Error('GATEWAY_TIMEOUT');
          timeoutErr.status = 504;
          timeoutErr.code = 'GATEWAY_TIMEOUT';
          throw timeoutErr;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Requests a realtime ticket from Game Core ingress.
     * @param {Object} params
     * @param {string} params.actor
     * @param {Object} [params.session={}]
     * @param {string} [params.path='/ingress/ticket']
     * @returns {Promise<Object>}
     */
    async requestTicket({ actor, session = {}, path = '/ingress/ticket' }) {
      if (!actor) throw new Error('ACTOR_REQUIRED');

      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const url = baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
      const timestamp = String(clock());
      const bodyObj = { actor, session };
      const bodyString = JSON.stringify(bodyObj);

      const signature = signRequest({
        secret,
        timestamp,
        method: 'POST',
        path: cleanPath,
        actor,
        opKey: '',
        bodyString,
      });

      const headers = {
        'content-type': 'application/json',
        'x-service-timestamp': timestamp,
        'x-service-actor': actor,
        'x-service-opkey': '',
        'x-service-signature': signature,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error('CORE_GATEWAY_TIMEOUT'));
      }, timeout);
      if (typeof timer?.unref === 'function') timer.unref();

      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers,
          body: bodyString,
          signal: controller.signal,
        });

        const status = res.status ?? res.statusCode ?? 200;
        let text = '';
        let parsed = null;

        if (typeof res.text === 'function') {
          text = await res.text();
          if (text) {
            try { parsed = JSON.parse(text); } catch {}
          }
        } else if (typeof res.json === 'function') {
          try {
            parsed = await res.json();
            text = JSON.stringify(parsed);
          } catch {}
        } else if (typeof res.body === 'string') {
          text = res.body;
          try { parsed = JSON.parse(text); } catch {}
        } else if (res.body && typeof res.body === 'object') {
          parsed = res.body;
          text = JSON.stringify(parsed);
        } else if (res.data && typeof res.data === 'object') {
          parsed = res.data;
          text = JSON.stringify(parsed);
        }

        if (status < 200 || status >= 300) {
          const errCode = parsed?.error || parsed?.code || (text && text.length < 120 ? text : 'REQUEST_FAILED');
          const err = new Error(errCode);
          err.status = status;
          err.statusCode = status;
          err.code = errCode;
          err.data = parsed;
          throw err;
        }

        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
        return { ok: true, ticket: parsed };
      } catch (err) {
        if (err.name === 'AbortError' || err.message === 'CORE_GATEWAY_TIMEOUT') {
          const timeoutErr = new Error('GATEWAY_TIMEOUT');
          timeoutErr.status = 504;
          timeoutErr.code = 'GATEWAY_TIMEOUT';
          throw timeoutErr;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Creates an HTTP ingress handler running inside the Game Core process to receive forwarded requests.
 * @param {Object} options
 * @param {Object} options.coreService
 * @param {Object} [options.ticketIssuer]
 * @param {string} options.secret
 * @param {number} [options.maxDriftMs=30000]
 * @param {Function} [options.now=Date.now]
 * @returns {Function} async function ingress(req, res)
 */
function createCoreServiceIngress({
  coreService,
  ticketIssuer,
  secret,
  maxDriftMs = 30000,
  now = Date.now,
} = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('INGRESS_SECRET_REQUIRED');
  }

  const clock = typeof now === 'function' ? now : Date.now;

  async function ingress(req, res) {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', 'http://localhost');
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }

      if (method === 'OPTIONS') {
        res.statusCode = 204;
        if (typeof res.setHeader === 'function') {
          res.setHeader('Allow', 'POST, OPTIONS');
        }
        res.end();
        return;
      }

      const timestampHeader = getHeader(req.headers, 'x-service-timestamp');
      const actorHeader = getHeader(req.headers, 'x-service-actor');
      const opKeyHeader = getHeader(req.headers, 'x-service-opkey') || '';
      const signatureHeader = getHeader(req.headers, 'x-service-signature');

      const rawBody = await readBody(req);
      let parsedBody = null;
      if (rawBody && rawBody.trim().length > 0) {
        try { parsedBody = JSON.parse(rawBody); } catch {}
      }

      // 1. Verify timestamp drift
      const reqTimestamp = Number(timestampHeader);
      const currentTime = clock();
      if (!timestampHeader || !Number.isFinite(reqTimestamp) || Math.abs(currentTime - reqTimestamp) > maxDriftMs) {
        return sendIngressError(res, 401, 'REQUEST_EXPIRED');
      }

      // 2. Verify signature
      if (!signatureHeader || typeof signatureHeader !== 'string') {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }

      const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
      const payload = `${timestampHeader}:${method}:${pathname}:${actorHeader || ''}:${opKeyHeader}:${bodyHash}`;
      const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      if (!safeTimingCompare(signatureHeader, expectedSig)) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }

      // 3. Verify actor match and presence
      if (!actorHeader) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }
      if (parsedBody && typeof parsedBody === 'object' && parsedBody.actor && parsedBody.actor !== actorHeader) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }

      // 4. Route dispatch
      if (pathname === '/ingress/command') {
        if (method !== 'POST') {
          return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        }

        const opKey = opKeyHeader || parsedBody?.opKey;
        if (!opKey) {
          return sendIngressError(res, 400, 'OPKEY_REQUIRED');
        }

        const command = parsedBody?.command || (parsedBody?.type ? parsedBody : null);
        if (!command || typeof command !== 'object') {
          return sendIngressError(res, 400, 'INVALID_COMMAND');
        }

        if (!coreService || typeof coreService.run !== 'function') {
          return sendIngressError(res, 500, 'CORE_SERVICE_UNAVAILABLE');
        }

        try {
          const result = await coreService.run(
            { actor: actorHeader, scope: 'player' },
            opKey,
            command
          );
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (err) {
          const errCode = err?.code || err?.message || 'COMMAND_FAILED';
          const status = err?.status || 409;
          return sendIngressJson(res, status, { ok: false, error: errCode, message: errCode });
        }
      }

      if (pathname === '/ingress/ticket') {
        if (method !== 'POST') {
          return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        }

        const session = parsedBody?.session || parsedBody || {};
        try {
          let ticket = null;
          if (ticketIssuer && typeof ticketIssuer.issueTicket === 'function') {
            try {
              ticket = await ticketIssuer.issueTicket(actorHeader, session);
            } catch {
              ticket = await ticketIssuer.issueTicket({ actor: actorHeader, ...session });
            }
          } else if (ticketIssuer && typeof ticketIssuer.issue === 'function') {
            ticket = await ticketIssuer.issue({ actor: actorHeader, ...session });
          } else if (coreService && typeof coreService.issueTicket === 'function') {
            try {
              ticket = await coreService.issueTicket(actorHeader, session);
            } catch {
              ticket = await coreService.issueTicket({ actor: actorHeader, ...session });
            }
          } else {
            return sendIngressError(res, 500, 'TICKET_ISSUER_UNAVAILABLE');
          }

          const responseData = typeof ticket === 'object' && ticket !== null
            ? { ok: true, ticket: ticket.ticket || ticket, ...ticket }
            : { ok: true, ticket };
          return sendIngressJson(res, 200, responseData);
        } catch (err) {
          const errCode = err?.code || err?.message || 'TICKET_FAILED';
          const status = err?.status || 409;
          return sendIngressJson(res, status, { ok: false, error: errCode, message: errCode });
        }
      }

      return sendIngressError(res, 404, 'NOT_FOUND');
    } catch (err) {
      return sendIngressError(res, 500, 'INTERNAL_SERVER_ERROR', err?.message);
    }
  }

  ingress.handler = ingress;
  ingress.handleRequest = ingress;
  return ingress;
}

module.exports = {
  createCoreGateway,
  createCoreServiceIngress,
  signRequest,
  verifyRequest,
  safeTimingCompare,
};
