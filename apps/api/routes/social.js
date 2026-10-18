'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  sendJson,
  resolveAuth,
} = require('./helpers');
const {
  defaultReadCache,
  CACHE_CONTROL_POLICIES,
} = require(path.join(__dirname, '../../../packages/services/read-cache.js'));

/* The durable challenge projection (migration 0063): the caller's own OFFERED, unaccepted,
 * unexpired matches, read through the sanctioned profile.challenges_for(text) SECURITY DEFINER
 * export. The API tier never gains direct match.* grants. */
const CHALLENGES_SQL = 'SELECT * FROM profile.challenges_for($1)';

/**
 * Formats one durable challenge row into the display shape the shipped clients already parse
 * (id, terms.source, quote, players, playerNames, challengerName). The queue source is carried
 * so callers can filter it; the challenges route excludes it server-side like the legacy store.
 */
function formatChallengeRow(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return row;
  const players = Array.isArray(row.players) ? row.players : [];
  const playerNames = row.player_names && typeof row.player_names === 'object' ? row.player_names : {};
  return {
    id: row.match_id,
    status: row.status,
    terms: { source: row.source, ...(row.terms && typeof row.terms === 'object' ? row.terms : {}) },
    termsHash: row.terms_hash,
    quote: row.quote,
    created: row.created,
    expires: row.expires,
    players,
    accepted: Array.isArray(row.accepted) ? row.accepted : [],
    playerNames,
    challengerName: playerNames[players[0]] || 'Player',
    serverNow: now,
  };
}

/**
 * GET /api/community/challenges
 * Offfered direct challenges addressed to the caller (contract community.challenges). Answers
 * with the same display shape the legacy community store produced; a missing projection
 * function or pool is an honest 503, never an empty success.
 */
async function getChallenges(context, req, res) {
  const { actor } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }
  if (!context?.pool || typeof context.pool.query !== 'function') {
    const err = new Error('SERVICE_UNAVAILABLE');
    err.status = 503;
    throw err;
  }
  const result = await context.pool.query(CHALLENGES_SQL, [actor]);
  const now = Date.now();
  const display = (result.rows || [])
    .filter((row) => row && row.source !== 'queue')
    .map((row) => formatChallengeRow(row, now));
  return sendJson(res, 200, display, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * POST /api/community/presence
 * Per-session presence heartbeat (contract community.presence). The accounts service owns the
 * durable-session fence, the rate spend and the Redis write; this route only forwards the
 * caller's token and the foreground flag and reports the conservative result.
 */
async function postPresence(context, req, res) {
  const { token, accounts } = await resolveAuth(context, req);
  if (!token) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }
  let body = {};
  try {
    body = await parseJsonBody(req, 65536);
  } catch (error) {
    if (error?.status === 413) throw error;
    body = {};
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
  const result = await accounts.heartbeat(token, body.foreground === true);
  return sendJson(res, 200, {
    ok: true,
    state: result && typeof result === 'object' ? result.state || null : null,
    online: result?.online === true,
  }, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * GET /api/community/profile/:id
 * Privacy-aware player profile lookup:
 * - If caller === target: full profile.
 * - If relation === 'friend' and visibility === 'friends': full stats.
 * - If visibility === 'public': public stats.
 * - If visibility === 'private' or relation === 'blocked': profile not found / hidden stats.
 */
async function getProfile(context, req, res, targetId) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  if (!targetId || typeof targetId !== 'string') {
    const err = new Error('PROFILE_NOT_FOUND');
    err.status = 404;
    throw err;
  }

  const resolvedTarget = await accounts.resolve(targetId);
  if (!resolvedTarget) {
    const err = new Error('PROFILE_NOT_FOUND');
    err.status = 404;
    throw err;
  }

  // This is an actor-relative projection, even when the target has public
  // stats: block status, friendship, relation and visibility depend on the
  // requesting actor. A shared/stale target-only cache bypasses those checks.
  // Always consult the PostgreSQL account service for this private endpoint.
  const profile = await accounts.view(actor, resolvedTarget);
  return sendJson(res, 200, profile, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * GET /api/community/friends
 * Lists accepted friends.
 */
async function getFriends(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  // Friends and incoming requests are viewer-specific authority decisions.
  // A local cache has no cross-instance invalidation: a block/unfriend on
  // another API worker must take effect on the very next request.
  // Read PostgreSQL on every request and disallow CDN/shared cache storage.
  const result = await accounts.friends(actor);
  return sendJson(res, 200, result, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * POST /api/community/friend
 * Handles friend requests (request, accept, decline, cancel, remove, block, unblock).
 */
async function handleFriendAction(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const action = body.action || body.command;
  const target = body.target || body.from || body.opponent;
  const key = req.headers?.['x-operation-key'] || body.key || `social:${actor}:${action}:${target}:${Date.now()}`;

  const outcome = await accounts.social(actor, key, action, target);

  const readCache = context?.readCache || defaultReadCache;
  readCache.invalidate('friend.updated', { actor, target });
  return sendJson(res, 200, outcome);
}

/**
 * GET /api/community/search
 * Searches player profiles by tag (exact) or username prefix (min 3 chars).
 */
async function searchProfiles(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const url = new URL(req.url, 'http://localhost');
  const query = url.searchParams.get('q') || req.query?.q || '';
  // Search results depend on the viewer's blocks and profile relationships.
  // Public caching would let a CDN replay one player's results to another.
  if (!query || query.trim().length === 0) {
    return sendJson(res, 200, [], { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
  }

  const results = await accounts.search(actor, query);
  return sendJson(res, 200, results, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * Dispatches social routes based on method and pathname.
 * Returns true if handled, false otherwise.
 */
async function handleSocialRoute(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const method = req.method;

  if (pathname.startsWith('/api/community/profile/') && method === 'GET') {
    const targetId = decodeURIComponent(pathname.slice('/api/community/profile/'.length)).replace(/\/+$/, '');
    await getProfile(context, req, res, targetId);
    return true;
  }

  if (pathname === '/api/community/friends' && method === 'GET') {
    await getFriends(context, req, res);
    return true;
  }

  if (pathname === '/api/community/friend' && method === 'POST') {
    await handleFriendAction(context, req, res);
    return true;
  }

  if (pathname === '/api/community/search' && method === 'GET') {
    await searchProfiles(context, req, res);
    return true;
  }

  if (pathname === '/api/community/challenges' && method === 'GET') {
    await getChallenges(context, req, res);
    return true;
  }

  if (pathname === '/api/community/presence' && method === 'POST') {
    await postPresence(context, req, res);
    return true;
  }

  return false;
}

module.exports = {
  getProfile,
  getFriends,
  handleFriendAction,
  searchProfiles,
  getChallenges,
  postPresence,
  formatChallengeRow,
  CHALLENGES_SQL,
  handleSocialRoute,
};
