/* V5 P03 (V5-03-03/05) - importer consumer-visible invariants against a locally owned PG16.
 *
 * Harness contract (same as tests/v5-migrations.test.js):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: the URL is used ONLY to
 *     CREATE/DROP this suite's tracked v5_test_load_* databases.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 * No Neon/production target is ever contacted.
 *
 * Covered: every durable family is populated with the exact source values; ids/keys/timestamps
 * are exact; JSONB columns are semantically equal; a second same-run-id load is a no-op; a fresh
 * run id converges to identical rows; an interrupted batch resumes to the identical rows.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const {canonical} = require(path.join(ROOT, 'tools/v5-migration/canonical.js'));
const {capture} = require(path.join(ROOT, 'tools/v5-migration/capture.js'));
const {readSnapshot} = require(path.join(ROOT, 'tools/v5-migration/reader.js'));
const {load, KIND_ORDER} = require(path.join(ROOT, 'tools/v5-migration/loader.js'));
const {buildSyntheticSource} = require(path.join(ROOT, 'tools/v5-migration/fixtures/build-synthetic-source.js'));
const CHAIN_LENGTH = require(path.join(ROOT, 'packages/migrations/manifest.json')).migrations.length;

const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;

/* ------------------------------------------------------------------ backend */

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
  if (!bin) { backendError = 'no installed PostgreSQL 16 (set V5_PG_URL for an owned loopback cluster)'; throw new Error(backendError); }
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-load-pg-${PID}-`));
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

const createdDatabases = new Set();
async function connectAdmin(database) {
  const pg = require('pg');
  const url = new URL(backend.adminUrl);
  const c = new pg.Client({
    host: url.hostname, port: Number(url.port || 5432),
    user: url.username ? decodeURIComponent(url.username) : 'postgres',
    password: url.username ? decodeURIComponent(url.password || '') : undefined,
    database: database || decodeURIComponent(url.pathname.replace(/^\//, ''))
  });
  await c.connect();
  return c;
}
function ident(name) { return `"${name.replace(/"/g, '""')}"`; }
function trackedName(family) { return `v5_test_load_${family}_${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'); }
function dbUrl(database) {
  const url = new URL(backend.adminUrl);
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}
async function dropTracked(name) {
  if (!createdDatabases.has(name)) return;
  const c = await connectAdmin();
  try { await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); createdDatabases.delete(name); } finally { await c.end(); }
}

test.after(async () => {
  for (const name of [...createdDatabases]) {
    try { await dropTracked(name); } catch { /* best effort; only THIS suite's tracked names */ }
  }
  if (backend && backend.stop) backend.stop();
});

function runMigrate(args, env = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 240000,
    env: {...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', ...env}
  });
  return {status: r.status, stdout: r.stdout || '', stderr: r.stderr || ''};
}

async function freshTarget(t, family) {
  try { await ensureBackend(); }
  catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return null; }
  const name = trackedName(family);
  const c = await connectAdmin();
  try { await c.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await c.end(); }
  const result = runMigrate(['--execute', '--json', '--database-url', dbUrl(name)], {MIGRATE_CONFIRM: name, V5_TARGET: 'test'});
  assert.equal(result.status, 0, `migrate failed: ${result.stdout}${result.stderr}`);
  const pg = require('pg');
  const client = new pg.Client({connectionString: dbUrl(name)});
  await client.connect();
  return {client, name};
}

/* The model is read from a real immutable capture of the representative fixture, never from the
 * live fixture file. The fixture builder is the expensive part, so one build is shared by both
 * tests; each test still gets its own fresh target database. */
let cachedModel = null;
async function buildModel() {
  if (cachedModel) return cachedModel;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `v5-load-fx-${PID}-`));
  const source = buildSyntheticSource({directory: path.join(directory, 'representative'), variant: 'representative'});
  const snapshot = path.join(directory, 'snapshot.sqlite');
  await capture(source.file, snapshot, {captureClockMs: source.clockMs, sourceRelease: {sha: source.sourceRelease.sha}});
  const model = readSnapshot(snapshot, {captureClockMs: source.clockMs, sourceRelease: {sha: source.sourceRelease.sha}});
  cachedModel = {model, expected: source.expected, directory};
  return cachedModel;
}

test.after(() => {
  if (cachedModel) fs.rmSync(cachedModel.directory, {recursive: true, force: true});
});

/* ------------------------------------------------------------------ comparisons */

/* JSONB normalizes object key order and drops duplicate keys, so a stored value is compared
 * semantically; arrays stay order-sensitive, exactly as the design requires. */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}
function sameJson(a, b) { return JSON.stringify(sortValue(a)) === JSON.stringify(sortValue(b)); }
function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/* ------------------------------------------------------------------ suite */

test('the representative fixture imports every durable family exactly, and reruns converge', async (t) => {
  const target = await freshTarget(t, 'main');
  if (!target) return;
  const {client} = target;
  const {model, expected} = await buildModel();
  try {
    /* An unknown target is refused before ANY bookkeeping row exists: absence of a target_guard
     * entry is a refusal, never an implicit create. */
    await assert.rejects(() => load({
      model, runId: 'run-load-v5-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client
    }), (error) => error.code === 'TARGET_UNKNOWN');
    const before = (await client.query('SELECT count(*)::int AS n FROM v5_migration.run')).rows[0].n;
    assert.equal(before, 0, 'a refused load must write no run row');

    const first = await load({
      model, runId: 'run-load-v5-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test', adoptExisting: true}, client, batchSize: 50
    });
    assert.equal(first.runId, 'run-load-v5-1');
    assert.equal(first.sourceFingerprint, model.hashes.sourceFingerprint);
    assert.equal(first.batches.every((batch) => batch.status === 'committed'), true);
    assert.equal(first.counters.rowsWritten > 0, true);
    assert.equal(first.targetGuard.database, target.name);

    await verifyTarget(client, model);
    const rowsAfterFirst = await totalRowCount(client);
    const digestAfterFirst = await targetDigest(client);

    /* A second load with the SAME run id writes no data row and verifies every committed row
     * against the database's own rendering of the stored bytes. */
    const second = await load({
      model, runId: 'run-load-v5-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client, batchSize: 50
    });
    assert.equal(second.counters.rowsWritten, 0, 'a repeated run id must write nothing');
    assert.equal(second.counters.rowsVerifiedFromLedger, rowsAfterFirst);
    assert.equal(second.counters.rowsVerified, rowsAfterFirst);
    assert.equal(second.batches.every((batch) => batch.verified === true), true);
    assert.equal(await totalRowCount(client), rowsAfterFirst);
    assert.equal(await targetDigest(client), digestAfterFirst, 'a repeated run id must change nothing');

    /* A FRESH run id finds every non-singleton row already present and converges; the three seeded
     * singleton rows (0024) are updated in place with identical values. */
    const third = await load({
      model, runId: 'run-load-v5-2', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client, batchSize: 250
    });
    const singletons = await singletonRowCount(client);
    assert.equal(third.counters.rowsWritten, singletons);
    assert.equal(third.counters.rowsVerified, rowsAfterFirst - singletons);
    assert.equal(await totalRowCount(client), rowsAfterFirst);
    assert.equal(await targetDigest(client), digestAfterFirst, 'a fresh run id must converge to identical rows');
    await verifyTarget(client, model);

    /* The extractor release binds the run identity: a different one is refused. */
    await assert.rejects(() => load({
      model, runId: 'run-load-v5-1', extractorRelease: 'b'.repeat(64),
      target: {environment: 'test'}, client
    }), (error) => error.code === 'RUN_RELEASE_CONFLICT');

    /* A different source fingerprint under the same run id is refused. */
    const forged = JSON.parse(JSON.stringify(model));
    forged.hashes.sourceFingerprint = 'c'.repeat(64);
    await assert.rejects(() => load({
      model: forged, runId: 'run-load-v5-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client
    }), (error) => error.code === 'RUN_FINGERPRINT_CONFLICT');

    const bookkeeping = (await client.query(
      `SELECT (SELECT count(*)::int FROM v5_migration.run) runs,
              (SELECT count(*)::int FROM v5_migration.batch WHERE status <> 'committed') uncommitted,
              (SELECT count(*)::int FROM v5_migration.row_ledger WHERE run_id = 'run-load-v5-1') ledger_first,
              (SELECT count(*)::int FROM v5_migration.row_ledger WHERE run_id = 'run-load-v5-2') ledger_second,
              (SELECT count(*)::int FROM v5_migration.coverage WHERE classification = 'unclassified') unclassified,
              (SELECT count(DISTINCT target_table)::int FROM v5_migration.row_ledger WHERE run_id = 'run-load-v5-1') tables`
    )).rows[0];
    assert.equal(bookkeeping.runs, 2);
    assert.equal(bookkeeping.uncommitted, 0);
    assert.equal(bookkeeping.ledger_first, rowsAfterFirst);
    assert.equal(bookkeeping.ledger_second, rowsAfterFirst);
    assert.equal(bookkeeping.unclassified, 0);
    assert.equal(expected.variant, 'representative');
    assert.equal(bookkeeping.tables >= 40, true, 'the ledger must span every durable family');
  } finally {
    await client.end();
  }
});

test('an interrupted batch resumes from its last committed cursor to the identical rows', async (t) => {
  const target = await freshTarget(t, 'resume');
  if (!target) return;
  const {client} = target;
  const {model} = await buildModel();
  try {
    /* Interrupt MID-batch: after the chosen batch ordinal starts, the next target insert throws, so
     * that batch's transaction aborts and only its own rows roll back. PostgreSQL leaves the
     * committed earlier batches and the run row exactly as a crashed process would. */
    const interruptAt = 30;
    const guillotine = abortClient(client, interruptAt);
    await assert.rejects(() => load({
      model, runId: 'run-resume-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test', adoptExisting: true}, client: guillotine, batchSize: 20,
      onBatch: (batch) => { guillotine.arm(batch.ordinal); }
    }), /SIMULATED_INTERRUPT/);

    const partial = (await client.query(
      `SELECT (SELECT count(*)::int FROM v5_migration.batch WHERE run_id = $1 AND status = 'committed') committed,
              (SELECT count(*)::int FROM v5_migration.batch WHERE run_id = $1 AND status = 'failed') failed`,
      ['run-resume-1'])).rows[0];
    /* Batches 0..interruptAt commit; the abort lands on batch interruptAt+1, whose own transaction
     * rolls back with it. */
    assert.equal(partial.committed, interruptAt + 1);
    assert.equal(partial.failed, 1);
    const rowsAfterInterrupt = await totalRowCount(client);
    assert.equal(rowsAfterInterrupt > 0, true);
    assert.ok(rowsAfterInterrupt < 1439, 'the interruption must leave the run genuinely partial');

    /* Resume: the committed batches are verified against the ledger and skipped, the failed batch
     * re-executes with an incremented attempt count, and the run converges. */
    const resumed = await load({
      model, runId: 'run-resume-1', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client, batchSize: 20
    });
    assert.equal(resumed.batches.every((batch) => batch.status === 'committed'), true);
    assert.equal(resumed.batches.slice(0, interruptAt + 1).every((batch) => batch.verified === true), true);
    assert.equal(resumed.batches[interruptAt + 1].verified, false);
    assert.equal(resumed.batches[interruptAt + 1].attemptCount >= 2, true);
    assert.equal(resumed.batches[interruptAt + 1].cursor !== null, true,
      'a resumed batch records its last committed canonical key as its cursor');
    const rowsAfterResume = await totalRowCount(client);
    await verifyTarget(client, model);
    const resumedDigest = await targetDigest(client);

    /* The identical row set is reached by a clean load of the same model into a third run id. */
    const clean = await load({
      model, runId: 'run-resume-2', extractorRelease: model.hashes.sourceFingerprint,
      target: {environment: 'test'}, client, batchSize: 1000
    });
    assert.equal(clean.counters.rowsWritten, await singletonRowCount(client));
    assert.equal(clean.counters.rowsVerified, rowsAfterResume - await singletonRowCount(client));
    assert.equal(await totalRowCount(client), rowsAfterResume);
    assert.equal(await targetDigest(client), resumedDigest, 'a fresh run id must converge to identical rows');
    await verifyTarget(client, model);
  } finally {
    await client.end();
  }
});

/* ------------------------------------------------------------------ target verification */

/* The three seeded singleton rows (0024) exist before any import, so a fresh run id UPDATEs them in
 * place instead of inserting; count how many of them the model actually populates. */
async function singletonRowCount(client) {
  const rows = (await client.query(
    `SELECT (SELECT count(*)::int FROM runtime.controls)
          + (SELECT count(*)::int FROM economy.system_burns)
          + (SELECT count(*)::int FROM season.league_week) AS n`)).rows;
  return rows[0].n;
}

const COUNTED_TABLES = [...new Set([...KIND_ORDER.map((kind) => kind.split('#')[0]),
  'runtime.controls', 'economy.system_burns', 'season.league_week'])];
/* A deterministic digest of the entire target data set, so a resumed and a clean run can be shown
 * to reach byte-identical state. */
async function targetDigest(client) {
  const tables = (await client.query(
    `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
      WHERE schemaname = ANY($1::text[]) ORDER BY 1`,
    [['identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament', 'monetization', 'cosmetics', 'season', 'privacy', 'support', 'audit', 'runtime', 'ops']])).rows;
  const parts = [];
  for (const table of tables) {
    const ordered = (await client.query(
      `SELECT md5(string_agg(md5(t::text), '|' ORDER BY md5(t::text))) AS h FROM ${table.name} AS t`)).rows[0].h;
    parts.push(table.name + '=' + ordered);
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

/* A client wrapper that aborts the first target INSERT after a chosen batch ordinal has started,
 * then passes every later call through to the real client (so the resume can run normally). */
function abortClient(client, ordinal) {
  let armed = false;
  let tripped = false;
  return {
    arm(startedOrdinal) { if (startedOrdinal === ordinal) armed = true; },
    async query(sql, params) {
      if (armed && !tripped && /^INSERT INTO (?!v5_migration)/.test(String(sql).trim())) {
        tripped = true;
        throw new Error('SIMULATED_INTERRUPT');
      }
      return client.query(sql, params);
    }
  };
}

async function totalRowCount(client) {
  /* An exact count, not a statistics estimate: every target table the importer can write. */
  const expr = COUNTED_TABLES.map((table) => `(SELECT count(*) FROM ${table})`).join(' + ');
  const rows = (await client.query(`SELECT (${expr})::bigint::text AS n`)).rows;
  return Number(rows[0].n);
}

async function verifyTarget(client, model) {
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const accounts = new Map(model.state.parsed.accounts);
  const matches = new Map(model.state.parsed.matches);
  const rooms = new Map(model.rooms.map((room) => [String(room.id), room.parsed]));

  /* identity */
  const actors = await q('SELECT actor_id, region, wealth_public, created_at FROM identity.actors ORDER BY actor_id');
  assert.equal(actors.length, accounts.size);
  for (const row of actors) {
    const account = accounts.get(row.actor_id);
    assert.ok(account, 'unknown actor ' + row.actor_id);
    /* region is a JSON string scalar (0034); the driver decodes it to the source string. */
    assert.equal(row.region, account.region === undefined ? '' : account.region);
    assert.equal(row.wealth_public, account.wealthPublic === true);
    assert.equal(iso(row.created_at), new Date(account.createdAt).toISOString());
  }

  const wallets = await q('SELECT actor_id, coins::text coins, crowns::text crowns, reserved_coins::text rc, reserved_crowns::text rk, purchased_coins::text pc, purchased_crowns::text pk, purchase_influenced, legacy_competition_restricted FROM economy.wallets ORDER BY actor_id');
  assert.equal(wallets.length, accounts.size);
  for (const row of wallets) {
    const account = accounts.get(row.actor_id);
    assert.equal(Number(row.coins), account.coins);
    assert.equal(Number(row.crowns), account.crowns);
    assert.equal(Number(row.rc), account.reservedCoins);
    assert.equal(Number(row.rk), account.reservedCrowns);
    assert.equal(Number(row.pc), account.purchasedCoins === undefined ? 0 : account.purchasedCoins);
    assert.equal(Number(row.pk), account.purchasedCrowns === undefined ? 0 : account.purchasedCrowns);
    assert.equal(row.purchase_influenced, account.purchaseInfluenced === true);
    assert.equal(row.legacy_competition_restricted, account.legacyCompetitionRestricted === true);
  }

  const ratings = await q('SELECT actor_id, rating::text rating, peak::text peak, casual_rating::text cr, games, casual_games, tier FROM economy.ratings ORDER BY actor_id');
  assert.equal(ratings.length, accounts.size);
  for (const row of ratings) {
    const account = accounts.get(row.actor_id);
    const casual = account.casualRating === undefined ? (account.games >= 10 ? account.rating : 1000) : account.casualRating;
    assert.equal(Number(row.rating), account.rating);
    assert.equal(Number(row.peak), account.peak);
    assert.equal(Number(row.cr), casual);
    assert.equal(row.games, account.games);
    assert.equal(row.casual_games, account.casualGames === undefined ? 0 : account.casualGames);
    assert.equal(row.tier, account.tier);
  }

  /* ledger: the journal verbatim, order and ids exact */
  const ledger = await q('SELECT entry_id, actor_id, currency, amount::text amount, reason, source, at FROM economy.ledger ORDER BY entry_id');
  assert.equal(ledger.length, model.state.parsed.journal.length);
  const journal = new Map(model.state.parsed.journal.map((entry) => [entry.id, entry]));
  for (const row of ledger) {
    const entry = journal.get(row.entry_id);
    assert.ok(entry, 'unknown journal entry ' + row.entry_id);
    assert.equal(row.actor_id, entry.actor);
    assert.equal(row.currency, entry.currency);
    assert.equal(Number(row.amount), entry.amount);
    assert.equal(row.reason, entry.reason);
    assert.equal(row.source, entry.source);
    assert.equal(iso(row.at), new Date(entry.at).toISOString());
  }

  /* matches, with the JSONB members compared semantically */
  const matchRows = await q(`SELECT match_id, source, mode, kind, status, pool::text pool, contribution_a::text ca,
      contribution_b::text cb, accepted_count, escrow::text escrow, settled, revision::text revision,
      created_at, expires_at, terms_json, quote_json, terms_hash, state_json, receipt_json, receipt_reason,
      risk_actors, extra FROM match.matches ORDER BY match_id`);
  assert.equal(matchRows.length, matches.size);
  for (const row of matchRows) {
    const match = matches.get(row.match_id);
    assert.ok(match, 'unknown match ' + row.match_id);
    assert.equal(row.source, match.terms.source);
    assert.equal(row.mode, match.terms.mode);
    assert.equal(row.kind, match.terms.kind);
    assert.equal(row.status, match.status);
    assert.equal(row.accepted_count, (match.accepted || []).length);
    assert.equal(row.settled, match.settled === true);
    assert.equal(row.terms_hash, match.termsHash);
    assert.equal(iso(row.created_at), new Date(match.created).toISOString());
    assert.equal(iso(row.expires_at), new Date(match.expires).toISOString());
    assert.equal(Number(row.pool), match.quote.pool === undefined ? 0 : match.quote.pool);
    assert.equal(Number(row.ca), match.quote.contributions ? match.quote.contributions[0] : 0);
    assert.equal(Number(row.cb), match.quote.contributions ? match.quote.contributions[1] : 0);
    assert.equal(Number(row.escrow), match.escrow === undefined ? 0 : match.escrow);
    assert.ok(sameJson(row.terms_json, match.terms));
    assert.ok(sameJson(row.quote_json, match.quote));
    assert.ok(sameJson(row.state_json, match.state));
    assert.ok(sameJson(row.receipt_json, match.receipt === undefined ? null : match.receipt));
    assert.equal(row.receipt_reason, match.receipt === undefined ? null : match.receipt.reason);
    assert.ok(sameJson(row.risk_actors, match._riskActors === undefined ? {} : match._riskActors));
  }

  const participants = await q('SELECT match_id, seat, actor_id, accepted FROM match.participants ORDER BY match_id, seat');
  let expectedParticipants = 0;
  for (const [, match] of model.state.parsed.matches) expectedParticipants += match.players.length;
  assert.equal(participants.length, expectedParticipants);
  for (const row of participants) {
    const match = matches.get(row.match_id);
    assert.equal(row.actor_id, match.players[row.seat]);
    assert.equal(row.accepted, (match.accepted || []).includes(match.players[row.seat]));
  }

  const contributions = await q('SELECT match_id, actor_id, amount::text amount FROM match.escrow_contributions ORDER BY match_id, actor_id');
  for (const row of contributions) {
    const match = matches.get(row.match_id);
    const seat = match.players.indexOf(row.actor_id);
    assert.ok(seat >= 0, 'contribution for a non-player ' + row.actor_id);
    assert.equal(Number(row.amount), match.quote.contributions[seat]);
  }
  const moveOutcomes = await q('SELECT match_id, count(*)::int n FROM match.move_outcomes GROUP BY match_id ORDER BY match_id');
  for (const row of moveOutcomes) {
    assert.equal(row.n, matches.get(row.match_id).commands.length);
  }

  /* rooms */
  const roomRows = await q(`SELECT room_id, code, owner_id, name, format, table_kind, status, shape_version,
      groups_json, seed_json, final_refs_json, ranking, receipt_json, quote_json, escrow::text escrow, settled,
      revision::text revision, created_at, rules_version, capacity, clock_seconds, round_delay_ms
      FROM tournament.rooms ORDER BY room_id`);
  assert.equal(roomRows.length, rooms.size);
  for (const row of roomRows) {
    const room = rooms.get(row.room_id);
    assert.ok(room, 'unknown room ' + row.room_id);
    assert.equal(row.code, room.code);
    assert.equal(row.owner_id, room.owner);
    assert.equal(row.name, room.name);
    assert.equal(row.status, room.status);
    assert.equal(row.shape_version, room.version);
    assert.equal(Number(row.revision), room.revision);
    assert.equal(iso(row.created_at), new Date(room.created).toISOString());
    assert.equal(row.rules_version, room.rulesVersion);
    assert.equal(row.capacity, room.capacity);
    assert.equal(row.clock_seconds, room.clock);
    assert.equal(row.round_delay_ms, room.roundDelay);
    assert.ok(sameJson(row.groups_json, room.groups));
    assert.ok(sameJson(row.seed_json, room.seed === undefined ? null : room.seed));
    assert.ok(sameJson(row.final_refs_json, room.finalRefs === undefined ? null : room.finalRefs));
    assert.ok(sameJson(row.receipt_json, room.receipt === undefined ? null : room.receipt));
    assert.ok(sameJson(row.quote_json, room.quote === undefined ? null : room.quote));
    assert.deepEqual(row.ranking, room.ranking === undefined || room.ranking === null ? [] : room.ranking);
    assert.equal(Number(row.escrow), room.escrow === undefined ? 0 : room.escrow);
    assert.equal(row.settled, room.settled === true);
  }

  /* room_players: every source player at its own array index, soft membership, no joined_at */
  const players = await q('SELECT room_id, actor_id, name, ready, withdrawn, joined_at, ordinal FROM tournament.room_players ORDER BY room_id, ordinal');
  let expectedPlayers = 0;
  for (const room of model.rooms) expectedPlayers += room.parsed.players.length;
  assert.equal(players.length, expectedPlayers);
  for (const row of players) {
    const player = rooms.get(row.room_id).players[row.ordinal];
    assert.ok(player, 'no source player at ordinal ' + row.ordinal);
    assert.equal(row.actor_id, player.id);
    assert.equal(row.name, player.name);
    assert.equal(row.ready, player.ready === true);
    assert.equal(row.withdrawn, player.withdrawn === true);
    assert.equal(row.joined_at, null);
  }

  const fixtures = await q('SELECT room_id, fixture_id, round, "ready", players, slots_json, mini_json, status, winner, attempt, banks_json FROM tournament.fixtures ORDER BY room_id, fixture_id');
  let expectedFixtures = 0;
  for (const room of model.rooms) expectedFixtures += room.parsed.fixtures.length;
  assert.equal(fixtures.length, expectedFixtures);
  for (const row of fixtures) {
    const fixture = rooms.get(row.room_id).fixtures.find((candidate) => String(candidate.id) === row.fixture_id);
    assert.ok(fixture, 'unknown fixture ' + row.fixture_id);
    assert.equal(row.status, fixture.status);
    assert.equal(row.round, fixture.round === undefined ? null : fixture.round);
    assert.equal(row.winner, fixture.winner === undefined ? null : fixture.winner);
    assert.equal(row.attempt, fixture.attempt === undefined ? null : fixture.attempt);
    assert.ok(sameJson(row.slots_json, fixture.slots));
    assert.deepEqual(row.players, fixture.players === undefined || fixture.players === null ? [] : fixture.players);
    assert.deepEqual(row.ready, fixture.ready === undefined ? [] : fixture.ready);
    assert.ok(sameJson(row.mini_json, fixture.mini === undefined ? null : fixture.mini));
    assert.ok(sameJson(row.banks_json, fixture.banks === undefined ? null : fixture.banks));
  }

  /* economy per-account tables */
  const daily = await q('SELECT actor_id, "day"::text AS day, seconds::text seconds, finished, boards, claimed FROM economy.daily_progress ORDER BY actor_id, "day"');
  let expectedDaily = 0;
  for (const [, account] of model.state.parsed.accounts) expectedDaily += Object.keys(account.daily || {}).length;
  assert.equal(daily.length, expectedDaily);
  for (const row of daily) {
    const bucket = accounts.get(row.actor_id).daily[row.day];
    assert.ok(bucket, 'unknown daily bucket ' + row.actor_id + '/' + row.day);
    assert.equal(Number(row.seconds), bucket.seconds);
    assert.equal(row.finished, bucket.finished);
    assert.equal(row.boards, bucket.boards);
    assert.deepEqual(row.claimed, bucket.claimed || []);
  }

  const occupancy = await q('SELECT actor_id, kind, ref_id FROM core.actor_occupancy ORDER BY actor_id');
  for (const row of occupancy) {
    const active = accounts.get(row.actor_id).activeMatch;
    assert.ok(active, 'occupancy for an account with no activeMatch');
    if (active.startsWith('tournament:')) {
      assert.equal(row.kind, 'tournament');
      assert.equal(row.ref_id, active.slice('tournament:'.length));
    } else {
      assert.equal(row.kind, 'match');
      assert.equal(row.ref_id, active);
    }
  }

  const social = await q('SELECT actor_a, actor_b FROM social.friendships ORDER BY actor_a, actor_b');
  const expectedFriends = new Set();
  for (const [, account] of model.state.parsed.accounts) {
    for (const friend of account.friends || []) {
      const pair = [String(account.id), String(friend)].sort();
      expectedFriends.add(pair.join('|'));
    }
  }
  assert.equal(social.length, expectedFriends.size);
  for (const row of social) assert.ok(expectedFriends.has(row.actor_a + '|' + row.actor_b));

  /* monetization + cosmetics */
  const owned = await q('SELECT actor_id, item FROM cosmetics.owned_items ORDER BY actor_id, item');
  let expectedOwned = 0;
  for (const [, account] of model.state.parsed.accounts) expectedOwned += (account.owned || []).length;
  assert.equal(owned.length, expectedOwned);

  const redeemed = await q('SELECT actor_id, frame FROM monetization.redeemed_frames ORDER BY actor_id, frame');
  let expectedRedeemed = 0;
  for (const [, account] of model.state.parsed.accounts) expectedRedeemed += ((account.monetization || {}).redeemed || []).length;
  assert.equal(redeemed.length, expectedRedeemed);

  const credits = await q('SELECT actor_id, credit_balance::text credits, equipped_frame FROM monetization.credits ORDER BY actor_id');
  for (const row of credits) {
    const root = accounts.get(row.actor_id).monetization;
    assert.equal(Number(row.credits), root.credits);
    assert.equal(row.equipped_frame, root.equipped === undefined ? null : root.equipped);
  }

  const events = await q('SELECT event_id::text, actor_id, kind, at, value::text FROM monetization.reward_events ORDER BY event_id::bigint');
  const sourceEvents = model.tables.v35_events.rows.map((row) => row.values);
  assert.equal(events.length, sourceEvents.length);
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(Number(events[index].event_id), sourceEvents[index].id);
    assert.equal(events[index].actor_id, sourceEvents[index].actor);
    assert.equal(events[index].kind, sourceEvents[index].kind);
    assert.equal(iso(events[index].at), new Date(sourceEvents[index].at).toISOString());
    assert.equal(Number(events[index].value), sourceEvents[index].value);
  }

  /* singletons and rate buckets */
  const burns = await q('SELECT coins::text, crowns::text FROM economy.system_burns');
  assert.equal(Number(burns[0].coins), model.state.parsed.burned.coins);
  assert.equal(Number(burns[0].crowns), model.state.parsed.burned.crowns);
  const league = await q('SELECT week::text FROM season.league_week');
  assert.equal(league[0].week, model.state.parsed.leagueWeek);

  const buckets = await q('SELECT bucket_id, hits::text FROM ops.rate_buckets ORDER BY bucket_id');
  assert.equal(buckets.length, model.tables.community_limits.count + model.tables.v4_limits.count);
  const budget = buckets.find((row) => row.bucket_id === 'mail-budget:2026-10-08');
  assert.ok(budget, 'the durable mail budget row must be migrated verbatim');
  assert.equal(Number(budget.hits), 12);

  /* audit chain + profile archive */
  const audits = await q('SELECT audit_id, prev_hash, entry_hash, at FROM audit.operator_audit ORDER BY audit_id');
  for (const row of audits) {
    const source = model.tables.v41_operator_audit.rows.find((entry) => entry.values.id === row.audit_id).values;
    assert.equal(row.prev_hash, source.prev_hash);
    assert.equal(row.entry_hash, source.entry_hash);
    assert.equal(iso(row.at), new Date(source.at).toISOString());
  }
  const saves = await q('SELECT actor_id, revision::text, payload_text, updated_at FROM profile.profile_saves ORDER BY actor_id');
  for (const row of saves) {
    const source = model.tables.profile_saves.rows.find((entry) => entry.values.actor === row.actor_id).values;
    assert.equal(row.payload_text, source.payload, 'payload_text must be the exact original source string');
    assert.equal(Number(row.revision), source.revision);
    assert.equal(iso(row.updated_at), new Date(source.updated).toISOString());
  }

  /* monetization permanence: receipts, bindings, revocations, tickets, store state */
  const receipts = await q('SELECT store, transaction_id, actor_id, product_id, crowns::text, refunded, purchased_at FROM monetization.receipts ORDER BY store, transaction_id');
  assert.equal(receipts.length, model.state.parsed.receipts.length);
  for (const [key, source] of model.state.parsed.receipts) {
    const cut = key.indexOf(':');
    const row = receipts.find((candidate) => candidate.store === key.slice(0, cut) && candidate.transaction_id === key.slice(cut + 1));
    assert.ok(row, 'missing receipt ' + key);
    assert.equal(row.actor_id, source.actor);
    assert.equal(row.product_id, source.productId);
    assert.equal(Number(row.crowns), source.crowns);
    assert.equal(row.refunded, source.refunded === true);
    assert.equal(iso(row.purchased_at), new Date(source.at).toISOString());
  }

  const bindings = await q('SELECT actor_id, google_id, apple_token, created_at FROM monetization.store_bindings ORDER BY actor_id');
  assert.equal(bindings.length, model.tables.v41_store_bindings.count);
  for (const row of bindings) {
    const source = model.tables.v41_store_bindings.rows.find((entry) => entry.values.actor === row.actor_id).values;
    assert.equal(row.google_id, source.google_id, 'a permanent provider id is copied byte-for-byte');
    assert.equal(row.apple_token, source.apple_token);
    assert.equal(iso(row.created_at), new Date(source.created).toISOString());
  }

  const revocations = await q('SELECT store, transaction_id, product_id, reason FROM monetization.store_revocations ORDER BY store, transaction_id');
  assert.equal(revocations.length, model.tables.v41_store_revocations.count);

  const tickets = await q('SELECT ticket_id, actor_id, kind, issued_at, expires_at, day::text AS day, settled, transaction_id FROM monetization.reward_tickets ORDER BY ticket_id');
  assert.equal(tickets.length, model.tables.v35_tickets.count);
  for (const row of tickets) {
    const source = model.tables.v35_tickets.rows.find((entry) => entry.values.id === row.ticket_id).values;
    assert.equal(row.actor_id, source.actor);
    assert.equal(row.kind, source.kind);
    assert.equal(iso(row.issued_at), new Date(source.issued).toISOString());
    assert.equal(iso(row.expires_at), new Date(source.expires).toISOString());
    assert.equal(row.day, source.day);
    assert.equal(row.settled, source.settled === 1);
    assert.equal(row.transaction_id, source.transaction_id);
  }

  const contexts = await q('SELECT ticket_id, platform, ad_unit FROM monetization.ad_ticket_context ORDER BY ticket_id');
  assert.equal(contexts.length, model.tables.v41_ad_ticket_context.count);

  const finalize = await q('SELECT store, transaction_id, product_id, kind, state, attempts FROM monetization.store_finalize ORDER BY store, transaction_id');
  assert.equal(finalize.length, model.tables.v41_store_finalize.count);
  for (const row of finalize) {
    const source = model.tables.v41_store_finalize.rows.find((entry) => entry.values.transaction_id === row.transaction_id).values;
    assert.equal(row.state, source.state);
    assert.equal(row.attempts, source.attempts);
  }

  /* economy operations + wallet ledger, exact key text */
  const operations = await q('SELECT actor_id, "key", fingerprint, result FROM economy.wallet_operations ORDER BY actor_id, "key"');
  let expectedOperations = 0;
  for (const [, account] of model.state.parsed.accounts) expectedOperations += Object.keys(account.operations || {}).length;
  assert.equal(operations.length, expectedOperations);
  for (const row of operations) {
    const source = accounts.get(row.actor_id).operations[row.key];
    assert.ok(source, 'unknown wallet operation ' + row.actor_id + '/' + row.key);
    assert.equal(row.fingerprint, source.fingerprint, 'the conversion quote text is stored verbatim');
    /* `result` is a TEXT column with an `IS JSON` gate, so it round-trips as text. */
    assert.ok(sameJson(JSON.parse(row.result), source.result));
  }

  const walletLedger = await q('SELECT actor_id, entry_id, currency, amount::text, reason, at FROM economy.wallet_ledger_entries ORDER BY actor_id, entry_id');
  let expectedLedger = 0;
  for (const [, account] of model.state.parsed.accounts) expectedLedger += (account.ledger || []).length;
  assert.equal(walletLedger.length, expectedLedger);
  for (const row of walletLedger) {
    const source = accounts.get(row.actor_id).ledger.find((entry) => entry.id === row.entry_id);
    assert.ok(source, 'unknown wallet ledger entry ' + row.entry_id);
    assert.equal(row.currency, source.currency);
    assert.equal(Number(row.amount), source.amount);
    assert.equal(iso(row.at), new Date(source.at).toISOString());
  }

  /* command outcomes: the canonical JSON key text is stored exactly once */
  const economyOutcomes = await q('SELECT actor_id, "key", fingerprint, response FROM economy.command_outcomes ORDER BY actor_id, "key"');
  assert.equal(economyOutcomes.length, model.tables.commands.count);
  for (const row of economyOutcomes) {
    /* `key` holds the canonical JSON string text of the logical key, stored exactly once. */
    const logical = JSON.parse(row.key);
    const source = model.tables.commands.rows.find((entry) => entry.values.id === JSON.stringify([row.actor_id, logical]));
    assert.ok(source, 'unknown economy command key ' + row.key);
    assert.equal(source.values.actor, row.actor_id, 'the decoded actor must agree with the actor column');
    assert.equal(row.fingerprint, source.values.fingerprint);
    assert.equal(row.response, source.values.response);
  }

  const moveOutcomeCounts = await q('SELECT sum(n)::int AS n FROM (SELECT count(*)::int n FROM match.move_outcomes GROUP BY match_id) s');
  let expectedMoves = 0;
  for (const [, match] of model.state.parsed.matches) expectedMoves += match.commands.length;
  assert.equal(moveOutcomeCounts[0].n, expectedMoves, 'move commands are imported even at 0 rows for FINISHED settled matches');

  /* privacy / support / audit / runtime / ops */
  const reports = await q('SELECT count(*)::int AS n FROM privacy.reports');
  assert.equal(reports[0].n, model.tables.v41_reports.count);
  const requests = await q('SELECT count(*)::int AS n FROM privacy.requests');
  assert.equal(requests[0].n, model.tables.v41_privacy_requests.count);
  const deletionReceipts = await q('SELECT count(*)::int AS n FROM privacy.deletion_receipts');
  assert.equal(deletionReceipts[0].n, model.tables.v41_deletion_receipts.count);
  const support = await q('SELECT count(*)::int AS n FROM support.events');
  assert.equal(support[0].n, model.tables.v41_support_events.count);
  const runtimeState = await q('SELECT key, value FROM runtime.state ORDER BY key');
  assert.equal(runtimeState.length, model.tables.v4_runtime.count);
  const controls = await q('SELECT maintenance FROM runtime.controls');
  assert.equal(controls[0].maintenance, model.tables.v4_controls.rows[0].values.maintenance === 1,
    'maintenance is imported inert, never auto-enabled');

  /* snapshots and weekly payouts */
  const snapshots = await q('SELECT day::text AS day, actor_id, tier FROM season.day_snapshots ORDER BY day, actor_id');
  let expectedSnapshots = 0;
  for (const [, map] of model.state.parsed.snapshots) expectedSnapshots += Object.keys(map).length;
  assert.equal(snapshots.length, expectedSnapshots);
  const payouts = await q('SELECT payout_id, week::text AS week, actor_id, amount::text AS amount, tier, eligible, days FROM season.weekly_payouts ORDER BY payout_id');
  assert.equal(payouts.length, model.state.parsed.weeklyPaid.length);
  for (const [key, source] of model.state.parsed.weeklyPaid) {
    const row = payouts.find((candidate) => candidate.payout_id === source.id);
    assert.ok(row, 'missing weekly payout ' + key);
    assert.equal(row.week, source.week);
    assert.equal(row.actor_id, source.account);
    assert.equal(Number(row.amount), source.amount);
    assert.equal(row.tier, source.tier);
    assert.equal(row.eligible, source.eligible === true);
    assert.equal(row.days, source.days);
  }

  /* profiles and identity rows are the verbatim source values */
  const identities = await q('SELECT provider, subject, actor_id, created_at FROM identity.identities ORDER BY provider, subject');
  assert.equal(identities.length, model.tables.identities.count);
  for (const row of identities) {
    const source = model.tables.identities.rows.find((entry) => entry.values.provider === row.provider && entry.values.subject === row.subject).values;
    assert.equal(row.actor_id, source.actor);
    assert.equal(iso(row.created_at), new Date(source.created).toISOString());
  }
  const credentials = await q('SELECT email, actor_id, salt, password_hash, created_at, verified_at FROM identity.email_credentials ORDER BY email');
  assert.equal(credentials.length, model.tables.email_credentials.count);
  for (const row of credentials) {
    const source = model.tables.email_credentials.rows.find((entry) => entry.values.email === row.email).values;
    assert.equal(row.salt, source.salt);
    assert.equal(row.password_hash, source.password_hash, 'the password hash is copied byte-for-byte');
    assert.equal(iso(row.verified_at), source.verified_at === null ? null : new Date(source.verified_at).toISOString());
  }

  /* outbox: the recorded drained policy leaves the sealed ciphertext only while queued/sending */
  const outbox = await q('SELECT outbox_id, state, payload IS NULL AS drained FROM ops.outbox ORDER BY outbox_id');
  assert.equal(outbox.length, model.tables.v4_outbox.count);
  for (const row of outbox) {
    const source = model.tables.v4_outbox.rows.find((entry) => entry.values.id === row.outbox_id).values;
    if (source.state !== 'queued' && source.state !== 'sending') assert.equal(row.drained, true);
    else assert.equal(row.drained, source.payload === null);
  }

  /* Every durable family that actually received a row appears in the ledger. A family with zero
   * source rows (here: economy.actor_legacy_extra) legitimately has no ledger entry and still gets
   * its batch and coverage bookkeeping. */
  const ledgerTables = await q(
    `SELECT DISTINCT l.target_table AS name FROM v5_migration.row_ledger l
      WHERE l.run_id = (SELECT run_id FROM v5_migration.run ORDER BY started_at DESC, run_id DESC LIMIT 1)`);
  const covered = new Set(ledgerTables.map((row) => row.name));
  const families = [...new Set([...COUNTED_TABLES, ...KIND_ORDER.map((kind) => kind.split('#')[0])])];
  for (const table of families) {
    const counted = (await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
    if (counted > 0) assert.ok(covered.has(table), 'a non-empty family missing from the ledger: ' + table);
  }
  const batches = await q('SELECT count(DISTINCT kind)::int AS n FROM v5_migration.batch');
  assert.equal(batches[0].n, KIND_ORDER.length, 'every kind must have at least one batch');
  /* coverage: every source locator classified, none unclassified */
  const coverage = await q(
    `SELECT classification, count(*)::int AS n FROM v5_migration.coverage
      WHERE run_id = (SELECT run_id FROM v5_migration.run ORDER BY started_at DESC, run_id DESC LIMIT 1)
      GROUP BY classification`);
  const byClass = Object.fromEntries(coverage.map((row) => [row.classification, row.n]));
  assert.equal(byClass.unclassified === undefined ? 0 : byClass.unclassified, 0, 'an unclassified locator must fail the run');
  assert.equal(byClass.V > 0, true);
  assert.equal(byClass.E > 0, true);
}
