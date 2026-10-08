#!/usr/bin/env node
'use strict';
/* tools/v5-migration/cli.js - documented capture/extract CLI for the P03 source-side extraction.
 *
 * Commands
 * --------
 *   capture  Copy an already-retrieved local V4.1.2 SQLite database into an immutable, validated
 *            snapshot without ever writing to the source.
 *              node tools/v5-migration/cli.js capture \
 *                --source   /restricted/live/mega.sqlite \
 *                --snapshot /restricted/captures/mega-<run>.snapshot.sqlite \
 *                --capture-clock 1791396595015 \
 *                --release-sha 455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2 \
 *                --record   /restricted/captures/mega-<run>.capture.json
 *            Options: --capture-clock <ms>  fixed semantic clock (default: the backup manifest's
 *                                           createdAt, recorded as clockSource)
 *                     --release-sha <sha>  source release provenance
 *                     --record <path>      write the restricted capture record (0600)
 *            Refuses an existing snapshot, snapshot side files and a non-SQLite source. The source is
 *            opened read-only by the SQLite online backup; it is never checkpointed or modified.
 *
 *   extract  Read the immutable snapshot and emit the canonical deterministic source model.
 *              node tools/v5-migration/cli.js extract \
 *                --snapshot /restricted/captures/mega-<run>.snapshot.sqlite \
 *                --clock    1791396595015 \
 *                --out      /restricted/extract/mega-<run>.model.json \
 *                --summary  /restricted/extract/mega-<run>.summary.json \
 *                --expect-sha256 <snapshot sha256> \
 *                --allow-unclassified 'state.accounts[].legacyThing=LEGACY-THING-1'
 *            Options: --clock <ms>              required fixed capture clock (never a live clock)
 *                     --out <path>              restricted canonical model (0600, never overwritten)
 *                     --summary <path>          sanitized counts/hashes only
 *                     --expect-sha256 <hex>     refuse a mismatched file
 *                     --release-sha <sha>       source release provenance
 *                     --allow-unclassified <locator>=<rule-id>   repeatable; records an explicit
 *                                               preserve rule. The value is preserved, never dropped.
 *
 * Console output is limited to paths, counts, checksums and error codes; raw player data is never
 * printed, and an error locator is reduced to its structural shape before it is shown. Every raw
 * destination — including `--snapshot` — is physically bound: the ancestor chain is real-path
 * resolved so a symlink alias cannot place raw source data in a Git checkout, a named published/CI
 * artifact directory (`.git`, `.github`, `.artifacts`, `public`, `public_html`, `dist`, `coverage`) is
 * refused even at mode 0700, and a world-readable directory is refused. There is deliberately NO
 * override flag for raw output. Only `--summary`, which carries structural shapes and counts rather
 * than values, may be written anywhere writable.
 *
 * The full import (`load`), reconciliation (`verify`) and report commands are future parent-owned
 * extensions; they are deliberately NOT present here as stubs, so nothing can be mistaken for a
 * working importer.
 */

const fs = require('node:fs');
const path = require('node:path');
const {canonical, hashText} = require('./canonical.js');
const {readSnapshot, READER_VERSION} = require('./reader.js');
const {capture, CAPTURE_VERSION, assertRawDestinationBound} = require('./capture.js');

function parseArguments(argv) {
  const options = {allowUnclassified: {}};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw cliError('UNKNOWN_ARGUMENT', token);
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value = equals === -1 ? argv[++index] : token.slice(equals + 1);
    if (value === undefined) throw cliError('ARGUMENT_VALUE_REQUIRED', name);
    switch (name) {
      case 'source': case 'snapshot': case 'out': case 'summary': case 'record': options[name] = value; break;
      case 'model': case 'run': case 'target': case 'environment': case 'database-url': case 'extractor-release': options[name === 'database-url' ? 'databaseUrl' : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; break;
      case 'capture-clock': case 'clock': options.clock = value; break;
      case 'expect-sha256': options.expectSha256 = value; break;
      case 'release-sha': options.releaseSha = value; break;
      case 'batch-size': options.batchSize = value; break;
      case 'adopt-existing': options.adoptExisting = true; break;
      case 'allow-unclassified': {
        const split = value.lastIndexOf('=');
        if (split <= 1) throw cliError('ALLOW_UNCLASSIFIED_FORMAT', value);
        options.allowUnclassified[value.slice(0, split)] = value.slice(split + 1);
        break;
      }
      default: throw cliError('UNKNOWN_OPTION', name);
    }
  }
  return options;
}

function cliError(code, locator) {
  const error = new Error(code + (locator ? ':' + locator : ''));
  error.code = code;
  error.locator = locator || null;
  return error;
}

/* Console-safe locator: bracket contents (an actor id, email or primary key) are replaced by `[#]`, and
 * a trailing parenthetical detail is dropped. Exact locators stay in the restricted model/summary. */
function redact(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\[[^\]]*\]/g, '[#]').replace(/\([^)]*\)/g, '').replace(/\s+/, ' ').trim();
}

function guardRawOutput(target) {
  const resolved = assertRawDestinationBound(target, 'output');
  if (fs.existsSync(resolved)) throw cliError('OUTPUT_EXISTS', resolved);
  return resolved;
}

function writeRestricted(target, text) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const handle = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(handle, text); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  const dirHandle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dirHandle); } finally { fs.closeSync(dirHandle); }
  return {path: target, bytes: fs.statSync(target).size, sha256: hashText(text), mode: fs.statSync(target).mode & 0o777};
}

/* A locator reduced to its structural shape: `state.accounts[p0].legacyThing` -> `state.accounts[].legacyThing`.
 * An actor id, email address or primary key embedded in a bracket is removed, so a shareable summary can
 * never name a player. Exact locators stay in the restricted model (coverage.unclassified/accepted). */
function structuralLocator(locator) {
  return typeof locator === 'string' ? locator.replace(/\[[^\]]*\]/g, '[]') : locator;
}

/* The shareable artifact: counts, schema shape, dispositions and aggregate hashes only. Per-actor key
 * maps (`stateRoots.*.byKey`, `hashes.actorHashes`), exact locators and accepted-entry payloads are
 * deliberately omitted — they name actors and belong in the restricted model, never in a summary that
 * may leave the restricted store. Unknown paths are reported as counts and structural shapes so an
 * operator still sees where discovery is needed without leaking a key. */
function sanitizedSummary(model) {
  const tables = Object.fromEntries(Object.entries(model.tables).map(([name, table]) => [name, table.count]));
  const rowsTotal = Object.values(tables).reduce((sum, count) => sum + count, 0);
  const stateRoots = Object.fromEntries(Object.entries(model.hashes.stateRoots).map(([name, entry]) => {
    const shape = {ordered: entry.ordered};
    if (entry.absent) shape.absent = true;
    else if (entry.set !== undefined) shape.set = entry.set;
    shape.keyCount = entry.byKey ? Object.keys(entry.byKey).length : null;
    return [name, shape];
  }));
  const uniqueShapes = (entries) => [...new Set(entries.map((entry) => structuralLocator(entry.locator)))].sort();
  return {
    version: model.version,
    capture: {
      clockMs: model.capture.clockMs,
      sourceSha: model.capture.sourceSha,
      sourceRelease: model.capture.sourceRelease,
      fileSha256: model.capture.fileSha256,
      bytes: model.capture.bytes,
      schemaHead: model.capture.schemaHead.maxId,
      integrity: model.capture.integrity
    },
    schema: {
      tables: model.schema.tables.length,
      indexes: model.schema.indexes.length,
      triggers: model.schema.triggers.length,
      views: model.schema.views.length,
      drift: model.schema.drift
    },
    tables,
    rowsTotal,
    rooms: model.rooms.length,
    stateRows: model.tables.state.count,
    coverage: {
      tables: model.coverage.tables,
      fields: model.coverage.fields,
      dispositions: model.coverage.dispositions,
      unclassified_count: model.coverage.unclassified_count,
      unclassifiedShapes: uniqueShapes(model.coverage.unclassified),
      acceptedCount: model.coverage.accepted.length,
      acceptedShapes: uniqueShapes(model.coverage.accepted)
    },
    hashes: {
      tableRoots: model.hashes.tableRoots,
      stateRoots,
      actorHashesRoot: model.hashes.actorHashesRoot,
      sourceFingerprint: model.hashes.sourceFingerprint,
      normalizationCount: model.hashes.normalization.length,
      normalizationFields: [...new Set(model.hashes.normalization.map((entry) => entry.field))].sort(),
      grammarDriftCount: model.hashes.grammarDrift.length
    }
  };
}

function clock(value) {
  if (value === undefined) throw cliError('CLOCK_REQUIRED', '--capture-clock/--clock');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw cliError('CLOCK_INVALID', value);
  return parsed;
}

async function runCapture(options) {
  if (!options.source) throw cliError('SOURCE_REQUIRED', '--source');
  if (!options.snapshot) throw cliError('SNAPSHOT_REQUIRED', '--snapshot');
  /* Both raw destinations are physically bound before any byte is written anywhere: the snapshot itself
   * is raw production data, and capture() enforces the same bound for direct library callers. */
  guardRawOutput(options.snapshot);
  const recordPath = options.record ? guardRawOutput(options.record) : null;
  const record = await capture(options.source, options.snapshot, {
    captureClockMs: options.clock === undefined ? undefined : clock(options.clock),
    sourceRelease: options.releaseSha ? {sha: options.releaseSha} : undefined
  });
  let recordFile = null;
  if (recordPath) recordFile = writeRestricted(recordPath, canonical(record) + '\n');
  return {
    console: {
      command: 'capture',
      ok: true,
      snapshotPath: record.snapshot.path,
      snapshotSha256: record.snapshot.fileSha256,
      snapshotBytes: record.snapshot.bytes,
      snapshotMode: record.snapshot.mode,
      journalMode: record.snapshot.journalMode,
      sourcePath: record.source.path,
      sourceUnchanged: !record.source.mainFileChangedDuringCapture,
      clockMs: record.captureClockMs,
      clockSource: record.clockSource,
      tables: record.inventory.tables,
      indexes: record.inventory.indexes,
      triggers: record.inventory.triggers,
      views: record.inventory.views,
      rowsTotal: Object.values(record.inventory.tableCounts).reduce((sum, count) => sum + count, 0),
      schemaHead: record.schemaHead.maxId,
      sourceFingerprint: record.extraction.sourceFingerprint,
      unclassifiedCount: record.extraction.coverage.unclassified_count,
      recordFile
    }
  };
}

function runExtract(options) {
  if (!options.snapshot) throw cliError('SNAPSHOT_REQUIRED', '--snapshot');
  const captureClockMs = clock(options.clock);
  let outPath = null;
  if (options.out) outPath = guardRawOutput(options.out);
  /* The summary is the one artifact designed to be shareable, so it is not bound to the raw-output
   * rule; it still must not silently overwrite an existing file. */
  let summaryPath = null;
  if (options.summary) {
    summaryPath = path.resolve(options.summary);
    if (fs.existsSync(summaryPath)) throw cliError('OUTPUT_EXISTS', summaryPath);
  }

  const model = readSnapshot(options.snapshot, {
    captureClockMs,
    expectedSha256: options.expectSha256,
    sourceRelease: options.releaseSha ? {sha: options.releaseSha} : undefined,
    allowUnclassified: options.allowUnclassified
  });
  const sanitized = sanitizedSummary(model);

  const files = {};
  if (outPath) files.model = writeRestricted(outPath, canonical(model) + '\n');
  if (summaryPath) files.summary = writeRestricted(summaryPath, canonical(sanitized) + '\n');
  return {
    console: {
      command: 'extract',
      ok: true,
      readerVersion: READER_VERSION,
      snapshotPath: path.resolve(options.snapshot),
      fileSha256: model.capture.fileSha256,
      clockMs: model.capture.clockMs,
      schemaHead: model.capture.schemaHead.maxId,
      tables: model.schema.tables.length,
      rowsTotal: sanitized.rowsTotal,
      rooms: sanitized.rooms,
      fieldsClassified: model.coverage.fields.total,
      unclassifiedCount: model.coverage.unclassified_count,
      acceptedCount: model.coverage.accepted.length,
      normalizationCount: model.hashes.normalization.length,
      sourceFingerprint: model.hashes.sourceFingerprint,
      files
    }
  };
}

async function main(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === 'help') {
    console.log(JSON.stringify({usage: ['capture --source <db> --snapshot <file> [--capture-clock <ms>] [--release-sha <sha>] [--record <file>]', 'extract --snapshot <file> --clock <ms> [--out <file>] [--summary <file>] [--expect-sha256 <hex>] [--allow-unclassified <locator>=<rule>]', 'load --model <model.json> --run <run-id> --database-url <direct-url> --environment <label> [--release-sha <sha>] [--extractor-release <sha>] [--batch-size <n>] [--adopt-existing] [--summary <file>]', 'verify --model <model.json> --run <run-id> --database-url <direct-url> [--out <differences.jsonl>] [--summary <file>]'], note: 'load/verify operate only on a NON-SERVING target over a direct TLS connection as the trusted migration runner; raw destinations (--snapshot/--out/--record) are bound outside Git and public directories with no override'}, null, 2));
    return 0;
  }
  const command = argv[0];
  const options = parseArguments(argv.slice(1));
  const result = command === 'capture' ? await runCapture(options)
    : command === 'extract' ? runExtract(options)
      : command === 'load' ? await runLoad(options)
        : command === 'verify' ? await runVerify(options)
          : (() => { throw cliError('UNKNOWN_COMMAND', command); })();
  console.log(JSON.stringify(result.console, null, 2));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'CLI_FAILED';
      console.error(JSON.stringify({ok: false, code, locator: redact(error.locator)}, null, 2));
      process.exitCode = 1;
    });
}

/* ------------------------------------------------------- import + reconcile --
 * Both commands act ONLY on a declared non-serving target reached over the trusted direct
 * TLS/channel-binding path as the migration runner (parseAndGuardUrl + a session-level advisory
 * lock + SET LOCAL ROLE v5_owner per transaction, exactly like scripts/v5/migrate.js). They never
 * use the pooled runtime endpoints, never touch the source snapshot, and never print a raw value.
 * The model file is read back as the canonical JSON the extractor produced, so the import is a
 * pure function of an immutable artifact plus the fixed clock it carries.
 * ----------------------------------------------------------------------------- */

function readModel(pathname) {
  const resolved = path.resolve(pathname);
  if (!fs.existsSync(resolved)) throw cliError('MODEL_MISSING', resolved);
  let model;
  try {
    model = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw cliError('MODEL_INVALID', error.message);
  }
  if (!model || typeof model !== 'object' || !model.hashes || !model.state || !model.tables) throw cliError('MODEL_INVALID', 'not a reader model');
  if (typeof model.hashes.sourceFingerprint !== 'string') throw cliError('MODEL_INVALID', 'missing source fingerprint');
  return {model, path: resolved};
}

function requireImportOptions(options) {
  if (!options.model) throw cliError('MODEL_REQUIRED', '--model');
  if (!options.run) throw cliError('RUN_REQUIRED', '--run');
  if (!options.databaseUrl) throw cliError('DATABASE_URL_REQUIRED', '--database-url');
  if (!options.environment) throw cliError('ENVIRONMENT_REQUIRED', '--environment');
  const runId = String(options.run);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw cliError('RUN_INVALID', runId);
  const batchSize = options.batchSize === undefined ? undefined : Number(options.batchSize);
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)) throw cliError('BATCH_SIZE_INVALID', options.batchSize);
  return {runId, batchSize};
}

/* The runner path is imported lazily so the source-side commands stay free of any pg/network
 * dependency, and reused rather than reimplemented so the TLS/PLUS/role rules have exactly one
 * implementation. */
async function withImportClient(options, fn) {
  const migrate = require('../../scripts/v5/migrate.js');
  const {Client} = require('pg');
  // The production classification is computed from the ACTUAL url (database + host), never from
  // the operator-supplied label, so declaring a friendlier --environment cannot downgrade it.
  let looksProd = false;
  try {
    const parsed = new URL(options.databaseUrl);
    const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    looksProd = migrate.classifyTarget(dbName, parsed.hostname).kind === 'production';
  } catch { looksProd = false; }
  const cfg = migrate.parseAndGuardUrl(options.databaseUrl, {production: looksProd});
  const client = new Client({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password,
    ssl: cfg.ssl === false ? false : (cfg.ssl || undefined),
    application_name: 'v5-migration-import/' + options.environment,
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
    enableChannelBinding: cfg.channelBinding === 'require' || cfg.channelBinding === 'prefer'
  });
  await client.connect();
  try {
    const locked = (await client.query('SELECT pg_try_advisory_lock($1) AS got', [migrate.ADVISORY_LOCK_KEY])).rows[0].got;
    if (!locked) throw cliError('IMPORT_BUSY', 'another migration/import holds the advisory lock');
    try {
      return await fn(client, cfg);
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [migrate.ADVISORY_LOCK_KEY]); } catch { /* dropped */ }
    }
  } finally {
    try { await client.end(); } catch { /* already gone */ }
  }
}

function writeShareable(target, payload) {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) throw cliError('OUTPUT_EXISTS', resolved);
  fs.writeFileSync(resolved, payload, {mode: 0o600, flag: 'wx'});
  return {path: resolved, bytes: Buffer.byteLength(payload), sha256: hashText(payload)};
}

async function runLoad(options) {
  const {runId, batchSize} = requireImportOptions(options);
  const {model, path: modelPath} = readModel(options.model);
  const {load} = require('./loader.js');
  return withImportClient(options, async (client, cfg) => {
    const result = await load({
      model,
      runId,
      extractorRelease: options.extractorRelease || model.hashes.sourceFingerprint,
      target: {
        environment: options.environment,
        database: cfg.database,
        adoptExisting: options.adoptExisting === true
      },
      client,
      batchSize,
      sourceRelease: options.releaseSha ? {sha: options.releaseSha} : (model.capture && model.capture.sourceRelease) || undefined
    });
    const safe = {
      command: 'load',
      ok: true,
      runId: result.runId,
      environment: options.environment,
      database: cfg.database,
      modelPath,
      sourceFingerprint: result.sourceFingerprint,
      extractorRelease: result.extractorRelease,
      schemaHead: result.schemaHead,
      batchCount: result.batches.length,
      batches: result.batches.map((b) => ({ordinal: b.ordinal, kind: b.kind, status: b.status, rowsWritten: b.rowsWritten, attempts: b.attemptCount})),
      counters: result.counters,
      coverageCounts: result.coverageCounts,
      targetGuard: result.targetGuard,
      summaryFile: options.summary ? writeShareable(options.summary, canonical({kind: 'v5-import-summary', runId: result.runId, environment: options.environment, sourceFingerprint: result.sourceFingerprint, extractorRelease: result.extractorRelease, schemaHead: result.schemaHead, counters: result.counters, coverageCounts: result.coverageCounts}) + '\n') : null
    };
    return {console: safe};
  });
}

async function runVerify(options) {
  const {runId} = requireImportOptions({...options, run: options.run});
  const {model, path: modelPath} = readModel(options.model);
  const {verify, report} = require('./reconcile.js');
  return withImportClient(options, async (client, cfg) => {
    const runRow = (await client.query('SELECT run_id, source_fingerprint, extractor_release, schema_head FROM v5_migration.run WHERE run_id = $1', [runId])).rows[0];
    if (!runRow) throw cliError('RUN_UNKNOWN', runId);
    const result = await verify({model, run: runRow, client});
    const differences = result.differences || [];
    let outFile = null;
    if (options.out) {
      const resolved = path.resolve(options.out);
      if (fs.existsSync(resolved)) throw cliError('OUTPUT_EXISTS', resolved);
      fs.writeFileSync(resolved, differences.map((d) => JSON.stringify(d)).join('\n') + (differences.length ? '\n' : ''), {mode: 0o600, flag: 'wx'});
      outFile = {path: resolved, rows: differences.length, sha256: hashText(fs.readFileSync(resolved))};
    }
    const summary = typeof report === 'function' ? report(result) : {byCategory: result.byCategory, unexplainedCount: result.unexplainedCount, explainedCount: result.explainedCount};
    return {
      console: {
        command: 'verify',
        ok: result.unexplainedCount === 0,
        runId,
        environment: options.environment,
        database: cfg.database,
        modelPath,
        schemaHead: runRow.schema_head,
        unexplainedCount: result.unexplainedCount,
        explainedCount: result.explainedCount,
        byCategory: result.byCategory,
        invariants: result.invariants || null,
        differencesFile: outFile,
        summaryFile: options.summary ? writeShareable(options.summary, canonical(summary) + '\n') : null
      }
    };
  });
}

module.exports = {main, parseArguments, sanitizedSummary};
