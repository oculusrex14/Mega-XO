'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  sendJson,
  sendError,
  resolveAuth,
} = require('./helpers');
const { createCoreGateway } = require(path.join(__dirname, '../../../packages/services/core-gateway.js'));
const { createTicketIssuer } = require(path.join(__dirname, '../../../packages/services/tickets.js'));

/**
 * Resolves the core gateway client from context or options.
 * @param {Object} context
 * @returns {Object} CoreGateway instance
 */
function resolveGateway(context) {
  if (context?.coreGateway) return context.coreGateway;
  if (context?._coreGateway) return context._coreGateway;

  // A production API must never sign Core commands with a published fallback
  // secret, nor silently aim economic requests at an arbitrary local service.
  const coreUrl = context?.coreUrl || process.env.MEGA_CORE_URL || process.env.CORE_SERVICE_URL || process.env.CORE_URL || process.env.GAME_CORE_URL;
  // Use the same deployment-owned signing key accepted by the validated Vercel API config.
  // Core ingress must hold this identical key; no hard-coded defaults are permitted.
  const secret = context?.coreSecret || context?.proxySecret || context?.secret || process.env.MEGA_PROXY_SECRET || process.env.PROXY_SECRET || process.env.CORE_SECRET || process.env.SERVICE_SECRET;
  if (!coreUrl || typeof coreUrl !== 'string') {
    const error = new Error('CORE_URL_REQUIRED');
    error.status = 503;
    throw error;
  }
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    const error = new Error('GATEWAY_SECRET_REQUIRED');
    error.status = 503;
    throw error;
  }
  const timeoutMs = context?.timeoutMs || 5000;
  const fetcher = context?.fetcher || (typeof fetch === 'function' ? fetch : globalThis.fetch);
  const now = context?.now || Date.now;

  context._coreGateway = createCoreGateway({
    coreUrl,
    secret,
    timeoutMs,
    fetcher,
    now,
  });
  return context._coreGateway;
}

/** Ticket issuance is owned exclusively by api_runtime. Core can redeem but
 * must not need INSERT privileges or a borrowed API pool inside its process. */
async function resolveApiTicketIssuer(context) {
  if (context?.ticketIssuer && typeof context.ticketIssuer.issue === 'function') return context.ticketIssuer;
  if (!context?.pool || typeof context.pool.withTransaction !== 'function') return null;
  const environment = context.ticketEnvironment || process.env.MEGA_TICKET_ENV;
  if (typeof environment !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment)) return null;
  if (!context._ticketIssuerPromise) {
    context._ticketIssuerPromise = createTicketIssuer(context.pool, {
      environment,
      audience: context.ticketAudience || process.env.MEGA_TICKET_AUDIENCE || 'mega-core',
    }).catch((err) => {
      context._ticketIssuerPromise = null;
      throw err;
    });
  }
  return context._ticketIssuerPromise;
}

/**
 * Extracts or verifies actor identity from request or auth context.
 * @param {Object} context
 * @param {Object} req
 * @returns {Promise<string>} actor ID
 */
async function resolveActor(context, req) {
  // Core signs and executes this actor's economic commands. Only the linked,
  // server-verified session may supply that identity; never request headers.
  const { actor } = await resolveAuth(context, req);
  if (typeof actor === 'string' && actor) return actor;
  const err = new Error('AUTH_REQUIRED');
  err.status = 401;
  err.code = 'AUTH_REQUIRED';
  throw err;
}

/**
 * Resolves an idempotency key from request headers or body.
 * @param {Object} req
 * @param {Object} body
 * @returns {string} opKey
 */
function resolveOpKey(req, body) {
  // Never generate a fresh key on the API tier. Retrying a request after an
  // ambiguous network timeout must reuse the CLIENT'S durable operation ID,
  // otherwise the same economic action can settle twice.
  const key =
    req.headers?.['idempotency-key'] ||
    req.headers?.['x-opkey'] ||
    req.headers?.['x-idempotency-key'] ||
    body?.opKey ||
    body?.idempotencyKey ||
    body?.key;
  if (key === undefined || key === null || key === '') {
    const err = new Error('IDEMPOTENCY_KEY_REQUIRED');
    err.status = 400;
    throw err;
  }
  // Bounded and printable before logging, signing or storing at Core.
  if (typeof key !== 'string' || !/^[!-~]{1,200}$/.test(key)) {
    const err = new Error('INVALID_IDEMPOTENCY_KEY');
    err.status = 400;
    throw err;
  }
  return key;
}

/**
 * Common dispatcher to parse request, resolve actor/opKey, and forward command to Core.
 * @param {Object} context
 * @param {Object} req
 * @param {Object} res
 * @param {Function|Object} commandBuilder
 */
async function forwardToCore(context, req, res, commandBuilder) {
  const actor = await resolveActor(context, req);
  const body = (await parseJsonBody(req)) || {};
  const opKey = resolveOpKey(req, body);

  let command;
  if (typeof commandBuilder === 'function') {
    command = commandBuilder(body);
  } else if (commandBuilder && typeof commandBuilder === 'object') {
    command = { ...commandBuilder, ...body };
  } else {
    command = body.command || (body.type ? body : null);
  }

  if (!command) {
    const err = new Error('INVALID_COMMAND');
    err.status = 400;
    err.code = 'INVALID_COMMAND';
    throw err;
  }

  const gateway = resolveGateway(context);
  const result = await gateway.forwardCommand({ actor, opKey, command });

  const payload = (typeof result === 'object' && result !== null)
    ? (result.ok === undefined ? { ok: true, ...result } : result)
    : { ok: true, result };

  return sendJson(res, 200, payload);
}

/**
 * POST /api/v1/convert
 * Converts currency (e.g. coins to crowns).
 */
async function handleConvert(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'convert') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'convert',
      from: rest.from || 'coins',
      amount: rest.amount !== undefined ? rest.amount : 100,
      ...rest,
    };
  });
}

function resolveQueue(context, operation) {
  if (typeof context?.queue?.[operation] === 'function') return context.queue;
  if (!context?.queue) {
    const gateway = resolveGateway(context);
    if (typeof gateway[operation] === 'function') return gateway;
  }
  const error = new Error('QUEUE_UNAVAILABLE');
  error.status = 503;
  throw error;
}

/**
 * POST /api/v1/queue
 * Enters matchmaking queue.
 */
async function handleQueue(context, req, res) {
  const actor = await resolveActor(context, req);
  const body = (await parseJsonBody(req)) || {};
  const opKey = resolveOpKey(req, body);
  const queue = resolveQueue(context, 'join');
  // Only admission context crosses this boundary. Pairing commands, actor IDs
  // and command scopes supplied by the client cannot become Core authority.
  const result = await queue.join({
    actor, mode: body.mode === undefined ? 'ranked' : body.mode,
    opKey, region: body.region, latencyMs: body.latencyMs,
  });
  return sendJson(res, 200, result);
}

/**
 * POST /api/v1/cancel-queue
 * Cancels active matchmaking queue.
 */
async function handleCancelQueue(context, req, res) {
  const actor = await resolveActor(context, req);
  const body = (await parseJsonBody(req)) || {};
  const opKey = resolveOpKey(req, body);
  const queue = resolveQueue(context, 'cancel');
  const result = await queue.cancel({ actor, opKey });
  // The browser follows matched responses to the durable match view. A live
  // PLAYING match cannot be cancelled by leaving the queue.
  return sendJson(res, 200, result.state === 'playing'
    ? { ...result, state: 'matched' } : result);
}

/**
 * POST /api/v1/move
 * Submits a match move.
 */
async function handleMove(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'move') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'move',
      id: rest.id || rest.matchId,
      revision: rest.revision,
      move: rest.move,
      ...rest,
    };
  });
}

/**
 * POST /api/v1/resign
 * Resigns from an active match.
 */
async function handleResign(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'resign') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'resign',
      id: rest.id || rest.matchId,
      ...rest,
    };
  });
}

/**
 * POST /api/v1/offer
 * Direct challenge offer to an opponent (Core-only match escrow).
 */
async function handleOffer(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'offer') return body;
    // Only the exact V4 wire fields cross into Core; actor/scope stay server-resolved.
    return {
      type: 'offer',
      id: body.id || body.matchId,
      opponent: body.opponent,
      terms: body.terms,
    };
  });
}

/**
 * POST /api/v1/accept
 * Accepts a pending offer by its immutable terms hash (Core-only match escrow).
 */
async function handleAccept(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'accept') return body;
    return {
      type: 'accept',
      id: body.id || body.matchId,
      termsHash: body.termsHash,
    };
  });
}

/**
 * POST /api/v1/decline
 * Declines a pending offer.
 */
async function handleDecline(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'decline') return body;
    return {
      type: 'decline',
      id: body.id || body.matchId,
    };
  });
}

/**
 * POST /api/v1/cancel
 * Cancels an offer this actor created.
 */
async function handleCancel(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'cancel') return body;
    return {
      type: 'cancel',
      id: body.id || body.matchId,
    };
  });
}

/**
 * POST /api/v1/quest
 * Claims a completed quest reward.
 */
async function handleQuest(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'quest') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'quest',
      quest: rest.quest || rest.questId,
      ...rest,
    };
  });
}

/**
 * POST /api/v1/ticket
 * Issues a one-use realtime ticket through the API-role issuer. Core only redeems.
 */
async function handleTicket(context, req, res) {
  const { actor, token, accounts } = await resolveAuth(context, req);
  if (!actor || !token) {
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  const body = (await parseJsonBody(req)) || {};
  if (typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'matchScope')) {
    const error = new Error('INVALID_TICKET_REQUEST');
    error.status = 400;
    throw error;
  }
  const binding = await accounts.accessBinding(token);
  if (binding.actor !== actor) {
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  const issuer = await resolveApiTicketIssuer(context);
  if (!issuer) {
    const error = new Error('TICKET_ISSUER_UNAVAILABLE');
    error.code = 'TICKET_ISSUER_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const result = await issuer.issue({
    actor, sessionId: binding.sessionId, generation: binding.generation,
    connectionClass: binding.connectionClass, matchScope: body.matchScope ?? null,
  });
  const payload = (typeof result === 'object' && result !== null)
    ? (result.ok === undefined ? { ok: true, ...result } : result)
    : { ok: true, ticket: result };
  return sendJson(res, 200, payload);
}

/**
 * POST /api/v1/command
 * Generic competitive/economic command pass-through.
 */
async function handleCommand(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    return body.command || body;
  });
}

/**
 * Dispatches competitive routes based on method and pathname.
 * Returns true if handled, false otherwise.
 * @param {Object} context
 * @param {Object} req
 * @param {Object} res
 * @returns {Promise<boolean>}
 */
async function handleCompetitiveRoute(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const method = req.method;

  let subpath = pathname;
  if (subpath.startsWith('/api/v1/')) {
    subpath = '/api/' + subpath.slice('/api/v1/'.length);
  }

  if (method === 'POST') {
    if (subpath === '/api/convert') {
      await handleConvert(context, req, res);
      return true;
    }
    if (subpath === '/api/queue') {
      await handleQueue(context, req, res);
      return true;
    }
    if (subpath === '/api/cancel-queue' || subpath === '/api/queue/cancel') {
      await handleCancelQueue(context, req, res);
      return true;
    }
    if (subpath === '/api/move') {
      await handleMove(context, req, res);
      return true;
    }
    if (subpath === '/api/resign') {
      await handleResign(context, req, res);
      return true;
    }
    if (subpath === '/api/offer') {
      await handleOffer(context, req, res);
      return true;
    }
    if (subpath === '/api/accept') {
      await handleAccept(context, req, res);
      return true;
    }
    if (subpath === '/api/decline') {
      await handleDecline(context, req, res);
      return true;
    }
    if (subpath === '/api/cancel') {
      await handleCancel(context, req, res);
      return true;
    }
    if (subpath === '/api/quest' || subpath === '/api/quest/claim') {
      await handleQuest(context, req, res);
      return true;
    }
    if (subpath === '/api/ticket') {
      await handleTicket(context, req, res);
      return true;
    }
    if (subpath === '/api/command') {
      await handleCommand(context, req, res);
      return true;
    }
  }

  return false;
}

module.exports = {
  resolveGateway,
  resolveQueue,
  resolveActor,
  resolveOpKey,
  forwardToCore,
  handleConvert,
  handleQueue,
  handleCancelQueue,
  handleMove,
  handleResign,
  handleOffer,
  handleAccept,
  handleDecline,
  handleCancel,
  handleQuest,
  handleTicket,
  handleCommand,
  handleCompetitiveRoute,
};
