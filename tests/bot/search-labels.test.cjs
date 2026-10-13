'use strict';
// Regression: the requested search depth must actually REACH the alpha-beta search. The original bug
// was that `generate()` did not accept/propagate `depth`, and even forwarded the Expert node budget
// (350k) capped completed depth well below 12. These tests assert the depth is threaded end-to-end and
// that the ACTUAL completed depth (not the requested one) is recorded for provenance.
//
// Kept cheap: a short per-search budget means the search stops on the node/time budget (not depth), so
// these tests run in seconds while still proving the request is threaded. Deep classical search is
// genuinely expensive (depth 16 needs ~20M+ nodes / tens of seconds) — that cost is why the RL plan
// prioritises neural-guided search over deeper alpha-beta.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Data = require('../../training/bot/search-labels.cjs');

test('requested depth reaches the search config and real diagnostics are recorded per row', () => {
  const g = Data.game({ seed: 4242, simulations: 4, budgetMs: 60, openingPlies: 2, depth: 16 });
  assert.ok(g.rows.length > 0);
  for (const row of g.rows) {
    assert.equal(row.requestedDepth, 16, 'the search received maxDepth=16 (not the Expert default 12)');
    assert.equal(row.valueTargetSource, 'deep-search-root-score');
    assert.ok(Number.isInteger(row.searchDepth) && row.searchDepth >= 0, 'actual completed depth recorded');
    assert.ok(row.searchDepth <= 16, 'completed depth cannot exceed the request');
    assert.ok(Number.isInteger(row.searchNodes) && row.searchNodes >= 0, 'real node count recorded');
    assert.ok(typeof row.searchReason === 'string' && row.searchReason.length > 0);
    assert.ok(Number.isFinite(row.rootScore) && Number.isFinite(row.valueTarget));
    assert.equal(typeof row.forcedWin, 'boolean');
    // An immediate forced mega win short-circuits at the root (completedDepth 0, nodes 0); any search
    // that actually ran a deepening iteration must report the depth it reached.
    if (row.searchReason === 'forced-mega-win') assert.equal(row.searchDepth, 0);
    else assert.ok(row.searchDepth >= 1, 'a deepening search that ran reports its real completed depth');
  }
});

test('generate() accepts and forwards depth; manifest + searchQuality bind the real request', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-sl-'));
  try {
    const m = Data.generate({ output: path.join(dir, 'd.jsonl'), games: 1, seed: 909, simulations: 4, budgetMs: 60, depth: 16 });
    assert.equal(m.requestedDepth, 16);
    assert.equal(m.searchQuality.requestedDepth, 16);
    assert.ok(m.searchQuality.maxCompletedDepth >= 1 && m.searchQuality.maxCompletedDepth <= 16);
    assert.equal(m.searchQuality.perGameMaxCompletedDepth.length, 1);
    assert.equal(m.teacher.requestedDepth, 16);
    // The generator must refuse a nonsensical depth instead of silently ignoring it.
    assert.throws(() => Data.generate({ output: path.join(dir, 'x.jsonl'), games: 1, depth: 0 }), /INVALID_DEPTH/);
    assert.throws(() => Data.generate({ output: path.join(dir, 'y.jsonl'), games: 1, depth: 21 }), /INVALID_DEPTH/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('default (no depth) records the Expert default request, never an invented deep depth', () => {
  const g = Data.game({ seed: 77, simulations: 4, budgetMs: 60, openingPlies: 2 });
  for (const row of g.rows) assert.equal(row.requestedDepth, 12, 'Expert default depth is the recorded request');
});
