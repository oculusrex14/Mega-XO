'use strict';

/**
 * apps/api/routes/compat.js
 * Old-origin browser client compatibility routes for /api/v1.
 *
 * Requirements:
 * - GET /api/v1/profile: legacy profile shape
 *   { id, friendCode, name, rating, games, tier, wallet, records, daily, friends }
 *   with auth continuity (__Host-mega_session cookie or Bearer token).
 * - GET /api/v1/queue: genuinely read-only queue status, zero lazy database writes.
 * - GET /api/v1/match/:id: genuinely read-only match view, zero lazy database writes.
 * - GET /api/v1/invitations: pending match invitations for caller.
 * - Backed entirely by PostgreSQL api_runtime or Core services. Zero SQLite writes.
 */

const path = require('node:path');
const {
  sendJson,
  sendError,
  resolveAuth,
} = require('./helpers');
const {
  classifyRoute,
  defaultReadCache,
  CATEGORIES,
  CACHE_CONTROL_POLICIES,
  createVersionedProjection,
  materializeLeaderboardProjection,
} = require(path.join(__dirname, '../../../packages/services/read-cache.js'));

/**
 * Formats match data for participant display without leaking opponent secrets during queue matching.
 * @param {Object} m Match object
 * @param {string} actor Requesting player
 * @param {number} now Current timestamp in ms
 * @returns {Object} Public match representation
 */
function formatMatchDisplay(m, actor, now = Date.now()) {
  if (!m || typeof m !== 'object') return m;

  const id = m.id || m.match_id;
  const status = m.status;
  const terms = m.terms || m.terms_json || {};
  const termsHash = m.termsHash || m.terms_hash;
  const created = m.created || m.created_at;
  const expires = m.expires || m.expires_at;
  const players = Array.isArray(m.players) ? m.players : [];
  const accepted = Array.isArray(m.accepted) ? m.accepted : [];

  if (status === 'OFFERED' && terms.source === 'queue') {
    return {
      id,
      status,
      termsHash,
      created,
      expires,
      players: [actor],
      accepted: accepted.includes(actor) ? [actor] : [],
      opponentHidden: true,
      quote: m.quote,
      terms: {
        source: 'queue',
        kind: terms.kind,
        rated: terms.rated,
        turnSeconds: terms.turnSeconds,
      },
      serverNow: now,
    };
  }

  return {
    ...m,
    id,
    players,
    accepted,
    serverNow: now,
  };
}

/**
 * GET /api/v1/profile
 * Returns the legacy profile shape expected by older browser clients.
 */
async function handleGetProfile(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  // 1. Fetch self profile projection
  const self = await accounts.self(actor);

  // 2. Fetch friends & requests
  let friendsList = [];
  let friendRequests = [];
  try {
    const friendsData = await accounts.friends(actor);
    if (friendsData) {
      if (Array.isArray(friendsData.friends)) {
        friendsList = friendsData.friends.map((f) => ({
          ...f,
          online: Boolean(f.presence?.online || f.online),
        }));
      }
      if (Array.isArray(friendsData.incoming)) {
        friendRequests = friendsData.incoming.map((f) => f.id || f.actor || f);
      }
    }
  } catch {
    // Best-effort friends lookup
  }

  // 3. Fetch wallet, history records, and daily progress from PostgreSQL api_runtime
  let exportData = null;
  let stateData = null;

  if (context?.pool && typeof context.pool.query === 'function') {
    try {
      const resExport = await context.pool.query(
        'SELECT profile.account_export($1) AS val',
        [actor]
      );
      exportData = resExport?.rows?.[0]?.val || null;
    } catch {
      // Best-effort account_export
    }

    if (!exportData) {
      try {
        const resState = await context.pool.query(
          'SELECT profile.account_state($1) AS val',
          [actor]
        );
        stateData = resState?.rows?.[0]?.val || null;
      } catch {
        // Best-effort account_state
      }
    }
  }

  const wealth = exportData?.state?.wealth || stateData?.wealth || {};
  const competitive = exportData?.state?.competitive || stateData?.competitive || {};
  const records = exportData?.state?.history || stateData?.history || self.history || [];
  const ledger = Array.isArray(exportData?.economyJournal)
    ? exportData.economyJournal.slice(-40)
    : [];

  const nowMs = typeof context.now === 'function' ? context.now() : Date.now();
  const todayKey = new Date(nowMs).toISOString().slice(0, 10);
  const daily = (exportData?.daily && exportData.daily[todayKey])
    || (exportData?.daily && Object.values(exportData.daily)[0])
    || {};

  const wallet = {
    coins: Number.isSafeInteger(wealth.coins) ? wealth.coins : (self.coins ?? 0),
    crowns: Number.isSafeInteger(wealth.crowns) ? wealth.crowns : (self.crowns ?? 0),
    reservedCoins: Number.isSafeInteger(wealth.reservedCoins) ? wealth.reservedCoins : 0,
    reservedCrowns: Number.isSafeInteger(wealth.reservedCrowns) ? wealth.reservedCrowns : 0,
    owned: Array.isArray(wealth.owned) ? wealth.owned : [],
    ledger,
  };

  const rating = competitive.rating ?? self.rating ?? 1500;
  const games = competitive.games ?? self.games ?? 0;
  const tier = self.tier || competitive.tier || 'bronze';

  return sendJson(res, 200, {
    id: actor,
    friendCode: self.friendCode || self.tag,
    tag: self.tag,
    name: self.name || self.displayName || self.username,
    displayName: self.displayName || self.name || self.username,
    username: self.username,
    rating,
    games,
    tier,
    wallet,
    records,
    daily,
    friends: friendsList,
    friendRequests,
    wealthPublic: self.wealthPublic !== false,
    activeMatch: competitive.activeMatch || self.activeMatch || null,
    avatar: self.avatar || null,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * GET /api/v1/queue
 * Genuinely read-only matchmaking status, zero lazy database writes.
 */
async function handleGetQueue(context, req, res) {
  const { actor } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  // 1. Context queue service
  if (context?.queue && typeof context.queue.status === 'function') {
    try {
      const qStatus = await context.queue.status(actor);
      if (qStatus) return sendJson(res, 200, qStatus, { 'Cache-Control': CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT });
    } catch {}
  }

  // 2. Custom getQueueStatus hook
  if (typeof context?.getQueueStatus === 'function') {
    try {
      const qStatus = await context.getQueueStatus(actor);
      if (qStatus) return sendJson(res, 200, qStatus, { 'Cache-Control': CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT });
    } catch {}
  }

  // 3. PostgreSQL read-only check: occupancy / active match
  if (context?.pool && typeof context.pool.query === 'function') {
    try {
      const occQuery = await context.pool.query(
        'SELECT kind, ref_id FROM core.actor_occupancy WHERE actor_id = $1 LIMIT 1',
        [actor]
      );
      if (occQuery.rows.length > 0) {
        const occ = occQuery.rows[0];
        return sendJson(res, 200, {
          state: 'matched',
          matchId: occ.ref_id,
          mode: occ.kind || 'ranked',
        }, { 'Cache-Control': CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT });
      }
    } catch {}
  }

  // 4. Default: player is idle
  return sendJson(res, 200, { state: 'idle' }, { 'Cache-Control': CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT });
}

/**
 * GET /api/v1/match/:id
 * Genuinely read-only match view, zero lazy database writes.
 */
async function handleGetMatch(context, req, res, matchId) {
  const { actor } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  if (!matchId || typeof matchId !== 'string') {
    return sendJson(res, 400, { error: 'INVALID_MATCH_ID' });
  }

  // This route is participant-authenticated for every match state. Even
  // completed results may differ by viewer and require fresh entitlement;
  // neither CDN/public nor actor-blind shared cache may bypass Core/PG.
  let match = null;
  // 1. Core service readMatch
  const coreSvc = context?.core || context?.coreService;
  if (coreSvc && typeof coreSvc.readMatch === 'function') {
    try {
      match = await coreSvc.readMatch(actor, matchId);
    } catch (err) {
      const code = err?.message || err?.code;
      if (code === 'UNKNOWN_MATCH' || code === 'NOT_FOUND') {
        return sendJson(res, 404, { error: 'NOT_FOUND', message: 'UNKNOWN_MATCH' });
      }
      if (code === 'NOT_PARTICIPANT') {
        return sendJson(res, 403, { error: 'NOT_PARTICIPANT' });
      }
      throw err;
    }
  }

  // 2. Custom readMatch or getMatch handler
  if (!match && typeof context?.readMatch === 'function') {
    try {
      match = await context.readMatch(actor, matchId);
    } catch (err) {
      const code = err?.message || err?.code;
      if (code === 'NOT_PARTICIPANT') return sendJson(res, 403, { error: 'NOT_PARTICIPANT' });
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
  } else if (!match && typeof context?.getMatch === 'function') {
    try {
      match = await context.getMatch(actor, matchId);
    } catch (err) {
      const code = err?.message || err?.code;
      if (code === 'NOT_PARTICIPANT') return sendJson(res, 403, { error: 'NOT_PARTICIPANT' });
      return sendJson(res, 404, { error: 'NOT_FOUND' });
    }
  }

  // 3. Fallback: PostgreSQL read-only query
  if (!match && context?.pool && typeof context.pool.query === 'function') {
    try {
      const resMatch = await context.pool.query(
        `SELECT m.match_id AS id, m.status, m.mode, m.kind, m.terms_json AS terms,
                m.terms_hash AS "termsHash",
                (extract(epoch from m.created_at)*1000)::bigint AS created,
                (extract(epoch from m.expires_at)*1000)::bigint AS expires,
                (extract(epoch from m.deadline)*1000)::bigint AS deadline,
                (SELECT json_agg(p.actor_id ORDER BY p.seat) FROM match.participants p WHERE p.match_id = m.match_id) AS players,
                (SELECT json_agg(p.actor_id) FROM match.participants p WHERE p.match_id = m.match_id AND p.accepted = true) AS accepted
         FROM match.matches m
         WHERE m.match_id = $1`,
        [matchId]
      );
      if (resMatch.rows.length > 0) {
        const row = resMatch.rows[0];
        if (!Array.isArray(row.players) || !row.players.includes(actor)) {
          return sendJson(res, 403, { error: 'NOT_PARTICIPANT' });
        }
        match = row;
      }
    } catch {}
  }

  if (!match) {
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  const nowMs = typeof context.now === 'function' ? context.now() : Date.now();
  const displayed = formatMatchDisplay(match, actor, nowMs);

  const classification = classifyRoute('/api/v1/match/' + matchId, {
    matchStatus: match.status,
    isPrivateMatch: true,
  });

  return sendJson(res, 200, displayed, {
    'Cache-Control': classification.cacheControl,
  });
}
/**
 * GET /api/v1/invitations
 * Pending match invitations for caller.
 */
async function handleGetInvitations(context, req, res) {
  const { actor } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  let invitations = [];

  // 1. Injected invitations function or array
  if (typeof context?.invitations === 'function') {
    try {
      invitations = await context.invitations(actor);
    } catch {}
  } else if (Array.isArray(context?.invitations)) {
    invitations = context.invitations.filter((m) =>
      Array.isArray(m?.players) && m.players.includes(actor) &&
      (!Array.isArray(m.accepted) || !m.accepted.includes(actor))
    );
  } else if (typeof context?.getInvitations === 'function') {
    try {
      invitations = await context.getInvitations(actor);
    } catch {}
  } else if (context?.pool && typeof context.pool.query === 'function') {
    try {
      const resInv = await context.pool.query(
        `SELECT m.match_id AS id, m.status, m.terms_json AS terms, m.terms_hash AS "termsHash",
                (extract(epoch from m.created_at)*1000)::bigint AS created,
                (extract(epoch from m.expires_at)*1000)::bigint AS expires,
                (SELECT json_agg(p.actor_id ORDER BY p.seat) FROM match.participants p WHERE p.match_id = m.match_id) AS players,
                (SELECT json_agg(p.actor_id) FROM match.participants p WHERE p.match_id = m.match_id AND p.accepted = true) AS accepted
         FROM match.matches m
         JOIN match.participants p ON p.match_id = m.match_id
         WHERE p.actor_id = $1
           AND p.accepted = false
           AND m.status = 'OFFERED'
           AND (m.expires_at IS NULL OR m.expires_at > now())`,
        [actor]
      );
      invitations = resInv.rows || [];
    } catch {}
  }

  const nowMs = typeof context.now === 'function' ? context.now() : Date.now();
  const formatted = (invitations || []).map((inv) => formatMatchDisplay(inv, actor, nowMs));
  return sendJson(res, 200, formatted, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE,
  });
}

/**
 * GET /api/v1/leaderboard
 * Public ranked and wealth leaderboard rankings.
 */
async function handleGetLeaderboard(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const metric = url.searchParams.get('metric') || 'rating';
  const scope = url.searchParams.get('scope') || 'global';
  const league = url.searchParams.get('league') || 'all';
  const region = url.searchParams.get('region') || '';

  const readCache = context?.readCache || defaultReadCache;
  const cacheKey = `leaderboard:${metric}:${scope}:${league}:${region}`;

  const cached = readCache.get(cacheKey, { allowStale: true });
  if (cached) {
    const data = (cached && cached.data !== undefined) ? cached.data : cached;
    return sendJson(res, 200, data, {
      'Cache-Control': CACHE_CONTROL_POLICIES.PUBLIC_LEADERBOARD,
    });
  }

  let projection = null;
  const pool = context?.corePool || context?.pool;
  if (pool) {
    try {
      projection = await materializeLeaderboardProjection(pool, { metric, limit: 50 });
    } catch {}
  }
  if (!projection && typeof context?.leaderboard === 'function') {
    try {
      const rows = await context.leaderboard({ metric, scope, league, region });
      projection = createVersionedProjection(1, rows);
    } catch {}
  }
  if (!projection) {
    projection = createVersionedProjection(1, []);
  }

  readCache.set(cacheKey, projection, {
    ttlMs: 60000,
    staleToleranceMs: 300000,
    tags: ['leaderboard'],
    category: CATEGORIES.PUBLIC_PROJECTED,
  });

  return sendJson(res, 200, projection.data, {
    'Cache-Control': CACHE_CONTROL_POLICIES.PUBLIC_LEADERBOARD,
  });
}
/**
 * Dispatches /api/v1 compatibility routes.
 * Returns true if handled, false otherwise.
 * @param {Object} context
 * @param {Object} req
 * @param {Object} res
 * @returns {Promise<boolean>}
 */
async function handleCompatRoute(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const method = (req.method || 'GET').toUpperCase();

  // Match /api/v1 endpoints
  if (pathname === '/api/v1/profile') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    await handleGetProfile(context, req, res);
    return true;
  }

  if (pathname === '/api/v1/queue') {
    if (method === 'GET') {
      await handleGetQueue(context, req, res);
      return true;
    }
    // Note: POST /api/v1/queue is competitive mutation, handled by competitive.js
    return false;
  }

  if (pathname === '/api/v1/invitations') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    await handleGetInvitations(context, req, res);
    return true;
  }

  if (pathname.startsWith('/api/v1/match/')) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const matchId = decodeURIComponent(pathname.slice('/api/v1/match/'.length).trim());
    await handleGetMatch(context, req, res, matchId);
    return true;
  }

  if (pathname === '/api/v1/leaderboard') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    await handleGetLeaderboard(context, req, res);
    return true;
  }

  return false;
}

handleCompatRoute.handleCompatRoute = handleCompatRoute;
handleCompatRoute.handleGetProfile = handleGetProfile;
handleCompatRoute.handleGetQueue = handleGetQueue;
handleCompatRoute.handleGetMatch = handleGetMatch;
handleCompatRoute.handleGetInvitations = handleGetInvitations;
handleCompatRoute.formatMatchDisplay = formatMatchDisplay;
handleCompatRoute.handleGetLeaderboard = handleGetLeaderboard;

module.exports = handleCompatRoute;
module.exports.handleCompatRoute = handleCompatRoute;
module.exports.handleGetProfile = handleGetProfile;
module.exports.handleGetQueue = handleGetQueue;
module.exports.handleGetMatch = handleGetMatch;
module.exports.handleGetInvitations = handleGetInvitations;
module.exports.formatMatchDisplay = formatMatchDisplay;
module.exports.handleGetLeaderboard = handleGetLeaderboard;
