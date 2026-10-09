'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  sendJson,
  sendError,
  resolveAuth,
} = require('./helpers');
const { createCoreGateway } = require(path.join(__dirname, '../../../packages/services/core-gateway.js'));

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
  const secret = context?.coreSecret || context?.secret || process.env.CORE_SECRET || process.env.SERVICE_SECRET;
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
  if (typeof key !== 'string' || !/^[\\x21-\\x7e]{1,200}$/.test(key)) {
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

/**
 * POST /api/v1/queue
 * Enters matchmaking queue.
 */
async function handleQueue(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'queue') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'queue',
      mode: rest.mode || 'ranked',
      ...rest,
    };
  });
}

/**
 * POST /api/v1/cancel-queue
 * Cancels active matchmaking queue.
 */
async function handleCancelQueue(context, req, res) {
  return forwardToCore(context, req, res, (body) => {
    if (body.command) return body.command;
    if (body.type === 'cancel-queue' || body.type === 'cancel') return body;
    const { opKey, idempotencyKey, ...rest } = body;
    return {
      type: 'cancel-queue',
      ...rest,
    };
  });
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
 * Requests a ticket via Core ingress.
 */
async function handleTicket(context, req, res) {
  const actor = await resolveActor(context, req);
  const body = (await parseJsonBody(req)) || {};
  const gateway = resolveGateway(context);
  const result = await gateway.requestTicket({ actor, session: body });
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
  resolveActor,
  resolveOpKey,
  forwardToCore,
  handleConvert,
  handleQueue,
  handleCancelQueue,
  handleMove,
  handleResign,
  handleQuest,
  handleTicket,
  handleCommand,
  handleCompetitiveRoute,
};
