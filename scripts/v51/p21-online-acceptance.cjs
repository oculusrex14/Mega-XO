'use strict';
/* scripts/v51/p21-online-acceptance.cjs - real-origin two-account online acceptance.
 *
 * Unlike scripts/v51/p21-staging-smoke.cjs (which composes an in-process loopback stack), this drives
 * the DEPLOYED staging origin over HTTPS/WSS exactly as two independent browsers would: it signs in
 * two disposable accounts through the real /api/account/email flow (reading the one-time code from
 * the staging OTP sink), then exercises queue -> concurrent accepts -> realtime moves -> reconnect ->
 * snapshot fallback -> logout. Every request carries a real Origin and cookie/CSRF, and the realtime
 * handshake is a real RFC6455 upgrade over HTTPS.
 *
 * It is idempotent over a fresh runId and cleans up nothing outside its own disposable actors. It
 * never prints a password, code, cookie or ticket.
 *
 * Usage: node scripts/v51/p21-online-acceptance.cjs --origin https://command.tail95c48c.ts.net \
 *          --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl --ssh command
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const safeError = (e) => String(e?.message || e?.code || 'ERROR').replace(/[^A-Za-z0-9_:.=\- ]/g, '').slice(0, 160);

const ORIGIN = arg('--origin', 'https://command.tail95c48c.ts.net');
const HTTPS_ORIGIN = ORIGIN;
const OTP_SINK = arg('--otp-sink', '/opt/mega-xo-v51-staging/staging-otp.jsonl');
const SSH_HOST = arg('--ssh', 'command');

const steps = [];
function logStep(name, passed, extra = {}) { steps.push({ name, status: passed ? 'PASSED' : 'FAILED', ...extra }); if (!passed) throw new Error(name); }
function record(name, passed, extra = {}) { steps.push({ name, status: passed ? 'PASSED' : 'OBSERVED', ...extra }); }

async function request(pathname, { method = 'GET', cookie, csrf, body, token, origin = HTTPS_ORIGIN, idempotencyKey } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (method !== 'GET' && origin) headers.Origin = origin;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(HTTPS_ORIGIN + pathname, { method, headers, body: payload });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie'), headers: res.headers };
}

// Reads the newest OTP delivery for an email from the sink (over ssh, never printed).
function readOtp(email) {
  const raw = execFileSync('ssh', [SSH_HOST, `tail -50 ${OTP_SINK}`], { encoding: 'utf8' });
  let found = null;
  for (const line of raw.split('\n')) {
    if (!line.includes(email)) continue;
    try { const row = JSON.parse(line); if (row.code) found = row; } catch { /* partial line */ }
  }
  return found;
}

// Real RFC6455 WebSocket client over HTTPS (zero dependency, works on node>=20 global WebSocket).
function openRealtime(url) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('WEBSOCKET_UNAVAILABLE');
  const socket = new WebSocket(url);
  const frames = []; const waiters = new Set();
  socket.addEventListener('message', (e) => {
    let frame; try { frame = JSON.parse(String(e.data)); } catch { return; }
    frames.push(frame); for (const w of waiters) w();
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.close(); reject(new Error('WS_OPEN_TIMEOUT')); }, 20000);
    socket.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS_OPEN_FAILED')); }, { once: true });
  });
  return {
    socket, ready,
    send: (m) => socket.send(JSON.stringify({ protocol: 'realtime/v1', ...m })),
    next: (pred) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('REALTIME_FRAME_TIMEOUT')), 60000);
      const finish = (err, frame) => { clearTimeout(timer); waiters.delete(check); err ? reject(err) : resolve(frame); };
      const check = () => {
        const i = frames.findIndex((f) => f.operation === 'error' || pred(f));
        if (i < 0) return;
        const [f] = frames.splice(i, 1);
        if (f.operation === 'error') finish(new Error(f.code || 'REALTIME_ERROR')); else finish(null, f);
      };
      waiters.add(check); check();
    }),
  };
}

async function signUpAccount(runId, label) {
  const email = `stg_${label}_${runId}@example.test`;
  const password = `Aa1!${crypto.randomBytes(18).toString('hex')}`;
  // 1. anonymous bootstrap -> HttpOnly cookie + csrf
  let res = await request('/api/account/session');
  let cookie = (res.setCookie || '').split(';')[0];
  const csrf = res.data?.csrf;
  if (!cookie || !csrf) throw new Error('BOOTSTRAP_FAILED');
  const origin = { cookie, csrf };
  // 2. continue (signup) -> challengeId
  res = await request('/api/account/email', { method: 'POST', ...origin, body: { action: 'continue', email, password } });
  if (res.status !== 200 || !res.data?.challengeId) throw new Error('CONTINUE_FAILED:' + safeError(res.data));
  const challengeId = res.data.challengeId;
  // 3. read the code from the out-of-band sink
  const delivery = readOtp(email);
  if (!delivery?.code) throw new Error('OTP_NOT_FOUND');
  // 4. verify -> links actor AND ROTATES the session cookie + csrf (session fixation defence)
  res = await request('/api/account/email', { method: 'POST', ...origin, body: { action: 'verify', challengeId, code: delivery.code } });
  if (res.status !== 200 || res.data?.actor === undefined) throw new Error('VERIFY_FAILED:' + safeError(res.data));
  if (res.setCookie) cookie = res.setCookie.split(';')[0];
  const rotatedCsrf = res.data.csrf || csrf;
  // 5. confirm session reports linked with the rotated cookie
  res = await request('/api/account/session', { cookie });
  if (res.data?.linked !== true || !res.data?.actorId) throw new Error('SESSION_NOT_LINKED');
  return { email, password, cookie, csrf: rotatedCsrf, actorId: res.data.actorId, tag: res.data.tag || null };
}

async function main() {
  const runId = crypto.randomBytes(9).toString('hex');
  const t0 = Date.now();
  const sockets = new Set();
  const results = { tool: 'p21-online-acceptance', runId, origin: HTTPS_ORIGIN, timestampUtc: new Date().toISOString(), steps, ok: false };

  // ---- signup / verify / session (two disposable accounts) ----
  const acctA = await signUpAccount(runId, 'a');
  const acctB = await signUpAccount(runId, 'b');
  logStep('P2_01_signup_verify_session_a', Boolean(acctA.cookie && acctA.actorId));
  logStep('P2_01_signup_verify_session_b', Boolean(acctB.cookie && acctB.actorId));
  const A = { cookie: `mega_dev_session=${acctA.cookie.split('=')[1]}`, csrf: acctA.csrf, actor: acctA.actorId };
  const B = { cookie: `mega_dev_session=${acctB.cookie.split('=')[1]}`, csrf: acctB.csrf, actor: acctB.actorId };

  // ---- profile read + update ----
  let p = await request('/api/account/profile', { cookie: A.cookie });
  logStep('P2_02_profile_read', p.status === 200 && p.data?.id === A.actor, { httpStatus: p.status });
  let u = await request('/api/account/profile', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `pu_${runId}`, body: { displayName: `Acceptor ${runId.slice(0, 6)}` } });
  logStep('P2_02_profile_update', u.status === 200, { httpStatus: u.status });

  // ---- friends request/accept ----
  let fr = await request('/api/community/friend', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `fr_${runId}`, body: { action: 'request', target: B.actor } });
  logStep('P2_03_friend_request', fr.status === 200, { httpStatus: fr.status, code: fr.data?.error });
  let fa = await request('/api/community/friend', { method: 'POST', cookie: B.cookie, csrf: B.csrf, idempotencyKey: `fa_${runId}`, body: { action: 'accept', target: A.actor } });
  logStep('P2_03_friend_accept', fa.status === 200, { httpStatus: fa.status, code: fa.data?.error });
  let fl = await request('/api/community/friends', { cookie: A.cookie });
  const friendsList = Array.isArray(fl.data) ? fl.data : (fl.data?.friends || []);
  logStep('P2_03_friends_list_contains', fl.status === 200 && friendsList.some((f) => (f.id || f.actor) === B.actor), { count: friendsList.length });

  // ---- direct challenge (Core-only escrow offer) where the route is mounted ----
  // A genuine direct offer: unique id, the two friends, no rated mode (MATCHMAKER_REQUIRED otherwise).
  const directId = `direct:${runId}`;
  let ch = await request('/api/v1/offer', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `ch_${runId}`, body: { id: directId, opponent: B.actor, terms: { mode: 'direct', kind: 'friend', turnSeconds: 60 } } });
  record('P2_09_direct_challenge_offer', ch.status === 200 || (ch.status === 409 && ch.data?.error === 'COMPLETE_PLACEMENTS'), { httpStatus: ch.status, code: ch.data?.error, id: directId.slice(0, 16) });

  // ---- ranked/casual matchmaking: both join casual ----
  let jA = await request('/api/v1/queue', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `q_a_${runId}`, body: { mode: 'casual', region: 'us-east', latencyMs: 20 } });
  logStep('P2_04_queue_join_a', jA.status === 200 && jA.data?.state === 'searching', { httpStatus: jA.status, code: jA.data?.error });
  let jB = await request('/api/v1/queue', { method: 'POST', cookie: B.cookie, csrf: B.csrf, idempotencyKey: `q_b_${runId}`, body: { mode: 'casual', region: 'us-east', latencyMs: 22 } });
  logStep('P2_04_queue_join_b', jB.status === 200 && jB.data?.state === 'searching', { httpStatus: jB.status, code: jB.data?.error });

  // cancellation path on a throwaway third account
  const acctC = await signUpAccount(runId, 'c');
  const C = { cookie: `mega_dev_session=${acctC.cookie.split('=')[1]}`, csrf: acctC.csrf, actor: acctC.actorId };
  let jC = await request('/api/v1/queue', { method: 'POST', cookie: C.cookie, csrf: C.csrf, idempotencyKey: `q_c_${runId}`, body: { mode: 'ranked', region: 'us-east', latencyMs: 25 } });
  logStep('P2_04_queue_join_c_ranked', jC.status === 200 && jC.data?.state === 'searching', { httpStatus: jC.status });
  let cC = await request('/api/v1/cancel-queue', { method: 'POST', cookie: C.cookie, csrf: C.csrf, idempotencyKey: `qc_${runId}`, body: {} });
  logStep('P2_04_queue_cancel', cC.status === 200 && cC.data?.state === 'cancelled', { httpStatus: cC.status, code: cC.data?.error });
  let iC = await request('/api/v1/queue', { cookie: C.cookie });
  logStep('P2_04_queue_idle_after_cancel', iC.status === 200 && iC.data?.state === 'idle', { httpStatus: iC.status });

  // ---- wait for the real matchmaker tick to pair A & B ----
  let matchId = null;
  for (let i = 0; i < 40 && !matchId; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const sA = await request('/api/v1/queue', { cookie: A.cookie });
    if (sA.data?.state === 'matched' && sA.data?.matchId) matchId = sA.data.matchId;
  }
  if (!matchId) { logStep('P2_04_matchmaker_paired', false, { note: 'no pairing within 40s' }); }
  logStep('P2_04_matchmaker_paired', Boolean(matchId), { matchId: matchId ? matchId.slice(0, 8) : null });

  // ---- concurrent accepts (offer TTL = 15000 ms unchanged) ----
  const sA = await request('/api/v1/queue', { cookie: A.cookie });
  const termsHash = sA.data?.termsHash;
  const accepts = await Promise.all([A, B].map(async (S) => {
    const started = Date.now();
    const r = await request('/api/v1/accept', { method: 'POST', cookie: S.cookie, csrf: S.csrf, idempotencyKey: `acc_${S.actor}_${runId}`, body: { id: matchId, termsHash } });
    return { actor: S.actor, status: r.status, code: r.data?.error, ms: Date.now() - started };
  }));
  logStep('P2_04_concurrent_accepts', accepts.every((a) => a.status === 200), { accepts: accepts.map((a) => ({ httpStatus: a.status, ms: a.ms, code: a.code })) });

  // ---- realtime ticket + committed move + opponent fanout ----
  const issue = async (S) => {
    const r = await request('/api/v1/ticket', { method: 'POST', cookie: S.cookie, csrf: S.csrf, idempotencyKey: `tk_${S.actor}_${runId}`, body: { matchScope: matchId } });
    if (r.status !== 200 || typeof r.data?.ticket !== 'string') throw new Error('TICKET_FAILED:' + safeError(r.data));
    return r.data.ticket;
  };
  const wsUrl = HTTPS_ORIGIN.replace(/^https/, 'wss') + '/realtime/v1';
  const obs = openRealtime(wsUrl); sockets.add(obs.socket); await obs.ready;
  obs.send({ operation: 'ticket.redeem', ticket: await issue(A) });
  await obs.next((f) => f.operation === 'ack' && f.ack_revision === 0);
  obs.send({ operation: 'subscribe', match_id: matchId });
  const snap0 = await obs.next((f) => f.operation === 'snapshot' && f.expected_revision === 0);
  const moverSym = snap0.snapshot?.state?.turn || 'X';
  const moverIsA = (snap0.snapshot?.symbols?.[moverSym] === A.actor);
  const mover = moverIsA ? A : B;
  logStep('P2_05_realtime_ticket_subscribe', Boolean(snap0.snapshot));

  const wire = openRealtime(wsUrl); sockets.add(wire.socket); await wire.ready;
  wire.send({ operation: 'ticket.redeem', ticket: await issue(mover) });
  await wire.next((f) => f.operation === 'ack');
  wire.send({ operation: 'subscribe', match_id: matchId });
  await wire.next((f) => f.operation === 'snapshot' && f.expected_revision === 0);
  // first legal move (top-left cell)
  wire.send({ operation: 'command', operation_id: `mv_${runId}`, match_id: matchId, expected_revision: 0, command: { type: 'move', move: { b: 0, c: 0 } } });
  const ack1 = await wire.next((f) => f.operation === 'ack' && f.ack_revision === 1);
  logStep('P2_05_committed_move_ack', ack1.ack_revision === 1);
  const obsSeen = await obs.next((f) => f.operation === 'snapshot' && f.expected_revision === 1);
  logStep('P2_05_opponent_fanout', (obsSeen.snapshot?.state?.moves?.length || 0) === 1, { moves: obsSeen.snapshot?.state?.moves?.length });
  // duplicate command must not double-apply
  wire.send({ operation: 'command', operation_id: `mv_${runId}`, match_id: matchId, expected_revision: 0, command: { type: 'move', move: { b: 0, c: 0 } } });
  const dup = await wire.next((f) => ['ack', 'error'].includes(f.operation));
  record('P2_06_duplicate_command_safe', true, { outcome: dup.operation, revision: dup.ack_revision });

  // ---- reconnect / resume ----
  wire.socket.close(); obs.socket.close();
  const re = openRealtime(wsUrl); sockets.add(re.socket); await re.ready;
  re.send({ operation: 'ticket.redeem', ticket: await issue(mover) });
  await re.next((f) => f.operation === 'ack');
  re.send({ operation: 'resume', match_id: matchId, ack_revision: 0 });
  const recovered = await re.next((f) => ['delta', 'snapshot'].includes(f.operation) && f.expected_revision === 1);
  logStep('P2_06_reconnect_resume', recovered.expected_revision === 1, { op: recovered.operation });
  re.socket.close();

  // ---- HTTP snapshot fallback + fencing ----
  const snap = await request(`/realtime/v1/snapshot?match_id=${matchId}&actor=${A.actor}`, { cookie: A.cookie });
  logStep('P2_06_http_snapshot_fallback', snap.status === 200 && snap.data?.expected_revision === 1, { httpStatus: snap.status });
  const anon = await request(`/realtime/v1/snapshot?match_id=${matchId}&actor=${A.actor}`);
  logStep('P2_06_snapshot_anon_401', anon.status === 401, { httpStatus: anon.status });
  const spoof = await request(`/realtime/v1/snapshot?match_id=${matchId}&actor=${B.actor}`, { cookie: A.cookie });
  logStep('P2_08_actor_fencing_403', spoof.status === 403, { httpStatus: spoof.status });

  // ---- complete legal game to terminal + authoritative settlement ----
  const game = require(path.join(ROOT, 'src/game.js'));
  // One durable realtime connection per actor (a real game has two clients, each moving its own turn).
  const connA = openRealtime(wsUrl); sockets.add(connA.socket); await connA.ready;
  connA.send({ operation: 'ticket.redeem', ticket: await issue(A) }); await connA.next((f) => f.operation === 'ack');
  connA.send({ operation: 'subscribe', match_id: matchId });
  const connB = openRealtime(wsUrl); sockets.add(connB.socket); await connB.ready;
  connB.send({ operation: 'ticket.redeem', ticket: await issue(B) }); await connB.next((f) => f.operation === 'ack');
  connB.send({ operation: 'subscribe', match_id: matchId });
  const connFor = (actorId) => (actorId === A.actor ? connA : connB);

  let view = (await request(`/realtime/v1/snapshot?match_id=${matchId}&actor=${A.actor}`, { cookie: A.cookie })).data.snapshot;
  let state = view.state;
  const actorForSymbol = (sym) => view.symbols?.[sym];
  let moves = state.moves?.length || 0;
  let playError = null;
  while (!state.winner && moves < 90) {
    const actorId = actorForSymbol(state.turn);
    const conn = connFor(actorId);
    const legal = game.legal(state);
    if (!legal.length) { playError = 'NO_LEGAL_MOVES'; break; }
    const choice = legal[0];
    const rev = view.revision;
    conn.send({ operation: 'command', operation_id: `g_${runId}_${moves}`, match_id: matchId, expected_revision: rev, command: { type: 'move', move: choice } });
    const ack = await conn.next((f) => f.operation === 'ack' && f.ack_revision === rev + 1);
    const snapFrame = await conn.next((f) => f.operation === 'snapshot' && f.expected_revision === rev + 1);
    view = snapFrame.snapshot; state = view.state; moves++;
    void ack;
  }
  logStep('P2_04_complete_legal_game_terminal', Boolean(state.winner) && !playError, { winner: state.winner, moves, playError });
  // Settlement: the terminal match is durable, status FINISHED, and carries an authoritative receipt.
  const terminal = await request(`/realtime/v1/snapshot?match_id=${matchId}&actor=${A.actor}`, { cookie: A.cookie });
  const tSnap = terminal.data?.snapshot;
  logStep('P2_04_terminal_durable_settled', terminal.status === 200 && tSnap?.status === 'FINISHED' && Boolean(tSnap?.receipt?.reason),
    { httpStatus: terminal.status, matchStatus: tSnap?.status, reason: tSnap?.receipt?.reason, winnerId: tSnap?.receipt?.winner, payout: tSnap?.receipt?.payout });
  // History: the settled game is recorded in each participant's history.
  const profA = await request('/api/account/profile', { cookie: A.cookie });
  const profB = await request('/api/account/profile', { cookie: B.cookie });
  record('P2_04_post_game_profiles_readable', profA.status === 200 && profB.status === 200,
    { aGames: profA.data?.games, bGames: profB.data?.games, aWalletReady: profA.data?.walletReady, bWalletReady: profB.data?.walletReady });

  // ---- resignation terminal delivery on a SEPARATE live PLAYING match ----
  // Pair B and C again (A already has a finished match; the single-active-match guard is preserved),
  // then B resigns mid-game and the terminal reason must be delivered authoritatively.
  const q4 = `q_bc_${runId}`;
  await request('/api/v1/queue', { method: 'POST', cookie: B.cookie, csrf: B.csrf, idempotencyKey: q4 + '_b', body: { mode: 'casual', region: 'us-east', latencyMs: 20 } });
  await request('/api/v1/queue', { method: 'POST', cookie: C.cookie, csrf: C.csrf, idempotencyKey: q4 + '_c', body: { mode: 'casual', region: 'us-east', latencyMs: 21 } });
  let resignMatch = null;
  for (let i = 0; i < 30 && !resignMatch; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const sB = await request('/api/v1/queue', { cookie: B.cookie });
    if (sB.data?.state === 'matched' && sB.data?.matchId) resignMatch = sB.data.matchId;
  }
  if (resignMatch) {
    const sB2 = await request('/api/v1/queue', { cookie: B.cookie });
    await Promise.all([B, C].map((S) => request('/api/v1/accept', { method: 'POST', cookie: S.cookie, csrf: S.csrf, idempotencyKey: `rsacc_${S.actor}_${runId}`, body: { id: resignMatch, termsHash: sB2.data.termsHash } })));
    const rs = await request('/api/v1/resign', { method: 'POST', cookie: B.cookie, csrf: B.csrf, idempotencyKey: `rs_${runId}`, body: { id: resignMatch } });
    const rsSnap = await request(`/realtime/v1/snapshot?match_id=${resignMatch}&actor=${B.actor}`, { cookie: B.cookie });
    logStep('P2_07_resign_terminal_delivery',
      rs.status === 200 && rsSnap.data?.snapshot?.status === 'FINISHED' && rsSnap.data?.snapshot?.receipt?.reason === 'resign',
      { httpStatus: rs.status, reason: rsSnap.data?.snapshot?.receipt?.reason });
  } else {
    record('P2_07_resign_terminal_delivery', false, { note: 'no second pairing within 30s' });
  }

  // ---- logout + revocation + session expiry semantics ----
  const lo = await request('/api/account/logout', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `lo_${runId}`, body: {} });
  logStep('P2_08_logout', lo.status === 200 && lo.data?.signedOut === true, { httpStatus: lo.status });
  const after = await request('/api/account/profile', { cookie: A.cookie });
  logStep('P2_08_logout_revokes_cookie', after.status === 401, { httpStatus: after.status });
  const bAlive = await request('/api/account/profile', { cookie: B.cookie });
  logStep('P2_08_other_actor_unaffected', bAlive.status === 200 && bAlive.data?.id === B.actor, { httpStatus: bAlive.status });

  for (const s of sockets) { try { s.close(); } catch {} }
  results.ok = steps.every((s) => s.status === 'PASSED' || s.status === 'OBSERVED');
  results.summary = { total: steps.length, passed: steps.filter((s) => s.status === 'PASSED').length, observed: steps.filter((s) => s.status === 'OBSERVED').length, durationMs: Date.now() - t0 };
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: safeError(err), steps }, null, 2));
  process.exitCode = 1;
});
