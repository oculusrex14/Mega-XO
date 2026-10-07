/* Versioned HTTP route contract manifest.
 *
 * Machine-readable form of docs/v5/ROUTE-AND-DATA-INVENTORY.md for the mounts owned by
 * this package's routers. Every entry was read from the current source; `surface`
 * preserves the inventory's mounted / standalone / test-only / LAN / private
 * distinction and MUST NOT be collapsed into "the API".
 *
 * Consumed by contract tests (coverage enumeration) and by future adapters (Vercel
 * facade, Core command intake) that must preserve the same method, auth, CSRF,
 * idempotency and cache semantics. It defines no new route and starts no server.
 */
'use strict';

const CONTRACT_VERSION = 'api/v1';
const CACHE_NO_STORE = 'no-store';

/* auth classes, matching the source inventory's G/S/L/V/B/P shorthand */
const AUTH = Object.freeze({
 PUBLIC: 'public',
 SESSION: 'session',
 LINKED: 'linked',
 VERIFIED_PROVIDER: 'verified-provider',
 LAN_BEARER: 'lan-bearer',
 OPERATOR: 'operator'
});
/* origin enforcement actually present on each mount */
const ORIGIN = Object.freeze({ STRICT: 'strict', IF_PRESENT: 'if-present', NONE: 'none' });
/* idempotency handling of the durable operation key */
const KEY = Object.freeze({ REQUIRED: 'required', PASSTHROUGH: 'passthrough-to-store', NONE: 'none' });
const SURFACE = Object.freeze({ MOUNTED: 'mounted', STANDALONE: 'standalone-library', TEST_ONLY: 'test-only', LAN: 'lan-executable', PRIVATE: 'private-operator' });

const route = (id, method, path, extra = {}) => Object.freeze({
 id, method, path, version: CONTRACT_VERSION, cache: CACHE_NO_STORE,
 surface: SURFACE.MOUNTED, auth: AUTH.SESSION, origin: ORIGIN.STRICT, csrf: false,
 key: KEY.NONE, bodyLimit: 0, owner: 'A', ...extra
});

/* --------------------------------------------------- account / social (A) */
const ACCOUNT = Object.freeze([
 route('account.session', 'GET', '/api/account/session', { auth: AUTH.PUBLIC, csrf: false, owner: 'A', note: 'anonymous bootstrap issues a session cookie' }),
 route('account.save.read', 'GET', '/api/account/save', { auth: AUTH.LINKED }),
 route('account.sessions', 'GET', '/api/account/sessions', { auth: AUTH.LINKED }),
 route('account.deletion', 'GET', '/api/account/deletion', { auth: AUTH.LINKED }),
 route('account.email', 'POST', '/api/account/email', { csrf: true, bodyLimit: 300000, owner: 'A', note: 'production perimeter supersedes this mount with EmailAuth.dispatch' }),
 route('account.start', 'POST', '/api/account/start', { csrf: true, bodyLimit: 300000 }),
 route('account.callback', 'GET', '/auth/callback/:provider', { auth: AUTH.SESSION, csrf: false, origin: ORIGIN.NONE, owner: 'A', note: 'state/nonce/PKCE bound; no CSRF header, redirects 303' }),
 route('account.native.challenge', 'POST', '/api/account/native/challenge', { csrf: true, bodyLimit: 300000 }),
 route('account.native.finish', 'POST', '/api/account/native/finish', { csrf: true, bodyLimit: 300000 }),
 route('account.logout', 'POST', '/api/account/logout', { csrf: true, bodyLimit: 300000 }),
 route('account.sessions.revoke', 'POST', '/api/account/sessions/revoke', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('account.export', 'POST', '/api/account/export', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('account.delete', 'POST', '/api/account/delete', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('account.unlink', 'POST', '/api/account/unlink', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('account.profile', 'POST', '/api/account/profile', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('account.save.write', 'POST', '/api/account/save', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('community.friends', 'GET', '/api/community/friends', { auth: AUTH.LINKED }),
 route('community.search', 'GET', '/api/community/search', { auth: AUTH.LINKED, note: 'durable rate budget written on GET' }),
 route('community.profile', 'GET', '/api/community/profile/:id', { auth: AUTH.LINKED }),
 route('community.challenges', 'GET', '/api/community/challenges', { auth: AUTH.LINKED, owner: 'C' }),
 route('community.presence', 'POST', '/api/community/presence', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000 }),
 route('community.friend', 'POST', '/api/community/friend', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, note: 'social_operations row and state graph are one transaction' }),
 route('community.report', 'POST', '/api/community/report', { auth: AUTH.LINKED, csrf: true, bodyLimit: 300000, note: 'no operation-key dedupe; same-day open-report dedupe instead' })
]);

/* -------------------------------------------- competitive / economic (C) */
const COMPETITIVE = Object.freeze([
 route('v1.profile', 'GET', '/api/v1/profile', { auth: AUTH.LINKED, owner: 'C' }),
 route('v1.leaderboard', 'GET', '/api/v1/leaderboard', { auth: AUTH.LINKED, owner: 'C' }),
 route('v1.invitations', 'GET', '/api/v1/invitations', { auth: AUTH.LINKED, owner: 'C' }),
 route('v1.weekly', 'GET', '/api/v1/weekly', { auth: AUTH.LINKED, owner: 'C' }),
 route('v1.match', 'GET', '/api/v1/match/:id', { auth: AUTH.LINKED, owner: 'C', note: 'may persist expire/timeout settlement' }),
 route('v1.queue.status', 'GET', '/api/v1/queue', { auth: AUTH.LINKED, owner: 'C', note: 'sweeps queue and may commit paired offers' }),
 route('v1.queue.join', 'POST', '/api/v1/queue', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C', note: 'ephemeral ticket key in the queue process Map' }),
 route('v1.cancel-queue', 'POST', '/api/v1/cancel-queue', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.friend', 'POST', '/api/v1/friend', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'A', note: 'compatibility alias of community.friend' }),
 route('v1.accept-friend', 'POST', '/api/v1/accept-friend', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'A' }),
 route('v1.offer', 'POST', '/api/v1/offer', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.accept', 'POST', '/api/v1/accept', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.decline', 'POST', '/api/v1/decline', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.cancel', 'POST', '/api/v1/cancel', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.move', 'POST', '/api/v1/move', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.resign', 'POST', '/api/v1/resign', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.convert', 'POST', '/api/v1/convert', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.quest', 'POST', '/api/v1/quest', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.preferences', 'POST', '/api/v1/preferences', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C' }),
 route('v1.cosmetic', 'POST', '/api/v1/cosmetic', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 300000, owner: 'C', note: 'archived product path; production returns 404 before routing' })
]);

/* ------------------------------------------- monetization / provider (C/W) */
const MONETIZATION = Object.freeze([
 route('monetization.status', 'GET', '/api/monetization/status', { auth: AUTH.LINKED, owner: 'C', note: 'may lazily insert a permanent store binding' }),
 route('monetization.claim', 'POST', '/api/monetization/claim', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C' }),
 route('monetization.purchase', 'POST', '/api/monetization/purchase', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C' }),
 route('monetization.restore', 'POST', '/api/monetization/restore', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C' }),
 route('monetization.reward-ticket', 'POST', '/api/monetization/reward-ticket', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C' }),
 route('monetization.interstitial-permit', 'POST', '/api/monetization/interstitial-permit', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C' }),
 route('v1.purchase', 'POST', '/api/v1/purchase', { auth: AUTH.LINKED, csrf: true, key: KEY.REQUIRED, bodyLimit: 16384, owner: 'C', note: 'community fallback is SHADOWED by the earlier monetization mount' }),
 route('monetization.admob-ssv', 'GET', '/api/monetization/admob-ssv', { auth: AUTH.VERIFIED_PROVIDER, origin: ORIGIN.NONE, owner: 'C', note: 'economic GET; signed query is the credential' }),
 route('monetization.google-play-rtdn', 'POST', '/api/monetization/google-play-rtdn', { auth: AUTH.VERIFIED_PROVIDER, origin: ORIGIN.NONE, bodyLimit: 131072, owner: 'W', note: 'push authorization header is the credential' }),
 route('monetization.apple-notifications', 'POST', '/api/monetization/apple-notifications', { auth: AUTH.VERIFIED_PROVIDER, origin: ORIGIN.NONE, bodyLimit: 131072, owner: 'W', note: 'signed JWS body is the credential' })
]);

/* ------------------------------------------------------------ party (C/local) */
const PARTY = Object.freeze([
 route('party.capabilities', 'GET', '/api/party/capabilities', { auth: AUTH.PUBLIC, origin: ORIGIN.IF_PRESENT, owner: 'C' }),
 route('party.session', 'POST', '/api/party/session', { surface: SURFACE.LAN, auth: AUTH.LAN_BEARER, origin: ORIGIN.IF_PRESENT, csrf: false, bodyLimit: 16384, owner: 'E', note: 'free LAN guest only; online mount rejects with AUTH_REQUIRED' }),
 route('party.me', 'GET', '/api/party/me', { auth: AUTH.LAN_BEARER, origin: ORIGIN.IF_PRESENT, owner: 'A' }),
 route('party.room', 'GET', '/api/party/rooms/:id', { auth: AUTH.LAN_BEARER, origin: ORIGIN.IF_PRESENT, owner: 'C', note: 'view only; does not tick or settle' }),
 route('party.command', 'POST', '/api/party/command', { auth: AUTH.LAN_BEARER, origin: ORIGIN.IF_PRESENT, key: KEY.PASSTHROUGH, bodyLimit: 16384, owner: 'C', note: 'online mount additionally enforces account CSRF before routing' })
]);

/* ------------------------------- standalone adapter routes (library/fixture) */
/* server/http.js strips an optional /api/v1 prefix, so these are NOT extra mounted
 * endpoints. They are also reachable through the community mount for the prefixed
 * paths listed above. Kept separate so no invented public alias is created. */
const STANDALONE = Object.freeze([
 route('standalone.profile', 'GET', '/profile', { surface: SURFACE.STANDALONE }),
 route('standalone.leaderboard', 'GET', '/leaderboard', { surface: SURFACE.STANDALONE }),
 route('standalone.invitations', 'GET', '/invitations', { surface: SURFACE.STANDALONE }),
 route('standalone.queue.status', 'GET', '/queue', { surface: SURFACE.STANDALONE }),
 route('standalone.match', 'GET', '/match/:id', { surface: SURFACE.STANDALONE }),
 route('standalone.weekly', 'GET', '/weekly', { surface: SURFACE.STANDALONE }),
 route('standalone.purchase', 'POST', '/purchase', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, bodyLimit: 32768, owner: 'C' }),
 route('standalone.convert', 'POST', '/convert', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.quest', 'POST', '/quest', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.friend', 'POST', '/friend', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.accept-friend', 'POST', '/accept-friend', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.preferences', 'POST', '/preferences', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.cosmetic', 'POST', '/cosmetic', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.offer', 'POST', '/offer', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.accept', 'POST', '/accept', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.decline', 'POST', '/decline', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.cancel', 'POST', '/cancel', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.move', 'POST', '/move', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.resign', 'POST', '/resign', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.queue.join', 'POST', '/queue', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' }),
 route('standalone.cancel-queue', 'POST', '/cancel-queue', { surface: SURFACE.STANDALONE, csrf: false, origin: ORIGIN.IF_PRESENT, key: KEY.REQUIRED, bodyLimit: 32768, owner: 'C' })
]);

const ROUTES = Object.freeze([...ACCOUNT, ...COMPETITIVE, ...MONETIZATION, ...PARTY, ...STANDALONE]);

function routeById(id) {
 return ROUTES.find(entry => entry.id === id) || null;
}
function routesForOwner(owner) {
 return ROUTES.filter(entry => entry.owner === owner);
}
function routesForSurface(surface) {
 return ROUTES.filter(entry => entry.surface === surface);
}
/* Compatibility gate: a path+method pair may only be treated as the frozen contract for
 * that route id. Used by adapters that must not silently rename or re-version a route. */
function routeMatches(id, method, path) {
 const entry = routeById(id);
 if (!entry) return false;
 if (entry.method !== String(method || '').toUpperCase()) return false;
 const expected = entry.path;
 if (expected.includes('/:id')) return path.startsWith(expected.slice(0, expected.indexOf('/:id')) + '/');
 return path === expected;
}

module.exports = { CONTRACT_VERSION, CACHE_NO_STORE, AUTH, ORIGIN, KEY, SURFACE, ROUTES, ACCOUNT, COMPETITIVE, MONETIZATION, PARTY, STANDALONE, routeById, routesForOwner, routesForSurface, routeMatches };
