'use strict';
/* tests/helpers/v5-migration-fixture.js
 *
 * Fixture-side test helper (owner: SourceFixtures). Thin, deterministic orchestration around
 * tools/v5-migration/fixtures/build-synthetic-source.js plus the P03 capture/reader entry points, so
 * the parent's importer/reconciler smoke drives ONE code path instead of re-deriving it:
 *
 *   build  ->  capture (immutable snapshot)  ->  readSnapshot (raw version-1 source model)
 *
 * It contains no fixture data of its own: every row comes from the generator, and `expected` is the
 * generator's own factual block. The helper never asserts, never starts a server, never makes a
 * provider call, and never writes inside the repository - both the source directory and the snapshot
 * directory are created under the OS temp directory and removed by `cleanup()`.
 *
 * Usage:
 *   const {openVariant, openAllVariants, VARIANTS} = require('./helpers/v5-migration-fixture');
 *   const ws = openVariant('representative');
 *   try {
 *     ws.fixture.expected.balances;         // factual source values for reconciliation
 *     ws.capture;                           // capture record (hashes/counts only)
 *     const model = ws.read();              // version-1 source model, or throws the reader's own error
 *   } finally { ws.cleanup(); }
 *
 * Refusal behaviour (verified against the current capture.js/reader.js):
 *   - `representative` and `legacy` capture and read cleanly (35 tables, 4 rooms, 0 unclassified).
 *   - `unknown-field` captures (capture records unclassified locators) and `read()` throws
 *     COVERAGE_INCOMPLETE naming exactly `expected.refusal.locators`.
 *   - `unsafe-asset` is refused even by capture, because its non-finite/unsafe numeric literals fail in
 *     canonical.js before coverage is computed; `captureSnapshot()` rethrows that refusal.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildSyntheticSource, buildAllSyntheticSources, VARIANTS, DEFAULT_CLOCK_MS } = require('../../tools/v5-migration/fixtures/build-synthetic-source.js');
const { capture } = require('../../tools/v5-migration/capture.js');
const { readSnapshot } = require('../../tools/v5-migration/reader.js');

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return directory;
}

/* Builds one variant into its own source + snapshot directories and returns an accessor object.
   `read()` is lazy so a caller can inspect `expected` even when the reader currently refuses the
   fixture; the reader's own error (with its `code`/`locator`) is propagated verbatim. */
function openVariant(variant = 'representative', { clockMs = DEFAULT_CLOCK_MS } = {}) {
  if (!VARIANTS.includes(variant)) throw Error('UNKNOWN_FIXTURE_VARIANT: ' + String(variant));
  const base = tempDirectory('mega-v5-p03-fixture-' + variant + '-');
  const sourceDirectory = path.join(base, 'source');
  const snapshotDirectory = path.join(base, 'capture');
  fs.mkdirSync(sourceDirectory, { mode: 0o700 });
  fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
  const fixture = buildSyntheticSource({ directory: sourceDirectory, clockMs, variant });
  const snapshotPath = path.join(snapshotDirectory, 'source-snapshot.sqlite');
  let captureRecord = null;
  let model = null;
  return {
    variant,
    clockMs,
    fixture,
    expected: fixture.expected,
    file: fixture.file,
    snapshotPath,
    get capture() { return captureRecord; },
    /* Immutable capture: the reader must consume this snapshot, never the live fixture file. */
    async captureSnapshot() {
      if (!captureRecord) captureRecord = await capture(fixture.file, snapshotPath, { captureClockMs: fixture.clockMs, sourceRelease: fixture.sourceRelease });
      return captureRecord;
    },
    /* Version-1 source model from the captured snapshot (throws the reader's own refusal error). */
    read() {
      if (!captureRecord) throw Error('SNAPSHOT_REQUIRED: captureSnapshot() first');
      if (!model) model = readSnapshot(snapshotPath, { captureClockMs: fixture.clockMs, sourceRelease: fixture.sourceRelease });
      return model;
    },
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

/* Builds every variant into one shared temp base and returns {variant -> accessor}. */
function openAllVariants({ clockMs = DEFAULT_CLOCK_MS } = {}) {
  const base = tempDirectory('mega-v5-p03-fixtures-');
  const built = buildAllSyntheticSources({ directory: base, clockMs });
  const workspaces = Object.fromEntries(Object.entries(built).map(([variant, fixture]) => {
    const snapshotDirectory = path.join(base, variant + '-capture');
    fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
    const snapshotPath = path.join(snapshotDirectory, 'source-snapshot.sqlite');
    let captureRecord = null;
    let model = null;
    const workspace = {
      variant, clockMs, fixture, expected: fixture.expected, file: fixture.file, snapshotPath,
      get capture() { return captureRecord; },
      async captureSnapshot() {
        if (!captureRecord) captureRecord = await capture(fixture.file, snapshotPath, { captureClockMs: fixture.clockMs, sourceRelease: fixture.sourceRelease });
        return captureRecord;
      },
      read() {
        if (!captureRecord) throw Error('SNAPSHOT_REQUIRED: captureSnapshot() first');
        if (!model) model = readSnapshot(snapshotPath, { captureClockMs: fixture.clockMs, sourceRelease: fixture.sourceRelease });
        return model;
      },
    };
    return [variant, workspace];
  }));
  return { base, workspaces, cleanup() { fs.rmSync(base, { recursive: true, force: true }); } };
}

/* Convenience: build + capture + read one variant and hand back everything at once. */
async function readVariant(variant = 'representative', options = {}) {
  const workspace = openVariant(variant, options);
  try {
    const captureRecord = await workspace.captureSnapshot();
    return {
      variant,
      expected: workspace.expected,
      hazards: workspace.fixture.hazards,
      limitations: workspace.fixture.limitations,
      capture: captureRecord,
      model: workspace.read(),
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    workspace.cleanup();
    throw error;
  }
}

module.exports = { openVariant, openAllVariants, readVariant, VARIANTS, DEFAULT_CLOCK_MS };
