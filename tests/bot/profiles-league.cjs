'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const S = require('../../src/bot/search.js');
const R = require('./runner.cjs');

const [pairsArg = '100', output = '.artifacts/v51/profiles-league.json'] = process.argv.slice(2);
const pairs = Number(pairsArg);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 100000) {
  throw Error('INVALID_PAIRS');
}

const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync('src/bot/search.js')).digest('hex');
const rulesSha256 = crypto.createHash('sha256').update(fs.readFileSync('src/game.js')).digest('hex');

const engine = level => ({
  id: level,
  version: S.VERSION,
  budget: JSON.stringify(S.PROFILES[level]),
  choose: (s, rng) => S.choose(s, { difficulty: level, seed: Math.floor(rng() * 4294967296) }).move
});

// At least 100 independent paired opening families with strict leakage exclusion
const holdoutCount = Math.max(100, pairs);
const openings = R.holdoutFamilies({ minFamilies: holdoutCount, seed: 888, plies: 4 });
const leakageExcluded = openings.every(o => R.splitFor(R.family(o)) === 'holdout');

// Test adjacent difficulty tiers: Beginner -> Easy -> Medium -> Hard -> Expert
const leagues = [];
for (let i = 1; i < G.LEVELS.length; i++) {
  const higherTier = G.LEVELS[i];
  const lowerTier = G.LEVELS[i - 1];
  leagues.push(R.league(engine(higherTier), engine(lowerTier), {
    pairs,
    seed: 613 + i * 100,
    openings
  }));
}

// Adjacent-tier calibration analysis
const calibration = R.tierCalibration(leagues);

// Opening diversity across tiers from empty board across seeds
const emptyBoard = G.create('X');
const tierDiversity = {};
for (const level of G.LEVELS) {
  const choices = [];
  for (let s = 1; s <= 20; s++) {
    const move = S.choose(emptyBoard, { difficulty: level, seed: s }).move;
    choices.push({ moves: [move] });
  }
  tierDiversity[level] = R.openingDiversity(choices);
}

const report = {
  schemaVersion: 1,
  runtime: process.version,
  sourceSha256,
  rulesSha256,
  ruleset: C.RULESET,
  modelHash: 'no-model-search',
  pairs,
  holdoutFamiliesCount: openings.length,
  leakageExcluded,
  scope: 'Adjacent-tier calibration with balanced X/O on independently held-out D4 opening families. One runtime is not cross-device calibration.',
  calibration,
  tierDiversity,
  leagues: leagues.map(l => ({
    higherTier: l.engineA,
    lowerTier: l.engineB,
    summary: l.summary
  })),
  promotionApproved: false
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({
  pairs,
  holdoutFamiliesCount: report.holdoutFamiliesCount,
  calibration,
  tierDiversity
}, null, 2));
