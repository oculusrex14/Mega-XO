'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  parseCookies,
  sendJson,
  resolveAuth,
  resolveService,
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

const SESSION_COOKIE_NAMES = ['__Host-mega_session', 'mega_dev_session', 'session', 'token'];

function bearerFromCookies(req) {
  const cookies = parseCookies(req.headers?.cookie);
  for (const name of SESSION_COOKIE_NAMES) if (cookies[name]) return cookies[name];
  return null;
}

/**
 * Sets the anonymous/refreshed session cookie pair. `__Host-` requires Secure and no Domain, so it is
 * only usable over HTTPS; `mega_dev_session` carries the same token for the http staging origin.
 */
function sessionCookieHeaders(token) {
  return [
    `__Host-mega_session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure`,
    `mega_dev_session=${token}; Path=/; HttpOnly; SameSite=Lax`,
  ];
}

/**
 * Strips OTP delivery material from any service result before it can reach a caller. The delivery
 * (recipient + one-time code) is for the mail worker; it is NEVER an HTTP field. A staging-only
 * `context.otpSink` may observe it out of band.
 */
async function dispatchDelivery(context, result) {
  if (!result || typeof result !== 'object' || !result.delivery) return result;
  const { delivery, ...rest } = result;
  if (typeof context?.otpSink === 'function') {
    try { await context.otpSink(Object.freeze({ ...delivery, challengeId: rest.challengeId || null })); } catch { /* a sink failure must never alter the auth response */ }
  }
  return rest;
}

/**
 * GET /api/account/session
 * Anonymous bootstrap: issues a session cookie for a caller without one, otherwise returns the
 * caller's own session facts (linked state, CSRF token, linked providers). `auth: PUBLIC` per the
 * route contract - this is the ONLY place a browser session is minted from an unknown caller.
 */
async function getSession(context, req, res) {
  const accounts = await resolveService(context);
  const bootstrap = await accounts.bootstrap(bearerFromCookies(req));
  const headers = { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE };
  if (bootstrap.token) headers['Set-Cookie'] = sessionCookieHeaders(bootstrap.token);
  const providers = {};
  if (bootstrap.actor) {
    for (const identity of await accounts.identities(bootstrap.actor)) {
      providers[identity.provider] = Object.freeze({ web: true, linked: true });
    }
  }
  return sendJson(res, 200, {
    linked: Boolean(bootstrap.actor),
    actorId: bootstrap.actor || null,
    csrf: bootstrap.csrf,
    expires: bootstrap.expires,
    providers,
  }, headers);
}

/**
 * POST /api/account/email
 * Single email/password entry point matching the shipped client: `continue` (sign in / sign up),
 * `verify` (submit a one-time code), `forgot` (start reset), `reset` (complete reset), `reauth`
 * (recent-auth for a linked caller) and `change` (start an email change). Every action runs on the
 * V5 PostgreSQL account service; nothing here reads a V4 store or forges a session.
 */
async function postEmail(context, req, res) {
  const accounts = await resolveService(context);
  const bootstrap = await accounts.bootstrap(bearerFromCookies(req));
  const token = bootstrap.token || bearerFromCookies(req);
  const headers = { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE };
  if (bootstrap.token) headers['Set-Cookie'] = sessionCookieHeaders(bootstrap.token);
  const body = await parseJsonBody(req, 300 * 1024);
  const action = body.action;
  let result;
  if (action === 'continue') result = await accounts.emailContinue(token, body.email, body.password);
  else if (action === 'verify') result = await accounts.emailVerify(token, body.challengeId, body.code);
  else if (action === 'forgot') result = await accounts.emailResetStart(token, body.email);
  else if (action === 'reset') result = await accounts.emailResetComplete(token, body.challengeId, body.password);
  else if (action === 'reauth') result = await accounts.emailReauth(token, body.email, body.password);
  else if (action === 'change') result = await accounts.emailChangeStart(token, body.newEmail || body.email);
  else {
    const error = new Error('INVALID_OPERATION');
    error.status = 409;
    throw error;
  }
  result = await dispatchDelivery(context, result);
  if (action === 'forgot') {
    // Never disclose whether the address exists. The challenge id is returned so a subsequent
    // `verify` can be attempted; a nonexistent address simply never verifies.
    return sendJson(res, 200, { challengeId: result.challengeId, message: 'If this email has an account, a recovery code has been sent.' }, headers);
  }
  if (result && typeof result === 'object' && typeof result.token === 'string') {
    headers['Set-Cookie'] = sessionCookieHeaders(result.token);
    const { token: issued, ...publicResult } = result;
    // A result carrying a freshly issued token AND a durable actor IS a linked sign-in; expose the
    // boolean the shared client keys on (`if (result.linked)`) and a stable actor id. Never invented:
    // both derive from the service's own session row, not from client input.
    const linked = typeof publicResult.actor === 'string' && publicResult.actor.length > 0;
    return sendJson(res, 200, { ...publicResult, linked, actorId: publicResult.actor || null }, headers);
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

  if (pathname === '/api/account/session' && method === 'GET') {
    await getSession(context, req, res);
    return true;
  }

  if (pathname === '/api/account/email' && method === 'POST') {
    await postEmail(context, req, res);
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
  getSession,
  postEmail,
  handleAccountRoute,
};
