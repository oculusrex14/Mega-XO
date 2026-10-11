'use strict';

const crypto = require('node:crypto');
const { materializeLeaderboardProjection } = require('./read-cache.js');

/* The public leaderboard is an aggregate read: no actor is ever authenticated. The
 * single fixed public ingress path below is the ONLY place an empty actor header is
 * admitted, and its query surface is a bounded whitelist - never an arbitrary object. */
const LEADERBOARD_PATH = '/ingress/leaderboard';
const LEADERBOARD_FIELDS = Object.freeze(['metric', 'scope', 'league', 'region']);
const LEADERBOARD_METRICS = Object.freeze(['rating', 'wealth']);
const LEADERBOARD_MAX_FIELD = 64;
const LEADERBOARD_TOKEN = /^[A-Za-z0-9_-]*$/;

/**
 * Whitelists and bounds a public leaderboard query. Unknown keys, non-string or
 * oversized values, and unsupported metrics are rejected so an unvalidated object
 * can never reach the Core-owned read.
 * @param {*} body Parsed request body
 * @returns {{ok: boolean, query?: Object}}
 */
function validateLeaderboardQuery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  for (const key of Object.keys(body)) {
    if (!LEADERBOARD_FIELDS.includes(key)) return { ok: false };
  }
  const query = {};
  for (const key of LEADERBOARD_FIELDS) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > LEADERBOARD_MAX_FIELD || !LEADERBOARD_TOKEN.test(value)) {
      return { ok: false };
    }
    query[key] = value;
  }
  if (query.metric !== undefined && !LEADERBOARD_METRICS.includes(query.metric)) return { ok: false };
  return { ok: true, query };
}

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

    // Admission is a queue-service operation, never a player Core command.
    async join({ actor, opKey, mode, region, latencyMs }) {
      return this.forwardCommand({ actor, opKey, path: '/ingress/queue/join',
        command: { mode, region, latencyMs } });
    },
    async cancel({ actor, opKey }) {
      return this.forwardCommand({ actor, opKey, path: '/ingress/queue/cancel', command: {} });
    },
    async status(actor) {
      return this.forwardCommand({ actor, opKey: 'queue-status',
        path: '/ingress/queue/status', command: {} });
    },

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

    /**
     * Reads the public leaderboard aggregate through the Core-owned ingress.
     *
     * This is the ONE actor-free service call: the leaderboard is a public aggregate
     * with no authenticated principal, so the request is signed with the SAME
     * timestamp/method/path/actor('')/opKey('')/bodyHash construction the actor
     * paths use (an empty actor can therefore never be forged - it is signed, not
     * omitted). The body is the bounded query whitelist only, never a caller object.
     * @param {Object} [query] { metric, scope, league, region }
     * @returns {Promise<Array>} public leaderboard rows
     */
    async leaderboard(query = {}) {
      const cleanPath = LEADERBOARD_PATH;
      const url = baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
      const timestamp = String(clock());
      const bodyObj = {};
      for (const field of LEADERBOARD_FIELDS) {
        const value = query?.[field];
        if (typeof value === 'string') bodyObj[field] = value;
      }
      const bodyString = JSON.stringify(bodyObj);

      const signature = signRequest({
        secret,
        timestamp,
        method: 'POST',
        path: cleanPath,
        actor: '',
        opKey: '',
        bodyString,
      });

      const headers = {
        'content-type': 'application/json',
        'x-service-timestamp': timestamp,
        'x-service-actor': '',
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

        if (parsed && typeof parsed === 'object' && 'result' in parsed) return parsed.result;
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
  };
}

/**
 * Creates an HTTP ingress handler running inside the Game Core process to receive forwarded requests.
 * @param {Object} options
 * @param {Object} options.coreService
 * @param {Object} [options.ticketIssuer]
 * @param {Object} [options.queue] Core-owned queue service for admission/cancel/status.
 * @param {Function} [options.leaderboard] Core-owned public leaderboard materializer
 * `(query) => rows`. Defaults to the existing `materializeLeaderboardProjection`
 * against the Core-owned pool (bound via `leaderboardPool`), so the public API never
 * needs Core credentials.
 * @param {Object} [options.leaderboardPool] Core-owned pool used by the default materializer.
 * @param {string} options.secret
 * @param {number} [options.maxDriftMs=30000]
 * @param {Function} [options.now=Date.now]
 * @returns {Function} async function ingress(req, res)
 */
function createCoreServiceIngress({
  coreService,
  ticketIssuer,
  queue,
  leaderboard,
  leaderboardPool,
  secret,
  maxDriftMs = 30000,
  now = Date.now,
} = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('INGRESS_SECRET_REQUIRED');
  }

  const clock = typeof now === 'function' ? now : Date.now;

  /* The public leaderboard read is materialized by the Core-owned pool by default.
   * An injected `leaderboard` function takes precedence, but neither an injected
   * function nor a pool can be supplied by a request - only by the Core composition.
   * The served result is the public ROWS array (the projection wrapper stays Core-side). */
  const readLeaderboard = typeof leaderboard === 'function'
    ? leaderboard
    : (leaderboardPool
      ? async (query) => {
        const projection = await materializeLeaderboardProjection(leaderboardPool, query);
        return projection && Array.isArray(projection.data) ? projection.data : projection;
      }
      : null);

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

      // 3. Verify actor match and presence. The public leaderboard is the ONLY
      // actor-free call: it carries no principal, but its empty actor header is
      // still signed (see signRequest) and only the exact fixed path is admitted.
      const isPublicLeaderboard = pathname === LEADERBOARD_PATH;
      if (!actorHeader && !isPublicLeaderboard) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }
      if (parsedBody && typeof parsedBody === 'object' && parsedBody.actor && parsedBody.actor !== actorHeader) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }

      // 4. Route dispatch
      if (pathname === LEADERBOARD_PATH) {
        if (method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        if (typeof readLeaderboard !== 'function') {
          return sendIngressError(res, 503, 'LEADERBOARD_UNAVAILABLE');
        }
        // The signed request body is the bounded query whitelist; arbitrary
        // objects, unknown keys and oversized values never reach the Core read.
        const validated = validateLeaderboardQuery(parsedBody === null ? {} : parsedBody);
        if (!validated.ok) return sendIngressError(res, 400, 'INVALID_LEADERBOARD_QUERY');
        try {
          const result = await readLeaderboard(validated.query);
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (err) {
          const code = err?.code || err?.message || 'LEADERBOARD_UNAVAILABLE';
          return sendIngressJson(res, err?.status || 503, { ok: false, error: code });
        }
      }

      if (pathname === '/ingress/queue/join' ||
          pathname === '/ingress/queue/cancel' ||
          pathname === '/ingress/queue/status') {
        if (method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        const operation = pathname.slice('/ingress/queue/'.length);
        if (!opKeyHeader) return sendIngressError(res, 400, 'OPKEY_REQUIRED');
        if (typeof queue?.[operation] !== 'function') {
          return sendIngressError(res, 503, 'QUEUE_UNAVAILABLE');
        }
        const input = parsedBody?.command;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return sendIngressError(res, 400, 'INVALID_COMMAND');
        }
        // Signed headers are the sole authority. Body actor, opKey, pairing
        // players and scope never cross into the Core-owned queue service.
        try {
          const result = operation === 'status'
            ? await queue.status(actorHeader)
            : operation === 'cancel'
              ? await queue.cancel({ actor: actorHeader, opKey: opKeyHeader })
              : await queue.join({ actor: actorHeader, opKey: opKeyHeader,
                mode: input.mode, region: input.region, latencyMs: input.latencyMs });
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (err) {
          const code = err?.code || err?.message || 'QUEUE_UNAVAILABLE';
          return sendIngressJson(res, err?.status || 409, { ok: false, error: code });
        }
      }

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

        const session = parsedBody?.session;
        if (!session || typeof session !== 'object' || Array.isArray(session)) {
          return sendIngressError(res, 400, 'INVALID_TICKET_REQUEST');
        }
        try {
          if (!ticketIssuer || typeof ticketIssuer.issue !== 'function') {
            return sendIngressError(res, 503, 'TICKET_ISSUER_UNAVAILABLE');
          }
          const ticket = await ticketIssuer.issue({
            sessionId: session.sessionId, generation: session.generation,
            connectionClass: session.connectionClass, matchScope: session.matchScope ?? null,
            actor: actorHeader,
          });

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
