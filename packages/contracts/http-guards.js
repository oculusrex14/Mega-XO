/* Shared body/key/principal/request guards extracted from the mounted legacy routers.
 *
 * Every helper reproduces one exact existing expression, including its error code and
 * its leniency. The routers keep owning HTTP status mapping, response shapes and
 * precedence; only the reusable decision is shared so a future adapter cannot drift
 * from the shipped client contract.
 */
'use strict';
const { fail } = require('./errors.js');

const SCOPE_PLAYER = 'player';

/* ---------------------------------------------------------------- identifiers */

// community-http.js:7 - durable operation key for account/social/party mutations. The v35
// economic key grammar (monetization-store.js:6) is character-for-character identical, so a
// single definition serves both the legacy routers and the future Core command intake.
const OPERATION_KEY = /^[A-Za-z0-9:_-]{1,160}$/;
// src/domain.js:87, src/authority.js:7 - durable operation/actor identifier grammar.
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;

const isOperationKey = value => typeof value === 'string' && OPERATION_KEY.test(value);
const isOperationId = value => typeof value === 'string' && OPERATION_ID.test(value);
const isBoardCell = value => Number.isInteger(value) && value >= 0 && value <= 8;

/* --------------------------------------------------------------- header reads */

const header = (req, name) => {
 const value = req?.headers?.[name];
 return typeof value === 'string' ? value : '';
};

const isJsonContentType = req => String(req?.headers?.['content-type'] || '').startsWith('application/json');
/* Some mounts report a specific code when the JSON content type is missing. */
function requireJson(req, code = 'ORIGIN_OR_CONTENT_TYPE') {
 if (!isJsonContentType(req)) fail(code);
}

/* community-http.js:7 - missing, non-string or malformed key both raise this code. */
function operationKey(req) {
 const value = header(req, 'idempotency-key');
 if (!isOperationKey(value)) fail('IDEMPOTENCY_KEY_REQUIRED');
 return value;
}

const MAX_RAW_KEY_LENGTH = 160;

/* party-http.js:23 passes the raw header into RoomStore.run, whose own guard
 * (rooms.js:64) is `typeof key!=='string'||!key||key.length>160 -> INVALID_COMMAND`.
 * It accepts any string up to 160 characters, including characters the community
 * operation-key grammar rejects, so only that exact guard is mirrored here. */
function rawOperationKey(req) {
 const value = req?.headers?.['idempotency-key'];
 if (typeof value !== 'string' || !value || value.length > MAX_RAW_KEY_LENGTH) fail('INVALID_COMMAND');
 return value;
}

/* http.js POST branch only requires a truthy header and passes it to DurableStore,
 * which then applies validateInvocation's own key length ceiling. Kept exact. */
function truthyOperationKey(req) {
 const value = req?.headers?.['idempotency-key'];
 if (!value) fail('IDEMPOTENCY_KEY_REQUIRED');
 return value;
}

/* ------------------------------------------------------------------- bodies */

/* community-http.js:9 - per-chunk cumulative Buffer.byteLength against the limit. */
async function readJsonBody(req, limit = 300000) {
 let text = '';
 for await (const part of req) {
  text += part;
  if (Buffer.byteLength(text) > limit) fail('BODY_TOO_LARGE');
 }
 try { return JSON.parse(text || '{}'); } catch { fail('INVALID_JSON'); }
}

/* http.js:8 - the standalone adapter counts string length, not bytes. */
async function readRawJsonBody(req, limit = 32768) {
 let text = '';
 for await (const chunk of req) {
  text += chunk;
  if (text.length > limit) fail('BODY_TOO_LARGE');
 }
 try { return JSON.parse(text || '{}'); } catch { fail('INVALID_JSON'); }
}

/* party-http.js:13,16 - unparsable JSON propagates the raw SyntaxError; the router's
 * outer catch maps it to REQUEST_REJECTED (unchanged legacy behaviour). */
async function readPartyBody(req, limit = 16384) {
 let text = '';
 for await (const part of req) {
  text += part;
  if (Buffer.byteLength(text) > limit) fail('BODY_TOO_LARGE');
 }
 return JSON.parse(text || '{}');
}

/* monetization-http.js:12/20 - identical shape expression, different public codes. */
async function readStoreNotification(req) {
 const parsed = await readJsonBody(req, 131072);
 if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('INVALID_STORE_NOTIFICATION');
 return parsed;
}
async function readCommandBody(req) {
 const parsed = await readJsonBody(req, 16384);
 if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('INVALID_COMMAND');
 return parsed;
}

/* ------------------------------------------------------------------ cookies */

/* community-http.js:10 - unchanged leniency (invalid segments are skipped). */
function cookies(req) {
 const out = {};
 for (const pair of String(req?.headers?.cookie || '').split(';')) {
  const at = pair.indexOf('=');
  if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
 }
 return out;
}
const sessionToken = (req, cookieName) => cookies(req)[cookieName];

/* ------------------------------------------------------- origin / host / CSRF */

/* community-http.js:28 POST branch - strict origin equality AND JSON content type,
 * thrown so the router's catch maps it to 409. `http.js` differs: it only compares an
 * Origin that was actually sent, and answers 403 directly. Both are kept distinct. */
function requireSameOriginJson(req, origin) {
 if (!isJsonContentType(req) || header(req, 'origin') !== origin) fail('ORIGIN_OR_CONTENT_TYPE');
}
/* Origin-only variant: community-http.js:123 `handler.guard` checks the origin before the
 * CSRF token and leaves the content-type decision to the caller/mount. */
function requireExactOrigin(req, origin) {
 if (header(req, 'origin') !== origin) fail('ORIGIN_OR_CONTENT_TYPE');
}
function hasConflictingOrigin(req, origin) {
 const provided = req?.headers?.origin;
 return !!provided && provided !== origin;
}

/* party-http.js:10 - origin is only checked when the caller sent one, and the fallback
 * expected origin is derived from Host. */
function requirePartyOrigin(req, origin) {
 const provided = req?.headers?.origin;
 if (!provided) return;
 if (provided !== (origin || 'http://' + req.headers.host)) fail('BAD_ORIGIN');
}
function requirePartyHost(req, allowedHosts) {
 if (allowedHosts && !allowedHosts.has(req?.headers?.host)) fail('BAD_HOST');
}
function requirePartyJson(req) {
 if (!isJsonContentType(req)) fail('BAD_CONTENT_TYPE');
}

/* ------------------------------------------------------- principal derivation */

/* http.js:19 / community-http.js:104 - the authenticated session identity becomes a
 * player-scope principal; actor IDs, balances and outcomes are never read from JSON. */
function sessionPrincipal(identity) {
 return identity?.id ? { actor: identity.id, scope: SCOPE_PLAYER } : null;
}

/* party-http.js:17 - the LAN store resolves a bearer guest; the online adapter resolves
 * a session identity and additionally carries the display name. */
function partyPrincipal(identity) {
 if (!identity) return null;
 if (typeof identity.actor === 'string' && identity.actor) return identity;
 return identity.id ? { actor: identity.id, scope: SCOPE_PLAYER, name: identity.name || identity.id } : null;
}

/* ------------------------------------------------------------- error surface */

/* Only a bare public code may be echoed; everything else collapses to a fallback. */
const publicCode = (message, fallback = 'REQUEST_FAILED') => (/^[A-Z][A-Z0-9_]+$/.test(message) ? message : fallback);
/* http.js:58 uses the looser /^[A-Z0-9_]+$/ filter. Preserved separately. */
const standalonePublicCode = (message, fallback = 'REQUEST_FAILED') => (/^[A-Z0-9_]+$/.test(message) ? message : fallback);

/* party-http.js:25 - the party router allowlists error prefixes rather than codes. */
const PARTY_ERROR_PREFIXES = Object.freeze(['INVALID_', 'ROOM_', 'NOT_', 'AUTH_', 'HOST_', 'FREE_', 'PAID_', 'INSUFFICIENT_', 'PLAYERS_', 'MATCH_', 'STALE_', 'TIME_', 'CANNOT_', 'EVENT_', 'INELIGIBLE', 'ALREADY_', 'COMPLETE_', 'RULES_', 'AUTOMATIC_', 'USE_', 'ACCOUNT_', 'BODY_', 'BAD_', 'RATE_', 'SESSION_', 'SKILL_', 'IDEMPOTENCY_']);
const partyPublicCode = message => (PARTY_ERROR_PREFIXES.some(prefix => message.startsWith(prefix)) ? message : 'REQUEST_REJECTED');

/* --------------------------------------------------------- status mapping */

/* Each frozen table reproduces one router's existing mapping exactly. A future adapter
 * must pick the table belonging to the surface it replaces; they are deliberately not
 * merged, because the same code maps differently on different mounts. */
/* AMBIGUOUS_CREDENTIAL is an authentication failure (design B4.2): a request presenting BOTH a
 * session cookie and a bearer header is refused rather than guessed, exactly like a missing one. */
const ACCOUNT_STATUS = Object.freeze({ AUTH_REQUIRED: 401, LINK_ACCOUNT_REQUIRED: 401, RATE_LIMITED: 429, AMBIGUOUS_CREDENTIAL: 401 });
const accountStatus = code => ACCOUNT_STATUS[code] || 409;

/* Realtime ticket issuance/redeem edge mapping (design B5.4/B5.5, P05Tickets contract): the four
 * ticket codes are already realtime/v1 PUBLIC_CODES; this is the HTTP status half. A ticket is a
 * credential, so an invalid/expired/redeemed one is 403, and the per-actor admission ceiling is 429. */
const REALTIME_STATUS = Object.freeze({ AUTH_REQUIRED: 401, LINK_ACCOUNT_REQUIRED: 401, TICKET_INVALID: 403, TICKET_EXPIRED: 403, TICKET_REDEEMED: 403, TICKET_LIMIT: 429 });
const realtimeStatus = code => REALTIME_STATUS[code] || 409;

const MONETIZATION_STATUS = Object.freeze({ AUTH_REQUIRED: 401, LINK_ACCOUNT_REQUIRED: 401, INVALID_PUSH_AUTH: 401, STORE_UNAVAILABLE: 503, PUSH_AUTH_UNAVAILABLE: 503, INVALID_STORE_NOTIFICATION: 400 });
const monetizationStatus = code => MONETIZATION_STATUS[code] || 409;

/* Standalone http.js: anything that is not an auth failure is a 409, including method
 * and origin rejections that never reach the catch block. */
const standaloneStatus = code => (code === 'AUTH_REQUIRED' ? 401 : 409);

const PARTY_STATUS = Object.freeze({ AUTH_REQUIRED: 401 });
const partyStatus = code => PARTY_STATUS[code] || 400;

/* --------------------------------------------------------------- responses */

/* Two exact shipped header sets: with and without Referrer-Policy. */
function writeJson(res, status, value, { noReferrer = false } = {}) {
 const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
 if (noReferrer) headers['Referrer-Policy'] = 'no-referrer';
 res.writeHead(status, headers);
 res.end(JSON.stringify(value));
}

module.exports = {
 SCOPE_PLAYER,
 OPERATION_KEY,
 OPERATION_ID,
 MAX_RAW_KEY_LENGTH,
 isOperationKey,
 isOperationId,
 isBoardCell,
 header,
 isJsonContentType,
 requireJson,
 operationKey,
 truthyOperationKey,
 rawOperationKey,
 readJsonBody,
 readRawJsonBody,
 readPartyBody,
 readStoreNotification,
 readCommandBody,
 cookies,
 sessionToken,
 requireSameOriginJson,
 requireExactOrigin,
 hasConflictingOrigin,
 requirePartyOrigin,
 requirePartyHost,
 requirePartyJson,
 sessionPrincipal,
 partyPrincipal,
 publicCode,
 standalonePublicCode,
 PARTY_ERROR_PREFIXES,
 partyPublicCode,
 ACCOUNT_STATUS,
 accountStatus,
 REALTIME_STATUS,
 realtimeStatus,
 MONETIZATION_STATUS,
 monetizationStatus,
 standaloneStatus,
 PARTY_STATUS,
 partyStatus,
 writeJson
};
