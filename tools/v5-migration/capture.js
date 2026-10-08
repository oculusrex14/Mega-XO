'use strict';
/* tools/v5-migration/capture.js - WAL-consistent, non-overwriting capture of an immutable snapshot.
 *
 * Usage (library):
 *   const {capture} = require('./tools/v5-migration/capture.js');
 *   const record = await capture('/restricted/live/mega.sqlite', '/restricted/captures/mega.snapshot.sqlite', {
 *     captureClockMs: 1791396595015,      // the semantic clock recorded for extraction
 *     sourceRelease: {sha: '455b8ec9...'},
 *   });
 *
 * Guarantees (contract: local://v5-p03-source-contract.md):
 *   - The copy is made with the SQLite online backup API through the existing, production-proven
 *     `snapshot()` in server/production/backup.js (WAL content included), never by copying the main
 *     file alone. That module opens the source read-only and never constructs a store.
 *   - The target is never overwritten: an existing target, its journal side files and its manifest
 *     are refused before any byte is written, and the target name is reserved with an exclusive
 *     create before the finished artifact is renamed into place.
 *   - Sensitive bytes never land in a shared directory: the online backup is written into a fresh
 *     0700 staging directory created before the first byte, at 0600 in WAL mode, normalized to
 *     journal_mode=delete inside that private directory, then moved to the destination. Created
 *     artifacts are 0600; a parent directory this call creates is 0700. The artifact and its directory
 *     are fsynced before the call returns.
 *   - The canonical destination is physically bound: the ancestor chain is real-path resolved so a
 *     symlink alias cannot place raw production data in a Git checkout, a named published/CI artifact
 *     directory (.git, .github, .artifacts, public, public_html, dist, coverage) is refused even at mode
 *     0700, and a world-readable destination directory is refused. Enforced in this function, so direct
 *     library callers are safe too. There is no override flag.
 *   - The artifact is normalized to journal_mode=delete *on the copy only*, so the immutable
 *     snapshot needs no -shm/-wal side file and a later read-only open provably writes nothing.
 *     The source file is never written, never checkpointed and never switched out of WAL mode.
 *   - The finished artifact is validated by the extractor itself (`readSnapshot`): quick_check,
 *     foreign_key_check, source-schema table/index/trigger inventory and every v4_schema checksum.
 *   - No network, no provider call, no store/authority constructor. The source's live clock is never
 *     consulted: `captureClockMs` is either supplied or taken from the backup manifest's own
 *     creation stamp, and is recorded without altering any source state.
 *   - Source retrieval stays with the existing Restic tooling; this module only ever consumes a
 *     local file that an operator has already retrieved.
 */

const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync, backup} = require('node:sqlite');
const {hashFile, sqliteHeader, readSnapshot, describeSource} = require('./reader.js');

const CAPTURE_VERSION = 1;

function captureError(code, locator, detail) {
  const error = new Error(code + (locator ? ':' + locator : '') + (detail ? ' (' + detail + ')' : ''));
  error.code = code;
  error.locator = locator || null;
  if (detail) error.detail = detail;
  return error;
}

function ensureParent(directory) {
  const created = [];
  let current = path.resolve(directory);
  const lineage = [];
  while (!fs.existsSync(current)) { lineage.unshift(current); current = path.dirname(current); if (current === path.dirname(current)) break; }
  for (const candidate of lineage) {
    fs.mkdirSync(candidate, {mode: 0o700});
    created.push(candidate);
  }
  return created;
}

/* Path segments that are published, served or collected as CI artifacts, as named by the source
 * contract. Raw player data must never be written under one of these, regardless of its permission
 * bits, because the content is published whether or not the leaf directory happens to be 0700. */
const PUBLISHED_PATH_SEGMENTS = Object.freeze([
  '.git', '.github', '.artifacts', 'public', 'public_html', 'dist', 'coverage'
]);

/* Physical destination bound for raw data, enforced in the library so any caller is safe.
 *  - The ancestor chain is real-path resolved, so a symlink alias cannot place a raw copy of production
 *    data in a refused location.
 *  - Any ancestor named as a published/CI artifact segment is refused even when its mode is 0700.
 *  - A world-readable destination directory (group/other bit) is refused.
 * There is deliberately no override flag. */
function assertRawDestinationBound(target, label) {
  const resolved = path.resolve(target);
  let current = resolved;
  const seen = new Set();
  for (;;) {
    if (seen.has(current)) throw captureError('OUTPUT_PATH_CYCLE', label);
    seen.add(current);
    let real = current;
    if (fs.existsSync(current)) {
      try { real = fs.realpathSync(current); } catch { throw captureError('OUTPUT_PATH_UNREADABLE', label); }
    }
    if (fs.existsSync(path.join(real, '.git'))) throw captureError('OUTPUT_INSIDE_GIT_CHECKOUT', label);
    /* Walk every segment of the resolved path, including segments that do not exist yet, so a name
     * chosen for publication (public/, dist/, coverage/, .github/, .artifacts/) is refused up front. */
    const segments = real.split(path.sep).filter(Boolean);
    for (const segment of segments) {
      if (PUBLISHED_PATH_SEGMENTS.includes(segment.toLowerCase())) {
        throw captureError('OUTPUT_IN_PUBLISHED_LOCATION', label, segment);
      }
    }
    const parent = path.dirname(real);
    if (parent === real) break;
    current = parent;
  }
  const directory = path.dirname(resolved);
  if (fs.existsSync(directory) && (fs.statSync(directory).mode & 0o007) !== 0) {
    throw captureError('OUTPUT_DIRECTORY_PUBLIC', label);
  }
  return resolved;
}

function fsyncPath(target) {
  const handle = fs.openSync(target, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function refuseExisting(target) {
  for (const candidate of [target, target + '.json', target + '-wal', target + '-shm', target + '-journal']) {
    if (fs.existsSync(candidate)) throw captureError('CAPTURE_TARGET_EXISTS', candidate, 'refusing to overwrite an existing artifact');
  }
}

/* Normalizes the *copy* only. The artifact has no journal side file, so a read-only open of it can
 * never create one and can never checkpoint anything. */
function normalizeCopy(file) {
  const db = new DatabaseSync(file);
  try {
    const result = db.prepare('PRAGMA journal_mode=DELETE').get();
    if (!result || result.journal_mode !== 'delete') throw captureError('CAPTURE_NORMALIZE_FAILED', file, String(result && result.journal_mode));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) {
      if (fs.statSync(file + suffix).size !== 0) throw captureError('CAPTURE_SIDE_FILE_REMAINS', file + suffix);
      fs.unlinkSync(file + suffix);
    }
  }
}

async function capture(sourcePath, snapshotPath, options = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath) throw captureError('SOURCE_PATH_REQUIRED', null);
  if (typeof snapshotPath !== 'string' || !snapshotPath) throw captureError('SNAPSHOT_PATH_REQUIRED', null);
  const source = path.resolve(sourcePath);
  const target = path.resolve(snapshotPath);
  if (source === target) throw captureError('CAPTURE_PATH_IDENTICAL', source);
  if (!fs.existsSync(source)) throw captureError('SOURCE_MISSING', source);
  const sourceHeader = sqliteHeader(source);
  if (sourceHeader.magic !== 'SQLite format 3\u0000') throw captureError('SOURCE_NOT_SQLITE', source);
  refuseExisting(target);
  if (fs.existsSync(target)) throw captureError('CAPTURE_TARGET_EXISTS', target);
  /* The staging directory and the artifact are raw production data, so the bound is enforced before
   * the first byte is written anywhere. */
  assertRawDestinationBound(target, 'snapshot');

  /* Required lazily so this module can be inspected without loading a production helper. */
  // eslint-disable-next-line global-require
  const productionBackup = require('../../server/production/backup.js');

  const parentCreated = ensureParent(path.dirname(target));
  const sourceShaBefore = hashFile(source);
  const sourceSideFilesBefore = ['-wal', '-shm'].filter((suffix) => fs.existsSync(source + suffix));

  let record = null;
  let staging = null;
  try {
    /* Sensitive bytes must never land in a directory another user can read, so the online backup is
     * written into a fresh 0700 staging directory created BEFORE the first byte. The copy lives there
     * at 0600 (backup.snapshot chmods its file) in WAL mode; it is normalized to journal_mode=delete
     * inside the same private directory, then moved to the canonical destination. This closes the
     * window in which a WAL copy of production data could sit in a shared temp directory. */
    staging = fs.mkdtempSync(path.join(path.dirname(target), '.v5-capture-'));
    fs.chmodSync(staging, 0o700);
    const working = path.join(staging, 'snapshot');
    const temporary = path.join(staging, 'artifact');

    await productionBackup.snapshot(source, working);
    /* Verify the fresh copy against its own manifest (integrity_check, state row, schema count,
     * byte length and sha256) before the manifest is discarded. */
    const verified = await productionBackup.verify(working);
    if (fs.existsSync(working + '.json')) fs.unlinkSync(working + '.json');
    fs.renameSync(working, temporary); // both names are inside the same private directory
    normalizeCopy(temporary);
    fs.chmodSync(temporary, 0o600);

    const clockSource = typeof options.captureClockMs === 'number' ? 'supplied'
      : (Number.isFinite(verified.createdAt) ? 'backup-manifest' : 'unspecified');
    const captureClockMs = clockSource === 'supplied' ? options.captureClockMs
      : clockSource === 'backup-manifest' ? verified.createdAt : null;
    if (captureClockMs !== null && (!Number.isFinite(captureClockMs) || captureClockMs < 0)) {
      throw captureError('CAPTURE_CLOCK_INVALID', 'captureClockMs', String(captureClockMs));
    }

    const snapshotSha = hashFile(temporary);
    const snapshotBytes = fs.statSync(temporary).size;

    /* The extractor validates the artifact that will actually be consumed. */
    const model = captureClockMs === null ? validateStructurally(temporary)
      : readSnapshot(temporary, {captureClockMs, sourceRelease: options.sourceRelease, expectedSha256: snapshotSha, reportCoverageOnly: true});

    fsyncPath(temporary);
    reserveAndInstall(temporary, target);
    /* Re-chmod after the rename: renameSync carries the source mode, but the final artifact must be
     * 0600 regardless, and the directory fsync makes the reservation and the rename durable. */
    fs.chmodSync(target, 0o600);
    fsyncPath(path.dirname(target));

    const sourceShaAfter = hashFile(source);
    record = {
      version: CAPTURE_VERSION,
      source: {
        path: source,
        fileSha256Before: sourceShaBefore,
        fileSha256After: sourceShaAfter,
        mainFileChangedDuringCapture: sourceShaBefore !== sourceShaAfter,
        bytes: fs.statSync(source).size,
        journalModeOnDisk: sourceHeader.wal ? 'wal' : 'delete',
        sideFilesBefore: sourceSideFilesBefore,
        sideFilesAfter: ['-wal', '-shm'].filter((suffix) => fs.existsSync(source + suffix))
      },
      snapshot: {
        path: target,
        fileSha256: snapshotSha,
        bytes: snapshotBytes,
        journalMode: 'delete',
        sideFiles: ['-wal', '-shm', '-journal'].filter((suffix) => fs.existsSync(target + suffix)),
        mode: fs.statSync(target).mode & 0o777
      },
      captureClockMs,
      clockSource,
      backupManifest: {version: verified.version, createdAt: verified.createdAt, schema: verified.schema},
      sourceRelease: options.sourceRelease || null,
      integrity: model.capture.integrity,
      schemaHead: model.capture.schemaHead,
      inventory: {
        tables: model.schema.tables.length,
        indexes: model.schema.indexes.length,
        triggers: model.schema.triggers.length,
        views: model.schema.views.length,
        tableCounts: Object.fromEntries(Object.entries(model.tables).map(([name, table]) => [name, table.count])),
        drift: model.schema.drift
      },
      extraction: {
        readerVersion: model.version,
        sourceFingerprint: model.hashes.sourceFingerprint,
        tableRoots: model.hashes.tableRoots,
        /* Aggregate hashes only; the per-actor `byKey` map stays in the restricted model. */
        stateRoots: Object.fromEntries(Object.entries(model.hashes.stateRoots).map(([name, entry]) => [name, {
          ordered: entry.ordered,
          absent: entry.absent === true,
          set: entry.set === undefined ? null : entry.set,
          keyCount: entry.byKey ? Object.keys(entry.byKey).length : null
        }])),
        actorHashesRoot: model.hashes.actorHashesRoot,
        actorCount: model.hashes.actorHashes ? Object.keys(model.hashes.actorHashes).length : null,
        normalizationCount: model.hashes.normalization.length,
        normalizationFields: [...new Set(model.hashes.normalization.map((entry) => entry.field))].sort(),
        grammarDriftCount: model.hashes.grammarDrift.length,
        coverage: {
          tables: model.coverage.tables,
          fields: model.coverage.fields,
          dispositions: model.coverage.dispositions,
          unclassified_count: model.coverage.unclassified_count,
          unclassified_locators: model.coverage.unclassified.map((item) => item.locator),
          accepted_count: model.coverage.accepted.length,
          accepted: model.coverage.accepted.map((item) => item.locator + '=' + item.ruleId)
        }
      },
      createdDirectories: parentCreated,
      capturedAtMs: Number.isFinite(options.capturedAtMs) ? options.capturedAtMs : null
    };
  } finally {
    /* The staging directory holds a raw copy of production data; remove it and everything in it,
     * including the nested snapshot() scratch copy and any journal side file. */
    if (staging && fs.existsSync(staging)) fs.rmSync(staging, {recursive: true, force: true});
  }
  return record;
}

/* Structural validation used when no capture clock is known, so capture stays usable without
 * inventing one. It runs the same source-schema checksum and inventory checks the extractor will, and
 * reports (never enforces) coverage: the coverage gate belongs to extraction, where the operator's
 * `--allow-unclassified` rules are supplied. */
function validateStructurally(file) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const {integrity, schema, schemaHead} = describeSource(db, file);
    const state = db.prepare('SELECT json FROM state WHERE id=1').get();
    if (!state || typeof state.json !== 'string') throw captureError('SOURCE_STATE_MISSING', file);
    return {
      version: 1,
      capture: {integrity, schemaHead},
      schema: {tables: schema.tables, indexes: schema.indexes, triggers: schema.triggers, views: schema.views, drift: {unverified: 'no capture clock supplied; coverage not classified'}},
      tables: Object.fromEntries(schema.tableNames.map((name) => [name, {count: db.prepare('SELECT count(*) AS n FROM ' + JSON.stringify(name)).get().n}])),
      rooms: [],
      coverage: {tables: [], fields: {total: null, unclassified: null, accepted: null}, dispositions: {}, unclassified_count: 0, unclassified: [], accepted: []},
      hashes: {sourceFingerprint: null, tableRoots: {}, stateRoots: {}, actorHashesRoot: null, actorHashes: null, normalization: [], grammarDrift: []}
    };
  } finally { db.close(); }
}

/* Reserves the target name with an exclusive create (so a concurrent writer cannot be clobbered),
 * then installs the finished artifact by rename over our own reservation. */
function reserveAndInstall(temporary, target) {
  const reservation = fs.openSync(target, 'wx', 0o600);
  fs.closeSync(reservation);
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
}

if (require.main === module) {
  const [source, target, clock] = process.argv.slice(2);
  capture(source, target, clock ? {captureClockMs: Number(clock)} : {})
    .then((record) => console.log(JSON.stringify({ok: true, snapshot: record.snapshot.fileSha256, tables: record.inventory.tables})))
    .catch((error) => { console.error(/^[A-Z_]+$/.test(error.code || '') ? error.code : 'CAPTURE_FAILED'); process.exitCode = 1; });
}

module.exports = {capture, CAPTURE_VERSION, captureError, assertRawDestinationBound, PUBLISHED_PATH_SEGMENTS};
