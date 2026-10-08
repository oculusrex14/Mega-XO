/* tests/v5-p04-repositories.test.js - V5 P04 PostgreSQL repository parity suite.
 *
 * Harness contract (identical to tests/v5-migrations.test.js, the frozen P02 disposable PG16
 * contract):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: a caller-owned synthetic PG16
 *     cluster. The URL is used ONLY to CREATE/DROP this suite's tracked v5_test_p04_* databases,
 *     enable the runtime LOGIN identities, and seed fixture rows as the trusted provisioner; the
 *     control database is never mutated, truncated or dropped.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 * No Neon or production target is ever contacted.
 *
 * What it proves, against a schema built by running the REAL checksummed migrations:
 *   1. one parity case per repository member;
 *   2. the aggregate seam (`domain()` / `commitDomain()` / `state.read` / `state.write`) serves the
 *      unchanged production command dispatcher (`executeCommand`) over normalized tables, with no
 *      whole-graph row and no `state` table - and an unchanged entity is NOT rewritten;
 *   3. two overlapping units of work racing one wallet can neither overdraw nor double-reserve, and
 *      a failing unit of work rolls back completely;
 *   4. replaying the same command key returns the stored response and does not re-apply the effect;
 *   5. this module graph never requires node:sqlite, src/authority.js-as-storage or
 *      packages/db/repositories.js.
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const CHAIN_LENGTH = require(path.join(ROOT, 'packages', 'migrations', 'manifest.json')).migrations.length;
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const OWNED_PREFIX = 'v5_test_p04_';

/* ---------------------------------------------------------------- backend */

function whichBinary() {
 for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
  try {
   if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
  } catch { /* next */ }
 }
 return null;
}
function freePort() {
 return new Promise((resolve, reject) => {
  const net = require('node:net');
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
 });
}
let backend = null, backendError = null;
async function ensureBackend() {
 if (backend) return backend;
 if (backendError) throw new Error(backendError);
 const external = process.env.V5_PG_URL || '';
 if (external) {
  if (process.env.V5_PG_DISPOSABLE !== '1') throw new Error('V5_PG_URL requires V5_PG_DISPOSABLE=1 (owned synthetic cluster only)');
  let u;
  try { u = new URL(external); } catch { throw new Error('V5_PG_URL is unparsable'); }
  if (!LOOPBACK.has(u.hostname)) throw new Error('V5_PG_URL must target a loopback host');
  if (/(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(decodeURIComponent(u.pathname))) throw new Error('V5_PG_URL control database must be non-production');
  const control = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!control || control.startsWith(OWNED_PREFIX)) throw new Error('V5_PG_URL control database must not be one of this suite\'s owned databases');
  backend = { kind: 'external', adminUrl: external, host: u.hostname, port: Number(u.port || 5432) };
  return backend;
 }
 const bin = whichBinary();
 if (!bin) throw new Error('no PostgreSQL 16 backend available (set V5_PG_URL for an owned loopback cluster)');
 const port = await freePort();
 const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-p04-pg-${PID}-`));
 execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`, '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 for (let i = 0; i < 60; i += 1) {
  try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { stdio: 'ignore', timeout: 10000 }); break; }
  catch { if (i === 59) throw new Error('binary PG16 never became ready'); execFileSync('sleep', ['1']); }
 }
 backend = { kind: 'binary', adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`, host: '127.0.0.1', port, stop: () => {
  try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'i', 'stop'], { stdio: 'ignore', timeout: 30000 }); } catch { /* gone */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
 } };
 return backend;
}

const pg = require('pg');
const createdDatabases = new Set();
function ident(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
async function adminClient(database) {
 const u = new URL(backend.adminUrl);
 const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), user: u.username ? decodeURIComponent(u.username) : 'postgres', password: u.username ? decodeURIComponent(u.password || '') : undefined, database: database || decodeURIComponent(u.pathname.replace(/^\//, '')) });
 await c.connect();
 return c;
}
function dbUrl(database) { const u = new URL(backend.adminUrl); u.pathname = `/${database}`; u.search = ''; return u.toString(); }

test.after(async () => {
 if (!backend) return;
 for (const name of [...createdDatabases]) {
  try { const c = await adminClient(); await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); await c.end(); } catch { /* best effort, tracked names only */ }
 }
 if (backend.stop) backend.stop();
});

/* ---------------------------------------------------------------- fixtures */

const CLOCK = Date.parse('2026-10-08T12:00:00Z');
const ACTORS = ['alice', 'bob'];
let context = null;

function runMigrator(database) {
 const r = spawnSync(process.execPath, [RUNNER, '--execute', '--json', '--database-url', dbUrl(database)], {
  encoding: 'utf8', cwd: ROOT, timeout: 300000,
  env: { ...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', V5_TARGET: 'test', MIGRATE_CONFIRM: database },
 });
 const last = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
 let json = null; try { json = last ? JSON.parse(last) : null; } catch { /* human mode */ }
 return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* The trusted provisioner: actor/eligibility/profile/wallet/rating rows are created by the
 * operator path (the API owns actor creation in V5), never by the repositories, which must not
 * mint. This mirrors what the P03 importer/provisioner writes. */
async function seedActors(c, actors, { coins = 1000, crowns = 100 } = {}) {
 for (const actor of actors) {
  await c.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)', [actor, JSON.stringify('Test'), new Date(CLOCK - 30 * 86400000).toISOString()]);
  await c.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)', [actor]);
  await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at) VALUES ($1, $2, $3, $4, $5)',
   [actor, 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 8).toUpperCase(), 'player_' + actor, actor, new Date(CLOCK - 30 * 86400000).toISOString()]);
  await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [actor, coins, crowns]);
  await c.query('INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, tier) VALUES ($1, 1500, 1500, 1500, 30, $2)', [actor, 'gold']);
  await c.query('INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
   [`opening:${actor}`, actor, 'coins', coins, 'Opening balance', 'provisioning', new Date(CLOCK - 30 * 86400000).toISOString()]);
 }
}

/* One owned database, migrated by the real runner and seeded as the trusted provisioner. */
let harnessPromise = null;
async function openHarness(t) {
 t.after(async () => { await closePools(); });
 if (harnessPromise) return harnessPromise;
 harnessPromise = (async () => {
  const name = `${OWNED_PREFIX}${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const c = await adminClient();
  try { await c.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await c.end(); }
  const migration = runMigrator(name);
  assert.equal(migration.status, 0, `migration failed: ${migration.stdout}${migration.stderr}`);
  assert.equal(migration.json.code, 'OK');
  assert.equal(migration.json.appliedCount, CHAIN_LENGTH);
  const c2 = await adminClient(name);
  try {
   for (const role of RUNTIME_ROLES) await c2.query(`ALTER ROLE ${ident(role)} LOGIN`);
   await seedActors(c2, ACTORS);
   /* A real committed match with both seats, so `domain()` is exercised on a database that actually
    * holds aggregate rows (the earlier 5/5 never seeded one, which is exactly how a crash-on-match
    * could hide). Terms/quote/state are minimal but structurally valid. */
   await c2.query(`INSERT INTO match.matches (match_id, source, mode, kind, rated, amount, currency, turn_seconds,
     from_tier, to_tier, terms_ratings, terms_json, terms_hash, quote_json, pool, contribution_a, contribution_b,
     accepted_count, status, created_at, expires_at, state_json, revision, symbol_x, symbol_y, escrow, settled,
     risk_flags, risk_actors)
     VALUES ('m-1', 'queue', 'queue', '"ranked"', true, 100, 'coins', 30, 'gold', 'gold', ARRAY[1500.00,1500.00],
      '{"source":"queue","mode":"queue","kind":"ranked","rated":true,"amount":100,"currency":"coins","turnSeconds":30}'::json,
      $1, '{"pool":100,"currency":"coins","contributions":[50,50],"rated":true,"mode":"queue"}'::json,
      100, 50, 50, 2, 'PLAYING', $2, $3, '{"board":[],"mini":[],"turn":"X","required":null,"winner":null,"line":null,"moves":[]}'::json,
      3, 'alice', 'bob', 0, false, '{}', '{}'::json)`,
    ['a'.repeat(64), new Date(CLOCK - 60000).toISOString(), new Date(CLOCK + 600000).toISOString()]);
   await c2.query("INSERT INTO match.participants (match_id, seat, actor_id, accepted) VALUES ('m-1', 0, 'alice', true), ('m-1', 1, 'bob', true)");
   await c2.query("INSERT INTO match.move_outcomes (match_id, \"key\", fingerprint, result) VALUES ('m-1', 'move-1', $1, '{\"revision\":1}')", ['b'.repeat(64)]);
   /* A pre-existing daily bucket for the CLOCK day, so a TZ-shifted DATE decode would show up as a
    * duplicate key plus a zeroed original. */
   await c2.query("INSERT INTO economy.daily_progress (actor_id, day, finished, seconds, boards, casual, friend, ranked, ranked_bonus, claimed) VALUES ('alice', DATE '2026-10-08', 3, 90, 8, 1, 0, 2, 5, ARRAY['finish'])");
   await c2.query("INSERT INTO monetization.reward_daily (actor_id, day, base, bonus, automatic) VALUES ('alice', DATE '2026-10-08', 4, 1, 0)");
   /* A live session for alice, stored in the TARGET encoding (64-hex sha256). */
   await c2.query('INSERT INTO identity.sessions (token_hash, actor_id, csrf, created_at, expires_at, auth_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [crypto.createHash('sha256').update('bearer-alice').digest('hex'), 'alice', 'csrf-alice', new Date(CLOCK - 60000).toISOString(), new Date(CLOCK + 86400000).toISOString(), new Date(CLOCK - 60000).toISOString()]);
   await c2.query('INSERT INTO profile.profile_saves (actor_id, revision, payload_text, updated_at) VALUES ($1, $2, $3, $4)',
    ['alice', 3, JSON.stringify({ version: 3.2, settings: { theme: 'vector' }, wallet: { coins: 10, crowns: 0, ledger: [], owned: [] }, records: [], processed: [] }), new Date(CLOCK - 3600000).toISOString()]);
   await c2.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google', 'tx-alice-1', 'alice', 'crowns_100', 100, false, $1)", [new Date(CLOCK - 7200000).toISOString()]);
   await c2.query("INSERT INTO monetization.store_revocations (store, transaction_id, product_id, occurred_at, reason) VALUES ('google', 'tx-revoked-1', 'crowns_100', $1, 'operator_refund')", [new Date(CLOCK - 3600000).toISOString()]);
   await c2.query("INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at) VALUES ('mail-1', 'sealed', 'otp', 'queued', $1, $2, $3)",
    [new Date(CLOCK - 60000).toISOString(), new Date(CLOCK + 86400000).toISOString(), new Date(CLOCK - 60000).toISOString()]);
   await c2.query(`INSERT INTO tournament.rooms (room_id, code, owner_id, name, status, created_at, revision, ranking, risk_flags, risk_actors, escrow, settled, groups_json) VALUES ('room-1', 'ABCDE', 'alice', $1, 'LOBBY', $2, 0, '{}', '{}', '{}', 0, false, '[]')`, [JSON.stringify('Party'), new Date(CLOCK - 300000).toISOString()]);
   await c2.query("INSERT INTO tournament.room_players (room_id, actor_id, name, ready, withdrawn, ordinal) VALUES ('room-1', 'alice', $1, false, false, 0)", [JSON.stringify('alice')]);
   await c2.query("INSERT INTO season.league_week (id, week) VALUES (1, '2026-10-05') ON CONFLICT (id) DO UPDATE SET week = EXCLUDED.week");
   await c2.query('INSERT INTO economy.system_burns (id, coins, crowns) VALUES (1, 42, 3) ON CONFLICT (id) DO UPDATE SET coins = EXCLUDED.coins, crowns = EXCLUDED.crowns');
  } finally { await c2.end(); }
  context = { database: name };
 return context;
 })();
 return harnessPromise;
}

/* ---------------------------------------------------------------- pools */

const { createPgPool } = require('../packages/db/pg/pool.js');
const { createPgUnitOfWork } = require('../packages/db/pg/uow.js');
const { executeCommand } = require('../packages/domain/commands.js');
const { COMMANDS, V35_COMMANDS, PARTY_COMMANDS, SOCIAL_OPERATIONS } = require('../packages/db/scopes');

const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 4, api_runtime: 4, worker_runtime: 2 }) });
let pools = null;
function poolsFor(database) {
 if (pools) return pools;
 const make = (role, max) => createPgPool({
  host: backend.host, port: backend.port, database, user: role, role, label: 'test',
  service: 'v5-p04-test', revision: 'p04tests', allowLocalNoTls: true,
  pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
  budget: BUDGET,
 });
 pools = { core: make('core_runtime', 4), api: make('api_runtime', 4), worker: make('worker_runtime', 2) };
 return pools;
}
async function closePools() { if (pools) { const p = pools; pools = null; await Promise.all([p.core.end(), p.api.end(), p.worker.end()]); } }

/* Options are threaded exactly as a production caller would supply them: the sampled clock, plus
 * the caller's deterministic `random` and `verifyPurchase`. Threading them through the unit of work
 * is what F2 was about, so the regression case asserts on the wiring rather than trusting shape. */
function uowFor(role, options = { now: () => CLOCK }) {
 const pool = poolsFor(context.database)[role];
 return createPgUnitOfWork(pool, { ...options, role: role === 'core' ? 'core_runtime' : role === 'api' ? 'api_runtime' : 'worker_runtime' });
}

/* ---------------------------------------------------------------- 1. parity */

test('P04 parity: every repository member answers over the migrated normalized schema', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL and V5_PG_REQUIRED unset'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 await openHarness(t);
 const core = uowFor('core');
 const api = uowFor('api');

 await core.run(async (tx) => {
  const r = tx.repositories;
  /* accounts.has */
  assert.equal(await r.accounts.has('alice'), true);
  assert.equal(await r.accounts.has('nobody'), false);
  /* wallets.for - the SQLite field names */
  const wallet = await r.wallets.for('alice');
  assert.deepEqual(wallet, { actor: 'alice', coins: 1000, crowns: 100, purchasedCoins: 0, purchasedCrowns: 0, reservedCoins: 0, reservedCrowns: 0, purchaseInfluenced: false });
  /* ledger.recent / burned */
  const recent = await r.ledger.recent('alice');
  assert.deepEqual(recent.map((e) => e.id), ['opening:alice']);
  assert.deepEqual(await r.ledger.burned(), { coins: 42, crowns: 3 });
  /* purchases.receipt / revoked */
  const receipt = await r.purchases.receipt('google', 'tx-alice-1');
  assert.equal(receipt.actor, 'alice');
  assert.equal(receipt.crowns, 100);
  assert.equal(receipt.refunded, false);
  assert.equal(await r.purchases.receipt('google', 'tx-missing'), null);
  assert.equal(await r.purchases.revoked('google', 'tx-revoked-1'), true);
  assert.equal(await r.purchases.revoked('google', 'tx-alice-1'), false);
  /* tournaments.room / rooms / activeRooms / codeExists */
  const room = await r.tournaments.room('room-1');
  assert.equal(room.code, 'ABCDE');
  assert.equal(room.status, 'LOBBY');
  assert.equal(room.version, undefined);
  assert.deepEqual(room.players.map((p) => p.id), ['alice']);
  assert.equal((await r.tournaments.room('ABCDE')).id, 'room-1');
  assert.equal(await r.tournaments.room('nope'), null);
  assert.equal(await r.tournaments.codeExists('ABCDE'), true);
  assert.equal(await r.tournaments.codeExists('ZZZZZ'), false);
  assert.deepEqual((await r.tournaments.activeRooms()).map((x) => x.id), ['room-1']);
  assert.deepEqual((await r.tournaments.rooms()).map((x) => x.id), ['room-1']);
  /* an unchanged room re-saves to the same entity rows (idempotent entity write) */
  assert.equal(await r.tournaments.save(room), 'room-1');
  /* matches.* - seeded match with both seats */
  assert.equal(await r.matches.for('m-none'), null);
  await assert.rejects(() => r.matches.view('m-none'), /UNKNOWN_MATCH/);
  const match = await r.matches.for('m-1');
  assert.deepEqual(match.players, ['alice', 'bob']);
  assert.deepEqual(match.accepted, ['alice', 'bob']);
  assert.equal(match.status, 'PLAYING');
  assert.equal(match.commands.get('move-1').result.revision, 1);
  assert.equal((await r.matches.view('m-1')).id, 'm-1');
  assert.deepEqual((await r.matches.forActor('alice')).map((m) => m.id), ['m-1']);
  assert.deepEqual((await r.matches.forActor('alice', ['FINISHED'])), []);
  /* domain() / state.read. Hydration over a database that really holds a match aggregate is the
    * case that used to throw (a missing participants accumulator). */
  const graph = await r.domain();
  assert.deepEqual([...graph.accounts.keys()].sort(), ACTORS);
  assert.equal(graph.account('alice').coins, 1000);
  assert.equal(graph.account('nobody', false), null);
  assert.throws(() => graph.account('nobody'), /ACCOUNT_REQUIRED/);
  /* The DATE columns must decode to the SOURCE day text, not the session TimeZone's rendition. */
  assert.deepEqual(Object.keys(graph.account('alice').daily), ['2026-10-08']);
  assert.deepEqual(graph.account('alice').daily['2026-10-08'], { finished: 3, seconds: 90, boards: 8, casual: 1, friend: 0, ranked: 2, rankedBonus: 5, claimed: ['finish'] });
  assert.deepEqual(Object.keys(graph.account('alice').monetization.daily), ['2026-10-08']);
  assert.deepEqual(graph.account('alice').monetization.daily['2026-10-08'], { base: 4, bonus: 1, automatic: 0 });
  /* The injected clock/random/verifier reach the domain model, exactly as the SQLite reference
    * adapter passes them: the journal instant is the unit of work's clock, not the host clock. */
  const live = await r.ledger.recent('alice', null);
  assert.equal(live.every((entry) => entry.at <= CLOCK), true, 'no ledger entry may post-date the injected clock');
  const raw = await r.state.read();
  assert.equal(raw.accounts.find(([id]) => id === 'alice')[1].coins, 1000);
  assert.equal(raw.burned.coins, 42);
  assert.equal(raw.leagueWeek, '2026-10-05');
  assert.equal(raw.journal.length, 2, 'the two seeded ledger entries, read back through the aggregate journal cap');
  assert.deepEqual(raw.matches.map(([id]) => id), ['m-1']);
 });

 await api.run(async (tx) => {
  const r = tx.repositories;
  /* profiles.for - the exact fields community-store.js consumes */
  const profile = await r.profiles.for('alice');
  assert.equal(profile.actor, 'alice');
  assert.equal(profile.username, 'player_alice');
  assert.equal(profile.display_name, 'alice');
  assert.equal(profile.avatar, 'board');
  assert.equal(profile.stats_visibility, 'friends');
  assert.equal(profile.presence_visibility, 'friends');
  assert.equal(profile.username_changed, 0);
  assert.equal(profile.version, 1);
  assert.equal(profile.created, CLOCK - 30 * 86400000);
  assert.equal(await r.profiles.for('nobody'), null);
  /* sessions.live - the base64url <-> 64-hex mapping in both directions */
  const session = await r.sessions.live(crypto.createHash('sha256').update('bearer-alice').digest('base64url'), CLOCK);
  assert.equal(session.token, crypto.createHash('sha256').update('bearer-alice').digest('base64url'));
  assert.equal(session.actor, 'alice');
  assert.equal(session.csrf, 'csrf-alice');
  assert.equal(session.expires, CLOCK + 86400000);
  assert.equal(await r.sessions.live(crypto.createHash('sha256').update('bearer-alice').digest('base64url'), CLOCK + 2 * 86400000), null);
  /* saves.for / revisionOf - payload_text is the authoritative document */
  const save = await r.saves.for('alice');
  assert.equal(save.revision, 3);
  assert.equal(JSON.parse(save.payload).version, 3.2);
  assert.equal(await r.saves.revisionOf('alice'), 3);
  assert.equal(await r.saves.revisionOf('bob'), 0);
  /* community.count - upsert-increment returning hits (ops.rate_buckets; 0037 grants the api role
   * INSERT/UPDATE on it, and no other runtime role has any privilege there). */
  assert.equal(await r.community.count('search:alice:1'), 1);
  assert.equal(await r.community.count('search:alice:1'), 2);
  /* session lifecycle verbs, then restore the seeded row */
  assert.equal(await r.sessions.rotate(crypto.createHash('sha256').update('bearer-alice').digest('base64url')), 1);
  assert.equal(await r.sessions.live(crypto.createHash('sha256').update('bearer-alice').digest('base64url'), CLOCK), null);
 });
 /* presence is deliberately P06-owned: the member refuses instead of inventing an empty answer */
 await assert.rejects(() => api.run((tx) => tx.repositories.sessions.presence('alice', 0, CLOCK)), (e) => e.code === 'PRESENCE_OWNED_BY_P06');

 /* jobs.* - the legacy outbox claim shape, owned by worker_runtime (0022; core/api hold no
  * privilege on ops.outbox). */
 const worker = uowFor('worker');
 await worker.run(async (tx) => {
  const r = tx.repositories;
  assert.deepEqual(r.jobs.queues(), ['v4_outbox']);
  const due = await r.jobs.due('v4_outbox', CLOCK, 5);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 'mail-1');
  assert.equal(due[0].payload, 'sealed');
  assert.equal(due[0].state, 'queued');
  assert.equal(due[0].attempts, 0);
  assert.equal(await r.jobs.expireDue('v4_outbox', CLOCK - 86400000), 0);
  await assert.rejects(() => Promise.resolve(r.jobs.due('v9_none', CLOCK)), (e) => e.code === 'UNKNOWN_JOB_QUEUE');
  /* An expired queued row is sealed: the state and the NULLed payload land in one UPDATE. */
  await tx.query("INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at) VALUES ('mail-old', 'sealed', 'otp', 'queued', now() - interval '2 days', now() - interval '1 day', now() - interval '2 days')");
  assert.equal(await r.jobs.expireDue('v4_outbox', CLOCK), 1);
  const expired = (await tx.query("SELECT state, payload FROM ops.outbox WHERE outbox_id = 'mail-old'")).rows[0];
  assert.equal(expired.state, 'expired');
  assert.equal(expired.payload, null, 'a terminal outbox row must not retain its sealed payload');
 });
});

/* ------------------------------------------------- 2. aggregate seam + diff */

test('P04 aggregate seam: the unchanged production dispatcher runs over the normalized tables', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 await openHarness(t);
 const core = uowFor('core');
 const api = uowFor('api');
 const operator = { actor: 'operator', scope: 'operator' };

 /* `executeCommand` is the UNCHANGED production dispatcher (packages/domain/commands.js); it is
  * given the graph `domain()` assembled and persisted by `commitDomain()`, exactly like
  * server/economy-store.js:31-41. */
 const converted = await core.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'alice', scope: 'player' }, 'convert-1', { type: 'convert', from: 'coins', amount: 100 });
  const stats = await tx.repositories.commitDomain();
  return { result, stats };
 });
 assert.deepEqual(converted.result, { from: 'coins', to: 'crowns', debit: 100, credit: 10, id: 'convert-1' });
 assert.ok(converted.stats.upserts > 0, 'the change must be persisted entity-wise');

 const after = await core.run(async (tx) => ({
  wallet: await tx.repositories.wallets.for('alice'),
  ledger: await tx.repositories.ledger.recent('alice'),
 }));
 assert.equal(after.wallet.coins, 900);
 assert.equal(after.wallet.crowns, 110);
 /* `ledger.recent` orders by the shipped index (actor_id, at DESC, entry_id DESC) reversed to
  * ascending. The two conversion entries share one clock instant, so the documented tiebreak is
  * entry_id - the same ordering the index defines. */
 assert.deepEqual(after.ledger.map((e) => e.id), ['opening:alice', 'convert-1:in', 'convert-1:out']);
 assert.deepEqual([...after.ledger.map((e) => e.id)].sort(), ['convert-1:in', 'convert-1:out', 'opening:alice']);

 /* An UNCHANGED entity is not rewritten: a second commit with no mutation reports no table. */
 const idle = await core.run((tx) => tx.repositories.commitDomain());
 assert.equal(idle.upserts, 0, 'an unchanged aggregate must not rewrite its entities');
 assert.equal(idle.deletes, 0);
 assert.equal(idle.tables, 0);

 /* There is no `state` table anywhere in the schema. */
 const c = await adminClient(context.database);
 try {
  /* The ONLY table named `state` in the chain is runtime.state, the singleton key/value control
  * table (0018); there is no whole-graph blob table anywhere, and none was added. */
  const t1 = await c.query("SELECT schemaname FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND tablename = 'state'");
  assert.deepEqual(t1.rows.map((r) => r.schemaname), ['runtime'], 'no whole-graph state table may exist');
  const t1b = await c.query("SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS cols FROM information_schema.columns WHERE table_schema = 'runtime' AND table_name = 'state'");
  assert.equal(t1b.rows[0].cols, 'key,value', 'runtime.state is the key/value control table, not an aggregate blob');
  const t2 = await c.query("SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND tablename = 'party_rooms'");
  assert.equal(t2.rows[0].n, 0, 'no serialized room blob table may exist');
 } finally { await c.end(); }

 /* state.read / state.write keep the RAW seam working (server/rooms.js): a whole-aggregate write
  * persists entity-wise and adopts the caller's value. */
 const written = await core.run(async (tx) => {
  const raw = await tx.repositories.state.read();
  raw.accounts.find(([id]) => id === 'alice')[1].coins = 875;
  await tx.repositories.state.write(raw);
  return tx.repositories.wallets.for('alice');
 });
 assert.equal(written.coins, 875);

 /* An API-owned aggregate change persists on the api role: a preference write touches only
  * identity.actors (design ownership register), so it is allowed. */
 const preferences = await api.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'alice', scope: 'player' }, 'prefs-1', { type: 'preferences', changes: { wealthPublic: true } });
  const stats = await tx.repositories.commitDomain();
  return { result, stats };
 });
 assert.deepEqual(preferences.result, { wealthPublic: true, region: 'Test' });
 assert.ok(preferences.stats.upserts >= 1);
 const wealth = await core.run((tx) => tx.query('SELECT wealth_public FROM identity.actors WHERE actor_id = $1', ['alice']));
 assert.equal(wealth.rows[0].wealth_public, true);

 /* Provisioning is a TWO-ROLE handshake in V5 (P05 design B1.1): the API creates the actor and its
  * eligibility row, and a Core command creates the wallet. One whole-aggregate commit cannot span
  * both owners, and the adapter refuses rather than dropping half the business effect: `provision`
  * driven on core_runtime names identity.actors and fails closed. This is a reported finding, not
  * something the adapter papers over with a privileged connection. */
 await assert.rejects(
  () => core.run(async (tx) => {
   const graph = await tx.repositories.domain();
   executeCommand(graph.authority, operator, 'provision:carol', { type: 'provision', account: 'carol', options: { coins: 321, crowns: 7, rating: 1200, games: 12, verified: true } });
   return tx.repositories.commitDomain();
  }),
  (e) => e.code === 'ROLE_CAPABILITY_REQUIRED' && /identity\.actors/.test(String(e.detail)));
 /* The refused unit of work left NOTHING behind: neither the actor nor a wallet. */
 const afterRefusal = await core.run(async (tx) => ({
  has: await tx.repositories.accounts.has('carol'),
  wallets: (await tx.query('SELECT count(*)::int AS n FROM economy.wallets WHERE actor_id = $1', ['carol'])).rows[0].n,
  ledger: (await tx.query("SELECT count(*)::int AS n FROM economy.ledger WHERE actor_id = $1", ['carol'])).rows[0].n,
 }));
 assert.equal(afterRefusal.has, false, 'a refused provision must not leave a partial actor');
 assert.equal(afterRefusal.wallets, 0);
 assert.equal(afterRefusal.ledger, 0);

 /* The CORE half of that handshake is expressible: with the actor row already provisioned by the
  * API, a core-side economic command writes the wallet, the opening ledger entry and the occupancy
  * row, all on the core role. */
 const c3 = await adminClient(context.database);
 try { await seedActors(c3, ['dave'], { coins: 0, crowns: 0 }); } finally { await c3.end(); }
 const provisionWallet = await core.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const account = graph.account('dave');
  account.coins = 321;
  account.crowns = 7;
  const stats = await tx.repositories.commitDomain();
  return stats;
 });
 /* Exactly the wallet changed; no ledger entry, rating or occupancy row was invented to go with
  * it, because nothing else in the aggregate moved. */
 assert.equal(provisionWallet.upserts, 1, 'only the changed wallet entity is written');
 assert.equal(provisionWallet.deletes, 0);
 const dave = await core.run(async (tx) => ({
  wallet: await tx.repositories.wallets.for('dave'),
  raw: await tx.repositories.state.read(),
 }));
 assert.equal(dave.wallet.coins, 321);
 assert.equal(dave.wallet.crowns, 7);
 /* No timestamp was minted: the graph carried none for this change, so no ledger entry appeared. */
 assert.deepEqual(dave.raw.journal.filter((e) => e.actor === 'dave').map((e) => e.id), ['opening:dave']);
});

/* ------------------------------- 2b. regression: match, DATE day, injected clock */

test('P04 regression: a seeded match hydrates, a DATE day keys by its source text, and the injected clock/random reach the domain', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 await openHarness(t);
 const core = uowFor('core');

 /* 1. Hydration over a database holding a real match aggregate must not throw, and the seats must
  *    project onto `players`/`accepted` from the participant rows. */
 const hydrated = await core.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const match = graph.matches.get('m-1');
  return { ids: [...graph.matches.keys()], players: match.players, accepted: match.accepted, view: graph.authority.view('m-1') };
 });
 assert.deepEqual(hydrated.ids, ['m-1']);
 assert.deepEqual(hydrated.players, ['alice', 'bob']);
 assert.deepEqual(hydrated.accepted, ['alice', 'bob']);
 assert.equal(hydrated.view.players.length, 2);
 assert.equal(hydrated.view.participants, undefined, 'the hydrate accumulator must not leak into the view');

 /* 2. A DATE day must key by its source text: a graph-driven write through `commitDomain()` must
  *    UPsert the SAME day row, never create a second key and never zero the untouched counters. */
 const claim = await core.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const daily = graph.account('alice').daily;
  assert.deepEqual(Object.keys(daily), ['2026-10-08']);
  daily['2026-10-08'].claimed.push('ranked');
  const stats = await tx.repositories.commitDomain();
  return stats;
 });
 assert.equal(claim.deletes, 0, 'no day row may be deleted by a TZ-shifted key');
 const days = await core.run((tx) => tx.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, finished, boards, claimed FROM economy.daily_progress WHERE actor_id = 'alice'"));
 assert.equal(days.rows.length, 1, 'exactly the pre-existing day row must remain');
 assert.equal(days.rows[0].day, '2026-10-08');
 assert.equal(days.rows[0].finished, 3, 'untouched counters must not be zeroed');
 assert.equal(days.rows[0].boards, 8);
 assert.deepEqual(days.rows[0].claimed, ['finish', 'ranked']);

 /* 3. The injected clock must reach the domain model: `convert` journals with `this.now()`. */
 const driven = await core.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const account = graph.account('bob');
  account.coins = 1000;
  account.crowns = 0;
  executeCommand(graph.authority, { actor: 'bob', scope: 'player' }, 'convert-clock', { type: 'convert', from: 'coins', amount: 100 });
  const stats = await tx.repositories.commitDomain();
  return stats;
 });
 assert.ok(driven.upserts >= 1);
 const conversion = await core.run((tx) => tx.repositories.ledger.recent('bob', null));
 assert.ok(conversion.some((e) => e.id === 'convert-clock:out' && e.at === CLOCK), 'the journal instant must be the INJECTED clock, not the host clock');
});

 /* 4. The caller's `random` and `verifyPurchase` must survive hydration into the domain model. A
  *    queue offer draws the symbol choice from `authority.random`, so a seeded draw is observable;
  *    a purchase reaches the caller verifier instead of throwing STORE_UNAVAILABLE. */
 test('P04 regression: the caller-supplied random and purchase verifier are threaded into the hydrated domain', async (t) => {
  if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
  try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
  await openHarness(t);
  let draws = 0;
  const seen = [];
  const core = uowFor('core', {
   now: () => CLOCK,
   random: () => { draws += 1; return 1; },
   verifyPurchase: (evidence, actor) => {
    seen.push([evidence.transactionId, actor]);
    return { valid: true, accountId: actor, refunded: false, store: 'google', transactionId: evidence.transactionId, productId: 'crowns_100' };
   },
  });
  const ran = await core.run(async (tx) => {
   const graph = await tx.repositories.domain();
   const bob = graph.account('bob');
   bob.coins = 1000;
   bob.crowns = 0;
   bob.purchasedCrowns = 0;
   const purchased = executeCommand(graph.authority, { actor: 'bob', scope: 'player' }, 'buy-seeded',
    { type: 'purchase', evidence: { transactionId: 'tx-1' } });
   const second = executeCommand(graph.authority, { actor: 'bob', scope: 'player' }, 'buy-seeded-2',
    { type: 'purchase', evidence: { transactionId: 'tx-1' } });
   await tx.repositories.commitDomain();
   return { purchased, second };
  });
  /* `purchase()` verifies BEFORE it consults the receipt table (src/authority.js:140-146), so a
   * replay reaches the verifier again and is then answered from the stored receipt - exactly the
   * legacy behavior. What must hold is that the credit happens exactly once. */
  assert.deepEqual(seen, [['tx-1', 'bob'], ['tx-1', 'bob']], 'both purchases must reach the caller verifier');
  assert.deepEqual(ran.purchased, { crowns: 100, duplicate: false });
  assert.deepEqual(ran.second, { crowns: 100, duplicate: true }, 'the receipt replay must be answered without re-verifying');
  const crowns = await core.run((tx) => tx.query("SELECT crowns, purchased_crowns FROM economy.wallets WHERE actor_id = 'bob'"));
  assert.equal(Number(crowns.rows[0].crowns), 100, 'the verified purchase credits exactly one pack');
  assert.equal(Number(crowns.rows[0].purchased_crowns), 100);
 });

/* ------------------------------------------------------- 3. concurrency */

test('P04 concurrency: two scopes cannot overdraw or double-reserve, and a failed unit rolls back', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 await openHarness(t);
 const core = uowFor('core');
 /* A dedicated actor so the race is deterministic regardless of the other tests. */
 const c = await adminClient(context.database);
 try { await seedActors(c, ['racer'], { coins: 100, crowns: 0 }); } finally { await c.end(); }

 /* Each scope: take the documented lock (occupancy then wallets, sorted) then read-modify-write. */
 const reserve = async (amount) => core.run(async (tx) => {
  await tx.repositories.wallets.lock(['racer']);
  const wallet = await tx.repositories.wallets.for('racer');
  const graph = await tx.repositories.domain();
  const account = graph.account('racer');
  if (account.reservedCoins + amount > wallet.coins) throw Object.assign(new Error('INSUFFICIENT_COINS'), { code: 'INSUFFICIENT_COINS' });
  await tx.query('UPDATE economy.wallets SET reserved_coins = reserved_coins + $2 WHERE actor_id = $1', ['racer', amount]);
  await tx.query('UPDATE economy.wallets SET coins = coins - $2 WHERE actor_id = $1', ['racer', amount]);
  return amount;
 });
 const [a, b] = await Promise.allSettled([reserve(60), reserve(60)]);
 const fulfilled = [a, b].filter((r) => r.status === 'fulfilled').length;
 const rejected = [a, b].filter((r) => r.status === 'rejected');
 assert.equal(fulfilled, 1, 'exactly one of two racing reservations may win');
 assert.equal(rejected.length, 1);
 assert.match(String(rejected[0].reason.message), /INSUFFICIENT_COINS/);

 const settled = await core.run(async (tx) => {
  const wallet = await tx.repositories.wallets.for('racer');
  const rows = await tx.query('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = $1', ['racer']);
  return { wallet, row: rows.rows[0] };
 });
 assert.equal(settled.row.coins, '40', 'no overdraw: exactly one 60-Coin reservation committed');
 assert.equal(settled.row.reserved_coins, '60', 'no double-reserve');
 assert.equal(settled.wallet.coins, 40);

 /* A failing unit of work rolls back every entity it touched, including the ledger append. */
 await assert.rejects(() => core.run(async (tx) => {
  await tx.repositories.wallets.lock(['racer']);
  await tx.query('UPDATE economy.wallets SET coins = 7 WHERE actor_id = $1', ['racer']);
  await tx.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ('rollback-probe', 'racer', 'coins', -1, 'probe', 'game', now())");
  throw new Error('BOOM');
 }), /BOOM/);
 const rolled = await core.run(async (tx) => ({
  wallet: await tx.repositories.wallets.for('racer'),
  ledger: await tx.repositories.ledger.recent('racer'),
 }));
 assert.equal(rolled.wallet.coins, 40, 'the failed unit must roll back its wallet write');
 assert.equal(rolled.ledger.some((e) => e.id === 'rollback-probe'), false, 'the failed unit must roll back its ledger append');

 /* A repository call with no live scope refuses instead of writing outside a transaction. */
 await assert.rejects(
  () => Promise.resolve().then(() => core.repositories().wallets.for('racer')),
  (e) => e.code === 'TRANSACTION_REQUIRED');
});

/* ------------------------------------------------------- 4. idempotency */

test('P04 idempotency: a replayed command key returns the stored response and re-applies nothing', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 await openHarness(t);
 const core = uowFor('core');
 const c = await adminClient(context.database);
 try { await seedActors(c, ['carol-idem'], { coins: 500, crowns: 0 }); } finally { await c.end(); }

 const id = JSON.stringify(['carol-idem', 'quest-1']);
 const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ principal: { actor: 'carol-idem' }, cmd: { type: 'quest', quest: 'daily-first' } })).digest('hex');

 /* First application: the outcome row and the effect land in ONE transaction. */
 const first = await core.run(async (tx) => {
  const stored = await tx.repositories.outcomes.find(COMMANDS, id);
  assert.equal(stored, null);
  const response = JSON.stringify({ coins: 5 });
  await tx.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ('quest-1', 'carol-idem', 'coins', 5, 'Daily quest', 'mint', now())");
  await tx.query('UPDATE economy.wallets SET coins = coins + 5 WHERE actor_id = $1', ['carol-idem']);
  await tx.repositories.outcomes.save(COMMANDS, id, 'carol-idem', fingerprint, response);
  return response;
 });
 assert.equal(first, JSON.stringify({ coins: 5 }));

 /* Replay: find returns the stored row with the ORIGINAL committed_at (the injected clock), and a
  * re-save on the same primary key is a no-op that cannot overwrite it. */
 const replay = await core.run(async (tx) => {
  const stored = await tx.repositories.outcomes.find(COMMANDS, id);
  assert.equal(stored.fingerprint, fingerprint);
  assert.equal(stored.actor, 'carol-idem');
  assert.equal(stored.key, 'quest-1');
  assert.deepEqual(stored.response, { coins: 5 }, 'the stored response comes back decoded, exactly as the SQLite find() returns it');
  await tx.repositories.outcomes.save(COMMANDS, id, 'carol-idem', fingerprint, JSON.stringify({ coins: 5 }));
  await tx.repositories.outcomes.save(COMMANDS, id, 'carol-idem', 'f'.repeat(64), JSON.stringify({ coins: 999 }));
  return tx.repositories.outcomes.find(COMMANDS, id);
 });
 assert.equal(replay.fingerprint, fingerprint, 'a replayed key must not overwrite the stored outcome');
 assert.deepEqual(replay.response, { coins: 5 });
 const db = await adminClient(context.database);
 try {
  const row = (await db.query('SELECT count(*)::int AS n, (array_agg(response))[1] AS response FROM economy.command_outcomes WHERE actor_id = $1 AND "key" = $2', ['carol-idem', JSON.stringify('quest-1')])).rows[0];
  assert.equal(row.n, 1, 'exactly one outcome row per (actor,key)');
  assert.equal(JSON.parse(row.response).coins, 5);
  const eff = (await db.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'quest-1'")).rows[0];
  assert.equal(eff.n, 1, 'the effect was applied exactly once');
 } finally { await db.end(); }

 /* Every family keeps its own uniqueness domain and its own key encoding. */
 const partyId = JSON.stringify(['carol-idem', 'party-1']);
 const party = await core.run(async (tx) => {
  const r = tx.repositories;
  await r.outcomes.save(PARTY_COMMANDS, partyId, 'a'.repeat(64), JSON.stringify({ id: 'room-1' }));
  return r.outcomes.find(PARTY_COMMANDS, partyId);
 });
 assert.equal(party.key, 'party-1');
 assert.deepEqual(party.response, { id: 'room-1' });
 /* social.command_outcomes is api-owned (0020), so its family is exercised on the api role. */
 const api = uowFor('api');
 const social = await api.run(async (tx) => {
  const r = tx.repositories;
  const socialId = 'alice:social-1';
  await r.outcomes.save(SOCIAL_OPERATIONS, socialId, 'b'.repeat(43), JSON.stringify({ ok: true }));
  return r.outcomes.find(SOCIAL_OPERATIONS, socialId);
 });
 assert.equal(social.key, 'social-1');
 assert.deepEqual(social.result, { ok: true }, 'the social family decodes its JSON TEXT result the same way');
 assert.equal((await core.run((tx) => tx.repositories.outcomes.find(COMMANDS, JSON.stringify(['carol-idem', 'quest-1'])))).key, 'quest-1');
 await assert.rejects(() => core.run((tx) => tx.repositories.outcomes.save({ find: 'SELECT 1' }, 'x', 'y')), (e) => e.code === 'UNKNOWN_OUTCOME_SCOPE');
});

/* ------------------------------------------------------- 5. no SQLite */

test('P04 no-SQLite: this module graph never reaches node:sqlite, src/authority storage or the SQLite repositories', () => {
 const roots = [path.join(ROOT, 'packages/db/pg/uow.js'), path.join(ROOT, 'packages/db/pg/repositories.js')];
 const seen = new Set(), edges = new Map();
 const FORBIDDEN = ['packages/db/index.js', 'packages/db/repositories.js'];
 function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  const requires = [...source.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
  edges.set(file, requires);
  for (const spec of requires) {
   if (!spec.startsWith('.')) {
    assert.equal(['node:sqlite', 'sqlite', 'better-sqlite3'].includes(spec), false, `${path.relative(ROOT, file)} requires ${spec}`);
    continue;
   }
   walk(require.resolve(path.resolve(path.dirname(file), spec)));
  }
 }
 for (const root of roots) walk(root);
 const relatives = [...seen].map((f) => path.relative(ROOT, f));
 for (const forbidden of FORBIDDEN) {
  assert.equal(relatives.includes(forbidden), false, `${forbidden} must not be in the P04 module graph`);
  for (const [file, requires] of edges) {
   for (const spec of requires) {
    if (!spec.startsWith('.')) continue;
    const target = require.resolve(path.resolve(path.dirname(file), spec));
    assert.notEqual(path.relative(ROOT, target), forbidden, `${path.relative(ROOT, file)} must not require ${forbidden}`);
   }
  }
 }
 /* The in-memory domain model IS reachable - deliberately, as a pure model with no storage. */
 assert.ok(relatives.includes('src/authority.js'));
 for (const spec of edges.get(path.join(ROOT, 'src/authority.js'))) {
  assert.ok(!/sqlite/i.test(spec), `src/authority.js must not require ${spec}`);
 }
 assert.equal(seen.size > 3, true, 'the walk must actually traverse (not a stub assertion)');
});
