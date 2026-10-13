'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const game = require('../src/game.js');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/realtime.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const clone = value => structuredClone(value);
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function playing(moves = [], id = 'queue:synthetic-reader-match') {
  const state = moves.reduce((current, move) => game.apply(current, move), game.create());
  return { id, players: ['synthetic-x', 'synthetic-o'], status: 'PLAYING', symbols: { X: 'synthetic-x', O: 'synthetic-o' }, revision: state.moves.length, state, settled: false, receipt: null,
    termsHash: 'synthetic-frozen-terms', terms: { source: 'queue', turnSeconds: 60 }, quote: { rated: false, currency: null, contributions: [0, 0], payout: 0, burn: 0 }, deadline: 1060000 };
}
function terminal(snapshot, status) {
  return { ...clone(snapshot), status, settled: true,
    state: { ...clone(snapshot.state), winner: status === 'FINISHED' ? 'O' : snapshot.state.winner },
    receipt: status === 'FINISHED' ? { winner: 'synthetic-o', reason: 'resign', currency: null, payout: 0, burn: 0, bonus: 0, refunded: 0, rating: null, at: 1000500 }
      : { reason: 'Server cancellation', refunded: 0, burn: 0, payout: 0, rating: null } };
}
const envelope = snapshot => ({ protocol: 'realtime/v1', operation: 'snapshot', match_id: snapshot.id, expected_revision: snapshot.revision, snapshot: clone(snapshot), server_now: 1000000 });
const one = () => playing([{ b: 0, c: 4 }]);
const two = () => playing([{ b: 0, c: 4 }, { b: 4, c: 0 }]);

function clock() {
  let at = 1000000, id = 0;
  const rows = new Map();
  return {
    now: () => at,
    schedule(fn, delay) { const key = ++id; rows.set(key, { fn, delay, due: at + delay }); return key; },
    cancel(key) { rows.delete(key); },
    pending: () => [...rows.values()],
    async advance(milliseconds) {
      const end = at + milliseconds;
      for (let count = 0; count < 100; count++) {
        const next = [...rows.entries()].filter(([, row]) => row.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) { at = end; await flush(); return; }
        at = next[1].due; rows.delete(next[0]); next[1].fn(); await flush();
      }
      throw Error('Synthetic timer failed to remain bounded');
    },
  };
}

async function harness(options = {}) {
  const { createRealtimeReader } = await modulePromise;
  const time = clock(), sockets = [], calls = [], accepted = [], statuses = [], auth = [];
  const context = { actorId: 'synthetic-x', match: clone(options.match || one()), session: options.session === undefined ? { id: 'synthetic-session' } : options.session, epoch: 1 };
  let ticketCount = 0, recoveryCount = 0;
  const result = { time, sockets, calls, accepted, statuses, auth, context, allowReceive: true };
  class Socket {
    constructor(url) {
      if (options.constructorFailure) throw Error('SYNTHETIC_UPGRADE_DENIED');
      this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.push(this);
    }
    send(value) { if (options.sendFailure) throw Error('SYNTHETIC_SEND_FAILED'); this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.closeCount++; }
    open() { this.readyState = 1; this.onopen?.({}); }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    closeFromServer(code = 1008) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const request = async (requestPath, body) => {
    calls.push({ path: requestPath, body: clone(body) });
    if (requestPath === '/api/v1/ticket') {
      ticketCount++;
      if (options.ticket) return options.ticket({ ...result, count: ticketCount });
      return { ok: true, ticket: 'synthetic-ticket-' + ticketCount, expiresAt: time.now() + 10000 };
    }
    assert.equal(requestPath, '/realtime/v1/snapshot?match_id=' + encodeURIComponent(context.match.id));
    recoveryCount++;
    if (options.recovery) return options.recovery({ ...result, count: recoveryCount });
    return envelope(context.match);
  };
  const reader = createRealtimeReader({
    getContext: () => context, request,
    receive(snapshot) { if (!result.allowReceive) return false; accepted.push(clone(snapshot)); context.match = clone(snapshot); options.onReceive?.(snapshot, result); return true; },
    changed: state => statuses.push(state.status), onAuthRequired: error => auth.push(error.message),
    Socket: Object.hasOwn(options, 'Socket') ? options.Socket : Socket,
    href: () => 'https://synthetic.invalid/game?ignored=1#ignored', schedule: time.schedule, cancel: time.cancel, now: time.now,
  });
  result.reader = reader;
  result.start = async () => { reader.sync(); await flush(); return sockets.at(-1); };
  result.redeem = async peer => { peer.open(); peer.frame({ protocol: 'realtime/v1', operation: 'ack', match_id: context.match.id, ack_revision: 0 }); await flush(); };
  result.ready = async () => { const peer = await result.start(); await result.redeem(peer); peer.frame(envelope(context.match)); await flush(); return peer; };
  return result;
}

test('P21-RT-URL same-origin ingress derives ws/wss and never carries a ticket or page query', async () => {
  const { realtimeUrl } = await modulePromise;
  assert.equal(realtimeUrl('https://synthetic.invalid:443/game?ticket=synthetic#x'), 'wss://synthetic.invalid/realtime/v1');
  assert.equal(realtimeUrl('http://127.0.0.1:8080/game'), 'ws://127.0.0.1:8080/realtime/v1');
  assert.throws(() => realtimeUrl('file:///synthetic/game'), /REALTIME_UNAVAILABLE/);
});

test('P21-RT-SHAPE invalid identity, board, move, state and current revision shapes fail closed', async () => {
  const { canApplyMatchSnapshot: accepts } = await modulePromise;
  const initial = one();
  assert.equal(accepts(initial, null, 'synthetic-x', initial.id), true);
  const invalid = [
    value => { value.id = 'another-match'; }, value => { value.status = 'OFFERED'; },
    value => { value.players = ['synthetic-x', 'synthetic-x']; }, value => { value.symbols.O = 'outsider'; },
    value => { value.players[1] = null; value.symbols.O = null; },
    value => { value.players[1] = ''; value.symbols.O = ''; },
    value => { const actor = {}; value.players[1] = actor; value.symbols.O = actor; },
    value => { value.state.board[0] = []; }, value => { value.state.board[0][0] = 'DRAW'; },
    value => { value.state.mini[0] = 'invalid'; }, value => { value.state.turn = 'DRAW'; },
    value => { value.state.required = 9; }, value => { value.state.winner = 'invalid'; },
    value => { value.state.moves[0].b = 1.5; }, value => { value.state.moves[0].player = 'DRAW'; },
    value => { value.revision = -1; }, value => { value.revision = 1.5; },
    value => { value.revision = 99; }, value => { value.state.line = [0, 1, 9]; },
  ];
  invalid.forEach((mutate, index) => { const candidate = clone(initial); mutate(candidate); assert.equal(accepts(candidate, initial, 'synthetic-x', initial.id), false, 'invalid shape ' + index); });
  assert.equal(accepts(initial, null, 'outsider', initial.id), false);
});

test('P21-RT-HISTORY rejects regressions, divergent history and equal-history board changes while preserving settlement', async () => {
  const { canApplyMatchSnapshot: accepts } = await modulePromise;
  const current = two(), past = one();
  assert.equal(accepts(current, past, 'synthetic-x', current.id), true);
  assert.equal(accepts(past, current, 'synthetic-x', current.id), false);
  const divergent = playing([{ b: 0, c: 3 }, { b: 3, c: 0 }]);
  assert.equal(accepts(divergent, current, 'synthetic-x', current.id), false);
  const changed = clone(current); changed.state.board[8][8] = 'X';
  assert.equal(accepts(changed, current, 'synthetic-x', current.id), false);
  for (const status of ['FINISHED', 'VOID']) {
    const finished = terminal(current, status);
    assert.equal(accepts(finished, current, 'synthetic-x', current.id), true, 'same revision ' + status);
    assert.equal(accepts(current, finished, 'synthetic-x', current.id), false);
    const replaced = clone(finished); replaced.receipt.payout = 999;
    assert.equal(accepts(replaced, finished, 'synthetic-x', current.id), false, 'settled receipt is immutable');
  }
});

test('P21-RT-REDEEM fresh scoped ticket precedes subscribe and resume; only authoritative snapshots advance presentation', async () => {
  const wait = deferred(), h = await harness({ recovery: () => wait.promise });
  try {
    const peer = await h.start();
    assert.deepEqual(h.calls[0], { path: '/api/v1/ticket', body: { matchScope: h.context.match.id } });
    assert.equal(peer.url, 'wss://synthetic.invalid/realtime/v1');
    assert.deepEqual(peer.sent, []);
    await h.redeem(peer);
    assert.deepEqual(peer.sent, [
      { protocol: 'realtime/v1', operation: 'ticket.redeem', ticket: 'synthetic-ticket-1' },
      { protocol: 'realtime/v1', operation: 'subscribe', match_id: one().id },
      { protocol: 'realtime/v1', operation: 'resume', match_id: one().id, ack_revision: 1 },
    ]);
    peer.frame(envelope(two())); await flush();
    assert.equal(h.context.match.revision, 2); assert.equal(h.reader.status(), 'live');
    assert.deepEqual(h.context.match.terms, two().terms); assert.deepEqual(h.context.match.quote, two().quote); assert.equal(h.context.match.deadline, two().deadline);
    assert.ok(h.calls.every(call => !/\/move|\/resign/.test(call.path)));
  } finally { h.reader.destroy(); wait.resolve(envelope(one())); await flush(); }
});

test('P21-RT-HINTS ack and delta never apply moves or acknowledge an unapplied revision', async () => {
  const wait = deferred(), h = await harness({ recovery: () => wait.promise });
  try {
    const peer = await h.start(); await h.redeem(peer);
    peer.frame({ protocol: 'realtime/v1', operation: 'ack', match_id: one().id, ack_revision: 2 });
    peer.frame({ protocol: 'realtime/v1', operation: 'delta', match_id: one().id, expected_revision: 2, delta: { from: 1, to: 2, moves: two().state.moves.slice(1) }, server_now: h.time.now() });
    await flush();
    assert.equal(h.accepted.length, 0); assert.equal(h.context.match.revision, 1);
    assert.equal(h.calls.filter(call => call.path.startsWith('/realtime/')).length, 1, 'recovery reads coalesce');
    h.reader.reconnect(); await flush(); const next = h.sockets.at(-1); await h.redeem(next);
    assert.equal(next.sent.find(frame => frame.operation === 'resume').ack_revision, 1);
  } finally { h.reader.destroy(); wait.resolve(envelope(one())); await flush(); }
});

test('P21-RT-SETTLEMENT equal-revision ack recovery discovers FINISHED and VOID and retires transport', async t => {
  for (const status of ['FINISHED', 'VOID']) await t.test(status, async () => {
    const wait = deferred(), h = await harness({ recovery: () => wait.promise });
    try {
      const peer = await h.start(); await h.redeem(peer);
      peer.frame({ protocol: 'realtime/v1', operation: 'ack', match_id: one().id, ack_revision: 1 });
      wait.resolve(envelope(terminal(one(), status))); await flush();
      assert.equal(h.context.match.revision, 1); assert.equal(h.context.match.status, status);
      assert.deepEqual(h.context.match.receipt, terminal(one(), status).receipt);
      assert.equal(h.reader.status(), 'complete'); assert.equal(peer.readyState, 3); assert.equal(h.time.pending().length, 0);
      peer.frame(envelope(one())); assert.equal(h.context.match.status, status);
    } finally { h.reader.destroy(); wait.resolve(envelope(one())); }
  });
});

test('P21-RT-FALLBACK HTTP recovery never claims a confirmed socket subscription; malformed push returns to recovery', async () => {
  const h = await harness();
  try {
    const peer = await h.start(); await h.redeem(peer);
    assert.equal(h.reader.status(), 'fallback'); assert.equal(h.context.match.revision, 1);
    peer.frame(envelope(one())); assert.equal(h.reader.status(), 'live');
    peer.frame({ ...envelope(two()), expected_revision: 99 }); await flush();
    assert.equal(h.reader.status(), 'fallback'); assert.equal(h.context.match.revision, 1);
  } finally { h.reader.destroy(); }
});

test('P21-RT-BACKOFF healthy HTTP cannot reset repeated upgrade-denial backoff or reuse scoped tickets', async () => {
  const h = await harness({ constructorFailure: true });
  try {
    await h.start();
    const delays = [];
    for (let count = 0; count < 6; count++) {
      const pending = h.time.pending(); assert.equal(pending.length, 1);
      delays.push(pending[0].delay); await h.time.advance(pending[0].delay);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000]);
    assert.equal(h.reader.status(), 'fallback'); assert.equal(h.auth.length, 0);
    assert.equal(h.calls.filter(call => call.path === '/api/v1/ticket').length, 7);
  } finally { h.reader.destroy(); }
});

test('P21-RT-NO-SOCKET missing browser WebSocket uses HTTP recovery without ticket issuance or retry timers', async () => {
  const h = await harness({ Socket: null });
  try { await h.start(); assert.equal(h.reader.status(), 'fallback'); assert.equal(h.calls.length, 1); assert.ok(h.calls[0].path.startsWith('/realtime/')); assert.equal(h.accepted.length, 1); assert.equal(h.time.pending().length, 0); }
  finally { h.reader.destroy(); }
});

test('P21-RT-AUTH shared HTTP session cleanup before AUTH_REQUIRED still retires the owning reader', async t => {
  for (const channel of ['ticket', 'recovery']) await t.test(channel, async () => {
    const options = channel === 'ticket'
      ? { ticket: ({ context }) => { context.session = null; throw Error('AUTH_REQUIRED'); } }
      : { recovery: ({ context }) => { context.session = null; throw Error('AUTH_REQUIRED'); } };
    const h = await harness(options);
    try {
      const peer = await h.start(); if (peer) await h.redeem(peer);
      assert.deepEqual(h.auth, ['AUTH_REQUIRED']); assert.equal(h.reader.status(), 'auth'); assert.equal(h.time.pending().length, 0);
      if (peer) assert.equal(peer.readyState, 3);
    } finally { h.reader.destroy(); }
  });
});

test('P21-RT-BOOTSTRAP a first session created before transient ticket failure remains recoverable', async () => {
  const h = await harness({ session: null, ticket: ({ context, count, time }) => {
    if (count === 1) { context.session = { id: 'synthetic-bootstrapped-session' }; throw Error('SERVICE_UNAVAILABLE'); }
    return { ok: true, ticket: 'synthetic-fresh-bootstrap-ticket', expiresAt: time.now() + 10000 };
  } });
  try {
    await h.start(); assert.equal(h.reader.status(), 'fallback'); assert.equal(h.auth.length, 0);
    await h.time.advance(1000); const peer = h.sockets.at(-1); assert.ok(peer); await h.redeem(peer);
    assert.equal(peer.sent[0].ticket, 'synthetic-fresh-bootstrap-ticket'); assert.equal(h.calls.filter(call => call.path === '/api/v1/ticket').length, 2);
  } finally { h.reader.destroy(); }
});

test('P21-RT-FIRST-SESSION ticket bootstrap can adopt its first opaque session without replacing account ownership', async () => {
  const h = await harness({ session: null, ticket: ({ context, time }) => {
    context.session = { id: 'synthetic-new-session' };
    return { ok: true, ticket: 'synthetic-first-session-ticket', expiresAt: time.now() + 10000 };
  } });
  try {
    const peer = await h.ready(); assert.equal(h.reader.status(), 'live'); assert.equal(peer.sent[0].ticket, 'synthetic-first-session-ticket');
    assert.equal(h.context.actorId, 'synthetic-x'); assert.equal(h.auth.length, 0); assert.equal(h.calls.filter(call => call.path === '/api/v1/ticket').length, 1);
  } finally { h.reader.destroy(); }
});

test('P21-RT-LATE-TICKET route, actor, match and existing-session replacement fence late grants and errors', async t => {
  const changes = {
    actor: context => { context.actorId = 'synthetic-o'; }, session: context => { context.session = { id: 'another-session' }; },
    route: context => { context.epoch++; }, match: context => { context.match = playing([], 'another-match'); },
  };
  for (const [name, change] of Object.entries(changes)) for (const outcome of ['grant', 'auth']) await t.test(name + ':' + outcome, async () => {
    const wait = deferred(), h = await harness({ ticket: () => wait.promise });
    try {
      await h.start(); change(h.context);
      if (outcome === 'grant') wait.resolve({ ok: true, ticket: 'synthetic-obsolete-ticket', expiresAt: h.time.now() + 10000 }); else wait.reject(Error('AUTH_REQUIRED'));
      await flush(); assert.equal(h.sockets.length, 0); assert.equal(h.accepted.length, 0); assert.equal(h.auth.length, 0);
    } finally { h.reader.destroy(); }
  });
});

test('P21-RT-STALE-SOCKET actor/session/route/match/generation replacement fences saved socket callbacks', async t => {
  const changes = {
    actor: h => { h.context.actorId = 'synthetic-o'; h.reader.sync(); }, session: h => { h.context.session = { id: 'next-session' }; h.reader.sync(); },
    route: h => { h.context.epoch++; h.reader.sync(); }, match: h => { h.context.match = playing([], 'next-match'); h.reader.sync(); },
    generation: h => { h.reader.reconnect(); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const h = await harness();
    try {
      const peer = await h.ready(); const callbacks = { message: peer.onmessage, close: peer.onclose, error: peer.onerror, open: peer.onopen };
      change(h); await flush(); const count = h.calls.length, accepted = h.accepted.length;
      callbacks.message({ data: JSON.stringify({ protocol: 'realtime/v1', operation: 'error', code: 'AUTH_REQUIRED' }) });
      callbacks.message({ data: JSON.stringify(envelope(two())) }); callbacks.close({ code: 1008 }); callbacks.error({}); callbacks.open({}); await flush();
      assert.equal(h.calls.length, count); assert.equal(h.accepted.length, accepted); assert.equal(h.auth.length, 0); assert.equal(peer.readyState, 3);
    } finally { h.reader.destroy(); }
  });
});

test('P21-RT-ORDER a delayed recovery success or auth error cannot replace a newer accepted push', async t => {
  for (const outcome of ['snapshot', 'auth']) await t.test(outcome, async () => {
    const wait = deferred(), h = await harness({ recovery: () => wait.promise });
    try {
      const peer = await h.start(); await h.redeem(peer); peer.frame(envelope(two()));
      if (outcome === 'snapshot') wait.resolve(envelope(one()));
      else { h.context.session = null; wait.reject(Error('AUTH_REQUIRED')); }
      await flush(); assert.equal(h.context.match.revision, 2); assert.equal(h.accepted.length, 1); assert.equal(h.auth.length, 0);
    } finally { h.reader.destroy(); wait.resolve(envelope(one())); }
  });
});

test('P21-RT-RECORD HTTP record cannot lower the applied revision or record across a retired lifecycle', async () => {
  const wait = deferred(), h = await harness({ recovery: () => wait.promise });
  try {
    const peer = await h.start(); await h.redeem(peer); peer.frame(envelope(two()));
    h.reader.record(one()); h.reader.reconnect(); await flush(); const next = h.sockets.at(-1); await h.redeem(next);
    assert.equal(next.sent.find(frame => frame.operation === 'resume').ack_revision, 2);
    h.context.epoch++; h.reader.record(playing()); h.context.epoch--; h.reader.reconnect(); await flush();
    const third = h.sockets.at(-1); await h.redeem(third); assert.equal(third.sent.find(frame => frame.operation === 'resume').ack_revision, 2);
  } finally { h.reader.destroy(); wait.resolve(envelope(one())); await flush(); }
});

test('P21-RT-CONSUMER a rejected snapshot does not advance the applied resume revision', async () => {
  const wait = deferred(), h = await harness({ recovery: () => wait.promise });
  try {
    const peer = await h.start(); await h.redeem(peer); h.allowReceive = false; peer.frame(envelope(two()));
    assert.equal(h.context.match.revision, 1); h.reader.reconnect(); await flush(); const next = h.sockets.at(-1); await h.redeem(next);
    assert.equal(next.sent.find(frame => frame.operation === 'resume').ack_revision, 1);
  } finally { h.reader.destroy(); wait.resolve(envelope(one())); }
});

test('P21-RT-TICKET expired issuance and expiration during upgrade require a fresh ticket before redemption', async t => {
  await t.test('already expired', async () => {
    const h = await harness({ ticket: ({ count, time }) => ({ ok: true, ticket: 'synthetic-ticket-' + count, expiresAt: count === 1 ? time.now() : time.now() + 10000 }) });
    try { await h.start(); assert.equal(h.sockets.length, 0); await h.time.advance(1000); assert.equal(h.sockets.length, 1); h.sockets[0].open(); assert.equal(h.sockets[0].sent[0].ticket, 'synthetic-ticket-2'); }
    finally { h.reader.destroy(); }
  });
  await t.test('expires while connecting', async () => {
    const h = await harness();
    try { const peer = await h.start(); await h.time.advance(10001); peer.open(); await flush(); assert.equal(peer.sent.length, 0, 'an expired bearer is not redeemed'); assert.equal(peer.readyState, 3); await h.time.advance(1000); assert.equal(h.sockets.length, 2); }
    finally { h.reader.destroy(); }
  });
});

test('P21-RT-POLICY 1008 and spent-ticket errors recover with new tickets without invalidating the actor', async t => {
  for (const refusal of ['close', 'TICKET_EXPIRED', 'TICKET_REDEEMED']) await t.test(refusal, async () => {
    const h = await harness();
    try {
      const peer = await h.start(); peer.open();
      if (refusal === 'close') peer.closeFromServer(1008); else peer.frame({ protocol: 'realtime/v1', operation: 'error', code: refusal });
      await flush(); assert.equal(h.auth.length, 0); assert.equal(h.reader.status(), 'fallback'); await h.time.advance(1000);
      const next = h.sockets.at(-1); next.open(); assert.equal(next.sent[0].ticket, 'synthetic-ticket-2'); assert.equal(h.context.actorId, 'synthetic-x');
    } finally { h.reader.destroy(); }
  });
});

test('P21-RT-HEARTBEAT pong keeps one heartbeat deadline and absent pong recovers a lost socket', async () => {
  const h = await harness();
  try {
    const peer = await h.ready(); await h.time.advance(15000); assert.equal(peer.sent.at(-1).operation, 'ping');
    assert.equal(h.time.pending().length, 1); assert.equal(h.time.pending()[0].delay, 10000);
    peer.frame({ protocol: 'realtime/v1', operation: 'pong', server_now: h.time.now() });
    assert.equal(h.time.pending().length, 1); assert.equal(h.time.pending()[0].delay, 15000);
    await h.time.advance(15000); await h.time.advance(10000);
    assert.equal(peer.readyState, 3); assert.equal(h.reader.status(), 'fallback'); assert.equal(h.time.pending().length, 1); assert.equal(h.auth.length, 0);
    await h.time.advance(1000); assert.equal(h.sockets.length, 2);
  } finally { h.reader.destroy(); }
});

test('P21-RT-HANDSHAKE a timed-out ticket request cannot open a stale connection after the next attempt', async () => {
  const wait = deferred(), h = await harness({ ticket: ({ count, time }) => count === 1 ? wait.promise : { ok: true, ticket: 'synthetic-second-attempt-ticket', expiresAt: time.now() + 10000 } });
  try {
    await h.start(); await h.time.advance(12000); assert.equal(h.reader.status(), 'fallback'); await h.time.advance(1000); assert.equal(h.sockets.length, 1);
    wait.resolve({ ok: true, ticket: 'synthetic-stale-attempt-ticket', expiresAt: h.time.now() + 10000 }); await flush();
    assert.equal(h.sockets.length, 1); h.sockets[0].open(); assert.equal(h.sockets[0].sent[0].ticket, 'synthetic-second-attempt-ticket');
  } finally { h.reader.destroy(); wait.resolve({}); }
});

test('P21-RT-RECOVERY-DEADLINE a hung recovery is bounded and its late result cannot supersede the next read', async () => {
  const wait = deferred(), h = await harness({ recovery: ({ count, context }) => count === 1 ? wait.promise : envelope(context.match) });
  try {
    const peer = await h.start(); await h.redeem(peer); assert.equal(h.calls.filter(call => call.path.startsWith('/realtime/')).length, 1);
    await h.time.advance(12000); assert.equal(h.accepted.length, 0);
    assert.equal(await h.reader.recover(), true); assert.equal(h.calls.filter(call => call.path.startsWith('/realtime/')).length, 2);
    wait.resolve(envelope(two())); await flush(); assert.equal(h.context.match.revision, 1); assert.equal(h.accepted.length, 1);
    assert.equal(h.time.pending().length, 1, 'only the active socket heartbeat remains');
  } finally { h.reader.destroy(); wait.resolve(envelope(one())); }
});

test('P21-RT-MALFORMED malformed socket payloads cannot mutate the board and recover with bounded transport work', async t => {
  const payloads = {
    json: '{', binary: new Uint8Array([1, 2]), oversized: 'x'.repeat(270001),
    protocol: JSON.stringify({ ...envelope(two()), protocol: 'another/v1' }),
    match: JSON.stringify({ ...envelope(two()), match_id: 'another-match' }),
    operation: JSON.stringify({ protocol: 'realtime/v1', operation: 'invented', match_id: one().id }),
  };
  for (const [name, data] of Object.entries(payloads)) await t.test(name, async () => {
    const h = await harness();
    try {
      const peer = await h.ready(); peer.onmessage({ data }); await flush();
      assert.equal(h.context.match.revision, 1); assert.equal(h.auth.length, 0); assert.equal(peer.readyState, 3); assert.equal(h.reader.status(), 'fallback');
      assert.equal(h.time.pending().length, 1, 'healthy HTTP leaves one bounded retry timer');
    } finally { h.reader.destroy(); }
  });
});

test('P21-RT-DESTROY teardown cancels all timers and fences pending HTTP and saved socket callbacks', async () => {
  const wait = deferred(), h = await harness({ recovery: () => wait.promise });
  const peer = await h.start(); await h.redeem(peer); const message = peer.onmessage, close = peer.onclose;
  assert.ok(h.time.pending().length); h.reader.destroy();
  assert.equal(h.time.pending().length, 0); assert.equal(peer.readyState, 3); assert.equal(peer.onmessage, null);
  wait.resolve(envelope(two())); message({ data: JSON.stringify(envelope(two())) }); close({ code: 1008 }); await flush(); await h.time.advance(60000);
  assert.equal(h.accepted.length, 0); assert.equal(h.auth.length, 0); assert.equal(h.sockets.length, 1);
  const count = h.calls.length; h.reader.sync(); h.reader.reconnect(); assert.equal(await h.reader.recover(), false); await flush(); assert.equal(h.calls.length, count); assert.equal(h.time.pending().length, 0);
});
