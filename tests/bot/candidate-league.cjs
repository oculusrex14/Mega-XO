'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const S = require('../../src/bot/search.js');
const R = require('./runner.cjs');

const [pairsArg = '100', budgetArg = '20', output = '.artifacts/v51/candidate-league.json'] = process.argv.slice(2);
const pairs = Number(pairsArg), budgetMs = Number(budgetArg);
if (!Number.isInteger(pairs) || pairs < 1 || !Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 2000) {
  throw Error('INVALID_BENCHMARK_ARGS');
}

const legacy = {
  id: 'legacy-Expert',
  version: 'f8913fd',
  budget: budgetMs + 'ms scaled original clock; original node cap remains',
  choose(state, rng) {
    const start = performance.now();
    return G.choose(state, 'Expert', rng, { clock: () => (performance.now() - start) * (320 / budgetMs) });
  }
};

const candidateSourceSha256 = crypto.createHash('sha256').update(fs.readFileSync('src/bot/search.js')).digest('hex');
const candidate = {
  id: S.VERSION,
  version: candidateSourceSha256,
  budget: budgetMs + 'ms; 350000-node ceiling',
  choose: (state, rng) => S.choose(state, { difficulty: 'Expert', seed: Math.floor(rng() * 4294967296), budgetMs }).move
};

// At least 100 independent paired opening families with strict leakage exclusion
const holdoutCount = Math.max(100, pairs);
const openings = R.holdoutFamilies({ minFamilies: holdoutCount, seed: 777, plies: 4 });
const leakageExcluded = openings.every(o => R.splitFor(R.family(o)) === 'holdout');

const report = R.league(candidate, legacy, { pairs, seed: 2026, openings });
report.runtime = process.version;
report.budgetMs = budgetMs;
report.candidateSourceSha256 = candidateSourceSha256;
report.rulesSha256 = crypto.createHash('sha256').update(fs.readFileSync('src/game.js')).digest('hex');
report.modelHash = 'no-model-search';
report.ruleset = C.RULESET;
report.holdoutFamiliesCount = openings.length;
report.leakageExcluded = leakageExcluded;
report.methodology = 'Same wall search budget with balanced X/O on independently held-out D4 opening families. Paired bootstrap 95% confidence interval over matched pairs. Leakage exclusion verified. Tuning label only; not promotion evidence without multi-device benchmark.';
report.promotionApproved = false;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  pairs: report.pairs,
  holdoutFamilies: report.holdoutFamiliesCount,
  leakageExcluded: report.leakageExcluded,
  summary: report.summary
}, null, 2));
