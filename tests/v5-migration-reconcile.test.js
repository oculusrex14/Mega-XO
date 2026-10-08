/* V5 P03 (V5-03-04) - target-side reconciliation: verify()/report() consumer-visible invariants.
 *
 * Harness contract (same disposable contract as tests/v5-migrations.test.js):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: a caller-owned synthetic PG16
 *     cluster. The URL is used ONLY to CREATE/DROP this suite's tracked v5_test_* databases.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir and a
 *     random loopback port; Docker (postgres:16) is the fallback.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 *
 * The target is built the way the task allows while tools/v5-migration/loader.js does not exist:
 * the checksummed migration chain is executed through the real trusted runner, then a small
 * hand-built fixture is inserted directly and the run/target_guard/row_ledger rows are written with
 * the reconciler's own published hash contract. Nothing here touches a Neon or production target;
 * every database is a temporary loopback cluster owned by this process.
 *
 * Covered boundaries: a clean match yields zero unexplained differences; the A07 swapped-wallet
 * case fails while the global totals stay identical; a deleted target row and an extra target row
 * are both reported; a tampered value is reported; the explained-category path is exercised
 * (restore-normalization from a reader-reported delta and unclassified-key-accepted); the run
 * fingerprint guard refuses a model that belongs to another run; report() emits a sanitized,
 * checksummed summary with no actor id or value in it.
 *
 * Run: node --test tests/v5-migration-reconcile.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const RECONCILE = path.join(ROOT, 'tools', 'v5-migration', 'reconcile.js');
const {verify, report, rowHash, targetPkHash, locatorFor, EXPLAINED_CATEGORIES, TABLES} = require(RECONCILE);
const {hash, canonical} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));
const pg = require('pg');

const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;
const CLOCK = Date.parse('2026-10-08T12:00:00Z');

/* ---------------------------------------------------------------- backend */

function whichBinary() {
  const dirs = ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) &&
          execFileSync(path.join(dir, 'initdb'), ['--version'], {encoding: 'utf8'}).includes(' 16.')) return dir;
    } catch { /* next */ }
  }
  try {
    const found = spawnSync('which', ['initdb'], {encoding: 'utf8'});
    if (found.status === 0 && execFileSync(found.stdout.trim(), ['--version'], {encoding: 'utf8'}).includes(' 16.')) {
      return path.dirname(found.stdout.trim());
    }
  } catch { /* not on PATH */ }
  return null;
}

function dockerAvailableOnce() {
  try { execFileSync('docker', ['info', '-f', '{{.ServerVersion}}'], {stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000}); return true; }
  catch { return false; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

let backend = null;
let backendError = null;
async function ensureBackend() {
  if (backend) return backend;
  if (backendError) throw new Error(backendError);
  const external = process.env.V5_PG_URL || '';
  if (external) {
    if (process.env.V5_PG_DISPOSABLE !== '1') { backendError = 'V5_PG_URL requires V5_PG_DISPOSABLE=1 (owned synthetic cluster only)'; throw new Error(backendError); }
    let u;
    try { u = new URL(external); } catch { backendError = 'V5_PG_URL is unparsable'; throw new Error(backendError); }
    if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) { backendError = 'V5_PG_URL must target a loopback host'; throw new Error(backendError); }
    if (/(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(decodeURIComponent(u.pathname))) { backendError = 'V5_PG_URL control database must be non-production'; throw new Error(backendError); }
    backend = {kind: 'external', adminUrl: external};
    return backend;
  }
  const bin = whichBinary();
  if (bin) {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-reconcile-pg-${PID}-`));
    execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'],
      {stdio: 'ignore', env: {...process.env, LC_ALL: 'C'}, timeout: 120000});
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
      '-l', path.join(dataDir, 'server.log'), 'start'], {stdio: 'ignore', env: {...process.env, LC_ALL: 'C'}, timeout: 120000});
    const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 60; i += 1) {
      try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], {stdio: 'ignore', timeout: 10000}); break; }
      catch { if (i === 59) { backendError = 'binary PG16 never became ready'; throw new Error(backendError); } execFileSync('sleep', ['1']); }
    }
    backend = {kind: 'binary', adminUrl, stop: () => {
      try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'i', 'stop'], {stdio: 'ignore', timeout: 30000}); } catch { /* gone */ }
      fs.rmSync(dataDir, {recursive: true, force: true});
    }};
    return backend;
  }
  if (dockerAvailableOnce()) {
    const name = `v5-rec-${PID}-${SUFFIX}`;
    try { execFileSync('docker', ['image', 'inspect', 'postgres:16'], {stdio: 'ignore', timeout: 15000}); }
    catch { execFileSync('docker', ['pull', 'postgres:16'], {stdio: 'ignore', timeout: 900000}); }
    execFileSync('docker', ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p', '127.0.0.1::5432', 'postgres:16', 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'], {stdio: 'ignore', timeout: 300000});
    let port = 0;
    for (let i = 0; i < 90; i += 1) {
      try { port = Number(execFileSync('docker', ['port', name, '5432/tcp'], {encoding: 'utf8'}).trim().split('\n')[0].split(':').pop()); if (port) break; } catch { /* pending */ }
      execFileSync('sleep', ['1']);
    }
    if (!port) { backendError = 'container port never mapped'; throw new Error(backendError); }
    backend = {kind: 'container', adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
      stop: () => { try { execFileSync('docker', ['rm', '-f', '-v', name], {stdio: 'ignore', timeout: 60000}); } catch { /* gone */ } }};
    return backend;
  }
  backendError = 'no PG16 backend available (no V5_PG_URL, no postgresql@16 binary, no docker daemon)';
  throw new Error(backendError);
}

const createdDatabases = new Set();
function ident(name) { return `"${name.replace(/"/g, '""')}"`; }
function backendParts() {
  const url = new URL(backend.adminUrl);
  return {
    host: url.hostname, port: Number(url.port || 5432),
    user: url.username ? decodeURIComponent(url.username) : 'postgres',
    password: url.username ? decodeURIComponent(url.password || '') : undefined
  };
}
async function connectAdmin(database) {
  const c = new pg.Client({...backendParts(), database: database || decodeURIComponent(new URL(backend.adminUrl).pathname.replace(/^\//, ''))});
  await c.connect();
  return c;
}
function dbUrl(database) {
  const url = new URL(backend.adminUrl);
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

test.after(async () => {
  if (!backend) return;
  for (const name of [...createdDatabases]) {
    try { const c = await connectAdmin(); await c.query(`DROP DATABASE IF EXISTS ${ident(name)}`); await c.end(); }
    catch { /* best effort; only THIS suite's tracked names */ }
  }
  if (backend.stop) backend.stop();
});

function trackedName(family) { return `v5_test_reconcile_${family}_${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'); }

async function freshMigratedDb(family) {
  const name = trackedName(family);
  const admin = await connectAdmin();
  try { await admin.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await admin.end(); }
  const run = spawnSync(process.execPath, [RUNNER, '--execute', '--json', '--database-url', dbUrl(name)], {
    encoding: 'utf8', cwd: ROOT, timeout: 240000,
    env: {...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', MIGRATE_CONFIRM: name, V5_TARGET: 'test'}
  });
  const last = (run.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  let parsed = null;
  try { parsed = last ? JSON.parse(last) : null; } catch { /* human mode */ }
  assert.equal(run.status, 0, 'migrations must succeed: ' + (run.stderr || '').slice(0, 400));
  assert.equal(parsed && parsed.ok, true);
  return name;
}

/* ---------------------------------------------------------------- the model */

function account(id, overrides = {}) {
  return {
    id, friendCode: 'MEGA-' + id.replace(/[^A-Za-z0-9]/g, '').toUpperCase().padEnd(8, '0').slice(0, 8),
    coins: 150, crowns: 0, purchasedCoins: 0, purchasedCrowns: 0, legacyCompetitionRestricted: false,
    reservedCoins: 0, reservedCrowns: 0, rating: 600, peak: 600, games: 0, tier: 'wood',
    casualRating: 1000, casualGames: 0, verified: true, createdAt: CLOCK - 5000, region: '', wealthPublic: false,
    suspended: false, hold: false, blocked: [], friends: [], friendRequests: [], activeMatch: null,
    history: [], daily: {}, operations: {}, ledger: [], owned: [], purchaseInfluenced: false,
    tournamentRecord: {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0},
    season: {id: '2026-Q4', startedAt: Date.UTC(2026, 9, 1), games: 0, queueGames: 0, opponents: [], wins: 0, losses: 0, draws: 0, peakRating: 600, lastRatedAt: null, qualifiedAt: null},
    seasonHistory: [], ...overrides
  };
}

/* The hand-built source model, in the exact shape reader.js returns. */
function buildModel() {
  const alice = account('alice-1', {
    coins: 149, crowns: 1, purchasedCoins: 6, purchaseInfluenced: true,
    rating: 612.5, peak: 612.5, games: 1, tier: 'wood', casualRating: 1000, casualGames: 1,
    friends: ['bob_2'], blocked: [], friendRequests: ['bob_2'],
    owned: ['Copper edge'],
    daily: {'2026-10-08': {finished: 1, seconds: 90.5, boards: 3, casual: 0, friend: 0, ranked: 1, rankedBonus: 0, claimed: ['finish']}},
    ledger: [
      {id: 'conv1:out', operation: 'conv1', currency: 'coins', amount: -10, reason: 'Convert to crowns', at: CLOCK - 1000},
      {id: 'conv1:in', operation: 'conv1', currency: 'crowns', amount: 1, reason: 'Converted from coins', at: CLOCK - 1000}
    ],
    history: [{
      id: 'm-finished', at: CLOCK - 2000, opponent: 'bob_2', mode: 'ranked', queue: true, symbol: 'X',
      rated: true, qualified: true, activityQualified: true, result: 'win', reason: 'line',
      activeSeconds: 120, ratingDelta: 12.5, casualDelta: 0
    }],
    activeMatch: null,
    operations: {conv1: {fingerprint: canonical({from: 'coins', to: 'crowns', debit: 10, credit: 1}), result: {from: 'coins', to: 'crowns', debit: 10, credit: 1, id: 'conv1'}}},
    monetization: {
      credits: 7, redeemed: ['classic'], equipped: 'classic',
      boosts: [{startedAt: CLOCK - 1000, endsAt: CLOCK + 600000}],
      daily: {'2026-10-08': {base: 2, bonus: 2, automatic: 1}},
      lastAdAt: CLOCK - 500, lastRewardStart: CLOCK - 400
    }
  });
  const bob = account('bob_2', {
    coins: 155, crowns: 0, friends: ['alice-1'],
    season: null, seasonHistory: [{id: '2026-Q3', startedAt: Date.UTC(2026, 6, 1), games: 4, queueGames: 2, opponents: ['alice-1'], wins: 2, losses: 2, draws: 0, peakRating: 605, lastRatedAt: CLOCK - 900000, qualifiedAt: CLOCK - 800000, finishRating: 604, finishTier: 'wood', endedAt: Date.UTC(2026, 9, 1)}]
  });
  /* `legacyCompetitionRestricted` is deliberately absent: the reader reports a restore-normalization
   * delta (boolean-coercion) and the RAW value stays authoritative in the target. */
  delete bob.legacyCompetitionRestricted;
  /* `casualGames` absent too: reported as casual-games-default. */
  delete bob.casualGames;

  const accounts = [['alice-1', alice], ['bob_2', bob]];
  const matches = [['m-finished', {
    id: 'm-finished', players: ['alice-1', 'bob_2'],
    terms: {source: 'queue', mode: 'queue', kind: 'ranked', rated: true, amount: 2, currency: 'coins', turnSeconds: 30, from: 'wood', to: 'wood', ratings: [600, 600]},
    quote: {version: 'economy-2', mode: 'queue', rated: true, currency: 'coins', minimum: 2, ceiling: 2, fee: 2, contributions: [2, 2], pool: 4, burn: 2, payout: 2, bonus: 0, netWin: 0},
    termsHash: hash({terms: 'queue'}), accepted: ['alice-1', 'bob_2'], created: CLOCK - 4000, expires: CLOCK - 3000,
    status: 'FINISHED', state: {board: [], mini: [], turn: 'X', required: null, winner: 'X', line: null, moves: [{b: 0, c: 0, player: 'X'}]},
    symbols: {X: 'alice-1', O: 'bob_2'}, revision: 3, commands: [], escrow: 0, settled: true,
    riskFlags: ['SHORT_DIRECT_RESULT_REVIEW'], started: CLOCK - 3500, _lastMoveAt: CLOCK - 2500,
    _moveTimings: [{actor: 'alice-1', ms: 1000}], preRatings: [600, 600], preTiers: ['wood', 'wood'],
    deadline: CLOCK - 2000,
    receipt: {winner: 'alice-1', reason: 'line', currency: 'coins', payout: 2, burn: 2, bonus: 0, refunded: 0, rating: {a: 612.5, b: 587.5, delta: 12.5, expectedA: 0.5, k: 24}, at: CLOCK - 2000},
    _riskActors: {}
  }]];
  const rooms = [{
    id: 'room-1', code: 'ABCD1234',
    raw: '{}',
    parsed: {
      version: 'tournament-2', id: 'room-1', code: 'ABCD1234', owner: 'alice-1', name: 'Public', format: 'mixed',
      table: 'low', sequential: false,
      quote: {name: 'Low', currency: 'coins', entry: 100, table: 'low', seats: 10, pool: 1000, burn: 100, payouts: [360, 200, 130, 110, 100, 0, 0, 0, 0, 0], net: [260, 100, 30, 10, 0, -100, -100, -100, -100, -100]},
      clock: 120, increment: 1, capacity: 10, rulesVersion: 1,
      players: [{id: 'alice-1', name: 'Alice', ready: true, withdrawn: false}, {id: 'bob_2', name: 'Bob', ready: false, withdrawn: false}],
      status: 'LOBBY', created: CLOCK - 1000, expires: CLOCK + 100000,
      fixtures: [{id: 'f-1', slots: [], label: 'R1', round: 1, group: null, decisive: false, status: 'BLOCKED', players: null, ready: [], state: null, winner: null, attempt: 0, mini: {}, history: [], revision: 0}],
      groups: [], ranking: null, finalRefs: null, started: null, revision: 2, roundDelay: 15000, seed: ['alice-1', 'bob_2'],
      escrow: 0, settled: false, contributions: [], receipt: null, riskFlags: [], _riskActors: {}
    }
  }];

  const state = {
    accounts, matches,
    /* tx-1 is a current-catalogue pack; tx-old is an ARCHIVED catalogue id (legacy-product-catalogue)
     * whose refunded flag has no matching revocation tombstone (refund-without-revocation). */
    receipts: [
      ['google:tx-1', {actor: 'alice-1', productId: 'crowns_100', crowns: 100, refunded: false, at: CLOCK - 5000}],
      ['apple:tx-old', {actor: 'bob_2', productId: 'crowns_legacy_50', crowns: 50, refunded: true, at: CLOCK - 7000}]
    ],
    snapshots: [['2026-10-08', {'alice-1': 'wood'}]],
    /* The source's weekly key is D.week(now) = the Monday DATE ('YYYY-MM-DD'), and the payout id is
     * `<week>:<actor>`; leagueWeek carries that same date. */
    weeklyPaid: [['2026-10-05:alice-1', {id: '2026-10-05:alice-1', account: 'alice-1', week: '2026-10-05', amount: 20, tier: 'wood', eligible: true, days: 7}]],
    burned: {coins: 2, crowns: 0},
    journal: [
      {id: 'provisioning:alice-1', actor: 'alice-1', currency: 'coins', amount: 150, reason: 'Welcome coins', source: 'provisioning', at: CLOCK - 9000},
      {id: 'provisioning:bob_2', actor: 'bob_2', currency: 'coins', amount: 150, reason: 'Welcome coins', source: 'provisioning', at: CLOCK - 9000},
      {id: 'm-finished:payout', actor: 'alice-1', currency: 'coins', amount: 2, reason: 'Match winnings', source: 'game', at: CLOCK - 2000},
      {id: 'quest:x', actor: 'bob_2', currency: 'coins', amount: 5, reason: 'A good start', source: 'mint', at: CLOCK - 1500},
      {id: 'quest:y', actor: 'alice-1', currency: 'coins', amount: 5, reason: 'One more round', source: 'mint', at: CLOCK - 1600},
      {id: 'quest:z', actor: 'alice-1', currency: 'coins', amount: 2, reason: 'A good start', source: 'mint', at: CLOCK - 1550},
      {id: 'conv1:out', actor: 'alice-1', currency: 'coins', amount: -10, reason: 'Currency conversion', source: 'conversion', at: CLOCK - 1000},
      {id: 'conv1:in', actor: 'alice-1', currency: 'crowns', amount: 1, reason: 'Currency conversion', source: 'conversion', at: CLOCK - 1000}
    ],
    leagueWeek: '2026-10-05'
  };

  const t = (rows) => ({columns: [], rows: rows.map((values) => ({key: '', values})), count: rows.length, sha256: hash(rows), owner: null, disposition: 'V', classification: 'described'});
  return {
    version: 1,
    capture: {clockMs: CLOCK, sourceSha: 'f'.repeat(40), fileSha256: 'a'.repeat(64), bytes: 1234, schemaHead: {maxId: 36, count: 36, allMatch: true}, sourceRelease: null},
    schema: {tables: [], indexes: [], triggers: [], views: [], drift: {}},
    tables: {
      profiles: t([
        {actor: 'alice-1', tag: 'MEGA-0A1B2C3D', username: 'alice', display_name: 'Alice', avatar: 'board', stats_visibility: 'friends', presence_visibility: 'friends', created: CLOCK - 5000, username_changed: null, version: 1},
        {actor: 'bob_2', tag: 'MEGA-0B0B0B0B', username: 'bob', display_name: 'Bob', avatar: 'board', stats_visibility: 'public', presence_visibility: 'hidden', created: CLOCK - 5000, username_changed: null, version: 2}
      ]),
      identities: t([{provider: 'email', subject: 'alice@example.test', actor: 'alice-1', created: CLOCK - 5000}]),
      email_credentials: t([{email: 'alice@example.test', actor: 'alice-1', salt: 'c2FsdA==', password_hash: 'scrypt-v1$abc', created: CLOCK - 5000, verified_at: CLOCK - 4000}]),
      profile_saves: t([{actor: 'alice-1', revision: 3, payload: '{"version":3.2,"records":[]}', updated: CLOCK - 100}]),
      v35_tickets: t([{id: 't-1', actor: 'alice-1', kind: 'credits', issued: CLOCK - 3000, expires: CLOCK + 100000, day: '2026-10-08', settled: 1, transaction_id: 'tx-1'}]),
      v35_casual: t([{actor: 'alice-1', match_id: 'm-finished', base: 1, bonus: 0}]),
      v35_events: t([{id: 1, actor: 'alice-1', kind: 'credits_redeemed', at: CLOCK - 3000, value: 1}]),
      v41_store_bindings: t([{actor: 'alice-1', google_id: 'g-1', apple_token: 'a-1', created: CLOCK - 5000}]),
      v41_store_revocations: t([{store: 'google', transaction_id: 'tx-orphan', product_id: null, occurred_at: CLOCK - 1000, reason: 'refund'}],),
      v41_reports: t([{id: 'r-1', reporter: 'bob_2', target: 'alice-1', category: 'username', detail: 'x', created: CLOCK - 7000, state: 'open', reviewed_at: null, reviewed_by: null, outcome: null}]),
      v41_privacy_requests: t([{id: 'p-1', actor: 'bob_2', kind: 'deletion', state: 'requested', requested_at: CLOCK - 6000, updated_at: CLOCK - 6000, completed_at: null, policy_version: 'v1', note: ''}]),
      v41_deletion_receipts: t([{id: 'd-1', actor_hash: 'h'.repeat(64), tombstone: 'deleted_' + '0'.repeat(32), completed_at: CLOCK - 8000, policy_version: 'v1', retained: []}]),
      v41_operator_audit: t([{id: 'a-1', at: CLOCK - 8000, operator: 'ops', action: 'provision', actor: 'alice-1', reason: 'bootstrap', detail: '{}', prev_hash: 'GENESIS', entry_hash: 'e'.repeat(64)}]),
      v4_controls: t([{id: 1, maintenance: 0}]),
      v4_runtime: t([{key: 'incident', value: 'none'}]),
      v4_outbox: t([{id: 'o-1', payload: null, kind: 'verify', state: 'cancelled', created: CLOCK - 9000, expires: CLOCK + 1, next_at: CLOCK, lease_until: 0, attempts: 1}]),
      v4_limits: t([{id: 'mail-budget:2026-10', hits: 4, expires: CLOCK + 1000}, {id: 'abuse:1', hits: 2, expires: CLOCK + 1000}]),
      community_limits: t([{id: 'search:1', hits: 1}]),
      party_guests: t([{token: 't'.repeat(43), actor: 'guest-1', name: 'LAN Guest', expires: CLOCK + 1000}]),
      account_sessions: t([{token: 'a'.repeat(64), actor: 'alice-1', csrf: 'c', created: CLOCK - 1000, expires: CLOCK + 1000, auth_at: CLOCK - 1000}]),
      email_challenges: t([{id: 'ch-1', session: 's', email: 'alice@example.test', purpose: 'verify-existing', actor: 'alice-1', code_hash: 'k', password_salt: null, password_hash: null, created: CLOCK - 1000, expires: CLOCK - 1, attempts: 1, verified_at: CLOCK - 900, consumed: 1}]),
      v4_email_versions: t([{challenge: 'ch-1', credential_hash: null}]),
      session_presence: t([{session: 'p'.repeat(43), actor: 'alice-1', seen: CLOCK - 100, foreground: 1}]),
      commands: t([{id: JSON.stringify(['alice-1', 'k1']), actor: 'alice-1', fingerprint: 'f'.repeat(64), response: '{}'}]),
      party_commands: t([{id: JSON.stringify(['alice-1', 'party setup v1']), fingerprint: 'b'.repeat(64), response: '{"id":"room-1"}'}]),
      social_operations: t([{id: 'alice-1:k1', fingerprint: 'A'.repeat(43), result: '{"ok":true}'}]),
      v35_commands: t([{actor: 'alice-1', key: 'claim', fingerprint: 'c'.repeat(64), response: '{"credits":1}'}]),
      v4_schema: t([{id: 1, name: '0001', checksum: 'x'.repeat(64), applied_at: CLOCK - 9000}])
    },
    state: {raw: '{}', parsed: state},
    rooms,
    coverage: {
      tables: [], fields: {total: 1, unclassified: 0, accepted: 1}, dispositions: {}, unclassified_count: 0,
      unclassified: [], accepted: [{locator: 'state.accounts[].someLegacyThing', ruleId: 'approved-legacy-variant'}],
      policy: {default: 'fail'}
    },
    hashes: {
      stateRoots: {}, tableRoots: {}, sourceFingerprint: '9f'.repeat(32), actorHashesRoot: 'ab'.repeat(32), actorHashes: {},
      normalization: [
        {actor: 'bob_2', field: 'state.accounts[].legacyCompetitionRestricted', rule: 'boolean-coercion', raw: null, normalized: false},
        {actor: 'bob_2', field: 'state.accounts[].casualGames', rule: 'casual-games-default', raw: null, normalized: 0},
        {actor: 'bob_2', field: 'state.accounts[].season', rule: 'season-roll-or-create', raw: null, normalized: {id: '2026-Q4', created: true, archivedSeasonHistoryLength: 1}}
      ],
      grammarDrift: [], opaqueUnsafeNumbers: []
    }
  };
}

/* ---------------------------------------------------------------- the target */

/* An INDEPENDENT target writer: it inserts the rows the importer must produce for this model, so
 * the reconciler is exercised against real PostgreSQL rows rather than against itself. */
async function materialize(client, model) {
  const accounts = new Map(model.state.parsed.accounts);
  const ledger = [];
  /* A json/jsonb parameter must be sent as JSON TEXT (pg passes a JS string through unchanged and
   * Postgres would then reject `line` as invalid JSON); a SQL NULL is the representation the DDL's
   * `IS NULL OR jsonb_typeof(...)` checks expect for an absent source value. */
  const jsql = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
  const exec = async (text, values) => {
    try { await client.query(text, values); }
    catch (error) { error.statement = text.replace(/\s+/g, ' ').slice(0, 160); throw error; }
  };
  const stamp = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  const record = (kind, table, keys, values) => {
    const row = {};
    for (const [column, value] of Object.entries(values)) row[column] = value === undefined ? null : value;
    ledger.push({kind, table, keys, row});
  };

  /* identity + economy per actor */
  for (const [id, a] of accounts) {
    /* identity.actors.region is the PG JSON type carrying a JSON string scalar (0034). */
    await exec('INSERT INTO identity.actors(actor_id, region, wealth_public, created_at) VALUES ($1,$2,$3,$4)',
      [a.id, JSON.stringify(a.region ?? ''), a.wealthPublic === true, stamp(a.createdAt)]);
    record('actors', 'identity.actors', {actor_id: a.id}, {actor_id: a.id, region: a.region, wealth_public: a.wealthPublic === true, created_at: a.createdAt});
    await exec('INSERT INTO identity.eligibility(actor_id, verified, suspended, security_hold) VALUES ($1,$2,$3,$4)',
      [a.id, a.verified === true, a.suspended === true, a.hold === true]);
    record('eligibility', 'identity.eligibility', {actor_id: a.id}, {actor_id: a.id, verified: a.verified === true, suspended: a.suspended === true, security_hold: a.hold === true});
    const purchasedCoins = Number.isSafeInteger(a.purchasedCoins) && a.purchasedCoins >= 0 ? a.purchasedCoins : 0;
    const purchasedCrowns = Number.isSafeInteger(a.purchasedCrowns) && a.purchasedCrowns >= 0 ? a.purchasedCrowns : 0;
    const restricted = Object.prototype.hasOwnProperty.call(a, 'legacyCompetitionRestricted') ? a.legacyCompetitionRestricted === true : a.purchaseInfluenced === true;
    await exec(`INSERT INTO economy.wallets(actor_id, coins, crowns, reserved_coins, reserved_crowns, purchased_coins, purchased_crowns, purchase_influenced, legacy_competition_restricted)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.coins, a.crowns, a.reservedCoins, a.reservedCrowns, purchasedCoins, purchasedCrowns, a.purchaseInfluenced === true, restricted]);
    record('wallets', 'economy.wallets', {actor_id: a.id}, {
      actor_id: a.id, coins: a.coins, crowns: a.crowns, reserved_coins: a.reservedCoins, reserved_crowns: a.reservedCrowns,
      purchased_coins: purchasedCoins, purchased_crowns: purchasedCrowns, purchase_influenced: a.purchaseInfluenced === true,
      legacy_competition_restricted: restricted
    });
    const casualRating = Number.isFinite(a.casualRating) ? a.casualRating : 1000;
    const casualGames = Number.isSafeInteger(a.casualGames) ? a.casualGames : 0;
    await exec(`INSERT INTO economy.ratings(actor_id, rating, peak, casual_rating, games, casual_games, tier, reached_at, last_rated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.rating, a.peak, casualRating, a.games, casualGames, a.tier, stamp(a.reachedAt), stamp(a.lastRatedAt)]);
    record('ratings', 'economy.ratings', {actor_id: a.id}, {
      actor_id: a.id, rating: a.rating, peak: a.peak, casual_rating: casualRating, games: a.games,
      casual_games: casualGames, tier: a.tier, reached_at: a.reachedAt === undefined ? null : a.reachedAt,
      last_rated_at: a.lastRatedAt === undefined ? null : a.lastRatedAt
    });
    for (const [day, value] of Object.entries(a.daily || {})) {
      await exec('INSERT INTO economy.daily_progress(actor_id, day, finished, seconds, boards, casual, friend, ranked, ranked_bonus, claimed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [a.id, day, value.finished, value.seconds, value.boards, value.casual, value.friend, value.ranked, value.rankedBonus, value.claimed]);
      record('daily_progress', 'economy.daily_progress', {actor_id: a.id, day}, {
        actor_id: a.id, day, finished: value.finished, seconds: value.seconds, boards: value.boards, casual: value.casual,
        friend: value.friend, ranked: value.ranked, ranked_bonus: value.rankedBonus, claimed: value.claimed
      });
    }
    if (a.season) {
      await exec(`INSERT INTO economy.season_state(actor_id, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, last_rated_at, qualified_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [a.id, a.season.id, stamp(a.season.startedAt), a.season.games, a.season.queueGames, a.season.opponents, a.season.wins, a.season.losses, a.season.draws, a.season.peakRating, stamp(a.season.lastRatedAt), stamp(a.season.qualifiedAt)]);
      record('season_state', 'economy.season_state', {actor_id: a.id}, {
        actor_id: a.id, season_id: a.season.id, started_at: a.season.startedAt, games: a.season.games,
        queue_games: a.season.queueGames, opponents: a.season.opponents, wins: a.season.wins, losses: a.season.losses,
        draws: a.season.draws, peak_rating: a.season.peakRating, last_rated_at: a.season.lastRatedAt === undefined ? null : a.season.lastRatedAt,
        qualified_at: a.season.qualifiedAt === undefined ? null : a.season.qualifiedAt
      });
    }
    for (let seq = 0; seq < (a.seasonHistory || []).length; seq++) {
      const s = a.seasonHistory[seq];
      await exec(`INSERT INTO economy.season_history(actor_id, seq, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, last_rated_at, qualified_at, finish_rating, finish_tier, ended_at)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [a.id, seq, s.id, stamp(s.startedAt), s.games, s.queueGames, s.opponents, s.wins, s.losses, s.draws, s.peakRating, stamp(s.lastRatedAt), stamp(s.qualifiedAt), s.finishRating, s.finishTier, stamp(s.endedAt)]);
      record('season_history', 'economy.season_history', {actor_id: a.id, seq}, {
        actor_id: a.id, seq, season_id: s.id, started_at: s.startedAt, games: s.games, queue_games: s.queueGames,
        opponents: s.opponents, wins: s.wins, losses: s.losses, draws: s.draws, peak_rating: s.peakRating,
        last_rated_at: s.lastRatedAt === undefined ? null : s.lastRatedAt, qualified_at: s.qualifiedAt === undefined ? null : s.qualifiedAt,
        finish_rating: s.finishRating, finish_tier: s.finishTier, ended_at: s.endedAt
      });
    }
    const record0 = a.tournamentRecord || {entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0};
    await exec(`INSERT INTO economy.tournament_records(actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum, premium_wins)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, record0.entered, record0.wins, record0.runnerUp, record0.top3, record0.top5, record0.bestFinish, record0.finishSum, record0.premiumWins]);
    record('tournament_records', 'economy.tournament_records', {actor_id: a.id}, {
      actor_id: a.id, entered: record0.entered, wins: record0.wins, runner_up: record0.runnerUp, top3: record0.top3,
      top5: record0.top5, best_finish: record0.bestFinish, finish_sum: record0.finishSum, premium_wins: record0.premiumWins
    });
    for (let seq = 0; seq < (a.history || []).length; seq++) {
      const h = a.history[seq];
      await exec(`INSERT INTO economy.match_history(actor_id, seq, match_id, at, opponent, mode, queue, symbol, rated, qualified, activity_qualified, result, reason, active_seconds, rating_delta, casual_delta)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [a.id, seq, h.id, stamp(h.at), h.opponent, h.mode, h.queue, h.symbol, h.rated, h.qualified, h.activityQualified, h.result, h.reason, h.activeSeconds, h.ratingDelta, h.casualDelta]);
      record('match_history', 'economy.match_history', {actor_id: a.id, seq}, {
        actor_id: a.id, seq, match_id: h.id, at: h.at, opponent: h.opponent, mode: h.mode, queue: h.queue, symbol: h.symbol,
        rated: h.rated, qualified: h.qualified, activity_qualified: h.activityQualified, result: h.result, reason: h.reason,
        active_seconds: h.activeSeconds, rating_delta: h.ratingDelta, casual_delta: h.casualDelta
      });
    }
    for (const [key, operation] of Object.entries(a.operations || {})) {
      await exec('INSERT INTO economy.wallet_operations(actor_id, key, fingerprint, result, committed_at) VALUES ($1,$2,$3,$4,NULL)',
        [a.id, key, operation.fingerprint, JSON.stringify(operation.result)]);
      record('wallet_operations', 'economy.wallet_operations', {actor_id: a.id, key}, {
        actor_id: a.id, key, fingerprint: operation.fingerprint, result: operation.result, committed_at: null
      });
    }
    for (const entry of a.ledger || []) {
      await exec('INSERT INTO economy.wallet_ledger_entries(actor_id, entry_id, operation_id, currency, amount, reason, at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [a.id, entry.id, entry.operation ?? null, entry.currency, entry.amount, entry.reason, stamp(entry.at)]);
      record('wallet_ledger_entries', 'economy.wallet_ledger_entries', {actor_id: a.id, entry_id: entry.id}, {
        actor_id: a.id, entry_id: entry.id, operation_id: entry.operation ?? null, currency: entry.currency,
        amount: entry.amount, reason: entry.reason, at: entry.at
      });
    }
    for (const item of a.owned || []) {
      await exec('INSERT INTO cosmetics.owned_items(actor_id, item, acquired_at) VALUES ($1,$2,NULL)', [a.id, item]);
      record('owned_items', 'cosmetics.owned_items', {actor_id: a.id, item}, {actor_id: a.id, item, acquired_at: null});
    }
    if (a.monetization) {
      const m = a.monetization;
      await exec('INSERT INTO monetization.credits(actor_id, credit_balance, equipped_frame, last_ad_at, last_reward_start, extra) VALUES ($1,$2,$3,$4,$5,NULL)',
        [a.id, m.credits, m.equipped, stamp(m.lastAdAt), stamp(m.lastRewardStart)]);
      record('credits', 'monetization.credits', {actor_id: a.id}, {
        actor_id: a.id, credit_balance: m.credits, equipped_frame: m.equipped,
        last_ad_at: m.lastAdAt === undefined ? null : m.lastAdAt, last_reward_start: m.lastRewardStart === undefined ? null : m.lastRewardStart, extra: null
      });
      for (const frame of m.redeemed || []) {
        await exec('INSERT INTO monetization.redeemed_frames(actor_id, frame, redeemed_at) VALUES ($1,$2,NULL)', [a.id, frame]);
        record('redeemed_frames', 'monetization.redeemed_frames', {actor_id: a.id, frame}, {actor_id: a.id, frame, redeemed_at: null});
      }
      for (let seq = 0; seq < (m.boosts || []).length; seq++) {
        await exec('INSERT INTO monetization.boosts(actor_id, boost_seq, started_at, ends_at) VALUES ($1,$2,$3,$4)',
          [a.id, seq, stamp(m.boosts[seq].startedAt), stamp(m.boosts[seq].endsAt)]);
        record('boosts', 'monetization.boosts', {actor_id: a.id, boost_seq: seq}, {
          actor_id: a.id, boost_seq: seq, started_at: m.boosts[seq].startedAt, ends_at: m.boosts[seq].endsAt
        });
      }
      for (const [day, value] of Object.entries(m.daily || {})) {
        await exec('INSERT INTO monetization.reward_daily(actor_id, day, base, bonus, automatic) VALUES ($1,$2,$3,$4,$5)',
          [a.id, day, value.base, value.bonus, value.automatic]);
        record('reward_daily', 'monetization.reward_daily', {actor_id: a.id, day}, {
          actor_id: a.id, day, base: value.base, bonus: value.bonus, automatic: value.automatic
        });
      }
    }
  }

  /* social graph */
  for (const [id, a] of accounts) {
    for (const friend of a.friends || []) {
      const pair = [id, friend].sort();
      /* The source stores the edge in both actors' arrays; the target keeps one canonical row. */
      if (id > pair[0]) continue;
      await exec('INSERT INTO social.friendships(actor_a, actor_b) VALUES ($1,$2)', pair);
      record('friendships', 'social.friendships', {actor_a: pair[0], actor_b: pair[1]}, {actor_a: pair[0], actor_b: pair[1]});
    }
    for (const target of a.friendRequests || []) {
      await exec('INSERT INTO social.friend_requests(from_id, to_id) VALUES ($1,$2)', [id, target]);
      record('friend_requests', 'social.friend_requests', {from_id: id, to_id: target}, {from_id: id, to_id: target});
    }
  }

  /* matches */
  for (const [id, m] of new Map(model.state.parsed.matches)) {
    const q = m.quote || {};
    await exec(`INSERT INTO match.matches(match_id, source, mode, kind, rated, amount, currency, turn_seconds, from_tier, to_tier, terms_ratings, terms_json, terms_hash,
                  quote_json, pool, contribution_a, contribution_b, accepted_count, status, created_at, expires_at, state_json, revision, symbol_x, symbol_y, escrow, settled,
                  started_at, last_move_at, deadline, move_timings, pre_ratings, pre_tiers, receipt_json, receipt_at, receipt_reason, receipt_payout, receipt_burn, receipt_bonus, receipt_refunded, risk_flags, risk_actors, extra)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)`,
      [id, m.terms.source, m.terms.mode, JSON.stringify(m.terms.kind), m.terms.rated === true, m.terms.amount, m.terms.currency, m.terms.turnSeconds,
        m.terms.from, m.terms.to, m.terms.ratings, jsql(m.terms), m.termsHash, jsql(q), q.pool,
        q.contributions[0], q.contributions[1], m.accepted.length, m.status, stamp(m.created), stamp(m.expires), jsql(m.state),
        m.revision, m.symbols ? m.symbols.X : null, m.symbols ? m.symbols.O : null, m.escrow, m.settled === true,
        stamp(m.started), stamp(m._lastMoveAt), stamp(m.deadline), jsql(m._moveTimings), m.preRatings, m.preTiers,
        m.receipt ? JSON.stringify(m.receipt) : null, m.receipt ? stamp(m.receipt.at) : null, m.receipt ? jsql(m.receipt.reason) : null,
        m.receipt ? m.receipt.payout : null, m.receipt ? m.receipt.burn : null, m.receipt ? m.receipt.bonus : null, m.receipt ? m.receipt.refunded : null,
        m.riskFlags || [], jsql(m._riskActors ?? {}), null]);
    record('matches', 'match.matches', {match_id: id}, {
      match_id: id, source: m.terms.source, mode: m.terms.mode, kind: m.terms.kind, rated: m.terms.rated === true,
      amount: m.terms.amount, currency: m.terms.currency, turn_seconds: m.terms.turnSeconds, from_tier: m.terms.from, to_tier: m.terms.to,
      terms_ratings: m.terms.ratings, terms_json: m.terms, terms_hash: m.termsHash, quote_json: q, pool: q.pool,
      contribution_a: q.contributions[0], contribution_b: q.contributions[1], accepted_count: m.accepted.length, status: m.status,
      created_at: m.created, expires_at: m.expires, state_json: m.state, revision: m.revision,
      symbol_x: m.symbols ? m.symbols.X : null, symbol_y: m.symbols ? m.symbols.O : null, escrow: m.escrow, settled: m.settled === true,
      started_at: m.started === undefined ? null : m.started, last_move_at: m._lastMoveAt === undefined ? null : m._lastMoveAt,
      deadline: m.deadline === undefined ? null : m.deadline, move_timings: m._moveTimings === undefined ? null : m._moveTimings,
      pre_ratings: m.preRatings === undefined ? null : m.preRatings, pre_tiers: m.preTiers === undefined ? null : m.preTiers,
      receipt_json: m.receipt || null, receipt_at: m.receipt ? m.receipt.at : null, receipt_reason: m.receipt ? m.receipt.reason : null,
      receipt_payout: m.receipt ? m.receipt.payout : null, receipt_burn: m.receipt ? m.receipt.burn : null,
      receipt_bonus: m.receipt ? m.receipt.bonus : null, receipt_refunded: m.receipt ? m.receipt.refunded : null,
      risk_flags: m.riskFlags || [], risk_actors: m._riskActors ?? {}, extra: null
    });
    for (let seat = 0; seat < m.players.length; seat++) {
      await exec('INSERT INTO match.participants(match_id, seat, actor_id, accepted) VALUES ($1,$2,$3,$4)',
        [id, seat, m.players[seat], m.accepted.includes(m.players[seat])]);
      record('match_participants', 'match.participants', {match_id: id, seat}, {
        match_id: id, seat, actor_id: m.players[seat], accepted: m.accepted.includes(m.players[seat])
      });
    }
  }

  /* rooms */
  for (const room of model.rooms) {
    const r = room.parsed;
    const q = r.quote;
    await exec(`INSERT INTO tournament.rooms(room_id, code, owner_id, name, format, table_kind, sequential, quote_json, quote_currency, entry, pool, burn,
                  clock_seconds, increment_seconds, capacity, rules_version, status, created_at, expires_at, started_at, ended_at, deadline, paused_at, reason, draw_game,
                  revision, round_delay_ms, groups_json, final_refs_json, seed_json, ranking, receipt_json, risk_flags, risk_actors, escrow, settled, settled_at,
                  timer_lease_owner, timer_lease_epoch, timer_lease_until, extra, shape_version)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42)`,
      [room.id, room.code, r.owner, JSON.stringify(r.name), r.format, r.table, r.sequential === true, JSON.stringify(q), q.currency, q.entry, q.pool, q.burn,
        r.clock, r.increment, r.capacity, r.rulesVersion, r.status, stamp(r.created), stamp(r.expires), stamp(r.started), stamp(r.ended), stamp(r.deadline),
        stamp(r.pausedAt), r.reason ?? null, r.drawGame ?? null, r.revision, r.roundDelay, jsql(r.groups), jsql(r.finalRefs),
        jsql(r.seed), r.ranking ?? [], jsql(r.receipt), r.riskFlags || [], jsql(r._riskActors ?? {}),
        r.escrow ?? 0, r.settled === true, null, null, null, null, null, r.version]);
    record('rooms', 'tournament.rooms', {room_id: room.id}, {
      room_id: room.id, code: room.code, owner_id: r.owner, name: r.name, format: r.format, table_kind: r.table,
      sequential: r.sequential === true, quote_json: q, quote_currency: q.currency, entry: q.entry, pool: q.pool, burn: q.burn,
      clock_seconds: r.clock, increment_seconds: r.increment, capacity: r.capacity, rules_version: r.rulesVersion, status: r.status,
      created_at: r.created, expires_at: r.expires, started_at: r.started === undefined ? null : r.started,
      ended_at: r.ended === undefined ? null : r.ended, deadline: r.deadline === undefined ? null : r.deadline,
      paused_at: r.pausedAt === undefined ? null : r.pausedAt, reason: r.reason ?? null, draw_game: r.drawGame ?? null,
      revision: r.revision, round_delay_ms: r.roundDelay, groups_json: r.groups ?? [], final_refs_json: r.finalRefs ?? null,
      seed_json: r.seed ?? null, ranking: r.ranking ?? [], receipt_json: r.receipt || null, risk_flags: r.riskFlags || [],
      risk_actors: r._riskActors ?? {}, escrow: r.escrow ?? 0, settled: r.settled === true, settled_at: null,
      timer_lease_owner: null, timer_lease_epoch: null, timer_lease_until: null, extra: null, shape_version: r.version
    });
    for (let ordinal = 0; ordinal < r.players.length; ordinal++) {
      const player = r.players[ordinal];
      await exec('INSERT INTO tournament.room_players(room_id, actor_id, name, ready, withdrawn, joined_at, ordinal) VALUES ($1,$2,$3,$4,$5,NULL,$6)',
        [room.id, player.id, JSON.stringify(player.name), player.ready === true, player.withdrawn === true, ordinal]);
      record('room_players', 'tournament.room_players', {room_id: room.id, actor_id: player.id}, {
        room_id: room.id, actor_id: player.id, name: player.name, ready: player.ready === true,
        withdrawn: player.withdrawn === true, joined_at: null, ordinal
      });
    }
    for (const fixture of r.fixtures) {
      await exec(`INSERT INTO tournament.fixtures(room_id, fixture_id, label, round, group_id, decisive, slots_json, players, ready, status, state_json, mini_json, winner, attempt,
                    opens_at, expires_at, ready_deadline, turn_at, finished_at, banks_json, last_move_at, move_timings, reason, history_json, revision, lease_owner, lease_epoch, lease_until, extra)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NULL,NULL,NULL,NULL)`,
        [room.id, fixture.id, fixture.label, fixture.round, fixture.group ?? null, fixture.decisive ?? null, jsql(fixture.slots),
          fixture.players ?? [], fixture.ready ?? [], fixture.status, jsql(fixture.state), jsql(fixture.mini),
          fixture.winner ?? null, fixture.attempt ?? null, stamp(fixture.opens), stamp(fixture.expires), stamp(fixture.readyDeadline),
          stamp(fixture.turnAt), stamp(fixture.finished), jsql(fixture.banks), stamp(fixture._lastMoveAt),
          jsql(fixture._moveTimings), fixture.reason ?? null, jsql(fixture.history), fixture.revision]);
      record('fixtures', 'tournament.fixtures', {room_id: room.id, fixture_id: fixture.id}, {
        room_id: room.id, fixture_id: fixture.id, label: fixture.label ?? null, round: fixture.round ?? null, group_id: fixture.group ?? null,
        decisive: fixture.decisive ?? null, slots_json: fixture.slots ?? [], players: fixture.players ?? [], ready: fixture.ready ?? [],
        status: fixture.status, state_json: fixture.state ?? null, mini_json: fixture.mini ?? {}, winner: fixture.winner ?? null,
        attempt: fixture.attempt ?? null, opens_at: fixture.opens ?? null, expires_at: fixture.expires ?? null,
        ready_deadline: fixture.readyDeadline ?? null, turn_at: fixture.turnAt ?? null, finished_at: fixture.finished ?? null,
        banks_json: fixture.banks ?? null, last_move_at: fixture._lastMoveAt ?? null, move_timings: fixture._moveTimings ?? null,
        reason: fixture.reason ?? null, history_json: fixture.history ?? null, revision: fixture.revision,
        lease_owner: null, lease_epoch: null, lease_until: null, extra: null
      });
    }
  }

  /* journal, burns, league week, snapshots, weekly payouts */
  const journal = model.state.parsed.journal;
  for (const entry of journal) {
    await exec('INSERT INTO economy.ledger(entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entry.id, entry.actor, entry.currency, entry.amount, entry.reason, entry.source, stamp(entry.at)]);
    record('ledger', 'economy.ledger', {entry_id: entry.id}, {
      entry_id: entry.id, actor_id: entry.actor, currency: entry.currency, amount: entry.amount,
      reason: entry.reason, source: entry.source, at: entry.at
    });
  }
  const burns = model.state.parsed.burned;
  await exec('UPDATE economy.system_burns SET coins=$1, crowns=$2 WHERE id=1', [burns.coins || 0, burns.crowns || 0]);
  record('burns', 'economy.system_burns', {id: 1}, {id: 1, coins: burns.coins || 0, crowns: burns.crowns || 0});
  await exec('UPDATE season.league_week SET week=$1 WHERE id=1', [model.state.parsed.leagueWeek]);
  record('league_week', 'season.league_week', {id: 1}, {id: 1, week: model.state.parsed.leagueWeek});
  for (const [date, tiers] of model.state.parsed.snapshots) {
    for (const actor of Object.keys(tiers)) {
      await exec('INSERT INTO season.day_snapshots(day, actor_id, tier) VALUES ($1,$2,$3)', [date, actor, tiers[actor]]);
      record('day_snapshots', 'season.day_snapshots', {day: date, actor_id: actor}, {day: date, actor_id: actor, tier: tiers[actor]});
    }
  }
  for (const [key, payment] of model.state.parsed.weeklyPaid) {
    await exec('INSERT INTO season.weekly_payouts(payout_id, week, actor_id, amount, tier, eligible, days, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)',
      [key, payment.week, payment.account, payment.amount, payment.tier, payment.eligible, payment.days]);
    record('weekly_payouts', 'season.weekly_payouts', {payout_id: key}, {
      payout_id: key, week: payment.week, actor_id: payment.account, amount: payment.amount, tier: payment.tier,
      eligible: payment.eligible, days: payment.days, created_at: null
    });
  }
  for (const [key, receipt] of model.state.parsed.receipts) {
    const [store, transactionId] = key.split(':');
    await exec(`INSERT INTO monetization.receipts(store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [store, transactionId, receipt.actor, receipt.productId, receipt.crowns, receipt.refunded === true, stamp(receipt.at)]);
    record('receipts', 'monetization.receipts', {store, transaction_id: transactionId}, {
      store, transaction_id: transactionId, actor_id: receipt.actor, product_id: receipt.productId,
      crowns: receipt.crowns, refunded: receipt.refunded === true, purchased_at: receipt.at
    });
  }

  /* the directly-mapped source tables */
  for (const row of model.tables.v35_tickets.rows.map((r) => r.values)) {
    await exec(`INSERT INTO monetization.reward_tickets(ticket_id, actor_id, kind, issued_at, expires_at, day, settled, transaction_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id, row.actor, row.kind, stamp(row.issued), stamp(row.expires), row.day, row.settled === 1 || row.settled === true, row.transaction_id]);
    record('reward_tickets', 'monetization.reward_tickets', {ticket_id: row.id}, {
      ticket_id: row.id, actor_id: row.actor, kind: row.kind, issued_at: row.issued, expires_at: row.expires,
      day: row.day, settled: row.settled === 1 || row.settled === true, transaction_id: row.transaction_id
    });
  }
  for (const row of model.tables.v35_casual.rows.map((r) => r.values)) {
    await exec('INSERT INTO monetization.casual_rewards(actor_id, match_id, base, bonus) VALUES ($1,$2,$3,$4)', [row.actor, row.match_id, row.base, row.bonus]);
    record('casual_rewards', 'monetization.casual_rewards', {actor_id: row.actor, match_id: row.match_id}, {
      actor_id: row.actor, match_id: row.match_id, base: row.base, bonus: row.bonus
    });
  }
  for (const row of model.tables.v35_events.rows.map((r) => r.values)) {
    await exec('INSERT INTO monetization.reward_events(event_id, actor_id, kind, at, value) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5)',
      [row.id, row.actor, row.kind, stamp(row.at), row.value ?? null]);
    await exec("SELECT setval(pg_get_serial_sequence('monetization.reward_events','event_id'), (SELECT max(event_id) FROM monetization.reward_events))");
    record('reward_events', 'monetization.reward_events', {event_id: row.id}, {
      event_id: row.id, actor_id: row.actor, kind: row.kind, at: row.at, value: row.value ?? null
    });
  }
  for (const row of model.tables.v41_store_bindings.rows.map((r) => r.values)) {
    await exec('INSERT INTO monetization.store_bindings(actor_id, google_id, apple_token, created_at) VALUES ($1,$2,$3,$4)',
      [row.actor, row.google_id, row.apple_token, stamp(row.created)]);
    record('store_bindings', 'monetization.store_bindings', {actor_id: row.actor}, {
      actor_id: row.actor, google_id: row.google_id, apple_token: row.apple_token, created_at: row.created
    });
  }
  for (const row of model.tables.v41_store_revocations.rows.map((r) => r.values)) {
    await exec('INSERT INTO monetization.store_revocations(store, transaction_id, product_id, occurred_at, reason) VALUES ($1,$2,$3,$4,$5)',
      [row.store, row.transaction_id, row.product_id ?? null, stamp(row.occurred_at), row.reason]);
    record('store_revocations', 'monetization.store_revocations', {store: row.store, transaction_id: row.transaction_id}, {
      store: row.store, transaction_id: row.transaction_id, product_id: row.product_id ?? null, occurred_at: row.occurred_at, reason: row.reason
    });
  }
  for (const row of model.tables.v41_reports.rows.map((r) => r.values)) {
    await exec(`INSERT INTO privacy.reports(report_id, reporter_id, target_id, category, detail, created_at, state, reviewed_at, reviewed_by, outcome)
                VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL)`,
      [row.id, row.reporter, row.target, row.category, row.detail, stamp(row.created), row.state]);
    record('reports', 'privacy.reports', {report_id: row.id}, {
      report_id: row.id, reporter_id: row.reporter, target_id: row.target, category: row.category, detail: row.detail,
      created_at: row.created, state: row.state, reviewed_at: null, reviewed_by: null, outcome: null
    });
  }
  for (const row of model.tables.v41_privacy_requests.rows.map((r) => r.values)) {
    await exec(`INSERT INTO privacy.requests(request_id, actor_id, kind, state, requested_at, updated_at, completed_at, policy_version, note)
                VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8)`,
      [row.id, row.actor, row.kind, row.state, stamp(row.requested_at), stamp(row.updated_at), row.policy_version, row.note]);
    record('privacy_requests', 'privacy.requests', {request_id: row.id}, {
      request_id: row.id, actor_id: row.actor, kind: row.kind, state: row.state, requested_at: row.requested_at,
      updated_at: row.updated_at, completed_at: null, policy_version: row.policy_version, note: row.note
    });
  }
  for (const row of model.tables.v41_deletion_receipts.rows.map((r) => r.values)) {
    await exec('INSERT INTO privacy.deletion_receipts(receipt_id, actor_hash, tombstone, completed_at, policy_version, retained) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.id, row.actor_hash, row.tombstone, stamp(row.completed_at), row.policy_version, JSON.stringify(row.retained)]);
    record('deletion_receipts', 'privacy.deletion_receipts', {receipt_id: row.id}, {
      receipt_id: row.id, actor_hash: row.actor_hash, tombstone: row.tombstone, completed_at: row.completed_at,
      policy_version: row.policy_version, retained: row.retained
    });
  }
  for (const row of model.tables.v41_operator_audit.rows.map((r) => r.values)) {
    await exec(`INSERT INTO audit.operator_audit(audit_id, at, operator, action, actor_id, reason, detail, prev_hash, entry_hash)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, stamp(row.at), row.operator, row.action, row.actor ?? null, row.reason, row.detail, row.prev_hash, row.entry_hash]);
    record('operator_audit', 'audit.operator_audit', {audit_id: row.id}, {
      audit_id: row.id, at: row.at, operator: row.operator, action: row.action, actor_id: row.actor ?? null,
      reason: row.reason, detail: row.detail, prev_hash: row.prev_hash, entry_hash: row.entry_hash
    });
  }
  for (const row of model.tables.profiles.rows.map((r) => r.values)) {
    await exec(`INSERT INTO identity.profiles(actor_id, tag, username, display_name, avatar, stats_visibility, presence_visibility, created_at, username_changed, version)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
      [row.actor, row.tag, row.username, row.display_name, row.avatar, row.stats_visibility, row.presence_visibility, stamp(row.created), row.version]);
    record('profiles', 'identity.profiles', {actor_id: row.actor}, {
      actor_id: row.actor, tag: row.tag, username: row.username, display_name: row.display_name, avatar: row.avatar,
      stats_visibility: row.stats_visibility, presence_visibility: row.presence_visibility, created_at: row.created,
      username_changed: null, version: row.version
    });
  }
  for (const row of model.tables.identities.rows.map((r) => r.values)) {
    await exec('INSERT INTO identity.identities(provider, subject, actor_id, created_at) VALUES ($1,$2,$3,$4)',
      [row.provider, row.subject, row.actor, stamp(row.created)]);
    record('identities', 'identity.identities', {provider: row.provider, subject: row.subject}, {
      provider: row.provider, subject: row.subject, actor_id: row.actor, created_at: row.created
    });
  }
  for (const row of model.tables.email_credentials.rows.map((r) => r.values)) {
    await exec('INSERT INTO identity.email_credentials(email, actor_id, salt, password_hash, created_at, verified_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.email, row.actor, row.salt, row.password_hash, stamp(row.created), stamp(row.verified_at)]);
    record('email_credentials', 'identity.email_credentials', {email: row.email}, {
      email: row.email, actor_id: row.actor, salt: row.salt, password_hash: row.password_hash,
      created_at: row.created, verified_at: row.verified_at
    });
  }
  for (const row of model.tables.profile_saves.rows.map((r) => r.values)) {
    await exec('INSERT INTO profile.profile_saves(actor_id, revision, payload_text, updated_at) VALUES ($1,$2,$3,$4)',
      [row.actor, row.revision, row.payload, stamp(row.updated)]);
    record('profile_saves', 'profile.profile_saves', {actor_id: row.actor}, {
      actor_id: row.actor, revision: row.revision, payload_text: row.payload, updated_at: row.updated
    });
  }
  for (const row of model.tables.v4_controls.rows.map((r) => r.values)) {
    await exec('UPDATE runtime.controls SET maintenance=$1 WHERE id=1', [row.maintenance === 1 || row.maintenance === true]);
    record('controls', 'runtime.controls', {id: row.id}, {id: row.id, maintenance: row.maintenance === 1 || row.maintenance === true});
  }
  for (const row of model.tables.v4_runtime.rows.map((r) => r.values)) {
    await exec('INSERT INTO runtime.state(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value', [row.key, row.value]);
    record('runtime_state', 'runtime.state', {key: row.key}, {key: row.key, value: row.value});
  }
  for (const row of model.tables.v4_outbox.rows.map((r) => r.values)) {
    const drained = row.state !== 'queued' && row.state !== 'sending';
    await exec(`INSERT INTO ops.outbox(outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, attempts, lease_owner, lease_token)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,NULL)`,
      [row.id, drained ? null : (row.payload ?? null), row.kind, row.state, stamp(row.created), stamp(row.expires),
        stamp(row.next_at), stamp(row.lease_until), row.attempts]);
    record('outbox', 'ops.outbox', {outbox_id: row.id}, {
      outbox_id: row.id, payload: drained ? null : (row.payload ?? null), kind: row.kind, state: row.state,
      created_at: row.created, expires_at: row.expires, next_at: row.next_at, lease_until: row.lease_until,
      attempts: row.attempts, lease_owner: null, lease_token: null
    });
  }
  const rateRows = [
    ...model.tables.community_limits.rows.map((r) => r.values).map((row) => ({id: row.id, hits: row.hits, expires: null})),
    ...model.tables.v4_limits.rows.map((r) => r.values).map((row) => ({id: row.id, hits: row.hits, expires: row.expires}))
  ];
  for (const row of rateRows) {
    await exec('INSERT INTO ops.rate_buckets(bucket_id, hits, expires_at) VALUES ($1,$2,$3)', [row.id, row.hits, stamp(row.expires)]);
    record('rate_buckets', 'ops.rate_buckets', {bucket_id: row.id}, {bucket_id: row.id, hits: row.hits, expires_at: row.expires});
  }
  for (const row of model.tables.commands.rows.map((r) => r.values)) {
    /* 0034 re-encodes this family's key column to the canonical JSON-string form. */
    await exec('INSERT INTO economy.command_outcomes(actor_id, key, fingerprint, response, committed_at) VALUES ($1,$2,$3,$4,NULL)',
      [row.actor, JSON.stringify('k1'), row.fingerprint, row.response]);
    record('command_outcomes', 'economy.command_outcomes', {actor_id: row.actor, key: 'k1'}, {
      actor_id: row.actor, key: 'k1', fingerprint: row.fingerprint, response: row.response, committed_at: null
    });
  }
  for (const row of model.tables.party_commands.rows.map((r) => r.values)) {
    await exec('INSERT INTO tournament.command_outcomes(actor_id, key, room_id, fingerprint, response, committed_at) VALUES ($1,$2,$3,$4,$5,NULL)',
      ['alice-1', JSON.stringify('party setup v1'), 'room-1', row.fingerprint, row.response]);
    record('party_command_outcomes', 'tournament.command_outcomes', {actor_id: 'alice-1', key: 'party setup v1'}, {
      actor_id: 'alice-1', key: 'party setup v1', room_id: 'room-1', fingerprint: row.fingerprint, response: row.response, committed_at: null
    });
  }
  for (const row of model.tables.social_operations.rows.map((r) => r.values)) {
    await exec('INSERT INTO social.command_outcomes(actor_id, key, fingerprint, result, committed_at) VALUES ($1,$2,$3,$4,NULL)',
      ['alice-1', 'k1', row.fingerprint, row.result]);
    record('social_command_outcomes', 'social.command_outcomes', {actor_id: 'alice-1', key: 'k1'}, {
      actor_id: 'alice-1', key: 'k1', fingerprint: row.fingerprint, result: row.result, committed_at: null
    });
  }
  for (const row of model.tables.v35_commands.rows.map((r) => r.values)) {
    await exec('INSERT INTO monetization.command_outcomes(actor_id, key, fingerprint, response, committed_at) VALUES ($1,$2,$3,$4,NULL)',
      [row.actor, row.key, row.fingerprint, row.response]);
    record('monetization_command_outcomes', 'monetization.command_outcomes', {actor_id: row.actor, key: row.key}, {
      actor_id: row.actor, key: row.key, fingerprint: row.fingerprint, response: row.response, committed_at: null
    });
  }
  return ledger;
}

/* Read the target row exactly the way the reconciler does, then hash it. */
async function ledgerEntryFor(client, kind, table, keys, actorId) {
  const columns = (await client.query(
    'SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',
    table.split('.'))).rows;
  /* The alias matters: PostgreSQL would otherwise key a bare to_char(...) call as `to_char`. */
  const select = columns.map((column) => column.data_type === 'date'
    ? `to_char("${column.column_name}", 'YYYY-MM-DD') AS "${column.column_name}"` : `"${column.column_name}"`).join(', ');
  const where = Object.keys(keys).map((column, index) => `"${column}" = $${index + 1}`).join(' AND ');
  /* 0034 stores the economy/party command key column as its canonical JSON-string text. */
  const encoded = Object.keys(keys).map((column) => (column === 'key' && (kind === 'command_outcomes' || kind === 'party_command_outcomes')
    ? JSON.stringify(keys[column]) : keys[column]));
  const row = (await client.query(`SELECT ${select} FROM ${table} WHERE ${where}`, encoded)).rows[0];
  assert.ok(row, 'materialized row must exist: ' + table + ' ' + canonical(keys));
  const normalized = {};
  for (const column of columns) {
    const value = row[column.column_name];
    if (value === null || value === undefined) { normalized[column.column_name] = null; continue; }
    const type = column.data_type, udt = column.udt_name;
    if (type === 'timestamp with time zone' || type === 'timestamp without time zone') normalized[column.column_name] = value instanceof Date ? value.getTime() : Number(value);
    else if (type === 'bigint' || type === 'integer' || type === 'smallint') normalized[column.column_name] = typeof value === 'number' ? value : Number(value);
    else if (type === 'numeric') normalized[column.column_name] = Number(value);
    else if (type === 'boolean') normalized[column.column_name] = value === true;
    else if (type === 'character') normalized[column.column_name] = String(value).replace(/\s+$/, '');
    else if (type === 'ARRAY') normalized[column.column_name] = Array.isArray(value) ? value.map((v) => v === null ? null : (udt === '_int4' || udt === '_int8' || udt === '_numeric' ? Number(v) : String(v))) : value;
    else normalized[column.column_name] = value;
  }
  const pkColumns = (await client.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::smallint[], a.attnum::smallint)`, [table])).rows.map((r) => r.attname);
  const pkKeys = {};
  for (const column of pkColumns) pkKeys[column] = normalized[column];
  return {
    source_locator: locatorFor(kind, keys),
    target_table: table,
    target_pk_hash: hash(pkKeys),
    row_hash: hash(normalized),
    batch_ordinal: 0,
    actorId
  };
}

async function seedRun(client, model, ledger, options = {}) {
  const runId = options.runId || ('run-' + SUFFIX);
  const fingerprint = model.hashes.sourceFingerprint;
  await client.query(`INSERT INTO v5_migration.run(run_id, source_fingerprint, extractor_release, source_release_sha, target_environment, target_database, target_system_identifier, schema_head, capture_clock_ms, status, started_at, counters)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed',$10,'{}'::jsonb)`,
  [runId, fingerprint, 'e'.repeat(64), '455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2', 'test', client.database,
    '7280000000000000001', 36, model.capture.clockMs, new Date(CLOCK - 10000).toISOString()]);
  await client.query(`INSERT INTO v5_migration.target_guard(target_system_id, target_environment, target_database, schema_head, created_by_run, adopted_existing_tables, created_at, updated_at)
    VALUES ($1,'test',$2,36,$3,'{}',$4,$4)`,
  ['7280000000000000001', client.database, runId, new Date(CLOCK - 10000).toISOString()]);
  for (const entry of ledger) {
    await client.query(`INSERT INTO v5_migration.row_ledger(run_id, source_locator, target_table, target_pk_hash, row_hash, batch_ordinal, written_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [runId, entry.source_locator, entry.target_table, entry.target_pk_hash, entry.row_hash, entry.batch_ordinal, new Date(CLOCK - 9000).toISOString()]);
  }
  return {
    run_id: runId, source_fingerprint: fingerprint, extractor_release: 'e'.repeat(64), schema_head: 36,
    capture_clock_ms: model.capture.clockMs, status: 'committed', target_environment: 'test',
    target_database: client.database, started_at: new Date(CLOCK - 10000).toISOString()
  };
}

/* ---------------------------------------------------------------- suite */

let gate = null;
async function gateOnce(t) {
  if (gate === null) {
    try { await ensureBackend(); gate = {ok: true}; }
    catch (error) { gate = {ok: false, message: error.message}; }
  }
  if (gate.ok) return false;
  if (process.env.V5_PG_REQUIRED === '1') throw new Error(gate.message);
  t.skip(gate.message);
  return true;
}

/* Build a fresh migrated database, materialize the fixture, seed the run rows, and hand back a
 * connected client in the trusted direct posture (the caller owns the connection). */
async function scenario(t, family) {
  const name = await freshMigratedDb(family);
  const client = new pg.Client({...backendParts(), database: name});
  await client.connect();
  /* Registered before any assertion can fail, so the connection is always released. */
  t.after(async () => { try { await client.end(); } catch { /* closed */ } });
  const model = buildModel();
  const rows = await materialize(client, model);
  const ledger = [];
  for (const entry of rows) ledger.push(await ledgerEntryFor(client, entry.kind, entry.table, entry.keys, entry.actorId));
  const run = await seedRun(client, model, ledger);
  return {name, client, model, run, ledger};
}

test('clean import yields zero unexplained differences and all equations pass', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'clean');
  const result = await verify({model: s.model, run: s.run, client: s.client});
  assert.equal(result.unexplainedCount, 0, 'unexplained: ' + JSON.stringify(result.differences.filter((d) => d.category === 'unexplained').slice(0, 8)));
  assert.ok(result.explainedCount > 0, 'the explained path must be exercised');
  for (const equation of result.equations) {
    assert.equal(equation.status, 'pass', equation.id + ' failed: ' + JSON.stringify(equation.residuals.filter((r) => r.status !== 'pass').slice(0, 5)));
  }
  assert.equal(result.invariants.coverageUnclassified, 0);
  assert.ok(result.invariants.ledgerRows > 20, 'the ledger covers every destination');

  /* The sanitized summary: counts, category names and hashes only. */
  const summary = report(result);
  assert.equal(summary.kind, 'v5-reconcile-summary');
  assert.equal(summary.counts.unexplained, 0);
  assert.equal(summary.gate.pass, true);
  assert.ok(/^[0-9a-f]{64}$/.test(summary.summaryChecksum));
  assert.ok(/^[0-9a-f]{64}$/.test(summary.differencesSha256));
  const text = JSON.stringify(summary);
  for (const id of ['alice-1', 'bob_2', 'alice@example.test', 'MEGA-0A1B2C3D', 'Copper edge']) {
    assert.ok(!text.includes(id), 'the summary must not carry ' + id);
  }
  for (const record of result.differences) {
    assert.notEqual(record.category, undefined);
    assert.ok(record.category === 'unexplained' || EXPLAINED_CATEGORIES.includes(record.category), 'unknown category ' + record.category);
  }
});

test('A07: a swapped wallet between two actors fails although the global totals are identical', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'swap');

  /* Swap the two actors' available coins. The global total is provably unchanged. */
  const before = (await s.client.query('SELECT sum(coins)::bigint AS total FROM economy.wallets')).rows[0].total;
  await s.client.query("UPDATE economy.wallets SET coins = CASE actor_id WHEN 'alice-1' THEN 155 WHEN 'bob_2' THEN 149 END WHERE actor_id IN ('alice-1','bob_2')");
  const after = (await s.client.query('SELECT sum(coins)::bigint AS total FROM economy.wallets')).rows[0].total;
  assert.equal(String(before), String(after), 'the swap must leave the global total unchanged');

  const result = await verify({model: s.model, run: s.run, client: s.client});
  const unexplained = result.differences.filter((record) => record.category === 'unexplained');
  assert.ok(unexplained.length > 0, 'a swapped per-actor wallet MUST be reported');
  const wallets = unexplained.filter((record) => record.fieldPath.startsWith('economy.wallets.'));
  assert.ok(wallets.length >= 2, 'both actors must be flagged independently');
  assert.equal(result.invariants.a07.perActorPerCurrencyCompared, true);
  assert.match(result.invariants.a07.statement, /global totals are insufficient/);
  assert.equal(result.invariants.a07.globalAvailableTotals.coins, Number(after));
});

test('a deleted target row, an extra target row and a tampered value are each reported', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'mutation');

  await s.client.query("DELETE FROM economy.ratings WHERE actor_id = 'bob_2'");
  await s.client.query(`INSERT INTO identity.actors(actor_id, region, wealth_public, created_at) VALUES ('ghost-7','""', false, now())`);
  await s.client.query("UPDATE economy.wallets SET coins = 999 WHERE actor_id = 'alice-1'");

  const result = await verify({model: s.model, run: s.run, client: s.client});
  const byPath = new Map(result.differences.map((record) => [record.fieldPath, record]));

  const missing = result.differences.filter((record) => record.fieldPath === 'economy.ratings.__row');
  assert.ok(missing.length >= 1, 'a committed row missing from the target must be reported');
  assert.equal(missing[0].category, 'unexplained');
  assert.equal(missing[0].actualHash, null);

  const extra = result.differences.filter((record) => record.locator.includes('ghost-7') || (record.fieldPath === 'identity.actors.__row' && record.expectedHash === null));
  assert.ok(extra.length >= 1, 'an extra target row the run did not write must be reported');
  assert.equal(extra[0].category, 'unexplained');

  const tampered = result.differences.filter((record) => record.fieldPath === 'economy.wallets.__row_hash');
  assert.ok(tampered.length >= 1, 'a tampered row hash must be reported');
  assert.equal(tampered[0].category, 'unexplained');
  assert.equal(tampered[0].expectedHash, s.ledger.find((entry) => entry.target_table === 'economy.wallets' && entry.source_locator.includes('alice-1')).row_hash);
  assert.notEqual(tampered[0].actualHash, tampered[0].expectedHash);

  /* The value column itself is reported once, by the semantic pass, with a hashed expected value. */
  const value = byPath.get('economy.wallets.coins');
  assert.ok(value, 'the changed value must also be reported');
  assert.equal(value.category, 'unexplained');

  /* The difference rows are persisted, hashes only. */
  const stored = (await s.client.query('SELECT category, actor_hash, locator, field_path, expected_hash, actual_hash, rule_id, severity FROM v5_migration.difference WHERE run_id = $1', [s.run.run_id])).rows;
  assert.equal(stored.length, result.differences.length);
  for (const row of stored) assert.ok(/^[0-9a-f]{64}$/.test(row.expected_hash) || row.expected_hash === null);
  /* "hashes only" means no VALUE is stored: every hash column is a 64-hex digest (or NULL) and the
   * free-text detail carries no source value. The `locator` is the structured canonical SOURCE
   * locator the frozen 0036 DDL requires (NOT NULL) and the design's differences.jsonl field list
   * names; the actor is separately identified only by its hash. */
  for (const row of stored) {
    assert.ok(row.expected_hash === null || /^[0-9a-f]{64}$/.test(row.expected_hash));
    assert.ok(row.actual_hash === null || /^[0-9a-f]{64}$/.test(row.actual_hash));
    assert.ok(row.actor_hash === null || /^[0-9a-f]{64}$/.test(row.actor_hash));
    assert.ok((row.detail || '').length <= 200);
    assert.ok(!(row.detail || '').includes('alice-1'), 'detail must not carry a source value');
  }
  const summaryText = JSON.stringify(report(result));
  assert.ok(!summaryText.includes('alice-1') && !summaryText.includes('bob_2'), 'the sanitized summary must carry no identifier');
});

test('the explained-category path is exercised and never invents a balance', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'explained');
  /* The source journal explains each actor's available balance exactly: 150 + 2 = 152 for alice-1
   * and 150 + 5 = 155 for bob_2, which is what the source carries. Prove the reported evidence
   * agrees, then break it and require a labelled baseline-needed record rather than an invented row. */
  const result = await verify({model: s.model, run: s.run, client: s.client});
  assert.equal(result.evidence.journalExplainsBalance.unexplained, 0, JSON.stringify(result.evidence.journalExplainsBalance));
  assert.equal(result.evidence.baselineNeeded.length, 0);
  const categories = Object.keys(result.byCategory);
  assert.ok(categories.includes('restore-normalization'), 'a reader-reported delta must appear: ' + categories.join(','));
  assert.ok(categories.includes('unclassified-key-accepted'), 'an accepted unclassified locator must appear');
  assert.ok(categories.includes('expired-challenge') || categories.includes('expired-session'), 'the ephemeral policy records must appear');
  assert.ok(categories.includes('orphan-tombstone'), 'a revocation tombstone with no receipt must be reported');
  assert.ok(categories.includes('deleted-principal'), 'a deletion tombstone reference must be reported');
  assert.ok(categories.includes('lan-guest-principal'), 'a quarantined LAN guest must be reported');
  assert.ok(categories.includes('legacy-product-catalogue'), 'an archived catalogue id must be reported');
  const c9 = result.equations.find((equation) => equation.id === 'C9');
  assert.equal(c9.status, 'pass');
  assert.ok(c9.classes.account >= 2);
  assert.equal(result.byCategory['restore-normalization'] >= 2, true);
  assert.equal(result.unexplainedCount, 0);

  /* A journal that does not explain the balance is REPORTED, and no row is invented for it. */
  const model = JSON.parse(JSON.stringify(s.model));
  model.state.parsed.accounts[0][1].coins = 500;
  const broken = await verify({model, run: s.run, client: s.client});
  assert.ok(broken.evidence.journalExplainsBalance.unexplained >= 1, 'the actor whose balance the journal cannot explain must be reported');
  assert.ok(broken.evidence.baselineNeeded.length >= 1);
  assert.ok(broken.evidence.baselineNeeded.every((row) => /^[0-9a-f]{64}$/.test(row.actorHash)), 'baseline-needed rows carry hashes only');
  assert.ok(broken.differences.some((record) => record.category === 'unexplained'), 'the mismatch is reported, never silently rebased');
});

test('a model from another run is refused, and a missing guard is refused', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'guard');
  const foreign = JSON.parse(JSON.stringify(s.model));
  foreign.hashes.sourceFingerprint = '00'.repeat(32);
  await assert.rejects(() => verify({model: foreign, run: s.run, client: s.client}),
    (error) => error.code === 'RUN_MODEL_MISMATCH');

  await s.client.query('DELETE FROM v5_migration.target_guard');
  await assert.rejects(() => verify({model: s.model, run: s.run, client: s.client}),
    (error) => error.code === 'TARGET_GUARD_MISSING');
});

test('the report is deterministic and sanitized', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'report');
  const first = await verify({model: s.model, run: s.run, client: s.client});
  const second = await verify({model: s.model, run: s.run, client: s.client});
  assert.equal(report(first).summaryChecksum, report(second).summaryChecksum, 'the summary must be deterministic');
  assert.deepEqual(first.differences.map((d) => d.locator), second.differences.map((d) => d.locator));
  const summary = report(first);
  assert.equal(summary.invariants.a07.actors, 2);
  assert.ok(summary.equations.every((equation) => ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'].includes(equation.id)));
  assert.equal(summary.counts.differences, (first.differences || []).length);
});

test('a ledger in the sibling importer\'s encoding verifies, and a tamper under it is still caught', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'sibling');
  /* Rewrite the run's ledger the way tools/v5-migration/loader.js writes it: bare schema-qualified
   * table + '#' + the source key, and the row/pk hashes produced BY POSTGRES from its own stored row
   * (`to_jsonb` / `jsonb_build_object`). Then prove the reconciler still resolves the locators, still
   * accepts the rows as unmodified, and still catches a tamper through that encoding. */
  await s.client.query('DELETE FROM v5_migration.row_ledger WHERE run_id = $1', [s.run.run_id]);
  const kindToTable = new Map();
  for (const [kind, spec] of Object.entries(TABLES)) if (spec.table && !kindToTable.has(spec.table)) kindToTable.set(spec.table, {kind, spec});
  /* The sibling importer's locator key is the SOURCE key, not the stored (0034-encoded) column
   * value, so the `key` column is decoded back before it is placed in the locator. */
  const sourceKeyOf = (column, entry) => {
    const value = entry[column];
    if (column === 'key' && typeof value === 'string' && value.startsWith('"')) {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  };
  const keyFor = (pk, row) => pk.map((column) => String(sourceKeyOf(column, row.normalized))).join('\u001f');
  let written = 0;
  for (const [kind, spec] of Object.entries(TABLES)) {
    if (!spec.table || !spec.pk) continue;
    const {readTable} = require(RECONCILE);
    const read = await readTable(s.client, spec.table, spec.pk);
    for (const raw of read.rows) {
      await s.client.query(
        `INSERT INTO v5_migration.row_ledger(run_id, source_locator, target_table, target_pk_hash, row_hash, batch_ordinal, written_at)
         VALUES ($1,$2,$3,$4,$5,0,now())`,
        [s.run.run_id, spec.table + '#' + keyFor(spec.pk, {normalized: raw}), spec.table, raw.__pk_hash_db, raw.__row_hash_db]);
      written++;
    }
  }
  assert.ok(written > 20);

  const clean = await verify({model: s.model, run: s.run, client: s.client});
  const hashFailures = clean.differences.filter((record) => record.fieldPath.endsWith('.__row_hash') || record.fieldPath.endsWith('.__pk_hash'));
  assert.deepEqual(hashFailures, [], 'the to_jsonb encoding must verify: ' + JSON.stringify(hashFailures.slice(0, 4)));
  assert.ok((clean.invariants.hashConventions || {}).to_jsonb > 0, 'the to_jsonb convention must be recognised');
  assert.equal(clean.unexplainedCount, 0);

  /* A tamper under the sibling encoding is caught by the same pass. */
  await s.client.query("UPDATE economy.wallets SET coins = 4242 WHERE actor_id = 'alice-1'");
  const tampered = await verify({model: s.model, run: s.run, client: s.client});
  assert.ok(tampered.differences.some((record) => record.fieldPath === 'economy.wallets.__row_hash' && record.category === 'unexplained'),
    'a tampered row must be reported under the sibling encoding too');
  void kindToTable;
});

test('a date + timestamptz + numeric target verifies clean, and a one-column mutation is reported', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'types');
  /* season.league_week carries a DATE, runtime.controls a timestamptz and economy.daily_progress a
   * NUMERIC — the exact mix whose raw-driver rendering (a local-midnight Date) used to defeat the
   * hash comparison. The fixture target already holds all three (one daily_progress row, the
   * league_week singleton and the controls singleton). */
  const clean = await verify({model: s.model, run: s.run, client: s.client});
  assert.equal(clean.unexplainedCount, 0, JSON.stringify(clean.differences.filter((d) => d.category === 'unexplained').slice(0, 4)));
  assert.ok((clean.invariants.projectedTables || []).includes('season.league_week'));
  assert.ok((clean.invariants.projectedTables || []).includes('economy.daily_progress'));
  assert.ok((clean.invariants.projectedTables || []).includes('runtime.controls'));

  /* The DATE column must be read as 'YYYY-MM-DD' and the numeric as a Number, not as a Date or a
   * string: the committed hash is recomputed from exactly those normalized values. */
  const {readHashedTable} = require(path.join(ROOT, 'tools/v5-migration/ledger.js'));
  const week = await readHashedTable(s.client, 'season.league_week', ['id']);
  assert.equal(week.hashed[0].normalized.week, '2026-10-05');
  assert.equal(typeof week.hashed[0].normalized.week, 'string');
  assert.equal(week.hashed[0].normalized.published_at, null);
  const progress = await readHashedTable(s.client, 'economy.daily_progress', ['actor_id', 'day']);
  assert.equal(typeof progress.hashed[0].normalized.seconds, 'number');
  assert.equal(progress.hashed[0].normalized.seconds, 90.5);
  assert.equal(progress.hashed[0].normalized.day, '2026-10-08');
  const committed = (await s.client.query(
    "SELECT row_hash FROM v5_migration.row_ledger WHERE run_id = $1 AND target_table = 'season.league_week'", [s.run.run_id])).rows[0].row_hash;
  assert.equal(week.hashed[0].rowHash, committed, 'the recomputed hash must equal the committed one');

  /* A one-column mutation of the DATE column is still reported. */
  await s.client.query("UPDATE season.league_week SET week = DATE '2026-10-12' WHERE id = 1");
  const mutated = await verify({model: s.model, run: s.run, client: s.client});
  assert.ok(mutated.differences.some((record) => record.fieldPath === 'season.league_week.__row_hash' && record.category === 'unexplained'),
    'a mutated DATE must be reported as a row-hash mismatch');
  assert.ok(mutated.differences.some((record) => record.fieldPath === 'season.league_week.week' && record.category === 'unexplained'),
    'the changed value must also be reported');

  /* And a one-column mutation of the NUMERIC column. */
  await s.client.query("UPDATE season.league_week SET week = DATE '2026-10-05' WHERE id = 1");
  await s.client.query("UPDATE economy.daily_progress SET seconds = 1.25 WHERE actor_id = 'alice-1'");
  const numericMutated = await verify({model: s.model, run: s.run, client: s.client});
  assert.ok(numericMutated.differences.some((record) => record.fieldPath === 'economy.daily_progress.__row_hash' && record.category === 'unexplained'),
    'a mutated NUMERIC must be reported as a row-hash mismatch');
});

test('rowHash and targetPkHash follow the frozen canonical contract', async (t) => {
  if (await gateOnce(t)) return;
  const s = await scenario(t, 'hash');
  const columns = (await s.client.query(
    "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='economy' AND table_name='wallets' ORDER BY ordinal_position")).rows;
  const raw = (await s.client.query('SELECT * FROM economy.wallets WHERE actor_id = $1', ['alice-1'])).rows[0];
  const normalized = {};
  for (const column of columns) {
    const value = raw[column.column_name];
    if (value === null || value === undefined) { normalized[column.column_name] = null; continue; }
    if (typeof value === 'bigint' || column.data_type === 'bigint' || column.data_type === 'integer' || column.data_type === 'smallint') normalized[column.column_name] = Number(value);
    else if (column.data_type === 'boolean') normalized[column.column_name] = value === true;
    else if (column.data_type === 'timestamp with time zone') normalized[column.column_name] = value instanceof Date ? value.getTime() : Number(value);
    else normalized[column.column_name] = value;
  }
  assert.equal(rowHash(columns, raw), hash(normalized));
  assert.equal(targetPkHash(['actor_id'], normalized), hash({actor_id: 'alice-1'}));
  /* The shared ledger contract: `<schema-qualified table>#<source key>`, U+001F between the parts of
   * a composite key. Both the importer and the reconciler require this one function. */
  const ledger = require(path.join(ROOT, 'tools/v5-migration/ledger.js'));
  assert.equal(ledger.rowHash(columns, raw), hash(normalized));
  assert.equal(ledger.pkHash(['actor_id'], normalized), hash({actor_id: 'alice-1'}));
  assert.equal(locatorFor('wallets', {actor_id: 'alice-1'}), 'economy.wallets#alice-1');
  assert.equal(locatorFor('match_participants', {match_id: 'm_1', seat: 0}), 'match.participants#m_1' + ledger.LOCATOR_SEPARATOR + '0');
  assert.ok(/^[0-9a-f]{64}$/.test(ledger.extractorRelease({mappingManifest: 'x'})));
  assert.equal(ledger.extractorRelease({mappingManifest: 'x'}), ledger.extractorRelease({mappingManifest: 'x'}));
  assert.notEqual(ledger.extractorRelease({mappingManifest: 'x'}), ledger.extractorRelease({mappingManifest: 'y'}));
  assert.equal(ledger.NORMALIZATION_SPEC.normalization['timestamp with time zone'], 'integer epoch milliseconds (JS Date -> getTime())');
});
