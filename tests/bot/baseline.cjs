'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const R = require('./runner.cjs');
const T = require('./tactics.cjs');

const [outputArg] = process.argv.slice(2);
const defaultOutput = '.artifacts/v51/baseline.json';
const outputFile = outputArg || defaultOutput;

const corpus = T.corpus();

function evaluateCorpus(budget) {
  return corpus.map(p => {
    let s = G.create(p.first);
    for (const m of p.moves) s = G.apply(s, m);
    return {
      id: p.id,
      moves: G.LEVELS.map(level => ({
        level,
        choices: [1, 2, 3].map(seed => R.legacy(level, { budget }).choose(s, C.seeded(seed)))
      }))
    };
  });
}

// 1. Freeze deterministic 512-node ceiling choices
const deterministicOutcomes = evaluateCorpus('nodes');

// 2. Freeze full-budget original G.choose choices
const fullBudgetOutcomes = evaluateCorpus('wall');

// 3. Document identical sequences
const opening = G.create('X');
const repeatedExpertOpening = [1, 2, 3, 4].map(seed => R.legacy('Expert', { budget: 'wall' }).choose(opening, C.seeded(seed)));
const expertA = R.legacy('Expert', { budget: 'nodes' });
const expertB = R.legacy('Expert', { budget: 'nodes' });

// Play two separate matches between Expert and Expert with different RNG seeds
const match1 = R.play(expertA, expertB, { seed: 101, first: 'X' });
const match2 = R.play(expertA, expertB, { seed: 999, first: 'X' });
const identicalExpertSelfPlay = match1.moves.length === match2.moves.length &&
  match1.moves.every((m, i) => C.sameMove(m, match2.moves[i]));

// 4. Seeded script-playing adversary
const sample = R.play(R.legacy('Easy', { budget: 'nodes' }), expertA, { seed: 72 });
const exploit = R.league(R.scripted(sample.moves), expertA, { pairs: 4, seed: 91 });

const result = {
  schemaVersion: 1,
  baselineCommit: 'f8913fd36566f0c96d0b755b1e4e57be1795a266',
  rulesSha256: crypto.createHash('sha256').update(fs.readFileSync('src/game.js')).digest('hex'),
  runtime: process.version,
  budget: 'Deterministic 512-node ceiling via injected clock and original full-budget per-tier caps captured side-by-side',
  repeatedExpertOpening,
  repeatedOpeningDeterministic: repeatedExpertOpening.every(m => C.sameMove(m, repeatedExpertOpening[0])),
  repeatedExpertSequences: {
    match1MovesCount: match1.moves.length,
    match2MovesCount: match2.moves.length,
    identicalSequencesAcrossDifferentSeeds: identicalExpertSelfPlay,
    sampleSequence: match1.moves.slice(0, 10).map(({ b, c }) => ({ b, c }))
  },
  corpus,
  outcomes: deterministicOutcomes,
  fullBudgetOutcomes,
  exploit: {
    scriptTrainingSeed: 72,
    scriptMoveCount: sample.moves.length,
    pairs: exploit.pairs,
    seed: exploit.seed,
    summary: exploit.summary,
    promotionEvidence: false,
    uncertainty: exploit.summary.uncertainty
  },
  promotionApproved: false
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n');

// Also update evidence file if directory exists and running in evidence mode
const evidenceFile = 'docs/v5.1/bot-ai/evidence/baseline.json';
if (fs.existsSync(path.dirname(evidenceFile)) && outputArg === evidenceFile) {
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2) + '\n');
}

console.log(JSON.stringify({
  cases: corpus.map(x => x.id),
  repeatedOpening: repeatedExpertOpening.slice(0, 2),
  identicalExpertSelfPlay,
  exploit: exploit.summary
}, null, 2));
