/* V5 P02 (V5-02-02/03) - migration set + runner consumer-visible invariants.
 *
 * Harness contract (parent-frozen, local://v5-p02-pg-harness-contract.md):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: run against a caller-owned
 *     synthetic PG16 cluster (loopback host + non-production control DB only). The URL is used
 *     ONLY to CREATE/DROP this suite's tracked v5_test_* databases; the control database is
 *     never mutated, truncated or dropped.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir and
 *     random loopback port; Docker (postgres:16, uniquely named, random published port, tried
 *     once) is the fallback when no binary exists.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 * Run under --test-concurrency=1 when sharing a service; within-suite parallelism uses real
 * separate connections. Full URLs, credentials and row data are never printed.
 *
 * Covered boundaries: checksummed manifest integrity and replay conflict on changed content,
 * pg_advisory_lock serialization, clean create + idempotent re-run, --verify catalog
 * conformance incl. drift detection, interrupted mid-file batch atomic rollback and clean
 * resume, per-role least-privilege denials through EXACT LOGIN identities (never SET ROLE),
 * URI/target/confirmation refusal boundaries, and fenced-lease/dedupe/escrow constraint
 * behavior from the P08-P10 integration.
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
const MIGRATIONS_DIR = path.join(ROOT, 'packages', 'migrations');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const { ADVISORY_LOCK_KEY, migrationChecksum, classifyTarget, parseAndGuardUrl } = require(RUNNER);
const pg = require('pg');
/* Chain length is read from the committed manifest (single source of truth): counts below
   derive from it instead of hard-coding a number that must be re-pinned every migration. */
const CHAIN_LENGTH = require(path.join(MIGRATIONS_DIR, 'manifest.json')).migrations.length;

const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime'];
const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;

/* ---------------------------------------------------------------- backend */

function whichBinary() {
  const dirs = ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) &&
          execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
    } catch { /* next */ }
  }
  try {
    const found = spawnSync('which', ['initdb'], { encoding: 'utf8' });
    if (found.status === 0 && execFileSync(found.stdout.trim(), ['--version'], { encoding: 'utf8' }).includes(' 16.')) {
      return path.dirname(found.stdout.trim());
    }
  } catch { /* not on PATH */ }
  return null;
}

function dockerAvailableOnce() {
  try { execFileSync('docker', ['info', '-f', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); return true; }
  catch { return false; } // daemon failure is reported once, never retried in a loop
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

let backend = null; // {kind, adminUrl, stop?}
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
    backend = { kind: 'external', adminUrl: external };
    return backend;
  }
  const bin = whichBinary();
  if (bin) {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-test-pg-${PID}-`));
    execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'],
      { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
    execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
      '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
    const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 60; i += 1) {
      try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { stdio: 'ignore', timeout: 10000 }); break; }
      catch { if (i === 59) { backendError = 'binary PG16 never became ready'; throw new Error(backendError); } execFileSync('sleep', ['1']); }
    }
    backend = { kind: 'binary', adminUrl, stop: () => {
      try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'i', 'stop'], { stdio: 'ignore', timeout: 30000 }); } catch { /* gone */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    } };
    return backend;
  }
  if (dockerAvailableOnce()) {
    const name = `v5-mig-${PID}-${SUFFIX}`; // uniquely named; removed with its volume in after()
    try { execFileSync('docker', ['image', 'inspect', 'postgres:16'], { stdio: 'ignore', timeout: 15000 }); }
    catch { execFileSync('docker', ['pull', 'postgres:16'], { stdio: 'ignore', timeout: 900000 }); }
    execFileSync('docker', ['run', '-d', '--name', name, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p', '127.0.0.1::5432', 'postgres:16', 'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'], { stdio: 'ignore', timeout: 300000 });
    let port = 0;
    for (let i = 0; i < 90; i += 1) {
      try { port = Number(execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0].split(':').pop()); if (port) break; } catch { /* pending */ }
      execFileSync('sleep', ['1']);
    }
    if (!port) { backendError = 'container port never mapped'; throw new Error(backendError); }
    backend = { kind: 'container', adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
      stop: () => { try { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 60000 }); } catch { /* gone */ } } };
    return backend;
  }
  backendError = 'no PG16 backend available (no V5_PG_URL, no postgresql@16 binary, no docker daemon)';
  throw new Error(backendError);
}

const createdDatabases = new Set();
async function connectAdmin(database) {
  const url = new URL(backend.adminUrl);
  const c = new pg.Client({
    host: url.hostname, port: Number(url.port || 5432),
    user: url.username ? decodeURIComponent(url.username) : 'postgres',
    password: url.username ? decodeURIComponent(url.password || '') : undefined,
    database: database || decodeURIComponent(url.pathname.replace(/^\//, '')),
  });
  await c.connect();
  return c;
}

test.after(async () => {
  if (!backend) return;
  for (const name of [...createdDatabases]) {
    try { const c = await connectAdmin(); await c.query(`DROP DATABASE IF EXISTS ${ident(name)}`); await c.end(); }
    catch { /* best effort; only THIS suite's tracked names */ }
  }
  if (backend.stop) backend.stop();
});

function ident(name) { return `"${name.replace(/"/g, '""')}"`; }
function trackedName(family) { return `v5_test_migrations_${family}_${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'); }

async function backendGate(t) {
  try { await ensureBackend(); return false; }
  catch (err) {
    if (process.env.V5_PG_REQUIRED === '1') throw err;
    t.skip(err.message);
    return true;
  }
}

async function freshDb(family) {
  const name = trackedName(family);
  const c = await connectAdmin();
  try { await c.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await c.end(); }
  return name;
}
async function dropTracked(name) {
  if (!createdDatabases.has(name)) return;
  const c = await connectAdmin();
  try { await c.query(`DROP DATABASE IF EXISTS ${ident(name)}`); createdDatabases.delete(name); } finally { await c.end(); }
}

function dbUrl(database) {
  const url = new URL(backend.adminUrl);
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

function runMigrate(args, env = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 240000,
    env: { ...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', ...env },
  });
  let json = null;
  const last = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  try { json = last ? JSON.parse(last) : null; } catch { /* human mode */ }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}
function execArgs(database, extra = []) { return ['--execute', '--json', '--database-url', dbUrl(database), ...extra]; }
function confirmEnv(database) { return { MIGRATE_CONFIRM: database, V5_TARGET: 'test' }; }

async function exec1(client, statements) {
  for (const stmt of statements) await client.query(stmt);
}

async function firstFullMigration(t, database) {
  const r = runMigrate(execArgs(database), confirmEnv(database));
  assert.equal(r.status, 0, `execute failed: ${r.stdout}${r.stderr}`);
  assert.equal(r.json.code, 'OK');
  assert.equal(r.json.appliedCount, CHAIN_LENGTH);
  // binding posture is disclosed (never claimed) even on synthetic loopback clusters
  assert.equal(typeof r.json.channelBinding.enableChannelBinding, 'boolean');
  const c = await connectAdmin(database);
  try {
    const led = await c.query('SELECT count(*)::int n FROM meta.migrations');
    assert.equal(led.rows[0].n, CHAIN_LENGTH);
  } finally { await c.end(); }
  return r;
}

/* The owned synthetic harness enables the EXACT runtime LOGIN identities (contract); the
   migration chain itself keeps them NOLOGIN. Guards connect as those identities directly and
   assert current_user = session_user = the exact role - never SET ROLE between runtimes. */
let loginsEnabled = false;
async function enableRuntimeLogins() {
  if (loginsEnabled) return;
  const c = await connectAdmin();
  try { for (const role of RUNTIME_ROLES) await c.query(`ALTER ROLE ${ident(role)} LOGIN`); }
  finally { await c.end(); }
  loginsEnabled = true;
}

async function asRole(database, role, sql) {
  const url = new URL(backend.adminUrl);
  const c = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), user: role,
    database, password: url.username ? decodeURIComponent(url.password || '') : undefined });
  await c.connect();
  try {
    const who = await c.query('SELECT current_user AS cu, session_user AS su');
    if (who.rows[0].cu !== role || who.rows[0].su !== role) {
      throw new Error(`identity guard failed for ${role}: ${JSON.stringify(who.rows[0])}`);
    }
    try { const r = await c.query(sql); return { ok: true, rowCount: r.rowCount, rows: r.rows }; }
    catch (err) { return { ok: false, pgError: err.code || null, message: String(err.message || '') }; }
  } finally { await c.end(); }
}
async function expectDenied(t, database, role, sql, why) {
  const r = await asRole(database, role, sql);
  assert.equal(r.ok, false, `${why}: statement unexpectedly succeeded`);
  assert.match(String(r.message), /permission denied|must be owner of/i, `${why}: unexpected error ${r.message}`);
}
async function expectAllowed(database, role, sql, why) {
  const r = await asRole(database, role, sql);
  assert.equal(r.ok, true, `${why}: ${r.message}`);
  return r;
}

/* LOCK TABLE needs a real transaction block (25P01 otherwise); this mirrors the exact
   session shape stock pg_dump uses for its ACCESS SHARE lock probe. */
async function expectAllowedInTx(database, role, statements, why) {
  const url = new URL(backend.adminUrl);
  const c = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), user: role,
    database, password: url.username ? decodeURIComponent(url.password || '') : undefined });
  let err = null;
  try {
    await c.connect();
    await c.query('BEGIN');
    for (const s of statements) await c.query(s);
    await c.query('COMMIT');
  } catch (e) { err = e; try { await c.query('ROLLBACK'); } catch { /* aborted */ } }
  finally { try { await c.end(); } catch { /* closed */ } }
  assert.ok(!err, `${why}: ${err && err.message}`);
}

/* ------------------------------------------------------------------ lifecycle */

test('clean create from zero; idempotent re-run; ledger chain, singletons and verify all pass', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('lifecycle');
  try {
    await firstFullMigration(t, database);
    const c = await connectAdmin(database);
    try {
      const chain = await c.query('SELECT bool_and(id = expected) ok FROM (SELECT id, row_number() OVER (ORDER BY id) expected FROM meta.migrations) q');
      assert.equal(chain.rows[0].ok, true);
      const meta = await c.query("SELECT count(*)::int n FROM meta.migrations WHERE schema_version = id AND applied_at IS NOT NULL AND runner LIKE 'scripts/v5/migrate.js%'");
      assert.equal(meta.rows[0].n, CHAIN_LENGTH);
      const seeded = await c.query('SELECT (SELECT count(*) FROM runtime.controls) + (SELECT count(*) FROM economy.system_burns) + (SELECT count(*) FROM season.league_week) n');
      assert.equal(Number(seeded.rows[0].n), 3);
    } finally { await c.end(); }
    const again = runMigrate(execArgs(database), confirmEnv(database));
    assert.equal(again.status, 0);
    assert.equal(again.json.appliedCount, 0); // idempotent no-op
    const v = runMigrate(['--verify', '--json', '--database-url', dbUrl(database)]);
    assert.equal(v.status, 0, JSON.stringify(v.json && v.json.failures));
    assert.equal(v.json.ok, true);
    const bad = runMigrate(execArgs(database), { MIGRATE_CONFIRM: 'wrong-name', V5_TARGET: 'test' });
    assert.equal(bad.status, 2);
    assert.equal(bad.json.code, 'CONFIRMATION_REQUIRED');
  } finally { await dropTracked(database); }
});

test('replay conflict: edited migration content aborts even with a self-consistent scratch manifest', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('tamper');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-mig-tamper-'));
  try {
    await firstFullMigration(t, database);
    fs.cpSync(MIGRATIONS_DIR, scratch, { recursive: true });
    // checksum rule is byte-identical to the legacy server/production/migrations.js rule
    const sql = fs.readFileSync(path.join(scratch, 'migrations', '0003_meta_ledger.sql'));
    assert.equal(migrationChecksum('0003_meta_ledger', sql),
      crypto.createHash('sha256').update('0003_meta_ledger' + '\n' + sql).digest('hex'));
    fs.appendFileSync(path.join(scratch, 'migrations', '0010_economy_history.sql'), '\n-- sneaky drift\n');
    assert.equal(runMigrate(['--dry-run', '--json', '--migrations-dir', scratch]).status, 4); // manifest integrity
    runMigrate(['--make-manifest', '--json', '--migrations-dir', scratch]);                   // attacker self-consistency
    const r = runMigrate(['--execute', '--json', '--migrations-dir', scratch, '--database-url', dbUrl(database)], confirmEnv(database));
    assert.equal(r.status, 4);
    assert.equal(r.json.code, 'MIGRATION_CHECKSUM_MISMATCH');
    assert.match(JSON.stringify(r.json), /0010_economy_history/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); await dropTracked(database); }
});

test('advisory lock serialization: concurrent migrator exits MIGRATOR_BUSY and writes nothing', async (t) => {
  if (await backendGate(t)) return;

  if (await backendGate(t)) return;
  const database = await freshDb('lock');
  const holder = await connectAdmin(database);
  try {
    const held = await holder.query('SELECT pg_try_advisory_lock($1) AS ok', [String(ADVISORY_LOCK_KEY)]);
    assert.equal(held.rows[0].ok, true);
    const r = runMigrate(execArgs(database), confirmEnv(database));
    assert.equal(r.status, 3);
    assert.equal(r.json.code, 'MIGRATOR_BUSY');
    const reg = await holder.query("SELECT COALESCE(to_regclass('meta.migrations')::text, 'absent') t");
    assert.equal(reg.rows[0].t, 'absent'); // busy path never bootstraps/writes
    await holder.query('SELECT pg_advisory_unlock($1)', [String(ADVISORY_LOCK_KEY)]);
    const after = runMigrate(execArgs(database), confirmEnv(database));
    assert.equal(after.status, 0);
    assert.equal(after.json.appliedCount, CHAIN_LENGTH);
  } finally { await holder.end().catch(() => {}); await dropTracked(database); }
});

test('source-fidelity invariants after SourceSchemaReview corrections (payload_text, fingerprints, caps)', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('fidelity');
  try {
    await firstFullMigration(t, database);
    const c = await connectAdmin(database);
    try {
      await execScript(c, `SET ROLE v5_owner;
        INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_fid', now());
        INSERT INTO economy.wallets(actor_id) VALUES ('u_fid')`);
      // 0033 cutover: payload_text is the ONLY authoritative opaque document (the JSONB
      // payload cache column is retired; DB enforces raw root-object + raw byte cap only).
      const baseDoc = '{"version":"3.2","records":[]}';
      // SET ROLE and the data statement are SEPARATE round-trips: node-pg refuses multiple
      // commands inside one extended-protocol (parameterized) statement (native 42601 observed).
      await c.query('SET ROLE v5_owner');
      await c.query("INSERT INTO profile.profile_saves(actor_id, revision, payload_text, updated_at) VALUES ('u_fid', 1, $1, now())", [baseDoc]);
      const baseRt = await c.query("SELECT payload_text FROM profile.profile_saves WHERE actor_id='u_fid'");
      assert.equal(baseRt.rows[0].payload_text, baseDoc, 'opaque document round-trips byte-identical');
      let missingText = null;
      try { await c.query("SET ROLE v5_owner; INSERT INTO profile.profile_saves(actor_id, revision, updated_at) VALUES ('u_fid_nt', 2, now())"); } catch (e) { missingText = e; }
      assert.ok(missingText && /not-null|violates|null value/i.test(missingText.message), 'payload_text must be NOT NULL');
      // social fingerprint is 43-char base64url; a 64-hex digest is now REJECTED
      await c.query("SET ROLE v5_owner; INSERT INTO social.command_outcomes(actor_id, key, fingerprint, result) VALUES ('u_fid', 'k1', '7d7649e9a87cfb90be72fa1fb2312d786106bc5a90d', '{}')");
      let hexFp = null;
      try { await c.query("SET ROLE v5_owner; INSERT INTO social.command_outcomes(actor_id, key, fingerprint, result) VALUES ('u_fid', 'k2', '" + 'a'.repeat(64) + "', '{}')"); } catch (e) { hexFp = e; }
      assert.ok(hexFp && /violates check constraint/i.test(hexFp.message), '64-hex social fingerprint must violate the grammar CHECK');
      // wallet_operations fingerprint stores the verbatim JSON quote text (IS JSON), not a digest
      await c.query("SET ROLE v5_owner; INSERT INTO economy.wallet_operations(actor_id, key, fingerprint, result) VALUES ('u_fid', 'o1', '{\"from\":\"coins\",\"amount\":10}', '{\"ok\":true}')");
      let badFp = null;
      try { await c.query("SET ROLE v5_owner; INSERT INTO economy.wallet_operations(actor_id, key, fingerprint, result) VALUES ('u_fid', 'o2', 'not-json', '{}')"); } catch (e) { badFp = e; }
      assert.ok(badFp && /violates check constraint/i.test(badFp.message), 'non-JSON wallet_operations fingerprint must violate the CHECK');
      // season history has no 8-entry import cap
      await c.query("SET ROLE v5_owner; INSERT INTO economy.season_history(actor_id, seq, season_id, started_at) VALUES ('u_fid', 8, '2026-Q1', now())");
      // archived cosmetic ids are tolerated verbatim (policy stays in the domain)
      await c.query("SET ROLE v5_owner; INSERT INTO monetization.credits(actor_id, credit_balance, equipped_frame) VALUES ('u_fid', 0, 'aurora_frame')");
      // receipt_refunded is a normalized BIGINT refund fact, not boolean
      await c.query(`SET ROLE v5_owner; INSERT INTO match.matches(match_id, source, mode, terms_json, terms_hash, quote_json, pool, contribution_a, contribution_b, status, created_at, expires_at, state_json, receipt_refunded)
        VALUES ('m_fid', 'direct', 'direct', '{}', '${'b'.repeat(64)}', '{}', 0, 0, 0, 'FINISHED', now(), now(), '{}', 24)`);
      const rr = await c.query("SELECT receipt_refunded FROM match.matches WHERE match_id='m_fid'");
      assert.equal(String(rr.rows[0].receipt_refunded), '24');
      const shape = await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema='match' AND table_name='matches' AND column_name='receipt_refunded'");
      assert.equal(shape.rows[0].data_type, 'bigint');
      const ra = await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema='match' AND table_name='matches' AND column_name='risk_actors'");
      assert.equal(ra.rows[0].data_type, 'jsonb');
      // 0025 (1): ALL FIVE runtime identities hold neither CREATE nor TEMPORARY on the
      // database - no hidden DDL channel via temp tables, backup_reader included (parent
      // ruling: the backup path is strictly read-only; pg_dump needs no database TEMP).
      await enableRuntimeLogins();
      for (const role of ['api_runtime', 'core_runtime', 'worker_runtime', 'audit_runtime', 'backup_reader']) {
        await expectDenied(t, database, role, 'CREATE TEMP TABLE tmp_smuggle (n int)', `${role} temp DDL`);
      }
      // 0033 opaque-archive regressions: the source producer commits escaped-NUL and
      // unpaired-surrogate bytes EXACTLY (community-store.js save); the DB admits them via
      // IS JSON OBJECT (grammar-only, no jsonb materialization) and stores them byte-exact.
      const nulDoc = '{"version":"3.2","records":[],"note":"a\\u0000b"}';
      const surrDoc = '{"version":"3.2","records":[],"note":"\\ud800"}';
      // unknown extensions and whitespace are lexical: stored verbatim, never canonicalized.
      const extDoc = '{ "version" : "3.2" , "records" : [ 1 , 2 ] , "futureExtension" : { "flag" : true } }';
      await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_nul', nulDoc]);
      await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_surr', surrDoc]);
      await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_ext', extDoc]);
      const byteExact = await c.query("SELECT payload_text FROM profile.profile_saves WHERE actor_id IN ('u_fid_ext','u_fid_nul','u_fid_surr') ORDER BY actor_id");
      assert.deepEqual(byteExact.rows.map((r) => r.payload_text), [extDoc, nulDoc, surrDoc], 'NUL/surrogate/extension bytes stored EXACT');
      let malformed = null;
      try { await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_bad', 'not json']); } catch (e) { malformed = e; }
      assert.ok(malformed && /profile_saves_payload_text_is_json_object_ck/.test(malformed.message), 'malformed payload_text must raise 23514');
      let arr = null;
      try { await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_arr', '[1,2]']); } catch (e) { arr = e; }
      assert.ok(arr && /profile_saves_payload_text_is_json_object_ck/.test(arr.message), 'non-object root must raise 23514');
      const members = Array.from({ length: 23000 }, (_, i) => `"k${i}":1`).join(',');
      const bigText = `{"version":"3.2","records":[1,2,3],${members}}`;
      assert.ok(Buffer.byteLength(bigText) <= 262144, 'fixture source stays within the RAW byte bound');
      await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_big', bigText]);
      const oversize = '{"version":"3.2","records":[],"pad":"' + 'y'.repeat(262200) + '"}';
      assert.ok(Buffer.byteLength(oversize) > 262144, 'oversized fixture exceeds the raw bound');
      let tooBig = null;
      try { await c.query('INSERT INTO profile.profile_saves(actor_id,revision,payload_text,updated_at) VALUES ($1,1,$2,now())', ['u_fid_oversize', oversize]); } catch (e) { tooBig = e; }
      assert.ok(tooBig && /profile_saves_payload_text_size_ck/.test(tooBig.message), 'raw bytes past 262144 must raise 23514');
      const gone = await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='profile' AND table_name='profile_saves' AND column_name='payload'");
      assert.equal(gone.rows[0].n, 0, 'the JSONB cache column is dead (0033 cutover)');
      // 0032 paid-wallet provenance (proven scenario-A: public buy + convert + paid
      // tournament reservation): raw UInt provenance persists EXACTLY; admission is the
      // INDEPENDENT safe-integer bound only. Parent's final numeric-admission contract:
      // NO cross-column ratio at rest (neither purchased<=free nor purchased<=free+reserved
      // is a proven invariant; the hydrate clamp is REPORT-only, not SQL storage admission).
      await c.query("SET ROLE v5_owner; INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_paid', now())");
      await expectAllowed(database, 'core_runtime', "INSERT INTO economy.wallets(actor_id, coins, purchased_coins, reserved_coins, crowns, purchased_crowns, reserved_crowns) VALUES ('u_paid', 800, 1000, 1200, 5, 5, 5)", 'scenario-A raw wallet accepted');
      const raw = await expectAllowed(database, 'core_runtime', "SELECT coins, purchased_coins, reserved_coins FROM economy.wallets WHERE actor_id='u_paid'", 'raw provenance preserved');
      assert.deepEqual([String(raw.rows[0].coins), String(raw.rows[0].purchased_coins), String(raw.rows[0].reserved_coins)], ['800', '1000', '1200'], 'the three source balances persist EXACTLY');
      for (const [col, ck] of [['purchased_coins', 'wallets_purchased_coins_bound_ck'], ['purchased_crowns', 'wallets_purchased_crowns_bound_ck']]) {
        const neg = await asRole(database, 'core_runtime', `UPDATE economy.wallets SET ${col} = -1 WHERE actor_id='u_paid'`);
        assert.equal(neg.ok, false, `${col} negative must be rejected`);
        assert.match(String(neg.message), new RegExp(ck));
        const over = await asRole(database, 'core_runtime', `UPDATE economy.wallets SET ${col} = 9007199254740992 WHERE actor_id='u_paid'`);
        assert.equal(over.ok, false, `${col} beyond MAX_SAFE_INTEGER must be rejected`);
        assert.match(String(over.message), new RegExp(ck));
        const edge = await expectAllowed(database, 'core_runtime', `UPDATE economy.wallets SET ${col} = 9007199254740991 WHERE actor_id='u_paid'`, `${col} safe-uint edge accepted`);
        assert.equal(edge.rowCount, 1);
      }
      // Cross-column ratio is NOT an at-rest admission rule: purchased far above the
      // free+reserved total must persist unclamped (conservative exact-source import).
      const atRest = await expectAllowed(database, 'core_runtime', "SELECT purchased_coins FROM economy.wallets WHERE actor_id='u_paid' AND purchased_coins > coins + reserved_coins", 'no cross-column ratio enforced at rest');
      assert.equal(atRest.rowCount, 1, 'purchased exceeding free+reserved persists, zero SQL clamp/repair');
    } finally { await c.end(); }
  } finally { await dropTracked(database); }
});

test('interrupted mid-file batch: injected failure rolls back atomically and resumes clean', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('interrupt');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-mig-interrupt-'));
  try {
    fs.cpSync(MIGRATIONS_DIR, scratch, { recursive: true });
    const broken = path.join(scratch, 'migrations', String(CHAIN_LENGTH + 1).padStart(4, '0') + '_injected_failure.sql');
    fs.writeFileSync(broken, 'CREATE TABLE audit.injected_probe (n INTEGER);\nINSERT INTO audit.injected_probe VALUES (1);\nSELECT 1/0;\n');
    runMigrate(['--make-manifest', '--json', '--migrations-dir', scratch]);
    const r = runMigrate(['--execute', '--json', '--migrations-dir', scratch, '--database-url', dbUrl(database)], confirmEnv(database));
    assert.equal(r.status, 5);
    assert.equal(r.json.code, 'MIGRATION_FAILED');
    const c = await connectAdmin(database);
    try {
      const led = await c.query('SELECT count(*)::int n FROM meta.migrations');
      assert.equal(led.rows[0].n, CHAIN_LENGTH); // ledger never saw the broken row
      const probe = await c.query("SELECT COALESCE(to_regclass('audit.injected_probe')::text, 'absent') t");
      assert.equal(probe.rows[0].t, 'absent'); // the whole failing file rolled back
    } finally { await c.end(); }
    fs.rmSync(broken);
    runMigrate(['--make-manifest', '--json', '--migrations-dir', scratch]);
    const resume = runMigrate(['--execute', '--json', '--migrations-dir', scratch, '--database-url', dbUrl(database)], confirmEnv(database));
    assert.equal(resume.status, 0);
    assert.equal(resume.json.appliedCount, 0);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); await dropTracked(database); }
});

/* ------------------------------------------------------------------ least privilege */

async function seedProbe(c) {
  await execScript(c, `SET ROLE v5_owner;
    INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_ci_probe', now());
    INSERT INTO economy.wallets(actor_id, coins, crowns) VALUES ('u_ci_probe', 100, 10)`);
}
async function execScript(client, script) {
  for (const stmt of script.split(';').map((s) => s.trim()).filter(Boolean)) await client.query(stmt);
}

test('least privilege through exact LOGIN identities: denials, appends and positive controls', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('roles');
  try {
    await firstFullMigration(t, database);
    await enableRuntimeLogins();
    const c = await connectAdmin(database);
    try { await seedProbe(c); } finally { await c.end(); }

    for (const role of RUNTIME_ROLES) {
      await expectDenied(t, database, role, `CREATE TABLE public.${role}_smuggled (n int)`, `${role} DDL`);
      await expectDenied(t, database, role, 'CREATE SCHEMA smuggled', `${role} create schema`);
    }
    // api_runtime: no economic/competitive writes; credential secrets unreadable.
    await expectDenied(t, database, 'api_runtime', "UPDATE economy.wallets SET coins = coins + 1000 WHERE actor_id = 'u_ci_probe'", 'api mint');
    await expectDenied(t, database, 'api_runtime', "UPDATE match.matches SET revision = 1 WHERE match_id = 'm1'", 'api matches');
    await expectDenied(t, database, 'api_runtime', "UPDATE monetization.receipts SET crowns = 9 WHERE transaction_id = 't1'", 'api receipts');
    await expectDenied(t, database, 'api_runtime', 'SELECT salt, password_hash FROM identity.email_credentials', 'api secrets');
    await expectDenied(t, database, 'api_runtime', 'SELECT code_hash FROM identity.email_challenges', 'api otp hash');
    await expectDenied(t, database, 'api_runtime', 'DELETE FROM economy.ledger', 'api ledger');
    // core_runtime: no credential export, no worker sweeps, ledger append-only, payouts permanent.
    await expectDenied(t, database, 'core_runtime', 'SELECT password_hash FROM identity.email_credentials', 'core export');
    await expectDenied(t, database, 'core_runtime', "UPDATE monetization.store_finalize SET state = 'done' WHERE transaction_id = 't1' AND store = 'google'", 'core finalize sweep');
    await expectDenied(t, database, 'core_runtime', "UPDATE monetization.store_notifications SET state = 'applied' WHERE notification_id = 'n1' AND store = 'google'", 'core notification sweep');
    await expectDenied(t, database, 'core_runtime', "UPDATE economy.ledger SET amount = 0 WHERE entry_id = 'ci-e1'", 'core ledger rewrite');
    await expectDenied(t, database, 'core_runtime', "DELETE FROM season.weekly_payouts WHERE payout_id = 'ci-p1'", 'core payout delete');
    // worker_runtime: zero economy surface; audit immutable for every runtime role.
    await expectDenied(t, database, 'worker_runtime', "INSERT INTO economy.ledger(entry_id, actor_id, currency, amount, reason, source, at) VALUES ('ci-e2','u_ci_probe','coins',5,'x','game',now())", 'worker ledger append');
    await expectDenied(t, database, 'worker_runtime', "UPDATE economy.wallets SET coins = 0 WHERE actor_id = 'u_ci_probe'", 'worker wallet');
    await expectDenied(t, database, 'worker_runtime', "UPDATE audit.operator_audit SET detail = 'x' WHERE audit_id = 'a1'", 'worker audit update');
    await expectDenied(t, database, 'worker_runtime', 'DELETE FROM audit.operator_audit', 'worker audit delete');
    await expectDenied(t, database, 'worker_runtime', "DELETE FROM monetization.store_finalize WHERE transaction_id = 't1' AND store = 'google'", 'worker cannot DELETE finalize (terminal abandonment state instead)');
    // audit_runtime: append allowed, mutation denied even for the appender (grant + trigger).
    await expectAllowed(database, 'audit_runtime', `INSERT INTO audit.operator_audit(audit_id,"at",operator,action,actor_id,reason,detail,prev_hash,entry_hash)
      VALUES ('a1', now(), 'ci', 'probe', NULL, 'acceptance', '{}', repeat('0',64), repeat('a',64))`, 'audit append');
    await expectDenied(t, database, 'audit_runtime', "UPDATE audit.operator_audit SET detail = 'x' WHERE audit_id = 'a1'", 'audit update by appender');
    await expectDenied(t, database, 'audit_runtime', "DELETE FROM audit.operator_audit WHERE audit_id = 'a1'", 'audit delete by appender');
    // backup_reader: reads all including credential/audit tables; writes nothing.
    await expectAllowed(database, 'backup_reader', 'SELECT count(*) FROM identity.email_credentials', 'backup creds read');
    await expectAllowed(database, 'backup_reader', 'SELECT count(*) FROM audit.operator_audit', 'backup audit read');
    await expectDenied(t, database, 'backup_reader', "INSERT INTO runtime.state(key, value) VALUES ('k','v')", 'backup write');
    // 0026 backup contract: backup_reader's read capability is the EXPLICIT grant set, so the
    // obsolete pg_read_all_data membership must be absent (0023's guarded fallback alone would
    // leave either topology working; this assertion is what distinguishes them). The consumer
    // dump proof is the parent-owned smoke evidence, not asserted here.
    {
      const bc = await connectAdmin(database);
      try {
        const mem = await bc.query(
          "SELECT count(*)::int n FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE r.rolname = 'pg_read_all_data' AND m.rolname = 'backup_reader'");
        assert.equal(mem.rows[0].n, 0, '0026 must have revoked (or never needed) pg_read_all_data membership');
        const denied = await bc.query(
          "SELECT count(*)::int n FROM information_schema.table_privileges WHERE grantee = 'backup_reader' AND privilege_type = 'INSERT'");
        assert.equal(denied.rows[0].n, 0, 'backup_reader holds no INSERT grant anywhere');
      } finally { await bc.end(); }
    }
    await expectAllowedInTx(database, 'backup_reader', ['LOCK TABLE economy.wallets IN ACCESS SHARE MODE'], 'pg_dump ACCESS SHARE lock inside a transaction block');
    await expectAllowed(database, 'backup_reader', 'SELECT last_value FROM monetization.reward_events_event_id_seq', 'pg_dump sequence value read');
    // Cross-role SET between runtime identities is structurally impossible.
    await expectDenied(t, database, 'api_runtime', 'SET ROLE core_runtime', 'api cannot become core');
    // Positive controls: scoped writes prove least privilege, not lockout.
    await expectAllowed(database, 'core_runtime', "UPDATE economy.wallets SET coins = coins + 1 WHERE actor_id = 'u_ci_probe'", 'core wallet');
    await expectAllowed(database, 'core_runtime', "INSERT INTO economy.ledger(entry_id, actor_id, currency, amount, reason, source, at) VALUES ('ci-e1','u_ci_probe','coins',1,'ci','game',now())", 'core ledger append');
    await expectAllowed(database, 'worker_runtime', "INSERT INTO ops.outbox(outbox_id, payload, kind, state, created_at, expires_at, next_at) VALUES ('o1','p','mail','queued',now(),now(),now())", 'worker outbox');
    // 0027 consumer regression (proven writers email-auth.js:36/103, community-store.js:260):
    // supersede/tombstone paths move queued|sending jobs to terminal 'cancelled' and NULL the
    // payload; sealed_payload_ck still forbids payload on cancelled rows.
    await expectAllowed(database, 'worker_runtime', "INSERT INTO ops.outbox(outbox_id,payload,kind,state,created_at,expires_at,next_at) VALUES ('o_cancel','{\"to\":\"a@x\"}','otp','queued',now(),now(),now())", 'worker enqueue (producer path)');
    const oClaim = await expectAllowed(database, 'worker_runtime', "UPDATE ops.outbox SET state='sending', attempts=attempts+1 WHERE outbox_id='o_cancel' AND state='queued'", 'worker claim');
    assert.equal(oClaim.rowCount, 1, 'claim moves queued -> sending');
    const oCancel = await expectAllowed(database, 'worker_runtime', "UPDATE ops.outbox SET state='cancelled', payload=NULL WHERE outbox_id='o_cancel' AND state IN ('queued','sending') RETURNING state, payload", 'source-shaped supersede cancel (0027)');
    assert.equal(oCancel.rowCount, 1, "'cancelled' is a legal terminal state after 0027");
    assert.equal(oCancel.rows[0].state, 'cancelled');
    assert.equal(oCancel.rows[0].payload, null, 'cancel drops the payload exactly like the source writers');
    const sealedNeg = await asRole(database, 'worker_runtime', "UPDATE ops.outbox SET payload='re-attached' WHERE outbox_id='o_cancel'");
    assert.equal(sealedNeg.ok, false, 'a cancelled row must not re-attach a payload');
    assert.match(String(sealedNeg.message), /outbox_sealed_payload_ck/);
    // payload NULL so ONLY the state domain can fail: 'shipped' is refused 23514 by
    // outbox_state_check (with a non-NULL payload the sealed-payload check would fire first).
    const bogusNeg = await asRole(database, 'worker_runtime', "INSERT INTO ops.outbox(outbox_id,payload,kind,state,created_at,expires_at,next_at) VALUES ('o_bogus',NULL,'otp','shipped',now(),now(),now())");
    assert.equal(bogusNeg.ok, false, 'the widened domain must still reject unknown states');
    assert.match(String(bogusNeg.message), /outbox_state_check/);
    const oPurge = await expectAllowed(database, 'worker_runtime', "DELETE FROM ops.outbox WHERE outbox_id='o_cancel'", 'worker retention purge of the cancelled row');
    assert.equal(oPurge.rowCount, 1);
    // 0022 posture: support.events is appended by the API ONLY; the worker retention path
    // is SELECT + purge DELETE, never INSERT. Seed as harness admin, exercise real worker caps.
    { const seed = await connectAdmin(database);
      try { await seed.query("INSERT INTO support.events(event_id,\"at\",method,route,status) VALUES ('s0',now(),'GET','/x',200)"); }
      finally { await seed.end(); } }
    await expectDenied(t, database, 'worker_runtime', "INSERT INTO support.events(event_id,\"at\",method,route,status) VALUES ('s0x',now(),'GET','/x',200)", 'worker cannot append support events (0022)');
    await expectAllowed(database, 'worker_runtime', "SELECT count(*)::int FROM support.events WHERE event_id='s0'", 'worker support read');
    await expectAllowed(database, 'worker_runtime', "DELETE FROM support.events WHERE event_id='s0'", 'worker retention purge delete');
    await expectAllowed(database, 'api_runtime', "INSERT INTO support.events(event_id,\"at\",method,route,status) VALUES ('s1',now(),'GET','/y',200)", 'api support append');
  } finally { await dropTracked(database); }
});

test('P08-P10 gap boundaries: fenced leases, notification dedupe machine, escrow facts', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('leases');
  try {
    await firstFullMigration(t, database);
    await enableRuntimeLogins();
    const c = await connectAdmin(database);
    try {
      await execScript(c, `SET ROLE v5_owner;
        INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_lease', now());
        INSERT INTO tournament.rooms(room_id, code, owner_id, status, created_at) VALUES ('r1','ROOM1','u_lease','RUNNING', now());
        INSERT INTO tournament.escrow_contributions(room_id, actor_id, amount) VALUES ('r1','u_lease',25);
        INSERT INTO tournament.fixtures(room_id, fixture_id, status) VALUES ('r1','f1','PLAYING')`);
      // fixtures fence (0013): owner + monotonic lease_epoch + expiry advance together.
      // SET ROLE and every data statement run as SEPARATE single-statement queries: a
      // multi-statement simple query aggregates results, so rowCount/rows of the fenced
      // UPDATE are only trustworthy when it is the sole statement in its own round-trip.
      await c.query('SET ROLE core_runtime');
      let bad = null;
      try { await c.query("UPDATE tournament.fixtures SET lease_owner='w1' WHERE room_id='r1' AND fixture_id='f1'"); } catch (e) { bad = e; }
      assert.ok(bad && /fixtures_lease_tuple_ck/.test(bad.message), 'partial lease must violate fixtures_lease_tuple_ck');
      const claim = await c.query("UPDATE tournament.fixtures SET lease_owner='w1', lease_epoch=1, lease_until=now()+interval '30 seconds', revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND lease_owner IS NULL RETURNING revision, lease_epoch");
      assert.equal(claim.rowCount, 1, 'unleased fixture must be claimable');
      assert.equal(String(claim.rows[0].revision), '1');
      assert.equal(String(claim.rows[0].lease_epoch), '1');
      const steal = await c.query("UPDATE tournament.fixtures SET lease_owner='w2', lease_epoch=lease_epoch+1, lease_until=now()+interval '30 seconds', revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND (lease_owner IS NULL OR lease_until < now())");
      assert.equal(steal.rowCount, 0, 'a LIVE lease cannot be stolen by a competing worker');
      const stale = await c.query("UPDATE tournament.fixtures SET revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND lease_owner='w1' AND lease_epoch=0");
      assert.equal(stale.rowCount, 0, 'stale fence cannot advance a newer lease');
      const bump = await c.query("UPDATE tournament.fixtures SET lease_epoch=lease_epoch+1, revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND lease_owner='w1' AND lease_epoch=1 RETURNING revision, lease_epoch");
      assert.equal(bump.rowCount, 1, 'holder must advance at its current fence');
      assert.equal(String(bump.rows[0].lease_epoch), '2');
      const expire = await c.query("UPDATE tournament.fixtures SET lease_until=now()-interval '1 second' WHERE room_id='r1' AND fixture_id='f1' AND lease_owner='w1' AND lease_epoch=2");
      assert.equal(expire.rowCount, 1, 'the holder may expire its own lease for takeover coverage');
      const take = await c.query("UPDATE tournament.fixtures SET lease_owner='w2', lease_epoch=lease_epoch+1, lease_until=now()+interval '30 seconds', revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND lease_until < now() RETURNING lease_owner");
      assert.equal(take.rowCount, 1, 'an expired lease must be takeable exactly once');
      assert.equal(take.rows[0].lease_owner, 'w2');
      const zombie = await c.query("UPDATE tournament.fixtures SET revision=revision+1 WHERE room_id='r1' AND fixture_id='f1' AND lease_owner='w1' AND lease_epoch=2");
      assert.equal(zombie.rowCount, 0, 'the pre-takeover holder is fenced out after takeover');
      // the room-clock sweep lease obeys the same tuple contract (0013 rooms)
      let badTimer = null;
      try { await c.query("UPDATE tournament.rooms SET timer_lease_owner='t1' WHERE room_id='r1'"); } catch (e) { badTimer = e; }
      assert.ok(badTimer && /rooms_timer_lease_tuple_ck/.test(badTimer.message), 'partial timer lease must violate rooms_timer_lease_tuple_ck');
      await c.query('RESET ROLE');
      await c.query("SET ROLE v5_owner; INSERT INTO monetization.store_notifications(store, notification_id, received_at, next_at) VALUES ('google', 'n1', now(), now())");
      let badApply = null;
      try { await c.query("SET ROLE worker_runtime; UPDATE monetization.store_notifications SET state='applied' WHERE store='google' AND notification_id='n1'"); } catch (e) { badApply = e; }
      assert.ok(badApply && /violates check constraint/i.test(badApply.message), 'applied without processed_at must violate a CHECK');
      await expectAllowed(database, 'worker_runtime', "UPDATE monetization.store_notifications SET state='processing', lease_owner='w1', lease_token=1, lease_until=now()+interval '30 seconds', attempts=attempts+1 WHERE store='google' AND notification_id='n1' AND state='pending'", 'notification fenced claim');
      await expectAllowed(database, 'worker_runtime', "UPDATE monetization.store_notifications SET state='applied', processed_at=now() WHERE store='google' AND notification_id='n1' AND lease_owner='w1' AND lease_token=1", 'notification applied with proof');
      // Finalizer abandonment per the frozen 0015 substitute contract: the V4 worker
      // DELETE-on-abandon became a pending->abandoned TERMINAL UPDATE with full lease-tuple
      // release; there is NO abandoned_reason column (source keeps no such fact).
      await c.query("SET ROLE v5_owner; INSERT INTO monetization.store_finalize(store,transaction_id,product_id,purchase_token,kind,state,attempts,next_at,created_at,updated_at) VALUES ('google','tx_fin1','gold_pack','tok1','consume','pending',0,now(),now(),now())");
      let badFinLease = null;
      try { await c.query("SET ROLE worker_runtime; UPDATE monetization.store_finalize SET lease_owner='w1' WHERE store='google' AND transaction_id='tx_fin1'"); } catch (e) { badFinLease = e; }
      assert.ok(badFinLease && /store_finalize_lease_tuple_ck/.test(badFinLease.message), 'partial finalize lease must violate store_finalize_lease_tuple_ck');
      const finClaim = await expectAllowed(database, 'worker_runtime', "UPDATE monetization.store_finalize SET lease_owner='w1', lease_token=1, lease_until=now()+interval '30 seconds', attempts=attempts+1, updated_at=now() WHERE store='google' AND transaction_id='tx_fin1' AND state='pending' AND lease_owner IS NULL", 'finalize fenced claim');
      assert.equal(finClaim.rowCount, 1, 'worker claims the pending finalizer exactly once');
      const finAbandon = await expectAllowed(database, 'worker_runtime', "UPDATE monetization.store_finalize SET state='abandoned', lease_owner=NULL, lease_token=NULL, lease_until=NULL, updated_at=now() WHERE store='google' AND transaction_id='tx_fin1' AND state='pending' AND lease_owner='w1' AND lease_token=1 RETURNING state", 'finalize terminal abandonment (UPDATE, never DELETE)');
      assert.equal(finAbandon.rowCount, 1, 'abandonment requires the owner+fence proof');
      assert.equal(finAbandon.rows[0].state, 'abandoned');
      const finRound = await expectAllowed(database, 'worker_runtime', "SELECT count(*)::int n FROM monetization.store_finalize WHERE store='google' AND transaction_id='tx_fin1' AND state='abandoned' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL", 'terminal state + full lease release roundtrip');
      assert.equal(finRound.rows[0].n, 1, 'the row SURVIVES abandoned with the whole lease tuple NULLed (DELETE-on-abandon replaced)');
      // Escrow invariant read: the badApply/finalize probes above leave c's session in a
      // non-owner role; this trusted-owner read runs on the admin session, no new grants.
      await c.query('RESET ROLE');
      const esc = await c.query("SELECT r.escrow, sum(e.amount) s FROM tournament.rooms r JOIN tournament.escrow_contributions e USING (room_id) WHERE r.room_id='r1' GROUP BY r.escrow");
      assert.equal(String(esc.rows[0].s), '25'); // single rooms.escrow fact, contributions normalized beside it
    } finally { await c.end(); }
  } finally { await dropTracked(database); }
});

test('P02 SourceGate semantic roundtrips: 0028 ordering/soft membership, 0029 space keys, 0030 legacy id domain, 0031 shape version', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('sourcegate');
  try {
    await firstFullMigration(t, database);
    await enableRuntimeLogins();
    const FP = 'a'.repeat(64);
    const c = await connectAdmin(database);
    try {
      await execScript(c, `SET ROLE v5_owner;
        INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_rpsurv', now()), ('u_roomowner', now());
        INSERT INTO tournament.rooms(room_id, code, owner_id, status, created_at) VALUES ('r_gate','GATE0001','u_roomowner','RUNNING', now())`);
      // 0028 (M1): guest + tombstone principals are plain TEXT (actor FK dropped, room FK kept);
      // ordinal preserves the source players[] array order (join.push sequence here happens to
      // run survivor -> guest -> tombstone while ids descend alphabetically: reversed order).
      // 0034: name is a JSON string scalar now - every value is passed in canonical
      // JSON.stringify form (physical+decoded assertions follow in the representation block).
      await c.query(`SET ROLE v5_owner;
        INSERT INTO tournament.room_players(room_id, actor_id, name, ready, withdrawn, ordinal) VALUES
          ('r_gate','u_rpsurv','${JSON.stringify('Survivor')}',true,false,0),
          ('r_gate','guest_0bad6eed','${JSON.stringify('Guest')}',false,false,1),
          ('r_gate','deleted_0123456789abcdef0123456789abcdef','${JSON.stringify('Tombstone')}',false,true,2)`);
      const order = await expectAllowed(database, 'core_runtime', "SELECT actor_id, name, joined_at IS NULL AS no_fabricated_time FROM tournament.room_players WHERE room_id='r_gate' ORDER BY ordinal", 'core consumer reads the source order');
      assert.deepEqual(order.rows.map((r) => r.actor_id), ['u_rpsurv', 'guest_0bad6eed', 'deleted_0123456789abcdef0123456789abcdef']);
      assert.ok(order.rows.every((r) => r.no_fabricated_time === true), 'joined_at stays NULL: no fabricated import timestamps');
      let dup = null;
      try { await c.query(`SET ROLE v5_owner; INSERT INTO tournament.room_players(room_id, actor_id, name, ordinal) VALUES ('r_gate','u_dupslot','${JSON.stringify('Dup')}',0)`); } catch (e) { dup = e; }
      assert.ok(dup && /room_players_room_id_ordinal_key/.test(dup.message), 'duplicate ordinal inside one room must raise 23505');
      let negOrd = null;
      try { await c.query(`SET ROLE v5_owner; INSERT INTO tournament.room_players(room_id, actor_id, name, ordinal) VALUES ('r_gate','u_negslot','${JSON.stringify('Neg')}',-1)`); } catch (e) { negOrd = e; }
      assert.ok(negOrd && /room_players_ordinal_check/.test(negOrd.message), 'negative ordinal must raise 23514');
      // platform-actor deletion must NOT erase historical membership (soft reference)
      await c.query("SET ROLE v5_owner; DELETE FROM identity.actors WHERE actor_id='u_rpsurv'");
      const survived = await c.query("SELECT count(*)::int n FROM tournament.room_players WHERE room_id='r_gate'");
      assert.equal(survived.rows[0].n, 3, 'memberships survive actor removal; guests/tombstones never were actors');
      // 0029+0034 (op-key families, economy/tournament only): the TEXT primary key holds the
      // CANONICAL JSON.stringify representation of every key (source validators are
      // invocation.js:16-21 / http-guards.js:46-55: non-empty + <=160 UTF-16 units — the exact
      // 160-unit logical bound lives in the JS source/loader layer, never re-pinned here). SQL
      // admits the encoded shape only: CASE-guarded string scalar, non-empty, <=962 bytes.
      const kSpace = JSON.stringify('party setup v1');
      const kHash = JSON.stringify('invite#7');
      const kUni = JSON.stringify('nul ' + String.fromCharCode(0) + '\ud800proxy');
      await expectAllowed(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${kSpace}','${FP}','{"ok":true,"state":"ready"}')`, 'canonical-encoded economy key accepted');
      await expectAllowed(database, 'core_runtime', `INSERT INTO tournament.command_outcomes(actor_id,"key",room_id,fingerprint,response) VALUES ('u_rpsurv','${kHash}','r_gate','${FP}','{"ok":true}')`, 'canonical-encoded party key accepted');
      await expectAllowed(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${kUni}','${FP}','{"ok":true}')`, 'canonical-encoded NUL/surrogate key accepted');
      // The two op-key families are deliberately split (kSpace+kUni -> economy/account-scope,
      // kHash -> tournament/party-scope with room_id): one deterministic UNION ALL readback
      // covers both, ordered by the canonical stored key.
      const exact = await expectAllowed(database, 'core_runtime', `SELECT "key", response FROM economy.command_outcomes WHERE actor_id='u_rpsurv' UNION ALL SELECT "key", response FROM tournament.command_outcomes WHERE actor_id='u_rpsurv' ORDER BY "key"`, 'physical serde state readback across both families');
      assert.equal(exact.rows.length, 3);
      assert.ok(exact.rows.every((r) => r.key.startsWith('"')), 'stored bytes are the canonical encoding, not raw text');
      const decoded = exact.rows.map((r) => JSON.parse(r.key));
      assert.ok(decoded.includes('party setup v1') && decoded.includes('invite#7') && decoded.includes('nul ' + String.fromCharCode(0) + '\ud800proxy'), 'decoded keys are code-unit identical (raw TEXT transport would have replaced D800)');
      assert.equal(exact.rows.find((r) => r.key === kSpace).response, '{"ok":true,"state":"ready"}', 'response TEXT survives byte-exact');
      const dupKey = await asRole(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${kSpace}','${FP}','{}')`);
      assert.equal(dupKey.ok, false, 'the same canonical key hits the PK');
      assert.match(String(dupKey.message), /command_outcomes_pkey/);
      for (const [badKey, why] of [['""', 'empty key'], ['42', 'numeric scalar'], ['not json', 'non-JSON text must signal 23514 via the CASE guard, not 22P02']]) {
        const bad = await asRole(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${badKey}','${FP}','{}')`);
        assert.equal(bad.ok, false, `refused: ${why}`);
        assert.match(String(bad.message), /command_outcomes_key_check/);
      }
      const overCap = JSON.stringify('y'.repeat(970));
      const tooLong = await asRole(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${overCap}','${FP}','{}')`);
      assert.equal(tooLong.ok, false, 'encoded bytes above 962 must be refused');
      assert.match(String(tooLong.message), /command_outcomes_key_check/);
      const edge160 = JSON.stringify('k '.repeat(80));
      const okEdge = await expectAllowed(database, 'core_runtime', `INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_rpsurv','${edge160}','${FP}','{}')`, 'a full 160-unit logical key survives SQL via its encoding');
      assert.equal(okEdge.rowCount, 1);
      // 0030 (M4): legacy domain is actor||':'||key - two target pairs collapsing to one legacy
      // id collide; distinct legacy ids coexist. (Importer reports ambiguous splits, never guesses.)
      // The social family's grammar check is 43-char base64url (0007), NOT the 64-hex FP used by
      // the economy/tournament families - a social-scoped constant is required verbatim.
      const SOCIAL_FP = '7d7649e9a87cfb90be72fa1fb2312d786106bc5a90d';
      await c.query(`SET ROLE v5_owner; INSERT INTO social.command_outcomes(actor_id,"key",fingerprint,result) VALUES ('u_leg1','x:y','${SOCIAL_FP}','{}')`);
      let collide = null;
      try { await c.query(`SET ROLE v5_owner; INSERT INTO social.command_outcomes(actor_id,"key",fingerprint,result) VALUES ('u_leg1:x','y','${SOCIAL_FP}','{}')`); } catch (e) { collide = e; }
      assert.ok(collide && /social_command_outcomes_legacy_id_uniq/.test(collide.message), 'legacy combined-id collision must raise 23505');
      await c.query(`SET ROLE v5_owner; INSERT INTO social.command_outcomes(actor_id,"key",fingerprint,result) VALUES ('u_leg1','x:z','${SOCIAL_FP}','{}')`);
      const distinct = await c.query("SELECT count(*)::int n FROM social.command_outcomes WHERE actor_id='u_leg1'");
      assert.equal(distinct.rows[0].n, 2, 'distinct legacy ids survive side by side');
      // 0031 (M5): shape lineage round-trips independently of the numeric rules lineage.
      // SET ROLE runs as its own statement: a multi-statement simple query returns an ARRAY of
      // results (pg _results), so `.rows` would be undefined on the composite.
      await c.query('SET ROLE v5_owner');
      const sv = await c.query("UPDATE tournament.rooms SET shape_version='tournament-2', rules_version=3 WHERE room_id='r_gate' RETURNING shape_version, rules_version");
      assert.equal(sv.rows[0].shape_version, 'tournament-2');
      assert.equal(String(sv.rows[0].rules_version), '3');
      const indep = await c.query("UPDATE tournament.rooms SET shape_version='tournament-3' WHERE room_id='r_gate' RETURNING shape_version, rules_version");
      assert.equal(indep.rows[0].shape_version, 'tournament-3', 'shape discriminator evolves');
      assert.equal(String(indep.rows[0].rules_version), '3', 'rules lineage is untouched by shape changes');

      // 0034 representation: the JSON-typed columns admit NUL/lone-surrogate escapes that raw
      // TEXT cannot (22021 / silent transport replacement). Checks assert the PHYSICAL stored
      // bytes and the decoded code units separately - never a mock echo.
      const uniRegion = JSON.stringify('re' + String.fromCharCode(0) + 'gion\ud800');
      await c.query(`SET ROLE v5_owner; UPDATE identity.actors SET region = '${uniRegion}' WHERE actor_id='u_roomowner'`);
      const regRt = await c.query(`SELECT region::text r FROM identity.actors WHERE actor_id='u_roomowner'`);
      assert.equal(regRt.rows[0].r, uniRegion, 'region stored byte-exact as a JSON string scalar');
      assert.equal(JSON.parse(regRt.rows[0].r), 're' + String.fromCharCode(0) + 'gion\ud800', 'decoded region code-unit identical');
      await c.query("SET ROLE v5_owner; INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_dflt', now())");
      const dflt = await c.query(`SELECT region::text r FROM identity.actors WHERE actor_id='u_dflt'`);
      assert.equal(dflt.rows[0].r, '""', 'region default is the JSON empty string');
      const uniName = JSON.stringify('🎮'.repeat(23) + '\ud83c'); // 47 UTF-16 units incl. a lone high surrogate
      await c.query(`SET ROLE v5_owner; UPDATE tournament.rooms SET name = '${uniName}' WHERE room_id='r_gate'`);
      const nameRt = await c.query(`SELECT name::text n FROM tournament.rooms WHERE room_id='r_gate'`);
      assert.equal(nameRt.rows[0].n, uniName, 'room name emoji slice stored byte-exact');
      assert.equal(JSON.parse(nameRt.rows[0].n).length, 47, 'decoded name keeps its UTF-16 unit count');
      await c.query(`SET ROLE v5_owner; UPDATE tournament.room_players SET name = '${JSON.stringify('p'.repeat(31) + '\ud800')}' WHERE room_id='r_gate' AND actor_id='guest_0bad6eed'`);
      const pName = await c.query(`SELECT name::text n FROM tournament.room_players WHERE actor_id='guest_0bad6eed'`);
      assert.equal(JSON.parse(pName.rows[0].n).length, 32, 'player name 32-unit slice survives');
      const b64 = 'b'.repeat(64);
      // The two-character JSON escape \u must reach SQL intact: build it OUTSIDE the template
      // as a plain JS string (inside a template, `\u` would be consumed as a JS escape).
      const termsDoc = '{"clock":300,"note":"x\\u0000y"}';
      await c.query('SET ROLE v5_owner');
      await c.query("INSERT INTO match.matches(match_id, source, mode, terms_json, terms_hash, quote_json, pool, contribution_a, contribution_b, status, created_at, expires_at, state_json) VALUES ('m_gate','direct','direct',$1,$2,'{}',0,0,0,'FINISHED',now(),now(),'{}')", [termsDoc, b64]);
      const termsRt = await c.query(`SELECT terms_json::text t FROM match.matches WHERE match_id='m_gate'`);
      assert.ok(termsRt.rows[0].t.includes('\\u0000'), 'terms document stores the NUL escape physically');
      let badTerms = null;
      try { await c.query(`SET ROLE v5_owner; UPDATE match.matches SET terms_json = '[1]'::json WHERE match_id='m_gate'`); } catch (e) { badTerms = e; }
      assert.ok(badTerms && /matches_terms_json_object_ck/.test(badTerms.message), 'terms root gate recreated for the JSON type');
      await c.query(`SET ROLE v5_owner; UPDATE match.matches SET kind = '${JSON.stringify('unranked duel\ud800')}', receipt_reason = '{"note":"x\\u0000y"}'::json WHERE match_id='m_gate'`);
      const gate2 = await c.query(`SELECT kind::text k, json_typeof(receipt_reason) jt FROM match.matches WHERE match_id='m_gate'`);
      assert.equal(JSON.parse(gate2.rows[0].k), 'unranked duel\ud800', 'kind JSON string scalar with lone surrogate');
      assert.equal(gate2.rows[0].jt, 'object', 'receipt_reason admits the object form');
      await c.query(`SET ROLE v5_owner; UPDATE match.matches SET receipt_reason = 'null'::json WHERE match_id='m_gate'`);
      const nullReason = await c.query(`SELECT json_typeof(receipt_reason) jt FROM match.matches WHERE match_id='m_gate'`);
      assert.equal(nullReason.rows[0].jt, 'null', 'receipt_reason admits JSON null (ANY VALUE, no CHECK needed)');
      // five approved-extension extras: JSON + name-preserved root-object gates
      const uniObj = JSON.stringify({ note: 'x' + String.fromCharCode(0) + '\ud800y' });
      await c.query(`SET ROLE v5_owner; INSERT INTO tournament.fixtures(room_id, fixture_id, status) VALUES ('r_gate','f_gate','READY')`);
      await c.query(`SET ROLE v5_owner; INSERT INTO monetization.credits(actor_id, credit_balance) VALUES ('u_roomowner', 0)`);
      await c.query(`SET ROLE v5_owner; INSERT INTO economy.actor_legacy_extra(actor_id, extra) VALUES ('u_roomowner', '{"seed":1}')`);
      for (const [tbl, pk, ck] of [
        ['tournament.rooms', `room_id='r_gate'`, 'rooms_extra_object_ck'],
        ['tournament.fixtures', `room_id='r_gate' AND fixture_id='f_gate'`, 'fixtures_extra_object_ck'],
        ['monetization.credits', `actor_id='u_roomowner'`, 'credits_extra_object_ck'],
        ['economy.actor_legacy_extra', `actor_id='u_roomowner'`, 'actor_legacy_extra_extra_check'],
        ['match.matches', `match_id='m_gate'`, 'matches_extra_object_ck'],
      ]) {
        await c.query(`SET ROLE v5_owner; UPDATE ${tbl} SET extra = '${uniObj}'::json WHERE ${pk}`);
        const rt = await c.query(`SELECT extra::text e FROM ${tbl} WHERE ${pk}`);
        assert.equal(rt.rows[0].e, uniObj, `${tbl}.extra stored byte-exact`);
        let badExtra = null;
        try { await c.query(`SET ROLE v5_owner; UPDATE ${tbl} SET extra = '[1]'::json WHERE ${pk}`); } catch (e) { badExtra = e; }
        assert.ok(badExtra && new RegExp(ck).test(badExtra.message), `${tbl}.extra root gate (${ck}) refuses non-object`);
      }
      // 0035 audit genesis: exact 'GENESIS' + 64-hex chain round-trip; arbitrary prev refused.
      const hA = 'c'.repeat(64);
      const hB = 'd'.repeat(64);
      await expectAllowed(database, 'audit_runtime', `INSERT INTO audit.operator_audit(audit_id,"at",operator,action,reason,detail,prev_hash,entry_hash) VALUES ('au_genesis',now(),'ci-op','account.tombstone','gdpr','raw-hmac-detail-a','GENESIS','${hA}')`, 'GENESIS first prev accepted (audit_runtime append posture)');
      await expectAllowed(database, 'audit_runtime', `INSERT INTO audit.operator_audit(audit_id,"at",operator,action,reason,detail,prev_hash,entry_hash) VALUES ('au_second',now(),'ci-op','account.tombstone','gdpr','raw-hmac-detail-b','${hA}','${hB}')`, 'hex prev chains');
      const genRt = await expectAllowed(database, 'audit_runtime', `SELECT prev_hash, detail FROM audit.operator_audit WHERE audit_id='au_genesis'`, 'genesis round-trip');
      assert.equal(genRt.rows[0].prev_hash, 'GENESIS', 'TEXT: no CHAR padding, no re-hash, no repair');
      assert.equal(genRt.rows[0].detail, 'raw-hmac-detail-a', 'detail stays raw HMAC-side text');
      let n = 0;
      for (const badPrev of ['GENESI', 'genesis', 'c'.repeat(63), 'g'.repeat(64)]) {
        const rej = await asRole(database, 'audit_runtime', `INSERT INTO audit.operator_audit(audit_id,"at",operator,action,reason,detail,prev_hash,entry_hash) VALUES ('au_bad${n++}',now(),'ci-op','x','y','z','${badPrev}','${hB}')`);
        assert.equal(rej.ok, false, `arbitrary prev refused: ${badPrev.slice(0, 10)}...`);
        assert.match(String(rej.message), /operator_audit_prev_hash_check/);
      }
    } finally { await c.end(); }
  } finally { await dropTracked(database); }
});

test('0034 upgrade regression: plain keys (including a quote-prefixed one) canonicalize exactly once from a head-0033 database', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('upgradecanon');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-mig-upgradecanon-'));
  const KEY_FP = 'f'.repeat(64);
  const plainKeys = ['party setup v1', '"quoted-prefix"', 'invite#7']; // quote-prefixed logical key, NUL-free
  try {
    fs.cpSync(MIGRATIONS_DIR, scratch, { recursive: true });
    // Head-0033 database: keep only files up to the 0034 boundary, whatever the chain length is.
    const files = fs.readdirSync(path.join(scratch, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const boundary = files.findIndex((f) => f.startsWith('0034_'));
    assert.ok(boundary > 0, 'the 0034 boundary exists in the chain');
    for (const f of files.slice(boundary)) fs.rmSync(path.join(scratch, 'migrations', f));
    runMigrate(['--make-manifest', '--json', '--migrations-dir', scratch]);
    const head = runMigrate(['--execute', '--json', '--migrations-dir', scratch, '--database-url', dbUrl(database)], confirmEnv(database));
    assert.equal(head.status, 0, `head apply failed: ${head.stdout}${head.stderr}`);
    assert.equal(head.json.appliedCount, boundary);
    const c = await connectAdmin(database);
    try {
      await c.query("SET ROLE v5_owner; INSERT INTO identity.actors(actor_id, created_at) VALUES ('u_canon', now())");
      for (const k of plainKeys) {
        await c.query(`SET ROLE v5_owner; INSERT INTO economy.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_canon','${k}','${KEY_FP}','{}')`);
        await c.query(`SET ROLE v5_owner; INSERT INTO tournament.command_outcomes(actor_id,"key",fingerprint,response) VALUES ('u_canon','${k}','${KEY_FP}','{}')`);
      }
      // restore the two pending steps and resume: 0034 must canonicalize EVERY row once,
      // unconditionally - the quote-prefixed logical key may not be skipped as "already encoded".
      fs.cpSync(path.join(MIGRATIONS_DIR, 'migrations', '0034_unicode_json_representation.sql'), path.join(scratch, 'migrations', '0034_unicode_json_representation.sql'));
      fs.cpSync(path.join(MIGRATIONS_DIR, 'migrations', '0035_audit_genesis_prev_hash.sql'), path.join(scratch, 'migrations', '0035_audit_genesis_prev_hash.sql'));
      runMigrate(['--make-manifest', '--json', '--migrations-dir', scratch]);
      const up = runMigrate(['--execute', '--json', '--migrations-dir', scratch, '--database-url', dbUrl(database)], confirmEnv(database));
      assert.equal(up.status, 0, `0034/0035 resume failed: ${up.stdout}${up.stderr}`);
      assert.equal(up.json.appliedCount, 2);
      const expected = plainKeys.map((k) => ({ enc: JSON.stringify(k), dec: k }));
      for (const tbl of ['economy.command_outcomes', 'tournament.command_outcomes']) {
        const rows = await c.query(`SELECT "key" FROM ${tbl} WHERE actor_id='u_canon'`);
        assert.equal(rows.rows.length, 3, `${tbl}: all three rows survive the upgrade`);
        // Order-independent (and stronger than an array compare): per-key containment plus the
        // decoded identity of the DB-returned bytes. ORDER BY would compare under the DATABASE
        // collation, which differs across platforms while the stored values are identical.
        const stored = new Map(rows.rows.map((r) => [r.key, JSON.parse(r.key)]));
        for (const e of expected) {
          assert.ok(stored.has(e.enc), `${tbl}: stored bytes are EXACTLY JSON.stringify(logical) for ${JSON.stringify(e.dec)}`);
          assert.equal(stored.get(e.enc), e.dec, `${tbl}: decoded logical identity for ${JSON.stringify(e.dec)}`);
        }
      }
    } finally { await c.end(); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); await dropTracked(database); }
});

test('verify detects catalog drift and ledger tampering', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('drift');
  try {
    await firstFullMigration(t, database);
    const c = await connectAdmin(database);
    try { await c.query('DROP TABLE season.league_week CASCADE'); } finally { await c.end(); }
    const v = runMigrate(['--verify', '--json', '--database-url', dbUrl(database)]);
    assert.equal(v.status, 6);
    assert.match(JSON.stringify(v.json.failures), /season\.league_week/);
    const c2 = await connectAdmin(database);
    try { await c2.query("UPDATE meta.migrations SET checksum = repeat('0',64) WHERE id = 1"); } finally { await c2.end(); }
    const v2 = runMigrate(['--verify', '--json', '--database-url', dbUrl(database)]);
    assert.equal(v2.status, 4);
    assert.match(JSON.stringify(v2.json), /replay conflict.*0001_roles_bootstrap|0001_roles_bootstrap.*replay conflict/);
  } finally { await dropTracked(database); }
});

/* ------------------------------------------------------------------ refusal boundaries */

test('runner refuses unconfirmed, pooler, weak-TLS, bad-binding and unprivileged invocations before writing', async (t) => {
  if (await backendGate(t)) return;
  const database = await freshDb('refuse');
  try {
    const good = dbUrl(database);
    // External-host URLs MUST carry a password: parseAndGuardUrl refuses an empty password
    // with a username (line ~182) BEFORE the host/TLS/binding rules, which would make the
    // negative cases pass for the wrong reason and the official-URI case fail incidentally.
    const withPw = good.replace('postgres@', 'postgres:v5ciprobe@');
    const remote = withPw.replace('127.0.0.1', 'ep-db.example.neon.tech').replace(/v5_test[a-z0-9_]*/, 'neondb');
    const extDb = () => withPw.replace('127.0.0.1', 'db.example.com');
    const cases = [
      [['--execute', '--json', '--database-url', good], {}, 2, 'CONFIRMATION_REQUIRED', 'missing confirm'],
      [['--execute', '--json', '--database-url', good], { MIGRATE_CONFIRM: 'nope', V5_TARGET: 'test' }, 2, 'CONFIRMATION_REQUIRED', 'wrong confirm'],
      // F2: a production classification is refused at PARSE time over plaintext loopback (the
      // loopback escape never applies to production), so this case asserts that refusal; the
      // second-approval gate is exercised separately below with a TLS-valid production URL.
      [['--execute', '--json', '--database-url', good.replace(/v5_test[a-z0-9_]*/, 'v5_production_refusal_probe')], { MIGRATE_CONFIRM: 'v5_production_refusal_probe', V5_TARGET: 'production' }, 2, 'DATABASE_URL_INVALID', 'production classification refuses the plaintext loopback escape'],
      [['--execute', '--json', '--database-url', good.replace('127.0.0.1', 'pooler-host-pooler.example')], { MIGRATE_CONFIRM: database, V5_TARGET: 'test' }, 2, 'DATABASE_URL_INVALID', 'pooler host'],
      [['--execute', '--json', '--database-url', extDb() + '?sslmode=verify-ca'], { MIGRATE_CONFIRM: 'v5db' }, 2, 'DATABASE_URL_INVALID', 'verify-ca off-loopback'],
      [['--execute', '--json', '--database-url', extDb() + '?sslmode=no-verify'], { MIGRATE_CONFIRM: 'v5db' }, 2, 'DATABASE_URL_INVALID', 'no-verify'],
      [['--execute', '--json', '--database-url', extDb() + '?pooler=true'], { MIGRATE_CONFIRM: 'v5db' }, 2, 'DATABASE_URL_INVALID', 'pooler parameter'],
      [['--verify', '--json', '--database-url', 'mysql://x/y'], {}, 2, 'DATABASE_URL_INVALID', 'wrong scheme'],
      [['--execute', '--json', '--database-url', remote + '?sslmode=verify-full&channel_binding=bogus'], { MIGRATE_CONFIRM: 'neondb' }, 2, 'DATABASE_URL_INVALID', 'bad channel_binding'],
      // Genuine official-URI shape (Neon direct endpoints issue channel_binding=require next
      // to sslmode; connect_timeout is NOT part of the issued URI and stays runner-refused).
      // 5-slot tuple: code sentinel, null want, label last. DNS to the fake host may fail;
      // that is a network-class verdict, never a *_INVALID config refusal.
      [['--execute', '--json', '--database-url', withPw.replace('127.0.0.1', 'ep-db.example.neon.tech').replace(/v5_test[a-z0-9_]*/, 'v5_ci_neondb_probe') + '?sslmode=verify-full&channel_binding=require'], { MIGRATE_CONFIRM: 'v5_ci_neondb_probe' }, 'NOTCONFIGREFUSED', null, 'official Neon URI parses past guards'],
    ];
    for (const [args, env, code, want, why] of cases) {
      const r = runMigrate(args, { V5_TARGET: 'test', ...env });
      if (code === 'NOTCONFIGREFUSED') {
        // The official URI shape must pass every pre-connect guard; ONLY the (fake-host)
        // network step may fail, and only with a network-class verdict. Any config-class
        // code (DATABASE_URL_INVALID, TARGET_*, CHANNEL_*, RUNNER_ROLE_*, ...) is a regression.
        assert.notEqual(r.status, 0, `${why}: fake host must never connect`);
        assert.ok(/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(String(r.json && r.json.code)),
          `${why}: expected network-class failure, got status=${r.status} code=${r.json && r.json.code}`);
        continue;
      }
      assert.equal(r.status, code, `${why}: stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(r.json.code, want, why);
    }
    // unknown target refusal (spec 01: never an unknown target)
    const unk = runMigrate(['--execute', '--json', '--database-url', remote + '?sslmode=verify-full'], { MIGRATE_CONFIRM: 'neondb', V5_TARGET: '' });
    assert.equal(unk.status, 2);
    assert.equal(unk.json.code, 'TARGET_ENVIRONMENT_UNRECOGNIZED');
    // Production-looking names classify as production with NO override (the gate-input
    // contract P22 relies on); the consumer-safety refusal is the CONFLICTING staging hint.
    // Hermetic: CI exports V5_TARGET (workflow env), so the ambient value must be REMOVED for
    // the no-override expectation, then set explicitly for the downgrade refusal.
    const priorTarget = process.env.V5_TARGET;
    try {
      delete process.env.V5_TARGET;
      assert.equal(classifyTarget('v5_production_main', '127.0.0.1').kind, 'production',
        'production-looking name classifies as production without an env override');
      process.env.V5_TARGET = 'staging';
      assert.throws(() => classifyTarget('v5_production_main', '127.0.0.1'), /refusing to downgrade/);
    } finally {
      if (priorTarget === undefined) delete process.env.V5_TARGET;
      else process.env.V5_TARGET = priorTarget;
    }
    // F2 (parent repro): the loopback plaintext escape must NEVER apply to a production
    // classification, and a deliberate no-TLS decision must survive into the client config
    // (ssl:false was being converted to undefined, letting pg fall back to the environment).
    const priorEsc = process.env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK;
    process.env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK = '1';
    try {
      // production classification: plaintext loopback is refused for both the implicit and
      // explicit forms, while a staging classification still admits it on an owned cluster.
      assert.throws(() => parseAndGuardUrl('postgresql://postgres@127.0.0.1:50709/v5_production_repro', { production: true }),
        (e) => e && e.code === 'DATABASE_URL_INVALID', 'production classification must not be downgraded over loopback (implicit)');
      assert.throws(() => parseAndGuardUrl('postgresql://postgres@127.0.0.1:50709/v5_production_repro?sslmode=disable', { production: true }),
        (e) => e && e.code === 'DATABASE_URL_INVALID', 'production classification must not be downgraded over loopback (sslmode=disable)');
      const stagingOk = parseAndGuardUrl('postgresql://postgres@127.0.0.1:50709/v5_test_repro', { production: false });
      assert.equal(stagingOk.ssl, false, 'staging loopback escape keeps the explicit no-TLS decision');
    } finally {
      if (priorEsc === undefined) delete process.env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK;
      else process.env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK = priorEsc;
    }
    // The production second-approval gate is still reachable with a TLS-valid production URL:
    // with the correct confirm echo but no --confirm-production, the runner refuses with
    // PRODUCTION_CONFIRMATION_REQUIRED (exit 2) before any connection.
    const prodTls = runMigrate(['--execute', '--json', '--database-url', 'postgresql://postgres:v5probe@ep-db.example.neon.tech:5432/v5_production_probe?sslmode=verify-full'],
      { MIGRATE_CONFIRM: 'v5_production_probe', V5_TARGET: 'production' });
    assert.equal(prodTls.status, 2, prodTls.stdout + prodTls.stderr);
    assert.equal(prodTls.json.code, 'PRODUCTION_CONFIRMATION_REQUIRED', 'production requires the second approval flag');
    // secrets never appear in output
    const leak = runMigrate(['--verify', '--json', '--database-url', 'postgres://postgres:SUP3RSECRET@db.example.com:5432/v5x?sslmode=disable']);
    assert.equal(leak.status, 2);
    assert.ok(!leak.stdout.includes('SUP3RSECRET') && !leak.stderr.includes('SUP3RSECRET'), 'secrets stay unprinted');
  } finally { await dropTracked(database); }
});
