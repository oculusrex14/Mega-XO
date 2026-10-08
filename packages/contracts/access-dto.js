/* access-dto.js - P05 native-credential and realtime-ticket DTO contracts.
 *
 * The shared library definition for the two P05 credential transports that do not exist in the V4
 * client (design B4.2 and B5):
 *
 *   - the cookie-free native host path: POST /api/account/native/token accepts EITHER a provider
 *     challenge+finish result or a refresh grant, and a request presenting BOTH a session cookie
 *     and a bearer header is refused (AMBIGUOUS_CREDENTIAL) rather than guessed;
 *   - the one-use realtime ticket bridge, which must never place ticket material in a log or URL.
 *
 * Pure validators only: no HTTP, no SQL, no provider or device claims. Reuses the existing
 * native/v1 validators so a provider grant is checked exactly once, by the already-frozen grammar.
 */
'use strict';
const { fail } = require('./errors.js');
const { validateFinishRequest } = require('./native-bridge.js');

const GRANT_TYPES = Object.freeze(['provider', 'refresh']);
const MAX_REFRESH_TOKEN_LENGTH = 512;
const TICKET_REDACT_PREFIX = 6;

/* POST /api/account/native/token body. Exactly one grant:
 *   {provider, state, idToken}                          -> provider challenge+finish result
 *   {grant:'refresh_token', refreshToken, deviceId?}    -> family rotation
 * The provider branch delegates to native/v1 (INVALID_AUTH_REQUEST / INVALID_ID_TOKEN /
 * INVALID_AUTH_STATE) so the shipped grammar is not duplicated. */
function validateNativeTokenGrant(body) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_AUTH_REQUEST');
 const hasProvider = body.idToken !== undefined || body.provider !== undefined || body.state !== undefined;
 const hasRefresh = body.refreshToken !== undefined || body.grant !== undefined;
 if (hasProvider && hasRefresh) fail('INVALID_AUTH_REQUEST', 'grant');
 if (hasRefresh) {
  if (body.grant !== undefined && body.grant !== 'refresh_token') fail('INVALID_AUTH_REQUEST', 'grant');
  if (typeof body.refreshToken !== 'string' || !body.refreshToken || body.refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
   fail('INVALID_AUTH_REQUEST', 'refreshToken');
  }
  if (body.deviceId !== undefined && (typeof body.deviceId !== 'string' || !body.deviceId)) fail('INVALID_AUTH_REQUEST', 'deviceId');
  return { kind: 'refresh', refreshToken: body.refreshToken, deviceId: body.deviceId || null };
 }
 const finish = validateFinishRequest(body);
 return { kind: 'provider', provider: finish.provider, state: finish.state, idToken: finish.idToken };
}

/* A ticket is a bearer credential: a log/error surface gets a bounded prefix, never the whole value.
 * Short values are fully withheld so a truncated display can never reveal a complete ticket. */
function redactTicket(ticket) {
 if (typeof ticket !== 'string' || !ticket) return '';
 if (ticket.length <= TICKET_REDACT_PREFIX) return '\u2026';
 return `${ticket.slice(0, TICKET_REDACT_PREFIX)}\u2026`;
}

/* Credential resolution must be unambiguous (design B4.2): a request presenting BOTH a session
 * cookie and a bearer header is refused. Non-empty header strings count as present. */
function refuseAmbiguousCredential({ cookieHeader, bearerHeader } = {}) {
 const cookie = typeof cookieHeader === 'string' ? cookieHeader.trim() : '';
 const bearer = typeof bearerHeader === 'string' ? bearerHeader.trim() : '';
 if (cookie && bearer) fail('AMBIGUOUS_CREDENTIAL');
 return { cookie: cookie || null, bearer: bearer || null };
}

module.exports = {
 GRANT_TYPES,
 MAX_REFRESH_TOKEN_LENGTH,
 TICKET_REDACT_PREFIX,
 validateNativeTokenGrant,
 redactTicket,
 refuseAmbiguousCredential,
};
