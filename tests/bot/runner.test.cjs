'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/game.js');
const E = require('../../src/bot/encoding.js');
const R = require('./runner.cjs');
const T = require('./tactics.cjs');

test('paired runner reverses sides, starters and replays legal whole games', () => {
  const x = R.league(R.legacy('Easy'), R.legacy('Beginner'), { pairs: 3 });
  const y = R.league(R.legacy('Easy'), R.legacy('Beginner'), { pairs: 3 });
  assert.deepEqual(x.games.map(g => g.moves), y.games.map(g => g.moves));
  assert.equal(x.summary.games, 6);
  assert.equal(x.games[1].swap, true);
  assert.equal(x.games[2].first, 'O');
  for (const g of x.games) {
    let s = G.create(g.first);
    for (const m of g.moves) s = G.apply(s, m);
    assert.equal(s.winner, g.winner);
  }
});

test('terminal states have no critical moves and illegal suggestions fail', () => {
  const state = G.create();
  assert.equal(T.verifyCritical(state, { b: 99, c: 0 }), false);
  assert.deepEqual(T.goals({ ...state, winner: 'DRAW' }), []);
});

test('at least 100 independent D4 opening families supported with strict leakage exclusion', () => {
  const families = R.holdoutFamilies({ minFamilies: 105, seed: 1234 });
  assert.ok(families.length >= 100, `must have at least 100 families, got ${families.length}`);

  const distinctD4 = new Set();
  for (const opening of families) {
    assert.ok(opening.length >= 2, 'openings must have at least 2 plies');
    // Verify reachability by canonical rules
    let s = G.create('X');
    for (const m of opening) {
      assert.ok(G.legal(s).some(x => x.b === m.b && x.c === m.c), 'move in opening must be legal');
      s = G.apply(s, m);
    }

    const fam = R.family(opening);
    distinctD4.add(fam);

    // Verify leakage exclusion: every opening family MUST belong to the 'holdout' split
    const split = R.splitFor(fam);
    assert.equal(split, 'holdout', `family ${fam} leaked into ${split}`);

    // Verify D4 dihedral symmetry commutation: all 8 symmetric transforms map to same family
    for (let sym = 0; sym < 8; sym++) {
      const mapped = opening.map(m => E.mapMove(m, sym));
      assert.equal(R.family(mapped), fam, `symmetry ${sym} must produce identical family ID`);
    }
  }
  assert.ok(distinctD4.size >= 100, `must have at least 100 distinct D4 families, got ${distinctD4.size}`);
});

test('paired bootstrap confidence intervals and uncertainty labels behave honestly', () => {
  // Fewer than 30 pairs -> smoke uncertainty flag
  const smoke = R.league(R.legacy('Easy'), R.legacy('Beginner'), { pairs: 4 });
  assert.ok(smoke.summary.uncertainty.includes('SMOKE ONLY'));
  assert.equal(smoke.summary.games, 8);

  // Opening diversity metrics
  assert.ok(typeof smoke.summary.openingDiversity.repetitionRate === 'number');
  assert.ok(typeof smoke.summary.openingDiversity.entropy === 'number');
  assert.ok(smoke.summary.openingDiversity.uniqueMoves >= 1);
});

test('adjacent-tier calibration reports step-by-step monotonicity and honest uncertainty', () => {
  const easy = R.legacy('Easy');
  const beg = R.legacy('Beginner');
  const leagues = [R.league(easy, beg, { pairs: 2, seed: 50 })];
  const cal = R.tierCalibration(leagues);
  assert.equal(cal.length, 1);
  assert.equal(cal[0].tierA, 'legacy-Easy');
  assert.equal(cal[0].tierB, 'legacy-Beginner');
  assert.ok(typeof cal[0].pointScore === 'number');
  assert.ok(typeof cal[0].monotonic === 'boolean');
  assert.ok(['statistically-separated', 'directionally-higher', 'inverted-or-tied'].includes(cal[0].status));
});

test('scripted adversary replays moves legally and falls back appropriately', () => {
  const exp = R.legacy('Expert');
  const sample = R.play(R.legacy('Easy'), exp, { seed: 15 });
  const scriptBot = R.scripted(sample.moves);

  let s = G.create('X');
  const m1 = scriptBot.choose(s, () => 0.5);
  assert.deepEqual(m1, sample.moves[0]);

  // When state deviates from script, falls back legally
  const illegalState = G.apply(G.apply(s, { b: 0, c: 4 }), { b: 4, c: 0 });
  const fallbackMove = scriptBot.choose(illegalState, () => 0.5);
  assert.ok(G.legal(illegalState).some(x => x.b === fallbackMove.b && x.c === fallbackMove.c));
});
