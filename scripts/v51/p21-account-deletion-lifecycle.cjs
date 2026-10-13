'use strict';
/* scripts/v51/p21-account-deletion-lifecycle.cjs - real-origin account deletion / retention evidence.
 *
 * Drives the DEPLOYED staging origin over HTTPS exactly as the shipped web client does and exercises
 * the REAL coordinated-deletion path (`POST /api/account/delete` ->
 * `packages/services/accounts.js:deleteAccount`), then verifies the observable end state:
 *
 *   1. an anonymous bootstrap + a REAL email signup/verify through `/api/account/email` (the one-time
 *      code is read out-of-band from the staging OTP sink over ssh - staging SMTP is disabled by
 *      design, so the sink is the only mail transport);
 *   2. negative guards: wrong player-tag confirmation, unauthenticated caller;
 *   3. the positive deletion, capturing the exact HTTP status and response body;
 *   4. post-conditions over HTTP: the bearer is revoked (401), the bearer no longer boots a LINKED
 *      session, another actor's profile read of the deleted actor is 404 and search no longer lists it;
 *   5. post-conditions over the durable store (read-only, one SELECT per fact, via the staging runtime
 *      roles): profile tombstone + closed visibility flags, `eligibility.verified=false`, credential /
 *      identity / session / challenge / cloud-save rows removed, the `privacy.requests` intake row in
 *      state `requested`, the durable `account.deletion` outbox hand-off row present and still
 *      `queued`, and NO permanent `privacy.deletion_receipts` row (worker_runtime owns completion).
 *
 * The API half is a REAL disable; the worker/Core half (request completion, permanent receipt,
 * economic/competitive erasure, training-capture erasure) is NOT deployed on this origin. The run
 * records that boundary instead of pretending the lifecycle is complete.
 *
 * It never prints a password, one-time code, cookie, bearer, email or secret, and it never mutates a
 * non-disposable account: every actor it touches is created by this run under `stg_del_<runId>@example.test`.
 *
 * Usage: node scripts/v51/p21-account-deletion-lifecycle.cjs --origin https://command.tail95c48c.ts.net \
 *          --otp-sink /opt/mega-xo-v51-staging/staging-otp.jsonl --ssh command
 *        Add --no-db to skip the durable-store observations (HTTP-only run).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);
const safeError = (e) => String(e?.message || e?.code || 'ERROR').replace(/[^A-Za-z0-9_:.=\- ]/g, '').slice(0, 160);

const ORIGIN = arg('--origin', 'https://command.tail95c48c.ts.net');
const OTP_SINK = arg('--otp-sink', '/opt/mega-xo-v51-staging/staging-otp.jsonl');
const SSH_HOST = arg('--ssh', 'command');
const SECRETS_DIR = arg('--secrets-dir', '/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging');
const OBSERVE_DB = !flag('--no-db');

const steps = [];
function pass(name, extra = {}) { steps.push({ name, status: 'PASSED', ...extra }); }
function fail(name, extra = {}) { steps.push({ name, status: 'FAILED', ...extra }); }
function expect(name, condition, extra = {}) { (condition ? pass : fail)(name, extra); return condition; }

/* --------------------------------------------------------------- HTTP surface */

async function request(pathname, { method = 'GET', cookie, csrf, body, origin = ORIGIN, idempotencyKey } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (method !== 'GET') headers.Origin = origin;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(ORIGIN + pathname, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie'), cacheControl: res.headers.get('cache-control') };
}

/* Newest delivery for one address from the staging sink (over ssh; the code is never printed). */
function readOtp(email) {
  const raw = execFileSync('ssh', [SSH_HOST, `tail -50 ${OTP_SINK}`], { encoding: 'utf8' });
  let found = null;
  for (const line of raw.split('\n')) {
    if (!line.includes(email)) continue;
    try { const row = JSON.parse(line); if (row.code) found = row; } catch { /* partial line */ }
  }
  return found;
}

/* A real email signup: anonymous bootstrap -> continue -> OTP -> verify (rotates the bearer). */
async function signUp(email, password, runId) {
  const boot = await request('/api/account/session');
  const cookie0 = (boot.setCookie || '').split(';')[0];
  const csrf0 = boot.data?.csrf;
  if (!cookie0 || !csrf0) throw new Error('BOOTSTRAP_FAILED');
  const cont = await request('/api/account/email', {
    method: 'POST', cookie: cookie0, csrf: csrf0, idempotencyKey: `del-continue-${runId}`,
    body: { action: 'continue', email, password },
  });
  if (cont.status !== 200 || !cont.data?.challengeId) throw new Error('CONTINUE_FAILED:' + safeError(cont.data?.error));
  const delivery = readOtp(email);
  if (!delivery?.code) throw new Error('OTP_NOT_FOUND');
  const verify = await request('/api/account/email', {
    method: 'POST', cookie: cookie0, csrf: csrf0, idempotencyKey: `del-verify-${runId}`,
    body: { action: 'verify', challengeId: cont.data.challengeId, code: delivery.code },
  });
  if (verify.status !== 200 || typeof verify.data?.actor !== 'string') throw new Error('VERIFY_FAILED:' + safeError(verify.data?.error));
  const cookie = (verify.setCookie || cookie0).split(';')[0];
  const session = await request('/api/account/session', { cookie });
  if (session.data?.linked !== true) throw new Error('SESSION_NOT_LINKED');
  return { email, cookie, csrf: verify.data.csrf || csrf0, actor: verify.data.actor, profile: verify.data.profile, session };
}

/* ------------------------------------------------- read-only durable observer */

function observer() {
  /* The staging runtime role credentials live in the operator's 0600 secrets directory (the same
   * material the deployed origin boots from). Only SELECTs are issued; nothing is printed but the
   * sanitized facts below. */
  const roles = JSON.parse(fs.readFileSync(path.join(SECRETS_DIR, 'runtime-roles.json'), 'utf8'));
  const ca = fs.readFileSync(path.join(SECRETS_DIR, 'ca.pem'), 'utf8');
  const { Client } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
  const connect = async (role) => {
    const client = new Client({
      host: roles.host, port: 5432, database: roles.database, user: role,
      password: roles.roles[role].password, ssl: { ca, rejectUnauthorized: true },
    });
    await client.connect();
    return client;
  };
  const one = async (client, text, params) => (await client.query(text, params)).rows;
  const count = async (client, text, params) => Number((await one(client, text, params))[0]?.n ?? -1);
  return { connect, one, count };
}

async function observeDeletedActor(obs, { actor, email, requestId, receiptId, responseTombstone }) {
  const out = { roles: {}, reads: {} };

  /* worker_runtime FIRST: it is the only role that can read the `account.deletion` outbox payload,
   * which is the authoritative source of the tombstone and actor hash. The response is compared
   * against it rather than trusted, so a route that drops the durable fields is caught, not hidden. */
  const worker = await obs.connect('worker_runtime');
  out.roles.worker_runtime = true;
  const w = (out.worker = { reads: {} });
  let payloadTombstone = null;
  try {
    const job = (await obs.one(worker, 'SELECT kind, state, payload FROM ops.outbox WHERE outbox_id = $1', [`account.deletion:${actor}`]))[0] || null;
    if (job) {
      let payload = null;
      try { payload = JSON.parse(job.payload); } catch { payload = null; }
      const text = typeof job.payload === 'string' ? job.payload : '';
      payloadTombstone = typeof payload?.tombstone === 'string' ? payload.tombstone : null;
      w.reads.outbox = {
        kind: job.kind, state: job.state,
        payload_keys: payload ? Object.keys(payload).sort() : null,
        retained: payload?.retained ?? null,
        receipt_id_matches: payload?.receiptId === receiptId,
        actor_hash_present: typeof payload?.actorHash === 'string' && payload.actorHash.length === 43,
        tombstone_shape: /^deleted_[0-9a-f]{32}$/.test(String(payloadTombstone)) ? 'deleted_<32hex>' : null,
        tombstone_matches_response: payloadTombstone !== null && payloadTombstone === responseTombstone,
        policy_version: payload?.policyVersion ?? null,
        carries_email: text.includes(email),
        carries_tag: /MEGA-[0-9A-F]{8}/.test(text),
        carries_raw_password_material: !!(payload && (payload.passwordHash || payload.salt)),
      };
    } else { w.reads.outbox = null; }
    /* The permanent receipt is written ONLY by the worker state machine, which is not deployed on
     * this origin: zero rows is the expected (and honest) completion state. */
    w.reads.permanent_receipts = await obs.count(worker, 'SELECT count(*)::int AS n FROM privacy.deletion_receipts WHERE receipt_id = $1', [receiptId]);
    w.reads.request_state = (await obs.one(worker, 'SELECT state FROM privacy.requests WHERE request_id = $1', [requestId]))[0]?.state ?? null;
  } finally { await worker.end(); }

  const api = await obs.connect('api_runtime');
  out.roles.api_runtime = true;
  const r = (out.reads = {});
  try {
    const profile = (await obs.one(api, 'SELECT tag, username, display_name, stats_visibility, presence_visibility FROM identity.profiles WHERE actor_id = $1', [actor]))[0] || null;
    /* The profile keeps only the 24-char scrub prefix, so the full tombstone is compared through the
     * outbox payload; the row proves the scrub happened. */
    r.profile_tombstone = profile ? {
      username: profile.username,
      display_name_matches_username: profile.display_name === profile.username,
      scrub_matches_outbox_prefix: payloadTombstone !== null && profile.username === payloadTombstone.slice(0, 24),
      stats_visibility: profile.stats_visibility,
      presence_visibility: profile.presence_visibility,
      tag_preserved: typeof profile.tag === 'string' && /^MEGA-[0-9A-F]{8}$/.test(profile.tag),
    } : null;
    r.eligibility_verified = (await obs.one(api, 'SELECT verified FROM identity.eligibility WHERE actor_id = $1', [actor]))[0]?.verified ?? null;
    r.credentials_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM identity.email_credentials WHERE actor_id = $1', [actor]);
    r.credentials_for_email_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM identity.email_credentials WHERE email = $1', [email]);
    r.identities_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM identity.identities WHERE actor_id = $1', [actor]);
    r.sessions_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM identity.sessions WHERE actor_id = $1', [actor]);
    r.challenges_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM identity.email_challenges WHERE actor_id = $1', [actor]);
    r.cloud_saves_remaining = await obs.count(api, 'SELECT count(*)::int AS n FROM profile.profile_saves WHERE actor_id = $1', [actor]);
    const req = (await obs.one(api, 'SELECT kind, state, policy_version, completed_at FROM privacy.requests WHERE request_id = $1', [requestId]))[0] || null;
    r.privacy_request = req ? { kind: req.kind, state: req.state, policy_version: req.policy_version, completed: req.completed_at !== null } : null;
    r.deletion_outbox_row_present = await obs.count(api, 'SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', [`account.deletion:${actor}`]);
    /* privacy.deletion_receipts is worker_runtime-owned (0022). api_runtime holds no grant on it -
     * the negative proof that the API cannot stamp completion itself. */
    try {
      await obs.one(api, 'SELECT receipt_id FROM privacy.deletion_receipts WHERE receipt_id = $1', [receiptId]);
      r.api_receipt_read = 'UNEXPECTEDLY_ALLOWED';
    } catch (error) {
      r.api_receipt_read = { denied: true, sqlstate: String(error?.code || 'UNKNOWN') };
    }
  } finally { await api.end(); }
  return out;
}

/* --------------------------------------------------------------- the lifecycle */

async function main() {
  const runId = crypto.randomBytes(9).toString('hex');
  const t0 = Date.now();
  const password = `Aa1!${crypto.randomBytes(18).toString('hex')}`;
  const aEmail = `stg_del_a_${runId}@example.test`;
  const bEmail = `stg_del_b_${runId}@example.test`;
  const results = {
    tool: 'p21-account-deletion-lifecycle', runId, origin: ORIGIN, timestampUtc: new Date().toISOString(),
    policyVersionObserved: null, deletions: [], ok: false, steps,
  };

  /* ---- 1. two disposable accounts through the real email flow ---- */
  const A = await signUp(aEmail, password, `${runId}_a`);
  const B = await signUp(bEmail, password, `${runId}_b`);
  pass('DL_01_signup_verify_linked', { actor_a_is_uuid: /^u_/.test(A.actor), actor_b_is_uuid: /^u_/.test(B.actor), sessionLinked: A.session.data.linked });

  /* A practice cloud save so the deletion has a real non-economic row to remove. */
  const save = await request('/api/account/save', {
    method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-save-${runId}`,
    body: {
      revision: 0,
      practice: {
        version: 3.2, economyVersion: 3.2, settings: { theme: 'vector' }, records: [], processed: [],
        playSeconds: 0, wallet: { coins: 0, crowns: 0, ledger: [], owned: [] }, daily: {}, weekly: {}, legacy: {}, profile: {},
      },
    },
  });
  expect('DL_02_cloud_save_written', save.status === 200, { httpStatus: save.status, code: save.data?.error });

  /* A real friendship so a second viewer exists for the visibility checks. */
  const fr = await request('/api/community/friend', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-fr-${runId}`, body: { action: 'request', target: B.actor } });
  const fa = await request('/api/community/friend', { method: 'POST', cookie: B.cookie, csrf: B.csrf, idempotencyKey: `del-fa-${runId}`, body: { action: 'accept', target: A.actor } });
  expect('DL_03_friendship_formed', fr.status === 200 && fa.status === 200, { request: fr.status, accept: fa.status, code: fr.data?.error || fa.data?.error });

  /* ---- 2. deletion availability + the tag confirmation contract ---- */
  const status = await request('/api/account/deletion', { cookie: A.cookie });
  results.policyVersionObserved = status.data?.policyVersion ?? null;
  /* The tag itself is a pseudonymous account identifier; only its grammar is recorded. */
  results.deletionConfirmationTagShape = typeof status.data?.confirmation === 'string' && /^MEGA-[0-9A-F]{8}$/.test(status.data.confirmation) ? 'MEGA-<8 hex upper>' : null;
  expect('DL_04_deletion_status_available', status.status === 200 && status.data?.available === true && typeof status.data?.confirmation === 'string' && status.data?.recentlyVerified === true,
    { httpStatus: status.status, available: status.data?.available, policyVersion: status.data?.policyVersion, recentlyVerified: status.data?.recentlyVerified });

  const unauth = await request('/api/account/delete', { method: 'POST', body: { confirmation: 'x' } });
  expect('DL_05_delete_requires_auth', unauth.status === 401 && unauth.data?.error === 'AUTH_REQUIRED', { httpStatus: unauth.status, code: unauth.data?.error });

  const wrong = await request('/api/account/delete', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-wrong-${runId}`, body: { confirmation: 'NOT-MY-TAG' } });
  expect('DL_06_wrong_confirmation_rejected', wrong.status === 409 && wrong.data?.error === 'DELETE_CONFIRMATION_REQUIRED', { httpStatus: wrong.status, code: wrong.data?.error });

  const missing = await request('/api/account/delete', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-missing-${runId}`, body: {} });
  expect('DL_07_missing_confirmation_rejected', missing.status === 409 && missing.data?.error === 'DELETE_CONFIRMATION_REQUIRED', { httpStatus: missing.status, code: missing.data?.error });

  const stillAlive = await request('/api/account/profile', { cookie: A.cookie });
  expect('DL_08_rejected_delete_keeps_session', stillAlive.status === 200 && stillAlive.data?.id === A.actor, { httpStatus: stillAlive.status });

  const bSeesABefore = await request(`/api/community/profile/${A.actor}`, { cookie: B.cookie });
  expect('DL_09_profile_readable_before', bSeesABefore.status === 200, { httpStatus: bSeesABefore.status, code: bSeesABefore.data?.error });

  /* ---- 3. the real coordinated deletion ---- */
  const tag = status.data.confirmation;
  const del = await request('/api/account/delete', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-${runId}`, body: { confirmation: tag } });
  const receiptId = del.data?.receiptId;
  const tombstone = del.data?.tombstone;
  const deletion = {
    actorLabel: 'a', httpStatus: del.status, error: del.data?.error ?? null,
    bodyKeys: del.data && typeof del.data === 'object' ? Object.keys(del.data).sort() : null,
    deletedFlag: del.data?.deleted ?? null, status: del.data?.status ?? null,
    receiptIdShape: typeof receiptId === 'string' && /^del_[0-9a-f-]{36}$/.test(receiptId) ? 'del_<uuid>' : null,
    tombstoneShape: typeof tombstone === 'string' && /^deleted_[0-9a-f]{32}$/.test(tombstone) ? 'deleted_<32hex>' : null,
    actorHashPresent: typeof del.data?.actorHash === 'string' && del.data.actorHash.length === 43,
    policyVersion: del.data?.policyVersion ?? null,
    cacheControl: del.cacheControl ?? null,
  };
  results.deletions.push(deletion);
  expect('DL_10_delete_acknowledged_pending', del.status === 200 && del.data?.deleted === true && del.data?.status === 'pending' && deletion.receiptIdShape === 'del_<uuid>' && deletion.tombstoneShape === 'deleted_<32hex>' && deletion.actorHashPresent,
    { httpStatus: del.status, status: del.data?.status, policyVersion: del.data?.policyVersion, bodyKeys: deletion.bodyKeys });

  /* ---- 4. post-conditions over HTTP ---- */
  const revokedProfile = await request('/api/account/profile', { cookie: A.cookie });
  expect('DL_11_bearer_revoked', revokedProfile.status === 401 && revokedProfile.data?.error === 'AUTH_REQUIRED', { httpStatus: revokedProfile.status, code: revokedProfile.data?.error });

  const revokedSave = await request('/api/account/save', { cookie: A.cookie });
  expect('DL_12_revoked_bearer_cannot_read_save', revokedSave.status === 401, { httpStatus: revokedSave.status, code: revokedSave.data?.error });

  const revokedStatus = await request('/api/account/deletion', { cookie: A.cookie });
  expect('DL_13_revoked_bearer_cannot_read_deletion_status', revokedStatus.status === 401, { httpStatus: revokedStatus.status, code: revokedStatus.data?.error });

  const rebootstrap = await request('/api/account/session', { cookie: A.cookie });
  expect('DL_14_revoked_bearer_boots_anonymous', rebootstrap.status === 200 && rebootstrap.data?.linked === false && rebootstrap.data?.actorId === null, { httpStatus: rebootstrap.status, linked: rebootstrap.data?.linked });

  const bSeesAAfter = await request(`/api/community/profile/${A.actor}`, { cookie: B.cookie });
  expect('DL_15_profile_unreadable_after', bSeesAAfter.status === 404 && bSeesAAfter.data?.error === 'PROFILE_NOT_FOUND', { httpStatus: bSeesAAfter.status, code: bSeesAAfter.data?.error });

  const searchByTag = await request(`/api/community/search?q=${encodeURIComponent(tag)}`, { cookie: B.cookie });
  const searchByUsername = await request(`/api/community/search?q=${encodeURIComponent(A.profile?.username || 'zzz')}`, { cookie: B.cookie });
  expect('DL_16_search_excludes_deleted', searchByTag.status === 200 && Array.isArray(searchByTag.data) && searchByTag.data.length === 0
    && searchByUsername.status === 200 && Array.isArray(searchByUsername.data) && searchByUsername.data.length === 0,
    { byTag: Array.isArray(searchByTag.data) ? searchByTag.data.length : searchByTag.status, byUsername: Array.isArray(searchByUsername.data) ? searchByUsername.data.length : searchByUsername.status });

  const friendsAfter = await request('/api/community/friends', { cookie: B.cookie });
  const friendIds = Array.isArray(friendsAfter.data) ? friendsAfter.data : (friendsAfter.data?.friends || []);
  expect('DL_17_deleted_actor_absent_from_friends', friendsAfter.status === 200 && !friendIds.some((f) => (f.id || f.actor) === A.actor), { httpStatus: friendsAfter.status, count: friendIds.length });

  const replay = await request('/api/account/delete', { method: 'POST', cookie: A.cookie, csrf: A.csrf, idempotencyKey: `del-replay-${runId}`, body: { confirmation: tag } });
  expect('DL_18_delete_replay_is_terminal', replay.status === 401, { httpStatus: replay.status, code: replay.data?.error });

  /* The credential + identity are gone, so the same address is an ordinary SIGNUP again (a NEW
   * actor; the former tag is never restored). */
  const reborn = await signUp(aEmail, password, `${runId}_reborn`);
  expect('DL_19_email_signs_up_as_new_actor_after_deletion', reborn.actor !== A.actor && reborn.profile?.tag !== tag,
    { sameActor: reborn.actor === A.actor, tagRestored: reborn.profile?.tag === tag });

  /* ---- 5. durable end state (read-only observation) ---- */
  if (OBSERVE_DB) {
    try {
      const obs = observer();
      const state = await observeDeletedActor(obs, { actor: A.actor, email: aEmail, requestId: receiptId, receiptId, responseTombstone: tombstone ?? null });
      deletion.durable = state;
      const r = state.reads;
      const w = state.worker.reads;
      expect('DL_20_profile_tombstoned_and_closed',
        r.profile_tombstone?.scrub_matches_outbox_prefix === true && r.profile_tombstone?.display_name_matches_username === true
        && r.profile_tombstone?.stats_visibility === 'private' && r.profile_tombstone?.presence_visibility === 'hidden'
        && r.profile_tombstone?.tag_preserved === true,
        { tombstone: r.profile_tombstone });
      expect('DL_21_account_marked_unverified', r.eligibility_verified === false, { verified: r.eligibility_verified });
      expect('DL_22_login_material_removed',
        r.credentials_remaining === 0 && r.credentials_for_email_remaining === 0 && r.identities_remaining === 0
        && r.sessions_remaining === 0 && r.challenges_remaining === 0 && r.cloud_saves_remaining === 0,
        { credentials: r.credentials_remaining, credentialsForEmail: r.credentials_for_email_remaining, identities: r.identities_remaining, sessions: r.sessions_remaining, challenges: r.challenges_remaining, saves: r.cloud_saves_remaining });
      expect('DL_23_privacy_request_recorded_requested', r.privacy_request?.state === 'requested' && r.privacy_request?.kind === 'deletion' && r.privacy_request?.completed === false && r.privacy_request?.policy_version === results.policyVersionObserved,
        { request: r.privacy_request });
      expect('DL_24_durable_outbox_handoff_present', r.deletion_outbox_row_present === 1, { rows: r.deletion_outbox_row_present });
      expect('DL_25_api_cannot_read_worker_receipt', r.api_receipt_read?.denied === true && r.api_receipt_read?.sqlstate === '42501', { result: r.api_receipt_read });
      expect('DL_26_handoff_payload_is_minimal',
        w.outbox?.kind === 'account.deletion' && w.outbox?.state === 'queued' && w.outbox?.tombstone_matches_response === true
        && w.outbox?.tombstone_shape === 'deleted_<32hex>' && w.outbox?.receipt_id_matches === true && w.outbox?.actor_hash_present === true
        && Array.isArray(w.outbox?.retained) && w.outbox.retained.length === 3
        && w.outbox?.carries_email === false && w.outbox?.carries_tag === false && w.outbox?.carries_raw_password_material === false,
        { outbox: w.outbox });
      expect('DL_27_completion_pending_worker', w.permanent_receipts === 0 && w.request_state === 'requested', { receipts: w.permanent_receipts, requestState: w.request_state });
    } catch (error) {
      fail('DL_20_profile_tombstoned_and_closed', { observationError: safeError(error) });
    }
  } else {
    steps.push({ name: 'DL_20-DL_27_durable_observations', status: 'NOT_RUN', note: '--no-db' });
  }

  /* ---- 6. hygiene: the two remaining disposable accounts are deleted too ---- */
  for (const [label, acct] of [['reborn', reborn], ['b', B]]) {
    const s = await request('/api/account/deletion', { cookie: acct.cookie });
    const d = await request('/api/account/delete', { method: 'POST', cookie: acct.cookie, csrf: acct.csrf, idempotencyKey: `del-${label}-${runId}`, body: { confirmation: s.data?.confirmation } });
    results.deletions.push({ actorLabel: label, httpStatus: d.status, error: d.data?.error ?? null, status: d.data?.status ?? null, tombstoneShape: typeof d.data?.tombstone === 'string' ? 'deleted_<32hex>' : null });
    expect(`DL_28_cleanup_deleted_${label}`, d.status === 200 && d.data?.status === 'pending', { httpStatus: d.status, code: d.data?.error });
  }

  results.ok = steps.every((s) => s.status === 'PASSED' || s.status === 'NOT_RUN');
  results.summary = {
    total: steps.length,
    passed: steps.filter((s) => s.status === 'PASSED').length,
    failed: steps.filter((s) => s.status === 'FAILED').length,
    notRun: steps.filter((s) => s.status === 'NOT_RUN').length,
    durationMs: Date.now() - t0,
  };
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: safeError(err), steps }, null, 2));
  process.exitCode = 1;
});
