/* packages/services/realtime-transport.js - V5 P08 authenticated realtime/v1 WebSocket transport
 * (V5-08-01).
 *
 *   const transport = createRealtimeTransport({ server, pool, core, ephemera, now });
 *   // staging ingress: wss://<host>/realtime/v1  (no other path on this server is touched)
 *   await transport.close();
 *
 * WHAT THIS IS. ONE native (zero-dependency, RFC 6455) WebSocket server bound to an EXISTING
 * http(s) server's 'upgrade' event, plus ONE ordinary request listener that serves the HTTP
 * snapshot fallback for the same two paths. HTTP reads are disabled unless the owning host injects
 * an authenticateHttp(req) session/bearer verifier; the URL's actor is only a mismatch assertion.
 * It owns the wire only: framing, the one-use ticket
 * handshake, subscription membership, the revision transaction, bounded snapshot/delta recovery
 * and safe error frames. It is deliberately not the command authority - a `command` envelope is
 * projected onto the ONE Core transaction boundary (`core.run`), which locks, dedupes, commits the
 * outcome/outbox atomically and is the sole source of the committed revision.
 *
 * WIRE CONTRACT (packages/contracts/realtime.js, frozen):
 *   client -> server  {protocol:'realtime/v1',operation:'ticket.redeem',ticket}
 *                     {protocol:'realtime/v1',operation:'subscribe',match_id}
 *                     {protocol:'realtime/v1',operation:'command',operation_id,match_id,
 *                      expected_revision,command,[actor]}
 *                     {protocol:'realtime/v1',operation:'resume',match_id,ack_revision}
 *                     {protocol:'realtime/v1',operation:'ping',server_now?}
 *   server -> client  {protocol:'realtime/v1',operation:'ack',match_id,ack_revision}
 *                     {protocol:'realtime/v1',operation:'snapshot',match_id,expected_revision,snapshot[,server_now]}
 *                     {protocol:'realtime/v1',operation:'delta',match_id,expected_revision,
 *                      delta:{from,to,moves}[,server_now]}
 *                     {protocol:'realtime/v1',operation:'pong',server_now}
 *                     {protocol:'realtime/v1',operation:'error',code[,match_id,expected_revision]}
 *   plain HTTP        GET /realtime/v1/snapshot?match_id=..&actor=..   -> application/json snapshot
 *                     GET /realtime/v1/match/:id?actor=..             -> application/json snapshot
 *                       (both require the host's authenticateHttp(req) verified principal)
 * `ack` answers a redeemed ticket (ack_revision 0) or a committed command (the durable committed
 * revision read back from PostgreSQL).
 * Every inbound frame passes validateEnvelope() before it has any effect; every outbound error
 * carries a bare PUBLIC_CODES code and never a message, a ticket, a SQL fragment or an internal
 * reason, so a refused client learns nothing about why the durable check failed.
 *
 * `pong` is the ONE server-originated operation outside the frozen OPERATIONS list (which names
 * only the client-side `ping`). The phase task requires envelope ping/pong, the reply must carry the
 * authority clock, and it MUST be a distinct operation: answering a client `ping` with a `ping`
 * would make two peers mirror each other forever. RFC 6455 PING frames are still answered at the
 * protocol level with PONG frames, so no application envelope is involved there.
 *
 * DURABLE AUTHORITY. PostgreSQL decides who may join a match: redemption consumes the durable
 * identity.realtime_tickets row through the narrow SECURITY DEFINER function (V5-05-05), and the
 * subscription probe reads committed match.participants / match.matches rows. The caller-owned
 * `ephemera` adapter holds ONE rebuildable advisory fact - the connection route record - whose loss
 * can only stop another Core from FINDING this socket, never let one enter a match or replay a
 * ticket. No Redis value is an authorization input anywhere in this file.
 *
 * BOUNDS. maxEnvelopeBytes (default and ceiling MAX_ENVELOPE_BYTES) bounds one frame, a fragmented
 * message and the per-connection read buffer; a breach sends close 1009 and destroys the socket.
 * A client frame that is unmasked, illegally fragmented, reserved-bit set, non-minimally length
 * encoded or carries an unknown opcode sends close 1002. authTimeoutMs bounds how long an
 * unauthenticated socket may exist.
 *
 * LIFECYCLE. close() removes the upgrade AND request listeners, closes every socket and drops every
 * timer. The caller's server, pool, core service and ephemera adapter are caller-owned and never
 * closed here.
 *
 * RECOVERY (V5-08-04). A returning client names the last revision it applied; `resume` compares it
 * with the durable head and answers `ack` (already in sync), a bounded `delta` plus the
 * authoritative `snapshot` (a miss inside the replayable window), or the full `snapshot` (a miss
 * beyond it, a non-move revision step, or a client claiming to be AHEAD of the authority). Because
 * the snapshot is the committed aggregate itself, a client is synchronized by REPLACEMENT and never
 * reapplies the moves it already holds - the invariant the phase gate tests. A client without a
 * socket reads the same committed view over the ordinary HTTP fallback on the same two paths.
 *
 * COMMANDS (V5-08-02). A `command` is answered only for a connection that has REDEEMED and
 * SUBSCRIBED to that match. The validated envelope cannot carry its own authority, so the transport
 * synthesizes the ONE command identity the durable boundary expects - `command.id` and
 * `command.revision` are stamped from `message.match_id`/`message.expected_revision` by the
 * transport, exactly as the HTTP bridge stamps them from the request body and never from client
 * JSON; a client therefore cannot name a second match or revision through the payload. The command
 * is executed as `core.run({actor: conn.actor, scope:'player'}, message.operation_id, payload)`:
 *   - `core.run` is the revision transaction. Inside ONE PostgreSQL transaction it takes the
 *     logical identities then the match row lock, LOOKS UP the operation outcome (dedupe BEFORE the
 *     stale-revision/legality checks, so a lost-response retry returns the PRIOR result instead of a
 *     STALE_REVISION) and compares the payload fingerprint (an altered payload under the same key
 *     is IDEMPOTENCY_CONFLICT and rolls the whole transaction back), then applies the command and
 *     commits the outcome/outbox atomically. PostgreSQL is the durable authority; the transport
 *     re-reads it after the commit instead of trusting its own memory.
 *   - The transport therefore owns NO revision state. It NEVER dedupes, NEVER compares revisions and
 *     NEVER invents a result: every ack_revision and every snapshot is read back from the committed
 *     aggregate with `core.readMatch`, so a replay that committed nothing still answers with the
 *     durable revision and the durable view.
 *   - A committed command is fanned out to every local socket subscribed to the match: `ack` to the
 *     sender first, then the shared post-commit `snapshot`. The command is NOT a delta - the
 *     authoritative view is bounded-read fresh for every observer, so a concurrent commit is never
 *     broadcast as stale state.
 *   - The engine's one internal legality code, `ILLEGAL_MOVE`, is normalized to the contract's
 *     `INVALID_MOVE`; every other engine code is already a bare PUBLIC_CODES member.
 */
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');

const {
  PROTOCOL, PUBLIC_CODES, MAX_ENVELOPE_BYTES, ENVELOPE_FIELDS,
  validateEnvelope,
} = require('../contracts/realtime.js');
const { redeemRealtimeTicket } = require('./tickets.js');

/* The ONE ingress this transport owns: an exact path, so a co-hosted route handler keeps every other
 * path. A query string or a single trailing slash is tolerated; nothing else is. */
const INGRESS_PATH = '/realtime/v1';
/* The HTTP snapshot fallback (V5-08-04). `GET /realtime/v1/snapshot?match_id=..&actor=..` and its
 * match-addressed alias `GET /realtime/v1/match/:id?actor=..` are the recovery path for a client
 * that cannot hold a socket open. They read the SAME durable authority the socket serves. */
const SNAPSHOT_PATH = '/realtime/v1/snapshot';
const MATCH_PATH_PREFIX = '/realtime/v1/match/';
/* The largest miss a bounded delta may cover. A client further behind (or ahead) is resynchronized
 * with the full committed view instead; the replayable window is a policy bound, not a durable one. */
const MAX_DELTA_MOVES = 10;
const WEBSOCKET_VERSION = '13';
/* RFC 6455 §1.3 handshake GUID: a protocol constant, not a secret. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/* The node identity recorded on the durable ticket row at redemption. */
const CORE_NODE = 'game-core';
const DEFAULT_AUTH_TIMEOUT_MS = 10000;
const MAX_AUTH_TIMEOUT_MS = 60000;
/* Advisory (`ephemera`) connection-route record lifetime. It is rebuildable and never an
 * authorization input; V5-08-05 owns the multi-process routing that reads it. */
const ROUTE_TTL_MS = 30000;
/* V5-08-05 multi-process routing. `core-match` is the SAME post-commit channel Core publishes to
 * (packages/services/core.js `MATCH_CHANNEL`); a hint carries ONLY the changed match id, so this
 * transport rereads committed PostgreSQL truth and never trusts the payload. */
const MATCH_CHANNEL = 'core-match';
/* V5-08-05 slow-client bound. The largest outbound socket buffer this transport will let accumulate
 * before it closes the peer with a policy error: a client that cannot absorb frames at the rate the
 * authority produces them reconnects and catches up through `resume`/snapshot recovery instead of
 * pinning unbounded frames in memory. A policy bound, not a durable one. */
const DEFAULT_MAX_BUFFER_BYTES = 65536;
/* How long a closing socket may linger for its close frame/FIN to flush before it is destroyed. */
const CLOSE_GRACE_MS = 5000;
/* RFC 6455 §5.5: a control frame payload never exceeds 125 bytes. */
const MAX_CONTROL_PAYLOAD = 125;
/* An upgrade request line plus headers beyond this is refused before it is parsed. */
const MAX_HANDSHAKE_BYTES = 16384;
/* A 16-byte key, base64 encoded: exactly 22 characters plus '=='. */
const WEBSOCKET_KEY = /^[A-Za-z0-9+/]{22}==$/;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/* RFC 6455 §7.4.1 close codes this transport sends. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_INTERNAL = 1011;

const EMPTY = Buffer.alloc(0);
const fail = (code) => { throw Error(code); };

/* Only bare public codes may cross the wire. */
function publicCode(value) {
  return typeof value === 'string' && PUBLIC_CODES.includes(value) ? value : 'SERVICE_UNAVAILABLE';
}
/* A guard/DB error carries its stable code as `error.message` (the repository-wide convention). A
 * non-public code - a role guard, a pool fault, a truncated aggregate read - becomes the generic
 * public failure instead of leaking the internal reason. */
function safeCode(error) {
  const code = error && typeof error.message === 'string' ? error.message : '';
  return PUBLIC_CODES.includes(code) ? code : 'SERVICE_UNAVAILABLE';
}
/* The game engine's ONE internal legality failure (`src/game.js apply`) crosses the wire as the
 * contract's `INVALID_MOVE`: an out-of-range or occupied cell is a move-shape fault, not a server
 * fault, and the frozen code list has no `ILLEGAL_MOVE`. Every other engine code
 * (STALE_REVISION/IDEMPOTENCY_CONFLICT/NOT_YOUR_TURN/TIMER_EXPIRED/MATCH_CLOSED/NOT_PARTICIPANT) is
 * already a PUBLIC_CODES member, so this is the only translation. */
function commandCode(value) {
  return value === 'ILLEGAL_MOVE' ? 'INVALID_MOVE' : publicCode(value);
}
/* The validated envelope carries only the command's own shape (`{type}` / `{type,move}`); the match
 * id and revision are the transport's, taken from `message.match_id`/`message.expected_revision`
 * exactly as the HTTP bridge takes them from the request body - NEVER from client JSON. `resign`
 * names neither. Only the two supported kinds are forwarded; anything else is a shape fault. */
function coreCommand(message) {
  if (message.command.type === 'move') {
    return { type: 'move', id: message.match_id, revision: message.expected_revision, key: message.operation_id, move: message.command.move };
  }
  if (message.command.type === 'resign') return { type: 'resign', id: message.match_id };
  throw Error('INVALID_COMMAND');
}
/* The correlation context a REFUSED command is answered with. An envelope that the frozen contract
 * rejects never reaches `dispatch`, so this reads the two correlating fields straight off the raw
 * message - but only after the contract's OWN field grammars accept them individually, so a
 * malformed value is never echoed back and the error code stays bare. This is what makes a
 * `command` refusal the same frame shape whether the fault was the move's shape (caught by
 * `validateCommand`) or the match's rules (caught inside the transaction): the client correlates on
 * `match_id` + `expected_revision` either way, and learns nothing else. */
function commandContext(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.protocol !== PROTOCOL || parsed.operation !== 'command') return undefined;
  if (!ENVELOPE_FIELDS.match_id(parsed.match_id)) return undefined;
  if (!Number.isSafeInteger(parsed.expected_revision) || parsed.expected_revision < 0) return undefined;
  return { match_id: parsed.match_id, expected_revision: parsed.expected_revision };
}
/* The HTTP status for a refused snapshot-fallback read. A missing/anonymous principal is 401; a
 * match the authority will not confirm or a caller it will not seat is 404/403; every other public
 * code (a pool fault, a truncation) is the generic 503. The fallback NEVER serves state it could not
 * prove the caller may see. */
const FALLBACK_STATUS = Object.freeze({
  AUTH_REQUIRED: 401,
  LINK_ACCOUNT_REQUIRED: 401,
  SESSION_REVOKED: 401,
  INVALID_ENVELOPE: 400,
  INVALID_REVISION: 400,
  UNKNOWN_MATCH: 404,
  NOT_PARTICIPANT: 403,
  FORBIDDEN: 403,
});
const fallbackStatus = (code) => FALLBACK_STATUS[code] || 503;

/* A caller may tighten a bound, never loosen it: the frozen contract ceilings stand. */
function boundedOption(value, fallback, max, code) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code);
  return value;
}

/* The request-target's path, with the query string / fragment removed and ONE trailing slash
 * tolerated. `/realtime/v1`, `/realtime/v1/` and `/realtime/v1?x=1` all address this ingress;
 * `/realtime/v10`, `/realtime` and `/other` do not. */
function ingressPath(target) {
  if (typeof target !== 'string' || target.length === 0) return '';
  let end = target.length;
  const query = target.indexOf('?');
  if (query !== -1 && query < end) end = query;
  const fragment = target.indexOf('#');
  if (fragment !== -1 && fragment < end) end = fragment;
  let path = target.slice(0, end);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/* The request-target of the HTTP snapshot fallback, or null when this listener does not own it. ONE
 * trailing slash is tolerated (the same rule the upgrade ingress uses), and the match-addressed
 * alias carries the match id in the path, percent-encoded as a single segment. A query parameter
 * named `match_id` on the alias is ignored, so the path is the ONE authority for which match is
 * read and no second, competing source can disagree with it. */
function snapshotRequest(target) {
  const path = ingressPath(target);
  if (path === SNAPSHOT_PATH) return { match_id: null };
  if (path.startsWith(MATCH_PATH_PREFIX)) {
    const segment = path.slice(MATCH_PATH_PREFIX.length);
    if (segment.length === 0 || segment.includes('/')) return null;
    try { return { match_id: decodeURIComponent(segment) }; }
    catch { return { match_id: null }; }
  }
  return null;
}

/* The changed-match id a `core-match` hint names, or null. The payload is an OPAQUE coordination
 * nudge - `{matchId}` and nothing else (packages/services/core.js `matchHintText`) - so it is
 * parsed only to pick the local subscribers to reread for. A malformed, truncated or spoofed hint
 * yields null and is ignored: it can never invent a match, redirect a read or replace PostgreSQL
 * truth, because the broadcast below is a fresh `core.readMatch`, not the payload. */
function matchHintId(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed.matchId === 'string' ? parsed.matchId : null;
  } catch { return null; }
}

/* A server frame is NEVER masked (RFC 6455 §5.1) and is always FIN-encoded. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 4294967296), 2);
    header.writeUInt32BE(length >>> 0, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
function closeFrame(code) {
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(code, 0);
  return encodeFrame(OP_CLOSE, body);
}

function createRealtimeTransport(options = {}) {
  const server = options.server;
  if (!server || typeof server.on !== 'function' || typeof server.removeListener !== 'function') fail('SERVER_REQUIRED');
  const pool = options.pool;
  if (!pool || typeof pool.withTransaction !== 'function') fail('PG_POOL_REQUIRED');
  const core = options.core;
  if (!core || typeof core.readMatch !== 'function' || typeof core.run !== 'function') fail('CORE_REQUIRED');
  const ephemera = options.ephemera === undefined || options.ephemera === null ? null : options.ephemera;
  if (ephemera && (typeof ephemera.registerRoute !== 'function' || typeof ephemera.cacheDel !== 'function')) fail('EPHEMERA_REQUIRED');
  const clock = options.now === undefined ? Date.now : options.now;
  if (typeof clock !== 'function') fail('CLOCK_REQUIRED');
  /* The HTTP recovery route has NO WebSocket ticket. The caller's identity
   * perimeter must authenticate the request independently (session cookie or
   * scoped bearer, including revocation/eligibility). An actor query parameter
   * is never a credential. Without this hook the route MUST fail closed. */
  const authenticateHttp = options.authenticateHttp;
  if (authenticateHttp !== undefined && typeof authenticateHttp !== 'function') fail('HTTP_AUTHENTICATOR_INVALID');
  const maxEnvelopeBytes = boundedOption(options.maxEnvelopeBytes, MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES, 'MAX_ENVELOPE_BYTES_INVALID');
  const authTimeoutMs = boundedOption(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, MAX_AUTH_TIMEOUT_MS, 'AUTH_TIMEOUT_INVALID');
  const maxBufferBytes = boundedOption(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES, DEFAULT_MAX_BUFFER_BYTES, 'MAX_BUFFER_BYTES_INVALID');

  /* Every live connection, keyed by its opaque connection id (the id recorded on the durable ticket
   * row at redemption and on the advisory route record). This Map is the ONLY registry: a socket
   * leaves it on 'close', so nothing outlives its socket. */
  const connections = new Map();
  let closed = false;
  /* V5-08-05 graceful drain. Set the instant `beginDrain()` runs: no new upgrade/request is accepted
   * and every live socket is told to go away; the transport stays usable only long enough for the
   * owning server to drain, and no new hint work is started. */
  let draining = false;

  /* V5-08-05 multi-process routing. `core-match` is pub/sub WITHOUT echo suppression, so this
   * process's OWN post-commit publish comes back to its own subscriber. Two facts make the hint
   * path idempotent against that:
   *   - a hint is NEVER authority - it only decides whether and for whom to reread committed
   *     PostgreSQL truth (the broadcast is a fresh `core.readMatch`, never the payload);
   *   - the SAME revision is broadcast to local subscribers at most once. `lastBroadcast` records
   *     the last revision each match was fanned out at, and a hint acts only when the fresh durable
   *     read shows a DIFFERENT revision (a genuine other-process change).
   * `pendingEcho` is the in-flight half of the same guard: a local command arms it with the revision
   * it is about to commit, so a hint that arrives BETWEEN the commit and the local broadcast (the
   * echo can beat the command handler back) waits for that revision to be broadcast instead of
   * publishing a second, duplicate snapshot. Both maps are advisory and bounded by the matches this
   * process has fanned out. */
  const lastBroadcast = new Map();
  const pendingEcho = new Map();
  /* The transport's OWN `core-match` subscription (never the caller's adapter). It is released on
   * beginDrain()/close(); until then it is the multi-process wake-up that turns another Core's
   * commit into a local snapshot. `matchReady` resolves true once it is open, false when hints are
   * definitively unavailable (no adapter/capability, or a fault); callers may await it before
   * relying on cross-process delivery. */
  let matchSubscription = null;
  let matchReady = Promise.resolve(false);
  /* Hint bursts coalesce into at most one in-flight durable reread per match plus one pending: a
   * hint never queues unbounded PostgreSQL work. */
  const hintInFlight = new Set();
  const hintPending = new Set();

  /* ------------------------------------------------------------- lifecycle --- */

  function clearAuthTimer(conn) {
    if (conn.authTimer === null) return;
    clearTimeout(conn.authTimer);
    conn.authTimer = null;
  }
  function clearGraceTimer(conn) {
    if (conn.grace === null) return;
    clearTimeout(conn.grace);
    conn.grace = null;
  }

  /* One socket, one close. The close frame is written first, so the peer receives the code before
   * the connection goes away: a graceful close end()s the writable side (the peer's own close/FIN
   * then completes the TCP teardown), a `hard` close (oversize, protocol and internal faults) skips
   * the exchange and destroys the socket once the frame is flushed. Either way an unref'd
   * CLOSE_GRACE_MS backstop destroys the socket, so no closing socket can outlive this bounded wait
   * or hold the process open. */
  function closeSocket(conn, code, hard = false) {
    if (conn.closing || conn.destroyed) return;
    conn.closing = true;
    clearAuthTimer(conn);
    const frame = closeFrame(code);
    if (hard) {
      try { conn.socket.write(frame, () => conn.socket.destroy()); }
      catch { conn.socket.destroy(); }
    } else {
      try { conn.socket.end(frame); }
      catch { conn.socket.destroy(); }
    }
    const grace = setTimeout(() => { conn.grace = null; conn.socket.destroy(); }, CLOSE_GRACE_MS);
    grace.unref();
    conn.grace = grace;
  }

  /* The only teardown path: it runs on the socket's own 'close' event, so a socket destroyed by the
   * peer, by a protocol fault, by close() or by an auth timeout always reaches it exactly once. */
  function teardown(conn) {
    if (conn.destroyed) return;
    conn.destroyed = true;
    clearAuthTimer(conn);
    clearGraceTimer(conn);
    /* The subscription set and the partial-frame buffers are per-socket state; dropping the
     * references here is what makes a closed connection collectable. */
    conn.subscriptions.clear();
    conn.buffer = EMPTY;
    conn.fragments = null;
    connections.delete(conn.id);
     forgetRoute(conn);
    if (!conn.socket.destroyed) conn.socket.destroy();
   }

  /* ------------------------------------------------------- advisory routing --- */

  /* A best-effort, rebuildable record of where this connection lives. It is never awaited by a
   * frame handler and never consulted for authorization: a miss makes another Core unable to route
   * a message, and the durable match/session rows still decide everything. */
  function registerRoute(conn, matchId) {
    if (!ephemera) return;
    const payload = JSON.stringify({ node: CORE_NODE, actor: conn.actor, match_id: matchId });
    conn.route = true;
    try { Promise.resolve(ephemera.registerRoute(conn.id, payload, ROUTE_TTL_MS)).catch(() => {}); }
    catch { /* advisory only */ }
  }
  function forgetRoute(conn) {
    if (!ephemera || !conn.route) return;
    conn.route = false;
    /* `route` is a FAMILIES member and `registerRoute` writes exactly this key; deleting it makes
     * the cross-process view immediately accurate instead of waiting out the TTL. */
    try { Promise.resolve(ephemera.cacheDel('route', conn.id)).catch(() => {}); }
    catch { /* advisory only */ }
  }

  /* ----------------------------------------------------------------- output --- */

  /* V5-08-05 slow-client handling. Every server frame goes through ONE write that, AFTER handing the
   * bytes to the socket, checks how much this peer still has queued. A socket whose kernel send
   * buffer is full and whose userland queue has crossed `maxBufferBytes` cannot keep up: it is
   * closed with policy error 1008 instead of holding unbounded frames in memory. The frame already
   * written is the last one it receives; the client reconnects and catches up through `resume`
   * (snapshot recovery), never through a replay of the frames that were dropped. */
  function sendFrame(conn, frame) {
    if (conn.destroyed || conn.closing) return;
    try {
      conn.socket.write(frame);
      if (conn.socket.bufferSize > maxBufferBytes) closeSocket(conn, CLOSE_POLICY, true);
    } catch { /* the socket is already gone; 'close' performs teardown */ }
  }
  function sendText(conn, value) {
    sendFrame(conn, encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(value), 'utf8')));
  }
  function sendControl(conn, opcode, payload) {
    sendFrame(conn, encodeFrame(opcode, payload));
  }

  /* The ONE authoritative snapshot frame for a committed view. `server_now` is the recovery clock a
   * client uses to reconcile its own turn countdown; only the recovery paths (`resume` and the HTTP
   * fallback) set it, so the V5-08-01 `subscribe` snapshot and the V5-08-02 post-command broadcast
   * stay byte-identical to what those tasks fixed (`withClock` false). `view` is a `core.readMatch`
   * DTO: the transport never re-derives a revision or a board, it only wraps the durable document. */
  function snapshotFrame(matchId, view, withClock) {
    const frame = {
      protocol: PROTOCOL,
      operation: 'snapshot',
      match_id: matchId,
      expected_revision: view.revision,
      snapshot: view,
    };
    if (withClock) frame.server_now = clock();
    return frame;
  }
  /* The bounded missed-move window: the committed aggregate's OWN suffix from the client's
   * acknowledged revision to the head. `moves[i]` is the i-th committed move, so the suffix from
   * `ackRevision` is exactly the moves the client missed - never a re-derived or speculative board. */
  function deltaFrame(matchId, view, ackRevision) {
    return {
      protocol: PROTOCOL,
      operation: 'delta',
      match_id: matchId,
      expected_revision: view.revision,
      delta: { from: ackRevision, to: view.revision, moves: view.state.moves.slice(ackRevision) },
      server_now: clock(),
    };
  }
  /* An ordinary HTTP JSON response for the snapshot fallback. `Cache-Control: no-store` keeps a
   * recovery read from being replayed out of a shared cache: it must reflect the current committed
   * revision every time. A socket that went away between the read and the write is simply ignored. */
  function sendJson(res, status, value) {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function sendSnapshotError(res, code) {
    sendJson(res, fallbackStatus(code), { protocol: PROTOCOL, operation: 'error', code });
  }
  /* A bare error frame for envelope/protocol faults (no match context is known or safe to name). A
   * command failure names its match and the revision the client believed, so a stale client can
   * reconcile without a second round-trip. */
  function sendError(conn, code, context) {
    const frame = { protocol: PROTOCOL, operation: 'error', code: publicCode(code) };
    if (context !== undefined) {
      frame.match_id = context.match_id;
      frame.expected_revision = context.expected_revision;
    }
    sendText(conn, frame);
  }
  function protocolError(conn) { closeSocket(conn, CLOSE_PROTOCOL, true); }
  function oversize(conn) { closeSocket(conn, CLOSE_TOO_BIG, true); }

  /* --------------------------------------------------------- frame decoding --- */

  /* Frames are parsed eagerly and synchronously as bytes arrive; a complete frame is consumed
   * before the next byte is buffered, so the read buffer never needs to hold more than ONE bounded
   * frame (plus its header). Every failure path closes the socket, so a malformed stream can never
   * be interpreted a second time. */
  function onData(conn, chunk) {
    if (conn.destroyed || conn.closing) return;
    conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
    parseFrames(conn);
  }

  function parseFrames(conn) {
    while (!conn.destroyed && !conn.closing) {
      const buffer = conn.buffer;
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      /* No extension was negotiated, so every reserved bit MUST be zero. */
      if ((first & 0x70) !== 0) { protocolError(conn); return; }
      /* RFC 6455 §5.1: a frame from a client MUST be masked. */
      if ((second & 0x80) === 0) { protocolError(conn); return; }

      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
        if (length < 126) { protocolError(conn); return; } /* non-minimal encoding */
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        offset += 8;
        if (high !== 0) { oversize(conn); return; } /* > 4 GiB: beyond every bound */
        length = low;
        if (length < 65536) { protocolError(conn); return; } /* non-minimal encoding */
      }

      const control = opcode >= OP_CLOSE;
      if (control) {
        /* A control frame MUST NOT be fragmented and MUST NOT carry more than 125 bytes. */
        if (!fin || length > MAX_CONTROL_PAYLOAD) { protocolError(conn); return; }
      } else if (opcode !== OP_CONTINUATION && opcode !== OP_TEXT) {
        /* 0x2-0x7 are reserved (no extension negotiated) and 0xB-0xF are undefined. */
        protocolError(conn); return;
      } else {
        /* The message bound covers one frame AND the accumulated fragments; it is enforced on the
         * declared length, before the payload is buffered. */
        const accumulated = opcode === OP_CONTINUATION && conn.fragments ? conn.fragments.length : 0;
        if (length + accumulated > maxEnvelopeBytes) { oversize(conn); return; }
      }

      if (buffer.length < offset + 4) return;
      const maskOffset = offset;
      offset += 4;
      if (buffer.length < offset + length) return; /* wait for the whole payload */

      const frame = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) frame[i] = buffer[offset + i] ^ buffer[maskOffset + (i & 3)];
      conn.buffer = buffer.subarray(offset + length);
      /* A control frame may sit between the fragments of a data message, so `conn.fragments` is
       * never touched here - only a completed data message clears it. The loop then consumes the
       * NEXT frame in the same buffer, so a burst of small frames in one TCP segment is answered in
       * order without ever exceeding the bound (every frame's declared length was checked above). */
      deliverFrame(conn, fin, opcode, frame);
    }
  }

  function deliverFrame(conn, fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      /* RFC 6455 §5.5.1: a 1-byte close payload is malformed, an invalid status code is refused. */
      if (payload.length === 0) { closeSocket(conn, CLOSE_NORMAL); return; }
      if (payload.length === 1) { protocolError(conn); return; }
      const code = payload.readUInt16BE(0);
      /* RFC 6455 §7.4.2: 1004/1005/1006 and 1015 are never sent in a frame; 1012-1014 are
       * IANA-assigned and refused here. Anything unassigned is a protocol error. */
      const legal = code === 1000 || code === 1001 || code === 1002 || code === 1003 || code === 1007
        || code === 1008 || code === 1009 || code === 1010 || code === 1011
        || (code >= 3000 && code <= 4999);
      if (!legal) { protocolError(conn); return; }
      /* A peer's close reply to our own close frame (or a first close) completes the handshake; the
       * socket is freed at once instead of waiting out the grace backstop. */
      if (conn.closing) { conn.socket.destroy(); return; }
      closeSocket(conn, code);
      return;
    }
    if (opcode === OP_PING) { sendControl(conn, OP_PONG, payload); return; }
    if (opcode === OP_PONG) return; /* keepalive acknowledgement: nothing to do */
    if (opcode === OP_TEXT) {
      if (conn.fragments) { protocolError(conn); return; } /* a new message started mid-fragment */
      if (!fin) { conn.fragments = payload; return; }
      onText(conn, payload.toString('utf8'));
      return;
    }
    /* OP_CONTINUATION */
    if (!conn.fragments) { protocolError(conn); return; }
    conn.fragments = conn.fragments.length === 0 ? payload : Buffer.concat([conn.fragments, payload]);
    if (!fin) return;
    const message = conn.fragments;
    conn.fragments = null;
    onText(conn, message.toString('utf8'));
  }

  /* ------------------------------------------------------------ dispatching --- */

  /* One connection, one ordered queue: an awaited ticket redemption or membership probe can never
   * be overtaken by the next frame, and a rejected task never becomes an unhandled rejection. */
  function enqueue(conn, task) {
    conn.chain = conn.chain.then(task).catch(() => {});
  }

  /* A whole text message, already bounded by the frame parser. Malformed JSON and a shape the frozen
   * contract rejects both produce a safe error frame; the socket stays open so the client may
   * correct itself. */
  function onText(conn, text) {
    if (conn.destroyed || conn.closing) return;
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { sendError(conn, 'INVALID_ENVELOPE'); return; }
    let message;
    try { message = validateEnvelope(parsed, { authenticatedActor: conn.actor || undefined }); }
    catch (error) { sendError(conn, safeCode(error)); return; }
    enqueue(conn, () => dispatch(conn, message));
  }

  function sendPong(conn) {
    /* `clock()` output is an epoch millisecond count (the application clock convention), which
     * always fits the contract's server_now bound; the envelope guard is applied as a belt-and-braces
     * check so a misconfigured clock degrades to a plain code rather than an out-of-shape frame. */
    const now = clock();
    try { validateEnvelope({ protocol: PROTOCOL, operation: 'ping', server_now: now }); }
    catch { sendError(conn, 'SERVICE_UNAVAILABLE'); return; }
    sendText(conn, { protocol: PROTOCOL, operation: 'pong', server_now: now });
  }

  async function dispatch(conn, message) {
    if (conn.destroyed || conn.closing) return;
    if (message.operation === 'ticket.redeem') {
      /* One ticket, one connection: a redeemed connection is already bound to an actor/session
       * generation, so a second ticket cannot re-bind it. */
      if (conn.actor) { sendError(conn, 'INVALID_OPERATION'); return; }
      await redeem(conn, message);
      return;
    }
    if (!conn.actor) {
      /* The one harmless pre-auth keepalive is answered; a client-side error frame needs no answer;
       * everything else is refused with the same code the HTTP bridge would use. */
      if (message.operation === 'ping') { sendPong(conn); return; }
      if (message.operation === 'error') return;
      sendError(conn, 'AUTH_REQUIRED');
      return;
    }
    if (message.operation === 'ping') { sendPong(conn); return; }
    if (message.operation === 'error') return;
    if (message.operation === 'subscribe') { await subscribe(conn, message); return; }
    if (message.operation === 'resume') { await resume(conn, message); return; }
    if (message.operation === 'command') { await command(conn, message); return; }
    /* `snapshot` / `delta` / `ack` are server-originated: a client may not push them at the
     * transport, and pretending to serve one would be a lie about the authority. */
    sendError(conn, 'SERVICE_UNAVAILABLE');
  }

  /* ------------------------------------------------------------- ticket.redeem -- */

  /* The socket is authenticated by redeeming a one-use ticket, and by nothing else. The envelope's
   * ticket is the only authorization input; the grant's STORED actor/session/generation/matchScope
   * become this connection's identity. */
  async function redeem(conn, message) {
    /* The client answered in time; the auth deadline stops here (a slow PostgreSQL round-trip must
     * not race a timeout that would tell a mid-redemption client it never authenticated). */
    clearAuthTimer(conn);
    let grant;
    try {
      grant = await redeemRealtimeTicket(pool, {
        ticket: message.ticket,
        connectionId: conn.id,
        node: CORE_NODE,
        now: clock,
      });
    } catch (error) {
      if (conn.destroyed) return;
      const code = safeCode(error);
      sendError(conn, code);
      /* A refused ticket is an authorization failure, not a server fault. */
      closeSocket(conn, code === 'SERVICE_UNAVAILABLE' ? CLOSE_INTERNAL : CLOSE_POLICY);
      return;
    }
    if (conn.destroyed) return;
    conn.actor = grant.actorId;
    conn.sessionId = grant.sessionId;
    conn.generation = grant.generation;
    conn.matchScope = grant.matchScope === undefined ? null : grant.matchScope;
    registerRoute(conn, null);
    sendText(conn, { protocol: PROTOCOL, operation: 'ack', match_id: grant.matchScope || 'auth', ack_revision: 0 });
  }

  /* -------------------------------------------------------------- subscribe --- */

  /* The durable membership probe, in ONE read-only transaction so both rows are read at one
   * committed snapshot. `match.participants` is the authority a subscription is enforced against;
   * `match.matches` only proves the match row exists (a terminal status still receives its
   * committed snapshot - V5-08-04 resumes from it). */
  async function membership(actor, matchId) {
    try {
      return await pool.withTransaction(async (tx) => {
        const participant = await tx.query('SELECT 1 FROM match.participants WHERE match_id = $1 AND actor_id = $2', [matchId, actor]);
        const match = await tx.query('SELECT status FROM match.matches WHERE match_id = $1', [matchId]);
        if (match.rows.length === 0) return { code: 'UNKNOWN_MATCH' };
        if (participant.rows.length === 0) return { code: 'NOT_PARTICIPANT' };
        return { code: null };
      });
    } catch (error) {
      return { code: safeCode(error) };
    }
  }

  async function subscribe(conn, message) {
    const matchId = message.match_id;
    /* A ticket bound to one match scope can never be widened here: the connection may only join the
     * match its grant named. */
    if (conn.matchScope && conn.matchScope !== matchId) { sendError(conn, 'FORBIDDEN'); return; }
    const probe = await membership(conn.actor, matchId);
    if (conn.destroyed) return;
    if (probe.code) { sendError(conn, probe.code); return; }
    let view;
    try {
      view = await core.readMatch(conn.actor, matchId);
    } catch (error) {
      if (conn.destroyed) return;
      sendError(conn, safeCode(error));
      return;
    }
    if (conn.destroyed) return;
    if (!view || typeof view !== 'object' || !Number.isSafeInteger(view.revision)) { sendError(conn, 'SERVICE_UNAVAILABLE'); return; }
    conn.subscriptions.add(matchId);
    registerRoute(conn, matchId);
    sendText(conn, snapshotFrame(matchId, view, false));
  }

  /* --------------------------------------------------------------- command --- */

  /* The committed revision, read from PostgreSQL AFTER the transaction boundary returned. The
   * transport keeps NO revision of its own: `resign` answers with a receipt that names no revision
   * and a replayed `move` commits nothing new, so the authority's committed aggregate is the only
   * honest source for `ack_revision` and for every broadcast `snapshot`. */
  async function committedView(actor, matchId) {
    const view = await core.readMatch(actor, matchId);
    if (!view || typeof view !== 'object' || !Number.isSafeInteger(view.revision)) throw Error('SERVICE_UNAVAILABLE');
    return view;
  }

  /* Fan the committed view out to every local socket subscribed to this match. A socket that closed
   * or unsubscribed mid-await is gone from both the registry and its own set, and sendText drops a
   * closing socket, so a subscriber can never be written after teardown. */
  function broadcastSnapshot(matchId, view) {
    /* Remember the revision this process fanned out for the match: a `core-match` hint that only
     * echoes this very commit (which this process already delivered) is suppressed rather than
     * duplicating every local subscriber's snapshot. */
    lastBroadcast.set('b|' + matchId, view.revision);
    for (const peer of connections.values()) {
      if (peer.destroyed || peer.closing) continue;
      if (!peer.subscriptions.has(matchId)) continue;
      sendText(peer, snapshotFrame(matchId, view, false));
    }
  }

  /* -------------------------------------------------------- multi-process hints --- */

  /* The `core-match` wake-up: another Core committed a change to `matchId`. A hint is NEVER
   * authority, so this only decides WHETHER to reread and for whom - the durable document is the
   * broadcast. Nothing is done for a hint that names a match no local socket watches (no wasted
   * `core.readMatch`) or that merely echoes a revision this process already fanned out. The reread
   * uses one already-subscribed local actor, because `core.readMatch` enforces match.participants
   * membership: a non-participant read can neither prove nor broadcast the match. */
  function onMatchHint(text) {
    if (closed || draining) return;
    const matchId = matchHintId(text);
    if (matchId === null) return;
    /* A local command is mid-flight for this match: its own echo must not fan out a snapshot before
     * the command handler's ordered ack+broadcast. Mark it pending; the worker re-reads after the
     * echo settles and the suppression marker decides. */
    if (pendingEcho.has(matchId)) { hintPending.add(matchId); return; }
    hintPending.add(matchId);
    drainHints(matchId);
  }
  async function drainHints(matchId) {
    if (hintInFlight.has(matchId) || closed || draining) return;
    hintInFlight.add(matchId);
    try {
      while (hintPending.has(matchId) && !closed && !draining) {
        hintPending.delete(matchId);
        /* Re-resolve a local subscriber every pass: it may have gone away while the reread ran. */
        let actor = null;
        for (const peer of connections.values()) {
          if (!peer.destroyed && !peer.closing && peer.subscriptions.has(matchId)) { actor = peer.actor; break; }
        }
        if (actor === null) break;
        let view;
        try { view = await committedView(actor, matchId); }
        catch { break; } /* a transient read fault keeps the match; the next hint rereads */
        if (closed || draining) break;
        /* Self-echo or an already-delivered revision: this process fanned that exact revision out.
         * Any other revision is a genuine other-process commit and is broadcast. */
        if (lastBroadcast.get('b|' + matchId) === view.revision) continue;
        broadcastSnapshot(matchId, view);
      }
    } finally { hintInFlight.delete(matchId); }
  }
  /* Opens the ONE owned `core-match` subscription. A missing `subscribe` capability (or a fault) is
   * conservative: this transport simply falls back to local fan-out and every recovery path still
   * reads committed PostgreSQL truth. This NEVER constructs, reconfigures or closes the caller's
   * adapter. */
  async function openMatchHints() {
    if (!ephemera || typeof ephemera.subscribe !== 'function') return false;
    try {
      const opened = await ephemera.subscribe(MATCH_CHANNEL, (text) => onMatchHint(text));
      if (!opened || typeof opened !== 'object') return false;
      matchSubscription = opened;
      return opened.available === true;
    } catch { matchSubscription = null; return false; }
  }
  /* Releases the owned subscription (never the caller's adapter). Bounded and idempotent; a failing
   * unsubscribe is swallowed. */
  function closeMatchHints() {
    const sub = matchSubscription;
    matchSubscription = null;
    if (!sub || typeof sub.unsubscribe !== 'function') return Promise.resolve();
    try {
      const result = sub.unsubscribe();
      if (result && typeof result.then === 'function') return result.then(() => {}, () => {});
    } catch { /* releasing an owned subscription is best-effort */ }
    return Promise.resolve();
  }

  /* ONE command envelope -> ONE Core transaction -> ack + fan-out (V5-08-02).
   *
   * The order below IS the contract:
   *   1. authority: an unauthenticated socket is refused before anything else; a ticket scoped to
   *      one match can never be widened; membership is proven by the committed match.participants
   *      row rather than by the subscription set the client controls.
   *   2. shape: only `move`/`resign` are supported (`coreCommand`), and a `move` missing its
   *      coordinates is `INVALID_MOVE` - both refused BEFORE the transaction, so a malformed client
   *      never opens a database transaction.
   *   3. the revision transaction: `core.run` locks the match row, looks the operation outcome up
   *      BEFORE the stale-revision/legality checks (a lost-response retry therefore returns the
   *      PRIOR result), compares the payload fingerprint (an altered payload under the same key is
   *      IDEMPOTENCY_CONFLICT and rolls back the whole transaction) and commits outcome/outbox
   *      atomically. `expected_revision` travels as `command.revision` and is compared INSIDE that
   *      transaction against the locked revision - never here, where it would race.
   *   4. the committed read: `core.readMatch` is the post-commit truth for `ack_revision` and for the
   *      broadcast, and it re-proves the actor is still seated (a match that closed under the
   *      command fails the read rather than broadcasting state the actor may no longer see).
   *   5. ack to the sender first, then the same committed view to every subscriber. */
  async function command(conn, message) {
    const matchId = message.match_id;
    if (conn.matchScope && conn.matchScope !== matchId) {
      sendError(conn, 'FORBIDDEN', message);
      return;
    }
    if (!conn.subscriptions.has(matchId)) {
      sendError(conn, 'NOT_PARTICIPANT', message);
      return;
    }
    let payload;
    try { payload = coreCommand(message); }
    catch (error) { sendError(conn, commandCode(error.message), message); return; }
    /* Arm the self-echo latch for this match BEFORE the commit. `core.run` publishes the hint only
     * after its transaction commits, and the transport's own subscriber can deliver it back before
     * this handler's ordered ack+broadcast runs; a hint for a match with a command in flight is held
     * pending (never fanned out early) until the broadcast below clears it. A refused/rolled-back
     * command publishes nothing, so the finally block's release is all that is needed. The latch is a
     * count so two commands for the same match cannot clear each other's hold. */
    pendingEcho.set(matchId, (pendingEcho.get(matchId) || 0) + 1);
    try {
      try {
        await core.run({ actor: conn.actor, scope: 'player' }, message.operation_id, payload);
      } catch (error) {
        if (conn.destroyed) return;
        sendError(conn, commandCode(error.message), message);
        return;
      }
      if (conn.destroyed) return;
      let view;
      try { view = await committedView(conn.actor, matchId); }
      catch (error) {
        if (conn.destroyed) return;
        sendError(conn, commandCode(error.message), message);
        return;
      }
      if (conn.destroyed) return;
      sendText(conn, { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: view.revision });
      broadcastSnapshot(matchId, view);
    } finally {
      /* Release the latch; the LAST command in flight re-runs any held hint, whose own durable-revision
       * suppression decides whether anything is owed. */
      const left = (pendingEcho.get(matchId) || 1) - 1;
      if (left <= 0) {
        pendingEcho.delete(matchId);
        if (hintPending.has(matchId)) drainHints(matchId);
      } else pendingEcho.set(matchId, left);
    }
  }

  /* ---------------------------------------------------------------- resume --- */

  /* One authenticated client, one acknowledged revision: the V5-08-04 recovery contract.
   *
   * A client that was away (backgrounded app, dropped network, a lost pubsub fan-out) returns with
   * the last revision it APPLIED. The transport never replays that client's own moves: it compares
   * the claim against the durable head and answers the smallest honest thing.
   *   - claim === head: `ack`. The client is already synchronized; nothing follows.
   *   - claim <  head, the miss is within the bounded window, and the durable move log is exactly as
   *     long as the revision (a contiguous window): the `delta` of the committed moves it missed,
   *     followed by the authoritative `snapshot`. The snapshot alone synchronizes by replacement, so
   *     the client never reapplies a move it already holds; the delta lets it replay the gap.
   *   - anything else - a miss beyond the window, a revision step that was not a move (a resign or a
   *     timeout), a truncated state read, or a claim AHEAD of the authority - the full committed
   *     `snapshot`, which brings the client to the true head whether it was behind or corrupted.
   *
   * Membership comes from PostgreSQL, never from the client's own subscription set: a connection
   * that is not yet subscribed is seated here only if `match.participants` says it may be. The
   * authority's committed revision decides everything; the client's `ack_revision` is a hint the
   * transport never trusts. */
  async function resume(conn, message) {
    const matchId = message.match_id;
    if (conn.matchScope && conn.matchScope !== matchId) { sendError(conn, 'FORBIDDEN'); return; }
    if (!conn.subscriptions.has(matchId)) {
      const probe = await membership(conn.actor, matchId);
      if (conn.destroyed) return;
      if (probe.code) { sendError(conn, probe.code); return; }
      conn.subscriptions.add(matchId);
      registerRoute(conn, matchId);
    }
    let view;
    try { view = await committedView(conn.actor, matchId); }
    catch (error) {
      if (conn.destroyed) return;
      sendError(conn, safeCode(error));
      return;
    }
    if (conn.destroyed) return;
    const ackRevision = message.ack_revision;
    if (ackRevision === view.revision) {
      sendText(conn, { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: view.revision });
      return;
    }
    const moves = view.state && Array.isArray(view.state.moves) ? view.state.moves : null;
    if (moves !== null && ackRevision < view.revision
      && view.revision - ackRevision <= MAX_DELTA_MOVES
      && moves.length === view.revision) {
      sendText(conn, deltaFrame(matchId, view, ackRevision));
    }
    sendText(conn, snapshotFrame(matchId, view, true));
  }

  /* --------------------------------------------------- HTTP snapshot fallback --- */

  /* The recovery read for a client that cannot hold a socket open (an old browser, a proxy that
   * refuses upgrades, a native shell that only does HTTP). `GET /realtime/v1/snapshot?match_id=..
   * &actor=..` and its match-addressed alias `GET /realtime/v1/match/:id?actor=..` answer the CURRENT
   * committed view as application/json - the same `core.readMatch` document the socket serves, never
   * a cache and never a transport-side board.
   *
   * The listener is PREPENDED, so it runs before the host's own request handler and answers only
   * these two paths. Node invokes EVERY 'request' listener synchronously, and the authority read
   * below is asynchronous, so a host handler MUST yield these two paths (a `res.headersSent` guard
   * alone is not enough: the answer lands a PostgreSQL round-trip later). Every other path is not
   * touched at all and the host's handler runs exactly as before. On the two paths it owns the
   * listener never leaves the peer without an answer: a read it cannot authorize (or that the
   * authority refuses) gets a status for its own public code, and a write is refused 405 rather
   * than handed back. No state is ever served to an unproven caller. */
  function httpQuery(target) {
    if (typeof target !== 'string') return new URLSearchParams();
    const at = target.indexOf('?');
    if (at === -1) return new URLSearchParams();
    try { return new URLSearchParams(target.slice(at + 1)); }
    catch { return new URLSearchParams(); }
  }
  /* A write to a read-only recovery path is refused HERE rather than left to a host handler that
   * has been told to yield these paths - an unanswered request would pin the socket. Node itself
   * strips the body of a HEAD response, so GET and HEAD share the read. */
  function snapshotReadOnly(res) {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(405, http.STATUS_CODES[405], {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Allow: 'GET, HEAD',
    });
    res.end(JSON.stringify({ protocol: PROTOCOL, operation: 'error', code: 'INVALID_ENVELOPE' }));
  }
  async function onRequest(req, res) {
    const route = snapshotRequest(req.url);
    if (route === null) return;
    /* V5-08-05 drain: a draining Core serves no new recovery read; the caller's other Core does. */
    if (draining) { sendJson(res, 503, { protocol: PROTOCOL, operation: 'error', code: 'SERVICE_UNAVAILABLE' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { snapshotReadOnly(res); return; }
    const query = httpQuery(req.url);
    const matchId = route.match_id === null ? query.get('match_id') : route.match_id;
    if (!ENVELOPE_FIELDS.match_id(matchId)) { sendSnapshotError(res, 'INVALID_ENVELOPE'); return; }
    if (!authenticateHttp) { sendSnapshotError(res, 'AUTH_REQUIRED'); return; }
    let principal;
    try { principal = await authenticateHttp(req); }
    catch (error) { sendSnapshotError(res, safeCode(error)); return; }
    if (!principal || typeof principal !== 'object' ||
        !ENVELOPE_FIELDS.actor(principal.actor)) {
      sendSnapshotError(res, 'AUTH_REQUIRED');
      return;
    }
    /* Keep the historical ?actor= URL as a compatibility assertion only.
     * A caller cannot impersonate a participant by changing its query value.
     * Without the legacy field, the verified identity still authorizes reads. */
    const actorHint = query.get('actor');
    if (actorHint !== null && actorHint !== principal.actor) {
      sendSnapshotError(res, 'FORBIDDEN');
      return;
    }
    let view;
    try { view = await committedView(principal.actor, matchId); }
    catch (error) { sendSnapshotError(res, safeCode(error)); return; }
    sendJson(res, 200, snapshotFrame(matchId, view, true));
  }

  /* -------------------------------------------------------------- handshake ---- */

  function onAuthTimeout(conn) {
    if (conn.destroyed || conn.closing || conn.actor) return;
    sendError(conn, 'AUTH_REQUIRED');
    closeSocket(conn, CLOSE_POLICY);
  }

  /* Node calls EVERY registered 'upgrade' listener for an upgrade request, so a co-hosted listener
   * is invited to claim it as usual; this transport simply declines every path but its own. But
   * Node answers NOTHING when all listeners decline, leaving the peer connected indefinitely - a
   * leak on a shared server. So an unrelated request is re-examined after the emit completes (all
   * listeners are synchronous) and refused only if nobody claimed it; a listener that already wrote
   * to or ended the socket is left untouched. */
  function refuseUnrelated(socket) {
    socket.on('error', () => { /* a peer that resets before the answer must not be process-fatal */ });
    setImmediate(() => {
      if (socket.destroyed || socket.writableEnded || socket.bytesWritten > 0) return;
      try { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
      catch { socket.destroy(); }
    });
  }
  function refuseUpgrade(socket, headers) {
    const lines = [
      'HTTP/1.1 400 Bad Request',
      'Connection: close',
      'Content-Length: 0',
      ...(headers || []),
      '', '',
    ];
    try { socket.end(lines.join('\r\n')); }
    catch { socket.destroy(); }
  }

  function onUpgrade(req, socket, head) {
    /* Nonconflicting ingress: any other request-target is declined here and answered by
     * refuseUnrelated only if no co-hosted upgrade listener claimed it. */
    if (ingressPath(req.url) !== INGRESS_PATH) { refuseUnrelated(socket); return; }
    /* V5-08-05 drain: a draining transport accepts no new session; the peer is answered with 503 and
     * the socket drained (never left hanging) so the caller's routing can send it to a surviving
     * Core. */
    if (draining) {
      socket.on('error', () => { /* always followed by 'close' */ });
      try { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
      catch { socket.destroy(); }
      return;
    }
    socket.on('error', () => { /* always followed by 'close', where teardown runs */ });
    const headers = req.headers || {};
    const version = headers['sec-websocket-version'];
    const key = headers['sec-websocket-key'];
    const upgrade = headers.upgrade;
    if (req.method !== 'GET'
      || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket'
      || version !== WEBSOCKET_VERSION
      || typeof key !== 'string' || !WEBSOCKET_KEY.test(key)
      || Number(headers['content-length']) > MAX_HANDSHAKE_BYTES) {
      refuseUpgrade(socket, version === WEBSOCKET_VERSION ? [] : [`Sec-WebSocket-Version: ${WEBSOCKET_VERSION}`]);
      return;
    }
    const accept = crypto.createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
    const conn = {
      id: crypto.randomBytes(16).toString('hex'),
      socket,
      actor: null,
      sessionId: null,
      generation: 0,
      matchScope: null,
      subscriptions: new Set(),
      chain: Promise.resolve(),
      buffer: EMPTY,
      fragments: null,
      authTimer: null,
      grace: null,
      route: false,
      closing: false,
      destroyed: false,
    };
    connections.set(conn.id, conn);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => onData(conn, chunk));
    socket.on('end', () => teardown(conn));
    socket.on('error', () => teardown(conn));
    socket.on('close', () => teardown(conn));
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    /* Bytes the client pipelined with its handshake (and any partial frame) are already protocol
     * payload, not a new HTTP request. */
    if (head && head.length > 0) onData(conn, head);
    conn.authTimer = setTimeout(() => onAuthTimeout(conn), authTimeoutMs);
    conn.authTimer.unref();
  }

  server.on('upgrade', onUpgrade);
  server.prependListener('request', onRequest);
  /* V5-08-05: open the ONE owned `core-match` subscription. Started here and exposed as `ready`; a
   * frame handler NEVER awaits it, so an unavailable adapter (or no `subscribe` capability) simply
   * leaves hints off while every local commit is still fanned out and every recovery path still
   * reads PostgreSQL. */
  matchReady = openMatchHints();

  /* V5-08-05 graceful drain, shared by beginDrain() and close(). Stops accepting new sessions by
   * flipping `draining` (onUpgrade then refuses every ingress upgrade with 503, and the HTTP
   * fallback with 503), releases the owned `core-match` subscription so no further hint work starts,
   * and sends RFC 6455 close code 1000 to every live socket so each peer reconnects to a surviving
   * Core. Returns the sockets that were live when the drain began. The upgrade/request listeners stay
   * registered so a racing peer is answered rather than left hanging; close() removes them. The
   * server, pool, core service and ephemera adapter stay caller-owned and are NOT touched. */
  async function drainAll() {
    if (!draining) {
      draining = true;
      await matchReady;
      await closeMatchHints();
    }
    const live = [...connections.values()].filter((conn) => !conn.destroyed);
    for (const conn of live) {
      clearAuthTimer(conn);
      closeSocket(conn, CLOSE_NORMAL);
    }
    return live;
  }
  async function shutdown() {
    if (closed) return;
    const live = await drainAll();
    closed = true;
    server.removeListener('upgrade', onUpgrade);
    server.removeListener('request', onRequest);
    const pending = live.filter((conn) => !conn.destroyed);
    if (pending.length > 0) {
      const drained = Promise.all(pending.map((conn) => new Promise((resolve) => {
        conn.socket.once('close', resolve);
      })));
      const backstop = setTimeout(() => { for (const conn of pending) conn.socket.destroy(); }, CLOSE_GRACE_MS);
      backstop.unref();
      await drained;
      clearTimeout(backstop);
    }
    connections.clear();
  }

  return Object.freeze({
    /* The staged ingress path this transport answered, for routing/monitoring callers. */
    ingressPath: INGRESS_PATH,
    /* V5-08-05 readiness of the cross-process hint channel: resolves `true` once the owned
     * `core-match` subscription is open (multi-process routing live), `false` when hints are
     * definitively unavailable (no adapter/capability or a subscribe fault). The transport itself
     * never depends on it - every path reads committed PostgreSQL truth - but a caller may await it
     * before relying on another Core's commits reaching this process's clients. */
    ready: matchReady,
    stats() {
      let authenticated = 0;
      let subscriptions = 0;
      for (const conn of connections.values()) {
        if (conn.actor) authenticated += 1;
        subscriptions += conn.subscriptions.size;
      }
      return Object.freeze({
        connections: connections.size,
        authenticated,
        subscriptions,
        maxEnvelopeBytes,
        authTimeoutMs,
        closed,
      });
    },
    /* V5-08-05 graceful drain. Stops accepting new upgrades (and new HTTP recovery reads), sends
     * RFC 6455 close code 1000 to every live socket so each peer reconnects to a surviving Core, and
     * releases the owned `core-match` subscription so no further hint work starts. Idempotent.
     * Resolves with the number of live sockets it sent a close frame to, so a caller can wait for
     * them to leave the registry (or call close() to await full teardown). */
    async beginDrain() {
      const live = await drainAll();
      return { draining: true, connections: live.length };
    },
    /* Full teardown: drains (idempotently) and then awaits every socket's departure. Once closed, a
     * later beginDrain()/close() is a no-op. A peer that never acknowledges the close frame is
     * destroyed after CLOSE_GRACE_MS, so this always resolves. */
    async close() {
      await shutdown();
    },
  });
}

module.exports = { createRealtimeTransport, INGRESS_PATH, DEFAULT_MAX_BUFFER_BYTES };
