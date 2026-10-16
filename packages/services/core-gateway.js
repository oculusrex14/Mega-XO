'use strict';

const crypto = require('node:crypto');
const { materializeLeaderboardProjection, normalizeLeaderboardFilter } = require('./read-cache.js');
const { tournamentCommand, tournamentRoomId } = require('./tournament-http-contract.js');
const T = require('../domain/index.js').tournament;
const TOURNAMENT_CAPABILITIES_PATH = '/ingress/tournaments/capabilities';
function tournamentTransportError(error) {
  if (Number.isInteger(error?.status) && error.status < 500) return error;
  const failure = Error('SERVICE_UNAVAILABLE');
  failure.status = 503;
  failure.code = 'SERVICE_UNAVAILABLE';
  return failure;
}

/* Actor-free ingress is restricted to two exact reads: the public leaderboard
 * and the canonical tournament capability catalogue. Both still carry a signed
 * empty actor and bounded bodies; neither can execute a player command. */
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
  try { return { ok: true, query: normalizeLeaderboardFilter(query) }; }
  catch { return { ok: false }; }
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

/* Service ingress accepts bounded JSON only. This limit is independent of upstream
 * API middleware: Core must defend itself before processing unsigned requests. */
const MAX_INGRESS_BODY_BYTES = 100 * 1024;
const INGRESS_BODY_TIMEOUT_MS = 10000;
function ingressBodyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Reads at most MAX_INGRESS_BODY_BYTES from a streamed, buffered or pre-parsed
 * request. Content-Length is an early hint, never the only size check. The
 * deadline is absolute so slow chunked clients cannot hold an ingress read open.
 */
async function readBody(req) {
  const declaredLength = getHeader(req.headers, 'content-length');
  if (declaredLength !== undefined) {
    const value = Number(declaredLength);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INGRESS_BODY_BYTES) {
      throw ingressBodyError('INGRESS_BODY_TOO_LARGE');
    }
  }

  if (req.body !== undefined && req.body !== null) {
    const text = typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8')
        : typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body);
    if (Buffer.byteLength(text, 'utf8') > MAX_INGRESS_BODY_BYTES) {
      throw ingressBodyError('INGRESS_BODY_TOO_LARGE');
    }
    return text;
  }
  if (typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)) {
    const raw = req.rawBody;
    if (Buffer.byteLength(raw, 'utf8') > MAX_INGRESS_BODY_BYTES) {
      throw ingressBodyError('INGRESS_BODY_TOO_LARGE');
    }
    return Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  }
  if (typeof req.on !== 'function') return '';

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      if (error) reject(error); else resolve(result);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_INGRESS_BODY_BYTES) {
        req.pause?.();
        return finish(ingressBodyError('INGRESS_BODY_TOO_LARGE'));
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, total).toString('utf8'));
    const onError = (error) => finish(error);
    const onAborted = () => finish(ingressBodyError('INGRESS_BODY_ABORTED'));
    const deadline = setTimeout(() => {
      req.pause?.();
      finish(ingressBodyError('INGRESS_BODY_TIMEOUT'));
    }, INGRESS_BODY_TIMEOUT_MS);
    deadline.unref?.();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
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
  const currentTime = (typeof now === 'function' ? now : Date.now)();
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

    async tournamentCommand({ actor, opKey, command }) {
      const projected = tournamentCommand(command);
      try { return await this.forwardCommand({ actor, opKey, path: '/ingress/tournaments/command', command: projected }); }
      catch (error) { throw tournamentTransportError(error); }
    },
    async tournamentView({ actor, id }) {
      const roomId = tournamentRoomId(id);
      try { return await this.forwardCommand({ actor, opKey: 'tournament-view', path: '/ingress/tournaments/view', command: { id: roomId } }); }
      catch (error) { throw tournamentTransportError(error); }
    },
    async tournamentCapabilities() {
      const timestamp = String(clock()), bodyString = '{}', path = TOURNAMENT_CAPABILITIES_PATH;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Error('CORE_GATEWAY_TIMEOUT')), timeout);
      timer.unref?.();
      try {
        const res = await fetchFn(`${baseUrl}${path}`, { method: 'POST', body: bodyString, signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-service-timestamp': timestamp,
            'x-service-actor': '', 'x-service-opkey': '',
            'x-service-signature': signRequest({ secret, timestamp, path, bodyString }) } });
        const result = JSON.parse(await res.text());
        if (res.status < 200 || res.status >= 300) {
          const error = Error(result.error || 'TOURNAMENTS_UNAVAILABLE'); error.status = res.status; throw error;
        }
        return result.result;
      } catch (error) {
        throw tournamentTransportError(error);
      } finally { clearTimeout(timer); }
    },

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

    /** LR12: the signed commerce command surface. The op allow-list lives Core-side
     * (packages/services/commerce-ingress.js); the gateway only signs and forwards. */
    async commerceCommand({ actor, opKey, op, key, kind, platform, itemId, evidence, restore } = {}) {
      return this.forwardCommand({ actor, opKey,
        path: '/ingress/commerce/command',
        command: { op, key, kind, platform, itemId, evidence, restore } });
    },

    /** LR12: forward the AdMob SSV query to the Core commerce callback. Actor-free by design. */
    async commerceSsv({ raw } = {}) {
      const path = '/ingress/commerce/ssv';
      const bodyString = JSON.stringify({ raw });
      const timestamp = String(clock());
      const signature = signRequest({ secret, timestamp, method: 'POST', path, actor: '', opKey: 'commerce-ssv', bodyString });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Error('CORE_GATEWAY_TIMEOUT')), timeout);
      timer.unref?.();
      try {
        const res = await fetchFn(baseUrl + path, { method: 'POST', body: bodyString, signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-service-timestamp': timestamp,
            'x-service-actor': '', 'x-service-opkey': 'commerce-ssv',
            'x-service-signature': signature } });
        const text = await res.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (res.status < 200 || res.status >= 300) {
          const error = Error((parsed && parsed.error) || 'COMMERCE_SSV_FAILED');
          error.status = res.status;
          throw error;
        }
        return parsed && parsed.result !== undefined ? parsed.result : parsed;
      } catch (error) {
        throw tournamentTransportError(error);
      } finally { clearTimeout(timer); }
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
  tournaments,
  commerce,
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

      // 3. Actor-free capability/catalogue reads use exact paths. Their empty
      // actor remains signed, so a read signature cannot authorize a command.
      /* The commerce SSV callback is actor-free too: Google's server calls it, the provider proof
       * inside carries the actor, and the path stays signature-protected like every other ingress. */
      const isPublicRead = pathname === LEADERBOARD_PATH || pathname === TOURNAMENT_CAPABILITIES_PATH
        || pathname === '/ingress/commerce/ssv';
      if (!actorHeader && !isPublicRead) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }
      if (parsedBody && typeof parsedBody === 'object' && parsedBody.actor && parsedBody.actor !== actorHeader) {
        return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
      }

      // 4. Route dispatch
      if (pathname === TOURNAMENT_CAPABILITIES_PATH) {
        if (method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody) || Object.keys(parsedBody).length) {
          return sendIngressError(res, 400, 'INVALID_TOURNAMENT_COMMAND');
        }
        const online = typeof tournaments?.run === 'function' && typeof tournaments?.view === 'function' && typeof tournaments?.sweepTimers === 'function';
        return sendIngressJson(res, 200, { ok: true, result: { online, publicEnabled: online,
          tables: online ? Object.keys(T.TABLES).map(table => T.prize(table)) : [] } });
      }

      if (pathname === '/ingress/tournaments/command' || pathname === '/ingress/tournaments/view') {
        if (method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!opKeyHeader || opKeyHeader.length > 160 || !/^[!-~]+$/.test(opKeyHeader)) return sendIngressError(res, 400, 'INVALID_IDEMPOTENCY_KEY');
        if (typeof tournaments?.run !== 'function' || typeof tournaments?.view !== 'function') return sendIngressError(res, 503, 'TOURNAMENTS_UNAVAILABLE');
        try {
          let result;
          if (pathname.endsWith('/command')) {
            result = await tournaments.run({ actor: actorHeader, scope: 'player' }, opKeyHeader, tournamentCommand(parsedBody?.command));
          } else {
            const input = parsedBody?.command;
            if (!input || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'id')) return sendIngressError(res, 400, 'INVALID_TOURNAMENT_COMMAND');
            result = await tournaments.view(tournamentRoomId(input.id), actorHeader);
          }
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (error) {
          // Unexpected database/network faults reveal no internal detail and
          // remain retryable with the SAME client operation key.
          if (!error.status && (!/^[A-Z][A-Z0-9_]+$/.test(error.message || '') || /^[0-9A-Z]{5}$/.test(error.code || ''))) {
            return sendIngressError(res, 503, 'SERVICE_UNAVAILABLE');
          }
          return sendIngressError(res, error.status || (['NOT_IN_ROOM', 'NOT_MATCH_PLAYER'].includes(error.message) ? 403 : error.message === 'ROOM_NOT_FOUND' ? 404 : 409), error.code || error.message);
        }
      }

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

      /* LR12: the signed commerce command surface. One allow-listed dispatcher
       * (packages/services/commerce-ingress.js) maps {op, ...args} to exactly one commerce call on
       * the Core-owned pool; the actor comes from the signed header, the idempotency key from the
       * client's durable operation key. */
      if (pathname === '/ingress/commerce/command') {
        if (method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!opKeyHeader || opKeyHeader.length > 160 || !/^[!-~]+$/.test(opKeyHeader)) return sendIngressError(res, 400, 'INVALID_IDEMPOTENCY_KEY');
        if (!actorHeader) return sendIngressError(res, 403, 'INVALID_SERVICE_SIGNATURE');
        if (!commerce || typeof commerce.command !== 'function') return sendIngressError(res, 503, 'COMMERCE_UNAVAILABLE');
        const input = parsedBody?.command;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return sendIngressError(res, 400, 'INVALID_COMMERCE_COMMAND');
        try {
          const result = await commerce.command({ actor: actorHeader, opKey: opKeyHeader, ...input });
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (error) {
          const code = error?.code || error?.message || 'COMMERCE_FAILED';
          if (error?.status) return sendIngressError(res, error.status, code);
          if (!/^[A-Z][A-Z0-9_]+$/.test(code)) return sendIngressError(res, 503, 'SERVICE_UNAVAILABLE');
          const status = /INVALID_|MISSING_|REQUIRED_/.test(code) ? 400
            : code === 'COMMERCE_METHOD_MISSING' || code === 'COMMERCE_SERVICE_REQUIRED' ? 503
            : 409;
          return sendIngressError(res, status, code);
        }
      }

      /* LR12: the AdMob SSV provider callback. Actor-free by design (the provider proof inside
       * carries the actor); signature-protected like every other ingress; GET (Google's shape) or
       * POST with {raw}. */
      if (pathname === '/ingress/commerce/ssv') {
        if (method !== 'GET' && method !== 'POST') return sendIngressError(res, 405, 'METHOD_NOT_ALLOWED');
        if (!commerce || typeof commerce.command !== 'function') return sendIngressError(res, 503, 'COMMERCE_UNAVAILABLE');
        const raw = method === 'GET'
          ? Object.fromEntries(url.searchParams)
          : (parsedBody && typeof parsedBody === 'object' ? parsedBody.raw : null);
        try {
          const result = await commerce.command({ op: 'ssv', raw });
          return sendIngressJson(res, 200, { ok: true, result });
        } catch (error) {
          const code = error?.code || error?.message || 'SSV_FAILED';
          if (error?.status) return sendIngressError(res, error.status, code);
          if (!/^[A-Z][A-Z0-9_]+$/.test(code)) return sendIngressError(res, 503, 'SERVICE_UNAVAILABLE');
          return sendIngressError(res, 400, code);
        }
      }

      return sendIngressError(res, 404, 'NOT_FOUND');
    } catch (err) {
      if (err?.code === 'INGRESS_BODY_TOO_LARGE' || err?.code === 'INGRESS_BODY_TIMEOUT') {
        if (typeof res.setHeader === 'function') res.setHeader('connection', 'close');
        return sendIngressError(res, err.code === 'INGRESS_BODY_TOO_LARGE' ? 413 : 408, err.code);
      }
      return sendIngressError(res, 500, 'INTERNAL_SERVER_ERROR');
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
