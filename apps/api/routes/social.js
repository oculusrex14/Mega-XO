'use strict';

const {
  parseJsonBody,
  sendJson,
  resolveAuth,
} = require('./helpers');

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

  const profile = await accounts.view(actor, resolvedTarget);
  return sendJson(res, 200, profile);
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

  const result = await accounts.friends(actor);
  return sendJson(res, 200, result);
}

/**
 * POST /api/community/friend
 * Handles friend requests (request, accept, decline, cancel, remove, block, unblock).
 */
async function handleFriendAction(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const action = body.action || body.command;
  const target = body.target || body.from || body.opponent;
  const key = req.headers?.['x-operation-key'] || body.key || `social:${actor}:${action}:${target}:${Date.now()}`;

  const outcome = await accounts.social(actor, key, action, target);
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
  if (!query || query.trim().length === 0) {
    return sendJson(res, 200, []);
  }

  const results = await accounts.search(actor, query);
  return sendJson(res, 200, results);
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

  return false;
}

module.exports = {
  getProfile,
  getFriends,
  handleFriendAction,
  searchProfiles,
  handleSocialRoute,
};
