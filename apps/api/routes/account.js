'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  parseCookies,
  sendJson,
  resolveAuth,
} = require('./helpers');
const {
  defaultReadCache,
  CACHE_CONTROL_POLICIES,
} = require(path.join(__dirname, '../../../packages/services/read-cache.js'));

/**
 * GET /api/account/profile
 * Returns caller profile (tag, username, displayName, avatar, statsVisibility, presenceVisibility).
 */
async function getProfile(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const profile = await accounts.self(actor);
  return sendJson(res, 200, {
    id: profile.id,
    tag: profile.tag,
    friendCode: profile.friendCode || profile.tag,
    username: profile.username,
    displayName: profile.displayName || profile.name,
    name: profile.name || profile.displayName,
    avatar: profile.avatar,
    statsVisibility: profile.statsVisibility,
    presenceVisibility: profile.presenceVisibility,
    rating: profile.rating,
    games: profile.games,
    tier: profile.tier,
    season: profile.season,
    relation: profile.relation,
    stats: profile.stats,
    profileVersion: profile.profileVersion,
    cloudRevision: profile.cloudRevision,
    cosmeticCredits: profile.cosmeticCredits,
    wealthPublic: profile.wealthPublic,
    providers: profile.providers,
    email: profile.email,
    emailVerified: profile.emailVerified,
    walletReady: profile.walletReady,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * POST /api/account/profile
 * Updates display name, avatar, statsVisibility, presenceVisibility, or username.
 */
async function updateProfile(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const updated = await accounts.edit(actor, {
    displayName: body.displayName !== undefined ? body.displayName : body.name,
    avatar: body.avatar,
    statsVisibility: body.statsVisibility,
    presenceVisibility: body.presenceVisibility,
    username: body.username,
  });

  const readCache = context?.readCache || defaultReadCache;
  readCache.invalidate('profile.updated', { actor });

  return sendJson(res, 200, updated);
}

/**
 * GET /api/account/save
 * Returns cloud practice save { revision, practice } from profile.profile_saves.
 */
async function getSave(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const save = await accounts.restore(actor);
  return sendJson(res, 200, {
    revision: save ? save.revision : 0,
    updated: save ? save.updated : null,
    practice: save ? save.practice : null,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * POST /api/account/save
 * Saves revision and practice state, handling revisions monotonically.
 */
async function postSave(context, req, res) {
  const { actor, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const revision = typeof body.revision === 'number' ? body.revision : 0;
  const practice = body.practice;

  const result = await accounts.save(actor, revision, practice);
  const readCache = context?.readCache || defaultReadCache;
  readCache.invalidate('save.updated', { actor });

  return sendJson(res, 200, {
    revision: result.revision,
    updated: result.updated,
    practice,
  });
}

/**
 * GET/POST /api/account/export
 * Exports caller data (profile, identities, saves, wallet read-only view).
 */
async function getExport(context, req, res) {
  const { actor, token, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const exportData = await accounts.exportData(token);

  return sendJson(res, 200, {
    ...exportData,
    profile: exportData.account?.profile,
    identities: exportData.account?.identities,
    saves: exportData.account?.practiceSave,
    wallet: exportData.account?.wallet,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * POST /api/account/delete
 * Initiates deletion workflow with tag confirmation check.
 */
async function deleteAccount(context, req, res) {
  const { actor, token, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const confirmation = body.confirmation;

  const result = await accounts.deleteAccount(token, confirmation);

  return sendJson(res, 200, {
    deleted: true,
    status: 'pending',
    receiptId: result.receiptId,
    tombstone: result.tombstone,
    policyVersion: result.policyVersion,
    actorHash: result.actorHash,
  });
}

/**
 * POST /api/account/unlink
 * Unlinks specified provider credential (rejects last auth method).
 */
async function unlinkProvider(context, req, res) {
  const { actor, token, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const body = await parseJsonBody(req);
  const provider = body.provider;

  const result = await accounts.unlink(token, provider);

  return sendJson(res, 200, result);
}

/**
 * GET /api/account/deletion
 * Returns deletion availability and policy status.
 */
async function getDeletionStatus(context, req, res) {
  const { actor, token, accounts } = await resolveAuth(context, req);
  if (!actor) {
    const err = new Error('AUTH_REQUIRED');
    err.status = 401;
    throw err;
  }

  const status = await accounts.deletionStatus(token);

  return sendJson(res, 200, status, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

async function logout(context, req, res) {
  const { token, accounts, credentialMode } = await resolveAuth(context, req, { linked: false });
  if (!token) {
    const error = new Error('AUTH_REQUIRED');
    error.status = 401;
    throw error;
  }
  if (credentialMode === 'cookie') {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) {
      const error = new Error('ORIGIN_OR_CONTENT_TYPE');
      error.status = 403;
      throw error;
    }
    await accounts.csrf(token, req.headers?.['x-csrf-token']);
  }
  const body = await parseJsonBody(req);
  const result = await accounts.logout(token, body.allDevices === true);
  const headers = { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE };
  if (credentialMode === 'cookie') {
    const cookies = parseCookies(req.headers?.cookie);
    headers['Set-Cookie'] = ['__Host-mega_session', 'mega_dev_session', 'session', 'token']
      .filter((name) => cookies[name])
      .map((name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${name === 'mega_dev_session' ? '' : '; Secure'}`);
  }
  return sendJson(res, 200, result, headers);
}

/**
 * Dispatches account routes based on method and pathname.
 * Returns true if handled, false otherwise.
 */
async function handleAccountRoute(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const method = req.method;

  if ((pathname === '/api/account/logout' || pathname === '/auth/logout') && method === 'POST') {
    await logout(context, req, res);
    return true;
  }

  if (pathname === '/api/account/profile') {
    if (method === 'GET') {
      await getProfile(context, req, res);
      return true;
    }
    if (method === 'POST') {
      await updateProfile(context, req, res);
      return true;
    }
  }

  if (pathname === '/api/account/save') {
    if (method === 'GET') {
      await getSave(context, req, res);
      return true;
    }
    if (method === 'POST') {
      await postSave(context, req, res);
      return true;
    }
  }

  if (pathname === '/api/account/export') {
    if (method === 'GET' || method === 'POST') {
      await getExport(context, req, res);
      return true;
    }
  }

  if (pathname === '/api/account/delete' && method === 'POST') {
    await deleteAccount(context, req, res);
    return true;
  }

  if (pathname === '/api/account/unlink' && method === 'POST') {
    await unlinkProvider(context, req, res);
    return true;
  }

  if (pathname === '/api/account/deletion' && method === 'GET') {
    await getDeletionStatus(context, req, res);
    return true;
  }

  return false;
}

module.exports = {
  getProfile,
  updateProfile,
  getSave,
  postSave,
  getExport,
  deleteAccount,
  unlinkProvider,
  getDeletionStatus,
  logout,
  handleAccountRoute,
};
