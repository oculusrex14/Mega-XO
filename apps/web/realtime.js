/* Read-only realtime/v1 client. HTTP remains the only mutation channel.
 * Tickets live only in the connection attempt; acknowledgments and deltas are
 * recovery hints, never board, settlement or wallet authority. */
const PROTOCOL = 'realtime/v1';
const TERMINAL = new Set(['FINISHED', 'VOID']);
const AUTH_CODES = new Set(['AUTH_REQUIRED', 'LINK_ACCOUNT_REQUIRED', 'SESSION_REVOKED', 'ACCOUNT_HELD']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const cell = value => Number.isInteger(value) && value >= 0 && value <= 8;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_key, entry) => object(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

/** Validate identities and continuity before either HTTP or socket presentation. */
export function canApplyMatchSnapshot(next, previous, actor, matchId) {
  if (!object(next) || next.id !== matchId || !['PLAYING', 'FINISHED', 'VOID'].includes(next.status) || !integer(next.revision)) return false;
  if (!Array.isArray(next.players) || next.players.length !== 2 || !next.players.every(player => typeof player === 'string' && player.length > 0 && player.length <= 160) || next.players[0] === next.players[1] || !next.players.includes(actor)) return false;
  if (!object(next.symbols) || next.symbols.X === next.symbols.O || !next.players.includes(next.symbols.X) || !next.players.includes(next.symbols.O)) return false;
  const state = next.state;
  if (!object(state) || !Array.isArray(state.board) || state.board.length !== 9 || !state.board.every(row => Array.isArray(row) && row.length === 9 && row.every(v => v === null || v === 'X' || v === 'O'))) return false;
  if (!Array.isArray(state.mini) || state.mini.length !== 9 || !state.mini.every(v => [null, 'X', 'O', 'DRAW'].includes(v)) || !['X', 'O'].includes(state.turn) || !(state.required === null || cell(state.required)) || ![null, 'X', 'O', 'DRAW'].includes(state.winner)) return false;
  if (!Array.isArray(state.moves) || state.moves.length > 81 || !state.moves.every(m => object(m) && cell(m.b) && cell(m.c) && ['X', 'O'].includes(m.player))) return false;
  if (!(state.line === null || (Array.isArray(state.line) && state.line.length === 3 && state.line.every(cell) && new Set(state.line).size === 3))) return false;
  if (new Set(state.moves.map(m => m.b + ':' + m.c)).size !== state.moves.length || state.moves.some(m => state.board[m.b][m.c] !== m.player) || state.board.flat().filter(Boolean).length !== state.moves.length) return false;
  if (next.revision !== state.moves.length) return false;
  if (!previous) return true;
  if (previous.id !== next.id || previous.symbols?.X !== next.symbols.X || previous.symbols?.O !== next.symbols.O || next.revision < previous.revision) return false;
  if (TERMINAL.has(previous.status) && previous.status !== next.status) return false;
  const moves = previous.state?.moves;
  if (!Array.isArray(moves) || state.moves.length < moves.length) return false;
  if (!moves.every((m, i) => m.b === state.moves[i].b && m.c === state.moves[i].c && m.player === state.moves[i].player)) return false;
  if (moves.length === state.moves.length && ['board', 'mini', 'turn', 'required', 'line'].some(key => stable(previous.state[key]) !== stable(state[key]))) return false;
  if (TERMINAL.has(previous.status) && previous.receipt != null && stable(previous.receipt) !== stable(next.receipt)) return false;
  if (previous.settled === true && next.settled !== true) return false;
  return true;
}

export function realtimeUrl(href) {
  const page = new URL(href);
  if (!['http:', 'https:'].includes(page.protocol)) throw Error('REALTIME_UNAVAILABLE');
  const url = new URL('/realtime/v1', page.origin);
  url.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** getContext returns actorId, match, session (opaque in-memory identity), and
 * epoch (route/account lifecycle). Every async callback checks all four. */
export function createRealtimeReader({ getContext, request, receive, changed = () => {}, onAuthRequired = () => {},
  Socket = globalThis.WebSocket, href = () => globalThis.location.href,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now } = {}) {
  let binding = null, socket = null, generation = 0, attempt = 0, phase = 'idle';
  let retryTimer, handshakeTimer, heartbeatTimer, pongTimer, recovery = null;
  let appliedVersion = 0, lastRevision = 0, lastSnapshot = null, destroyed = false, subscribed = false;
  const timers = () => { for (const timer of [retryTimer, handshakeTimer, heartbeatTimer, pongTimer]) if (timer !== undefined) cancel(timer); retryTimer = handshakeTimer = heartbeatTimer = pongTimer = undefined; };
  const same = (a, b) => a && b && a.actorId === b.actorId && a.matchId === b.match?.id && a.epoch === b.epoch && a.session === b.session;
  function owns(token, target) { const current = getContext(); return !destroyed && token === generation && target === binding && target && current?.actorId === target.actorId && current.match?.id === target.matchId && current.epoch === target.epoch; }
  function valid(token = generation, target = binding) {
    if (!owns(token, target)) return false;
    const current = getContext();
    if (target.session == null && current.session != null) target.session = current.session;
    return same(target, current);
  }
  // Shared HTTP clears its cached session before rejecting AUTH_REQUIRED.
  // Null is allowed only for that refusal, never for applying player state.
  function authOwned(token, target) { return owns(token, target) && (getContext()?.session == null || valid(token, target)); }
  function status(value) { phase = value; changed({ status: value }); }
  function clearRecovery() { if (recovery) { cancel(recovery.timer); recovery.expire?.(null); recovery = null; } }
  function close() { const old = socket; socket = null; subscribed = false; if (old) { old.onopen = old.onmessage = old.onerror = old.onclose = null; try { old.close(); } catch {} } }
  function stop() { generation++; timers(); close(); clearRecovery(); binding = null; attempt = 0; phase = 'idle'; }
  function auth(code) { stop(); status('auth'); onAuthRequired(Error(AUTH_CODES.has(code) ? code : 'AUTH_REQUIRED')); }
  function send(message) { if (!socket || socket.readyState !== 1) return false; try { socket.send(JSON.stringify({ protocol: PROTOCOL, ...message })); return true; } catch { return false; } }
  function retry(token, target) {
    if (!valid(token, target)) return;
    generation++; timers(); close(); clearRecovery();
    const next = generation;
    status('fallback');
    recover(next, target);
    retryTimer = schedule(() => { retryTimer = undefined; if (valid(next, target)) connect(); }, Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4)));
  }
  function accept(snapshot, token, target, fromSocket = false) {
    if (!valid(token, target) || !canApplyMatchSnapshot(snapshot, lastSnapshot, target.actorId, target.matchId) || !canApplyMatchSnapshot(snapshot, getContext()?.match, target.actorId, target.matchId)) return false;
    if (receive(snapshot) !== true) return false;
    // receive may retire this connection after a terminal snapshot.
    if (!valid(token, target)) return true;
    lastRevision = snapshot.revision; lastSnapshot = snapshot; appliedVersion++;
    if (fromSocket) { subscribed = true; attempt = 0; }
    if (TERMINAL.has(snapshot.status)) { stop(); status('complete'); }
    else status(subscribed && socket?.readyState === 1 ? 'live' : 'fallback');
    return true;
  }
  async function recover(token = generation, target = binding) {
    if (!valid(token, target)) return false;
    if (recovery?.token === token) return recovery.promise;
    const version = appliedVersion;
    const operation = { token, promise: null, timer: undefined, expire: null };
    recovery = operation;
    const deadline = new Promise(resolve => { operation.expire = resolve; operation.timer = schedule(() => { operation.timer = undefined; resolve(null); }, 12000); });
    operation.promise = (async () => {
      try {
        const frame = await Promise.race([request('/realtime/v1/snapshot?match_id=' + encodeURIComponent(target.matchId)), deadline]);
        if (!valid(token, target) || version !== appliedVersion) return false;
        if (!object(frame) || frame.protocol !== PROTOCOL || frame.operation !== 'snapshot' || frame.match_id !== target.matchId || frame.expected_revision !== frame.snapshot?.revision) return false;
        return accept(frame.snapshot, token, target);
      } catch (error) {
        if (AUTH_CODES.has(error?.message) && authOwned(token, target)) {
          if (version === appliedVersion) auth(error.message);
          else if (getContext()?.session == null) sync();
        }
        return false;
      } finally { cancel(operation.timer); if (recovery === operation) recovery = null; }
    })();
    return operation.promise;
  }
  function heartbeat(token, target) {
    heartbeatTimer = schedule(() => {
      heartbeatTimer = undefined;
      if (!valid(token, target)) return;
      if (!send({ operation: 'ping' })) { retry(token, target); return; }
      pongTimer = schedule(() => { pongTimer = undefined; retry(token, target); }, 10000);
    }, 15000);
  }
  async function connect() {
    if (!binding || destroyed) return;
    const target = binding, token = ++generation;
    timers(); close(); clearRecovery();
    if (typeof Socket !== 'function') { status('fallback'); recover(token, target); return; }
    status('connecting');
    handshakeTimer = schedule(() => retry(token, target), 12000);
    let grant;
    try { grant = await request('/api/v1/ticket', { matchScope: target.matchId }); }
    catch (error) { if (AUTH_CODES.has(error?.message) && authOwned(token, target)) auth(error.message); else if (valid(token, target)) retry(token, target); return; }
    // Account bootstrap may create the first in-memory session while issuing a
    // ticket. It must not replace a captured existing session or route/actor.
    const current = getContext();
    if (!destroyed && token === generation && target === binding && target.session == null && current?.session != null && current.actorId === target.actorId && current.epoch === target.epoch && current.match?.id === target.matchId) target.session = current.session;
    if (!valid(token, target)) return;
    if (!object(grant) || grant.ok !== true || typeof grant.ticket !== 'string' || !grant.ticket || grant.ticket.length > 512 || !integer(grant.expiresAt) || grant.expiresAt <= now()) { retry(token, target); return; }
    let ticket = grant.ticket; const expiresAt = grant.expiresAt; grant = null;
    try { socket = new Socket(realtimeUrl(href())); } catch { ticket = null; retry(token, target); return; }
    const peer = socket;
    let redeemed = false;
    peer.onopen = () => { if (!valid(token, target) || socket !== peer) { ticket = null; return; } if (expiresAt <= now()) { ticket = null; retry(token, target); return; } const value = ticket; ticket = null; if (!send({ operation: 'ticket.redeem', ticket: value })) retry(token, target); };
    peer.onmessage = event => {
      if (!valid(token, target) || socket !== peer) return;
      if (typeof event.data !== 'string' || event.data.length > 270000) { retry(token, target); return; }
      let frame; try { frame = JSON.parse(event.data); } catch { retry(token, target); return; }
      if (!object(frame) || frame.protocol !== PROTOCOL) { retry(token, target); return; }
      if (frame.operation === 'error') { frame.match_id && frame.match_id !== target.matchId ? retry(token, target) : AUTH_CODES.has(frame.code) ? auth(frame.code) : retry(token, target); return; }
      if (!redeemed) {
        if (frame.operation !== 'ack' || frame.match_id !== target.matchId || frame.ack_revision !== 0) { retry(token, target); return; }
        redeemed = true; cancel(handshakeTimer); handshakeTimer = undefined;
        if (!send({ operation: 'subscribe', match_id: target.matchId }) || !send({ operation: 'resume', match_id: target.matchId, ack_revision: lastRevision })) { retry(token, target); return; }
        // Equal-revision resume can acknowledge without returning settlement.
        recover(token, target); heartbeat(token, target);
        return;
      }
      if (frame.operation === 'pong') {
        if (!integer(frame.server_now) || frame.server_now === 0) { retry(token, target); return; }
        cancel(pongTimer); pongTimer = undefined; cancel(heartbeatTimer); heartbeat(token, target); return;
      }
      if (frame.match_id !== target.matchId) { retry(token, target); return; }
      if (frame.operation === 'snapshot') {
        if (frame.expected_revision !== frame.snapshot?.revision || !canApplyMatchSnapshot(frame.snapshot, getContext()?.match, target.actorId, target.matchId)) { subscribed = false; status('fallback'); recover(token, target); return; }
        accept(frame.snapshot, token, target, true);
      } else if ((frame.operation === 'ack' && integer(frame.ack_revision)) || frame.operation === 'delta') {
        // No delta replay or revision advancement: recover the full DTO.
        recover(token, target);
      } else retry(token, target);
    };
    peer.onerror = () => { ticket = null; retry(token, target); };
    // 1008 also covers slow consumers and expired tickets; only an explicit
    // authentication error (or an authenticated HTTP refusal) retires identity.
    peer.onclose = () => { ticket = null; retry(token, target); };
  }
  function sync() {
    const context = getContext();
    if (!context?.actorId || context.match?.status !== 'PLAYING') { if (binding) stop(); return; }
    if (same(binding, context)) return;
    stop();
    binding = { actorId: context.actorId, matchId: context.match.id, session: context.session, epoch: context.epoch };
    lastRevision = context.match.revision; lastSnapshot = context.match; appliedVersion = 0;
    connect();
  }
  return {
    sync, stop, recover: () => recover(),
    reconnect: () => { if (binding) { attempt = 0; connect(); } else sync(); },
    record: snapshot => { if (binding && valid() && canApplyMatchSnapshot(snapshot, lastSnapshot, binding.actorId, binding.matchId)) { lastRevision = snapshot.revision; lastSnapshot = snapshot; appliedVersion++; } },
    status: () => phase,
    destroy: () => { stop(); destroyed = true; },
  };
}
