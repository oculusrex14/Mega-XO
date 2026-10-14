'use strict';

const path = require('node:path');
const {
  parseJsonBody,
  parseCookies,
  sendJson,
  resolveAuth,
  resolveService,
  resolveAccess,
} = require('./helpers');
const {
  defaultReadCache,
  CACHE_CONTROL_POLICIES,
} = require(path.join(__dirname, '../../../packages/services/read-cache.js'));
const { ACCESS_TTL_SECONDS } = require(path.join(__dirname, '../../../packages/services/access.js'));
const { createRefreshService } = require(path.join(__dirname, '../../../packages/services/refresh.js'));
const { validateChallengeRequest, validateFinishRequest } = require(path.join(__dirname, '../../../packages/contracts/native-bridge.js'));
const { validateNativeTokenGrant } = require(path.join(__dirname, '../../../packages/contracts/access-dto.js'));

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

/* ============================================================================================
 * COOKIE-FREE NATIVE SESSION FAMILY (contract: packages/contracts/routes.js lines 55-61)
 *
 * Five routes are DECLARED by the frozen contract. They compose the EXISTING accounts/access/
 * refresh services: no policy, cap, session rule or token format is re-implemented here.
 *
 * The property that separates this family from the browser surface: NO response ever sets a
 * Set-Cookie header. The credential lives in the platform secure store (Android Keystore /
 * iOS Keychain) and travels as `Authorization: Bearer <access token>`; the three bearer routes
 * never consume a cookie as a credential (they only refuse a cookie+bearer PAIR, per design
 * B4.2, because guessing between two credentials is what AMBIGUOUS_CREDENTIAL forbids).
 *
 * Body limits are the contract's exact numbers and are ENFORCED by refusing, never truncating.
 * ============================================================================================ */
const NATIVE_BODY_LIMITS = Object.freeze({
  challenge: 300000,
  finish: 300000,
  token: 300000,
  refresh: 16384,
  logout: 16384,
});
/* Client-class audience -> the platform recorded against a bound device. Both keys are the
 * access service's own `playerAudiences` allowlist entries, not a new vocabulary. */
const NATIVE_PLATFORMS = Object.freeze({ 'mega-ios': 'ios', 'mega-android': 'android' });
const NATIVE_AUDIENCES = Object.freeze(['mega-ios', 'mega-android']);
/* Terminal for the client: it wipes its secure store on any of these, so they answer 401 rather
 * than the generic 409. The durable service codes are preserved verbatim. */
const NATIVE_TERMINAL_CODES = Object.freeze(['SESSION_REVOKED', 'REFRESH_EXPIRED', 'INVALID_REFRESH']);

function authRequired() {
  const error = new Error('AUTH_REQUIRED');
  error.status = 401;
  return error;
}

function nativeBearer(req) {
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !/^Bearer /i.test(authorization)) return null;
  const value = authorization.slice(7).trim();
  return value || null;
}

/* Design B4.2 / access-dto.refuseAmbiguousCredential: a request presenting BOTH a session cookie
 * and a bearer header is REFUSED rather than guessed. The API ingress applies this too; the mount
 * applies it again so a directly-invoked route cannot bypass it. */
function refuseNativeAmbiguity(req) {
  const cookie = req.headers?.cookie || null;
  const bearer = req.headers?.authorization || null;
  if (cookie && bearer) {
    const error = new Error('AMBIGUOUS_CREDENTIAL');
    error.status = 401;
    throw error;
  }
}

/* The declared `csrf: true` on challenge/finish, enforced exactly as /api/account/logout does it:
 * only a COOKIE credential carries a CSRF risk, so only a cookie-authenticated request must prove
 * its token. A bearer request has no cookie to protect (the ingress already checked Origin). */
async function enforceNativeCsrf(accounts, token, req) {
  if (!token) return;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) {
    const error = new Error('ORIGIN_OR_CONTENT_TYPE');
    error.status = 403;
    throw error;
  }
  await accounts.csrf(token, req.headers?.['x-csrf-token']);
}

/* Reads a body with the route's EXACT ceiling, and NEVER truncates.
 *
 *   - a platform pre-parsed body defers to the shared parseJsonBody (which measures it);
 *   - a declared Content-Length over the ceiling is refused BEFORE a byte is buffered (the request
 *     is drained, never destroyed, so the 413 can actually be written);
 *   - an undeclared-length (chunked) stream is bounded by the reader below, which stops
 *     accumulating at the ceiling, drains the remainder and rejects, so the refusal is still a real
 *     413 answer instead of a dropped connection.
 *
 * The refusal always precedes JSON parsing: an oversize body that is not even valid JSON must be
 * BODY_TOO_LARGE, never an INVALID_JSON from a truncated parse.
 */
function readNativeBody(req, limit) {
  if (req.body !== undefined && req.body !== null) return parseJsonBody(req, limit);
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    if (typeof req.resume === 'function') req.resume();
    const error = new Error('BODY_TOO_LARGE');
    error.status = 413;
    throw error;
  }
  return readNativeStream(req, limit);
}

function readNativeStream(req, limit) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const refuse = (code, status) => {
      settled = true;
      cleanup();
      if (typeof req.resume === 'function') req.resume();
      const error = new Error(code);
      error.status = status;
      reject(error);
    };
    const onData = (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        refuse('BODY_TOO_LARGE', 413);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('INVALID_JSON');
        error.status = 409;
        reject(error);
      }
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/* P05 signing/rotation services. The API runtime owns the P05 configuration: no issuer, key file
 * or audience fallback is ever inferred from client input (same rule as routes/helpers.js). */
async function resolveNativeAccess(context) {
  return resolveAccess(context);
}

async function resolveNativeRefresh(context) {
  if (context?.refresh && typeof context.refresh.rotate === 'function') return context.refresh;
  if (!context?.pool || typeof context.pool.withTransaction !== 'function') return null;
  if (!context._nativeRefreshPromise) {
    context._nativeRefreshPromise = (async () => {
      const access = await resolveNativeAccess(context);
      if (!access) return null;
      const clock = typeof context.now === 'function' ? context.now : Date.now;
      return createRefreshService(context.pool, {
        now: clock,
        /* `mintAccess` is REQUIRED by the service: a rotation that returned no access token would
         * be a stub, not a rotation. */
        mintAccess: ({ actor, sessionId, generation }) => access.issue({
          actor, sessionId, generation, amr: ['pwd'], authAt: clock(), audience: nativeAudience(context),
        }),
      });
    })().catch((error) => { context._nativeRefreshPromise = null; throw error; });
  }
  return context._nativeRefreshPromise;
}

/* The native client-class audience from the deployment's own allowlist (`nativeAudiences`), never a
 * value chosen by a caller. A value outside the access service's playerAudiences fails loudly with
 * AUDIENCE_MISMATCH rather than silently minting a token no consumer accepts. */
function nativeAudience(context) {
  const chosen = context?.nativeAudience;
  if (typeof chosen === 'string' && Object.hasOwn(NATIVE_PLATFORMS, chosen)) return chosen;
  const list = Array.isArray(context?.nativeAudiences) ? context.nativeAudiences : NATIVE_AUDIENCES;
  if (list.includes('mega-android')) return 'mega-android';
  if (list.includes('mega-ios')) return 'mega-ios';
  return list[0] || 'mega-android';
}

function resolveNativeProviders(context) {
  const providers = context?.providers || context?.identityProviders || null;
  return providers && typeof providers.verify === 'function' ? providers : null;
}

/* The provider verifier is deployment-owned (it does the real signature/issuer/audience/nonce
 * check). Its absence is a server misconfiguration, not a caller error. */
function providerUnavailable(status) {
  const error = new Error('PROVIDER_NOT_CONFIGURED');
  error.status = status;
  return error;
}

function nativeSessionUnavailable() {
  const error = new Error('NATIVE_SESSION_UNAVAILABLE');
  error.status = 503;
  return error;
}

/* Verify ONE provider ID token for the attempt's nonce. The capability gate keeps V4 parity: an
 * unconfigured provider answers PROVIDER_NOT_CONFIGURED without any network work. A provider's own
 * verification failure is preserved (it discloses nothing about account state). */
async function verifyNativeIdentity(providers, provider, idToken, nonce) {
  if (!providers) throw providerUnavailable(503);
  if (typeof providers.capabilities === 'function' && !providers.capabilities()?.[provider]?.native) {
    throw providerUnavailable(409);
  }
  return providers.verify(provider, idToken, nonce, 'native');
}

/* The frozen native session response the shipped Android/iOS hosts parse:
 * {accessToken, refreshToken, expiresIn, actorId}. NEVER a cookie. */
function sendNativeSession(res, { accessToken, refreshToken, actorId }) {
  return sendJson(res, 200, {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    actorId,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/* One durable single-flight rotation, shared by /native/token's refresh branch and /native/refresh.
 * The durable family state is the only authority, so a concurrent second rotation of the same
 * presented token cannot mint a second live family: it either recovers the ONE committed successor
 * inside the bounded retry window or revokes the family as a replay. */
async function performNativeRotation(context, refreshSecret) {
  const refresh = await resolveNativeRefresh(context);
  const access = await resolveNativeAccess(context);
  if (!refresh || !access) throw nativeSessionUnavailable();
  let outcome;
  try {
    outcome = await refresh.rotate({ refreshSecret });
  } catch (error) {
    if (error && NATIVE_TERMINAL_CODES.includes(error.message)) error.status = 401;
    throw error;
  }
  const claims = await access.verify(outcome.accessToken, { audience: nativeAudience(context) });
  return { accessToken: outcome.accessToken, refreshToken: outcome.refreshSecret, actorId: claims.sub };
}

/* The session bearer a provider-finish leg must present to bind the attempt. Order: an explicit
 * Authorization credential (raw session bearer, or a signed access token which is resolved to the
 * session it proves), then the browser cookie, then the `sessionToken` the challenge returned to a
 * credential-less caller. A null result is AUTH_REQUIRED, never a guess. */
async function resolveNativeSessionBinding(context, req, accounts, body) {
  const bearer = nativeBearer(req);
  if (bearer) {
    if (!bearer.includes('.')) return bearer;
    const access = await resolveNativeAccess(context);
    if (!access) throw nativeSessionUnavailable();
    return accounts.authenticateNative(bearer, {
      access, nativeAudiences: context?.nativeAudiences || NATIVE_AUDIENCES,
    });
  }
  const cookie = bearerFromCookies(req);
  if (cookie) return cookie;
  if (typeof body?.sessionToken === 'string' && body.sessionToken) return body.sessionToken;
  return null;
}

/* Provider grant: consume the one-use attempt, verify the ID token for its nonce and the native
 * audience, and rotate the session. Shared by /native/finish and /native/token. */
async function completeNativeProviderGrant(context, accounts, binding, grant) {
  const attempt = await accounts.consume(binding, grant.state, grant.provider, 'native');
  const identity = await verifyNativeIdentity(resolveNativeProviders(context), grant.provider, grant.idToken, attempt.nonce);
  return accounts.finishVerified(binding, attempt, identity);
}

/**
 * POST /api/account/native/challenge (contract: csrf: true, bodyLimit 300000)
 *
 * Begins a native sign-in: stores a provider attempt (state/nonce/verifier, one-use, 5-minute
 * bounded) bound to a durable session. A first-ever native sign-in presents neither a cookie nor a
 * bearer, so the route bootstraps the anonymous session the attempt must hang off and returns its
 * bearer IN THE BODY as `sessionToken` -- never as a cookie -- for the follow-up leg.
 * Response: {state, nonce, expires} plus `sessionToken` only on that credential-less path.
 */
async function postNativeChallenge(context, req, res) {
  refuseNativeAmbiguity(req);
  const accounts = await resolveService(context);
  const body = await readNativeBody(req, NATIVE_BODY_LIMITS.challenge);
  const input = validateChallengeRequest(body);
  const providers = resolveNativeProviders(context);
  if (typeof providers?.capabilities === 'function' && !providers.capabilities()?.[input.provider]?.native) {
    throw providerUnavailable(409);
  }
  const bearer = nativeBearer(req);
  const cookie = bearerFromCookies(req);
  if (cookie) await enforceNativeCsrf(accounts, cookie, req);
  let token = bearer || cookie || null;
  let sessionToken = null;
  if (!token) {
    const bootstrap = await accounts.bootstrap(null);
    token = bootstrap.token;
    sessionToken = bootstrap.token;
  }
  const attempt = await accounts.start(token, input.provider, input.intent, 'native');
  const payload = { state: attempt.state, nonce: attempt.nonce, expires: attempt.expires };
  if (sessionToken) payload.sessionToken = sessionToken;
  return sendJson(res, 200, payload, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * POST /api/account/native/finish (contract: csrf: true, bodyLimit 300000)
 *
 * The provider bridge's second half (the shipped WebView path calls challenge then finish). It
 * consumes the one-use attempt, verifies the ID token for that exact nonce, and rotates the
 * session. The rotated bearer is returned IN THE BODY (`sessionToken`) because this family never
 * sets a cookie; `linked`, `csrf`, `profile` and `created` are the V4 compatibility surface.
 */
async function postNativeFinish(context, req, res) {
  refuseNativeAmbiguity(req);
  const accounts = await resolveService(context);
  const body = await readNativeBody(req, NATIVE_BODY_LIMITS.finish);
  const input = validateFinishRequest(body);
  const cookie = bearerFromCookies(req);
  if (cookie && !nativeBearer(req)) await enforceNativeCsrf(accounts, cookie, req);
  const binding = await resolveNativeSessionBinding(context, req, accounts, body);
  if (!binding) throw authRequired();
  const logged = await completeNativeProviderGrant(context, accounts, binding, {
    provider: input.provider, state: input.state, idToken: input.idToken,
  });
  return sendJson(res, 200, {
    linked: true,
    csrf: logged.csrf,
    profile: logged.profile,
    created: logged.created,
    actorId: logged.actor,
    sessionToken: logged.token,
  }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
}

/**
 * POST /api/account/native/token (contract: auth BEARER, origin NONE, csrf false, bodyLimit 300000)
 *
 * Exactly one grant, per packages/contracts/access-dto.js validateNativeTokenGrant:
 *   {provider, state, idToken}                        -> provider grant (the finish request itself)
 *   {grant:'refresh_token', refreshToken, deviceId?}  -> refresh grant
 * The provider branch verifies the provider and then mints the cookie-free credential pair (an
 * `access` token plus a `refresh` family). A request presenting BOTH a cookie and a bearer is
 * refused with AMBIGUOUS_CREDENTIAL.
 */
async function postNativeToken(context, req, res) {
  refuseNativeAmbiguity(req);
  const body = await readNativeBody(req, NATIVE_BODY_LIMITS.token);
  const grant = validateNativeTokenGrant(body);
  if (grant.kind === 'refresh') return sendNativeSession(res, await performNativeRotation(context, grant.refreshToken));

  const accounts = await resolveService(context);
  const binding = await resolveNativeSessionBinding(context, req, accounts, body);
  if (!binding) throw authRequired();
  const logged = await completeNativeProviderGrant(context, accounts, binding, {
    provider: grant.provider, state: grant.state, idToken: grant.idToken,
  });
  const access = await resolveNativeAccess(context);
  const refresh = await resolveNativeRefresh(context);
  if (!access || !refresh) throw nativeSessionUnavailable();
  const bound = await accounts.accessBinding(logged.token);
  const family = await refresh.startFamily({ actor: bound.actor, sessionId: bound.sessionId, deviceId: null });
  const session = await accounts.session(logged.token);
  const accessToken = await access.issue({
    actor: bound.actor,
    sessionId: bound.sessionId,
    generation: bound.generation,
    amr: [grant.provider],
    authAt: session ? session.authAt : Date.now(),
    audience: nativeAudience(context),
  });
  return sendNativeSession(res, { accessToken, refreshToken: family.refreshSecret, actorId: bound.actor });
}

/**
 * POST /api/account/native/refresh (contract: auth BEARER, origin NONE, csrf false, bodyLimit 16384)
 *
 * Single-flight family rotation: rotates the access AND the refresh credential together. The
 * refresh secret in the body IS the credential (an expired access token is deliberately not
 * presented by the shipped hosts).
 */
async function postNativeRefresh(context, req, res) {
  refuseNativeAmbiguity(req);
  const body = await readNativeBody(req, NATIVE_BODY_LIMITS.refresh);
  const grant = validateNativeTokenGrant(body);
  if (grant.kind !== 'refresh') {
    const error = new Error('INVALID_AUTH_REQUEST');
    error.status = 409;
    throw error;
  }
  return sendNativeSession(res, await performNativeRotation(context, grant.refreshToken));
}

/**
 * POST /api/account/native/logout (contract: auth BEARER, origin NONE, csrf false, bodyLimit 16384)
 *
 * Revokes the presenting family and consumes the presenting session; `{allDevices:true}` ends
 * every session and family of the actor. No cookie is ever set. Order matters: the native session
 * projection requires the family to still be ACTIVE, so the session is consumed first and the
 * family revoked last.
 */
async function postNativeLogout(context, req, res) {
  refuseNativeAmbiguity(req);
  const accounts = await resolveService(context);
  const body = await readNativeBody(req, NATIVE_BODY_LIMITS.logout);
  const bearer = nativeBearer(req);
  if (!bearer) throw authRequired();
  const access = await resolveNativeAccess(context);
  if (!access) throw nativeSessionUnavailable();
  const credential = await accounts.authenticateNative(bearer, {
    access, nativeAudiences: context?.nativeAudiences || NATIVE_AUDIENCES,
  });
  const bound = await accounts.accessBinding(credential);
  const allDevices = body.allDevices === true;
  await accounts.logout(credential, allDevices);
  const refresh = await resolveNativeRefresh(context);
  if (refresh) {
    if (allDevices) await refresh.revokeForActor(bound.actor, 'logout');
    else await refresh.revokeForSession(bound.sessionId);
  }
  return sendJson(res, 200, { signedOut: true }, { 'Cache-Control': CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE });
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

  /* Cookie-free native session family (contract lines 55-61). Ordered before the generic
   * /api/account/native/* paths; each is POST-only and never sets a cookie. */
  if (pathname === '/api/account/native/challenge' && method === 'POST') {
    await postNativeChallenge(context, req, res);
    return true;
  }

  if (pathname === '/api/account/native/finish' && method === 'POST') {
    await postNativeFinish(context, req, res);
    return true;
  }

  if (pathname === '/api/account/native/token' && method === 'POST') {
    await postNativeToken(context, req, res);
    return true;
  }

  if (pathname === '/api/account/native/refresh' && method === 'POST') {
    await postNativeRefresh(context, req, res);
    return true;
  }

  if (pathname === '/api/account/native/logout' && method === 'POST') {
    await postNativeLogout(context, req, res);
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
  postNativeChallenge,
  postNativeFinish,
  postNativeToken,
  postNativeRefresh,
  postNativeLogout,
  NATIVE_BODY_LIMITS,
  handleAccountRoute,
};
