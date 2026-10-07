/* realtime/v1 envelope contract.
 *
 * Frozen schema for the future direct realtime transport (pack phase 08 /
 * V5-05-05). This is a validated library implementation used by the HTTP adapters
 * and the future Core - there is no deployed WebSocket endpoint, ticket issuer or
 * stub server in P01 and none may be inferred from this module.
 *
 * Bounds are derived from the legacy commands they will carry:
 *  - match id / operation key: the exact `validId` grammar (src/authority.js:7)
 *    and community operation-key length ceiling (160).
 *  - move coordinates: integer board/cell 0..8; move legality stays in game.apply.
 *  - revisions: non-negative safe integers, matching match.revision.
 */
'use strict';
const { fail } = require('./errors.js');
const { isOperationId, isBoardCell, isJsonContentType } = require('./http-guards.js');

const PROTOCOL = 'realtime/v1';
const MAX_ENVELOPE_BYTES = 8192;
const MAX_ACTOR_LENGTH = 160;
const MAX_MATCH_LENGTH = 160;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_DELTA_BYTES = 65536;
const MAX_MESSAGE_ERROR_BYTES = 1024;
const MAX_SERVER_NOW = Number.MAX_SAFE_INTEGER;

const OPERATIONS = Object.freeze([
 'ticket.redeem',
 'subscribe',
 'command',
 'snapshot',
 'delta',
 'ack',
 'error',
 'ping',
 'resume'
]);

/* Which fields each operation requires (and which it forbids). The wire names are the
 * snake_case form frozen by the pack specification. */
const ENVELOPE_FIELDS = Object.freeze({
 protocol: value => value === PROTOCOL,
 operation_id: value => typeof value === 'string' && isOperationId(value) && value.length <= 160,
 operation: value => typeof value === 'string' && OPERATIONS.includes(value),
 actor: value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ACTOR_LENGTH && isOperationId(value),
 match_id: value => typeof value === 'string' && value.length > 0 && value.length <= MAX_MATCH_LENGTH && isOperationId(value),
 expected_revision: value => Number.isSafeInteger(value) && value >= 0,
 ack_revision: value => Number.isSafeInteger(value) && value >= 0,
 ticket: value => typeof value === 'string' && value.length > 0 && value.length <= 512,
 server_now: value => Number.isSafeInteger(value) && value > 0 && value <= MAX_SERVER_NOW,
 code: value => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value) && value.length <= 64,
 message: value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_MESSAGE_ERROR_BYTES,
 command: value => value !== null && typeof value === 'object' && !Array.isArray(value),
 snapshot: value => value !== null && typeof value === 'object' && !Array.isArray(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_SNAPSHOT_BYTES,
 delta: value => value !== null && typeof value === 'object' && !Array.isArray(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_DELTA_BYTES
});

/* Required/optional/forbidden per operation. A field outside its list is rejected so a
 * future server cannot be probed with ambiguous, half-applicable messages. */
const SHAPES = Object.freeze({
 'ticket.redeem': { required: ['ticket'], optional: [] },
 subscribe: { required: ['match_id'], optional: ['ticket'] },
 command: { required: ['operation_id', 'match_id', 'expected_revision', 'command'], optional: ['actor'] },
 snapshot: { required: ['match_id', 'expected_revision', 'snapshot'], optional: ['server_now'] },
 delta: { required: ['match_id', 'expected_revision', 'delta'], optional: ['server_now'] },
 ack: { required: ['match_id', 'ack_revision'], optional: [] },
 error: { required: ['code'], optional: ['match_id', 'expected_revision', 'message'] },
 ping: { required: [], optional: ['server_now'] },
 resume: { required: ['match_id', 'ack_revision'], optional: [] }
});

/* Fields validated by requireRevision so revision errors stay distinguishable from
 * generic envelope-shape errors on every operation. */
const REVISION_FIELDS = Object.freeze(['expected_revision', 'ack_revision']);

/* Only bare public codes may cross the wire. */
const PUBLIC_CODES = Object.freeze([
 'AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED', 'FORBIDDEN', 'SESSION_REVOKED', 'ACCOUNT_HELD',
 'INVALID_ENVELOPE', 'INVALID_OPERATION', 'INVALID_COMMAND', 'INVALID_MOVE', 'INVALID_REVISION',
 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'STALE_REVISION', 'UNKNOWN_MATCH',
 'NOT_PARTICIPANT', 'MATCH_CLOSED', 'TERMS_CHANGED', 'NOT_YOUR_TURN', 'TIMER_EXPIRED',
 'TICKET_INVALID', 'TICKET_EXPIRED', 'TICKET_REDEEMED', 'SUBSCRIPTION_DENIED', 'SNAPSHOT_REQUIRED',
 'RATE_LIMITED', 'MAINTENANCE', 'SERVICE_UNAVAILABLE', 'REQUEST_REJECTED'
]);

/* ------------------------------------------------------------------ helpers */

/* Legacy `validId`/`OPERATION_ID` grammar with an explicit field-local error code. */
function requireId(label, value, code) {
 if (!isOperationId(value)) fail(code || 'INVALID_ENVELOPE', label);
 return value;
}
function requireRevision(label, value) {
 if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_REVISION', label);
 return value;
}
function requireActor(value) {
 if (typeof value !== 'string' || !value || value.length > MAX_ACTOR_LENGTH || !isOperationId(value)) fail('INVALID_ENVELOPE', 'actor');
 return value;
}

/* The only legal move payload. `apply` remains the single legality authority; this
 * validator rejects non-integer coordinates and out-of-range board/cell indices before
 * any rule evaluation, so an invalid realtime move cannot reach the game engine. */
function validateMove(move) {
 if (!move || typeof move !== 'object' || Array.isArray(move)) fail('INVALID_MOVE');
 if (!isBoardCell(move.b) || !isBoardCell(move.c)) fail('INVALID_MOVE');
 return { b: move.b, c: move.c };
}
function validateCommand(command) {
 if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string' || !command.type) fail('INVALID_COMMAND');
 const validated = { type: command.type };
 if (command.type === 'move') validated.move = validateMove(command.move);
 return validated;
}

/* ------------------------------------------------------------ envelope check */

function validateEnvelope(message, { authenticatedActor } = {}) {
 if (!message || typeof message !== 'object' || Array.isArray(message)) fail('INVALID_ENVELOPE');
 if (Buffer.byteLength(JSON.stringify(message)) > MAX_ENVELOPE_BYTES) fail('INVALID_ENVELOPE', 'size');
 if (message.protocol !== PROTOCOL) fail('INVALID_ENVELOPE', 'protocol');
 if (typeof message.operation !== 'string' || !OPERATIONS.includes(message.operation)) fail('INVALID_OPERATION');
 const shape = SHAPES[message.operation];
 const present = Object.keys(message).filter(key => key !== 'protocol' && key !== 'operation');
 for (const field of present) {
  if (!Object.prototype.hasOwnProperty.call(ENVELOPE_FIELDS, field)) fail('INVALID_ENVELOPE', field);
  if (shape.required.includes(field) || shape.optional.includes(field)) continue;
  fail('INVALID_ENVELOPE', field);
 }
 for (const field of shape.required) {
  if (message[field] === undefined) fail('INVALID_ENVELOPE', field);
  if (REVISION_FIELDS.includes(field)) { requireRevision(field, message[field]); continue; }
  if (!ENVELOPE_FIELDS[field](message[field])) fail('INVALID_ENVELOPE', field);
 }
 for (const field of shape.optional) {
  if (message[field] === undefined) continue;
  if (REVISION_FIELDS.includes(field)) { requireRevision(field, message[field]); continue; }
  if (!ENVELOPE_FIELDS[field](message[field])) fail('INVALID_ENVELOPE', field);
 }
 const out = { protocol: PROTOCOL, operation: message.operation };
 for (const field of shape.required) out[field] = message[field];
 for (const field of shape.optional) if (message[field] !== undefined) out[field] = message[field];
 if (out.match_id !== undefined) requireId('match_id', out.match_id);
 if (out.expected_revision !== undefined) requireRevision('expected_revision', out.expected_revision);
 if (out.ack_revision !== undefined) requireRevision('ack_revision', out.ack_revision);
 if (out.actor !== undefined) {
  requireActor(out.actor);
  // Core authenticates before joining; a payload actor is not an authorization input
  // and must never contradict the authenticated actor for the connection/session.
  if (authenticatedActor !== undefined && out.actor !== authenticatedActor) fail('FORBIDDEN', 'actor');
 }
 if (out.operation_id !== undefined && !ENVELOPE_FIELDS.operation_id(out.operation_id)) fail('INVALID_ENVELOPE', 'operation_id');
 if (out.server_now !== undefined && !ENVELOPE_FIELDS.server_now(out.server_now)) fail('INVALID_ENVELOPE', 'server_now');
 if (out.code !== undefined && !PUBLIC_CODES.includes(out.code)) fail('INVALID_ENVELOPE', 'code');
 if (out.command !== undefined) out.command = validateCommand(out.command);
 if (out.message !== undefined && !ENVELOPE_FIELDS.message(out.message)) fail('INVALID_ENVELOPE', 'message');
 return out;
}

/* ------------------------------------------------------- versioned responses */

/* Response frames reuse the same protocol tag and bounds; `revision` is the committed
 * revision, `server_now` the authority clock. Snapshots/deltas are opaque bounded data
 * produced by the authority, never re-derived by a transport. */
function validateResponse(message) {
 if (!message || typeof message !== 'object' || Array.isArray(message)) fail('INVALID_ENVELOPE');
 if (message.protocol !== undefined && message.protocol !== PROTOCOL) fail('INVALID_ENVELOPE', 'protocol');
 if (typeof message.operation !== 'string' || !OPERATIONS.includes(message.operation)) fail('INVALID_OPERATION');
 if (message.revision !== undefined) requireRevision('revision', message.revision);
 if (message.server_now !== undefined && !ENVELOPE_FIELDS.server_now(message.server_now)) fail('INVALID_ENVELOPE', 'server_now');
 if (message.error !== undefined) {
  if (!message.error || typeof message.error !== 'object' || typeof message.error.code !== 'string' || !PUBLIC_CODES.includes(message.error.code)) fail('INVALID_ENVELOPE', 'error');
 }
 if (message.snapshot !== undefined && !ENVELOPE_FIELDS.snapshot(message.snapshot)) fail('INVALID_ENVELOPE', 'snapshot');
 if (message.delta !== undefined && !ENVELOPE_FIELDS.delta(message.delta)) fail('INVALID_ENVELOPE', 'delta');
 return message;
}

/* ------------------------------------------------------ HTTP ticket bridge */

/* The authenticated HTTP API issues the one-use ticket; the socket redeems it. Ticket
 * material never belongs in a query string or a log line, so the request shape is
 * validated here and the router must keep it out of URLs. */
function validateTicketRequest(body, { authenticatedActor } = {}) {
 if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_ENVELOPE');
 if (typeof body.actor === 'string' && body.actor) {
  requireActor(body.actor);
  if (!authenticatedActor || body.actor !== authenticatedActor) fail('FORBIDDEN');
 }
 return { actor: authenticatedActor || null };
}
function redactTicket(value) {
 if (typeof value !== 'string' || !value) return '';
 return '[redacted:' + value.length + ']';
}

/* The envelope is a real protocol payload, not a query string. */
function validateEnvelopeTransport(req) {
 if (req?.method && req.method !== 'POST') fail('INVALID_ENVELOPE', 'method');
 if (req?.headers && !isJsonContentType(req)) fail('INVALID_ENVELOPE', 'content-type');
 return true;
}

module.exports = {
 PROTOCOL,
 OPERATIONS,
 SHAPES,
 ENVELOPE_FIELDS,
 PUBLIC_CODES,
 MAX_ENVELOPE_BYTES,
 MAX_SNAPSHOT_BYTES,
 MAX_DELTA_BYTES,
 MAX_MESSAGE_ERROR_BYTES,
 requireId,
 requireRevision,
 requireActor,
 validateMove,
 validateCommand,
 validateEnvelope,
 validateResponse,
 validateTicketRequest,
 validateEnvelopeTransport,
 redactTicket
};
