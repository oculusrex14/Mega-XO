'use strict';
// No services, wallets or browser globals. Every played move uses the rules oracle.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const E = require('../../src/bot/encoding.js');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function family(moves) {
  if (!moves || !moves.length) return 'opening-empty';
  return Array.from({ length: 8 }, (_, s) => moves.map(m => {
    const t = E.mapMove(m, s);
    return t.b * 9 + t.c;
  }).join(',')).sort()[0];
}

function splitFor(f) {
  if (f === 'opening-empty') return 'holdout';
  const n = parseInt(digest('split-v1:' + f).slice(0, 8), 16) % 100;
  return n < 80 ? 'train' : n < 90 ? 'validation' : 'holdout';
}

function holdoutFamilies({ minFamilies = 100, seed = 500, plies = 4 } = {}) {
  const rng = C.seeded(seed);
  const families = new Map();
  let attempts = 0;
  while (families.size < minFamilies && attempts < 50000) {
    attempts++;
    let s = G.create('X');
    for (let p = 0; p < plies; p++) {
      const legal = G.legal(s);
      s = G.apply(s, legal[Math.floor(rng() * legal.length)]);
    }
    const moves = s.moves.map(({ b, c }) => ({ b, c }));
    const f = family(moves);
    if (splitFor(f) === 'holdout' && !families.has(f)) {
      families.set(f, moves);
    }
  }
  return Array.from(families.values());
}

function legacy(level, { budget = 'nodes', nodeLimit = 512 } = {}) {
  if (!G.LEVELS.includes(level) || !['nodes', 'wall', 'full'].includes(budget)) throw Error('INVALID_PROFILE');
  const isNodes = budget === 'nodes';
  return {
    id: 'legacy-' + level,
    version: C.RULESET,
    budget: isNodes
      ? 'deterministic ' + nodeLimit + '-node ceiling (128-node clock checks), also bounded by original tier cap'
      : 'original per-tier wall/node caps (' + level + ')',
    choose: (state, rng) => {
      let calls = 0;
      return G.choose(state, level, rng, isNodes ? { clock: () => calls++ * 128 >= nodeLimit ? 1e12 : 0 } : {});
    }
  };
}

function play(a, b, { seed = 1, first = 'X', opening = [], swap = false } = {}) {
  let state = G.create(first);
  for (const move of opening) state = G.apply(state, move);
  const engines = swap ? { X: b, O: a } : { X: a, O: b };
  const rngs = { X: C.seeded(seed), O: C.seeded(seed ^ 0x9e3779b9) };
  const start = performance.now(), latency = { X: [], O: [] };
  while (!state.winner) {
    const who = state.turn, t = performance.now();
    const move = engines[who].choose(state, rngs[who]);
    latency[who].push(performance.now() - t);
    state = G.apply(state, C.assertMove(state, move));
  }
  const aSide = swap ? 'O' : 'X', point = state.winner === 'DRAW' ? 0.5 : state.winner === aSide ? 1 : 0;
  return {
    seed,
    first,
    opening,
    swap,
    a: a.id,
    b: b.id,
    versions: [a.version, b.version],
    budgets: [a.budget, b.budget],
    point,
    winner: state.winner,
    moves: state.moves,
    latency,
    elapsedMs: performance.now() - start
  };
}

function quantile(values, q) {
  const sorted = values.slice().sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
}

function openingDiversity(games) {
  if (!games || !games.length) return { uniqueOpenings: 0, repetitionRate: 0, entropy: 0 };
  const firstMoves = games.map(g => {
    const at = g.opening ? g.opening.length : 0;
    const m = g.moves[at];
    return m ? `${m.b}:${m.c}` : 'none';
  });
  const counts = new Map();
  for (const m of firstMoves) counts.set(m, (counts.get(m) || 0) + 1);
  const total = firstMoves.length;
  let maxCount = 0, entropy = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return {
    uniqueMoves: counts.size,
    repetitionRate: Math.round((maxCount / total) * 1000) / 1000,
    entropy: Math.round(entropy * 1000) / 1000
  };
}

function summarize(games) {
  if (!games.length) return { games: 0 };
  const points = games.reduce((n, g) => n + g.point, 0), pairs = [];
  for (let i = 0; i + 1 < games.length; i += 2) pairs.push((games[i].point + games[i + 1].point) / 2);
  const rng = C.seeded(731), boot = [];
  for (let i = 0; i < 2000 && pairs.length; i++) {
    let p = 0;
    for (let j = 0; j < pairs.length; j++) p += pairs[Math.floor(rng() * pairs.length)];
    boot.push(p / pairs.length);
  }
  return {
    games: games.length,
    wins: games.filter(g => g.point === 1).length,
    draws: games.filter(g => g.point === 0.5).length,
    losses: games.filter(g => g.point === 0).length,
    pointScore: points / games.length,
    pairBootstrap95: boot.length ? [quantile(boot, 0.025), quantile(boot, 0.975)] : null,
    uncertainty: pairs.length < 30
      ? 'SMOKE ONLY: fewer than 30 independent pairs; interval is not promotion evidence'
      : 'Paired bootstrap over ' + pairs.length + ' independent matched pairs',
    p50MoveMs: quantile(games.flatMap(g => [...g.latency.X, ...g.latency.O]), 0.5),
    p95MoveMs: quantile(games.flatMap(g => [...g.latency.X, ...g.latency.O]), 0.95)
  };
}

function tierCalibration(leagues) {
  return leagues.map(l => {
    const summary = l.summary;
    const low = summary.pairBootstrap95 ? summary.pairBootstrap95[0] : null;
    const high = summary.pairBootstrap95 ? summary.pairBootstrap95[1] : null;
    const monotonic = summary.pointScore > 0.50;
    const significant = low !== null && low > 0.50;
    return {
      tierA: l.engineA,
      tierB: l.engineB,
      pointScore: summary.pointScore,
      pairBootstrap95: summary.pairBootstrap95,
      monotonic,
      significant,
      status: significant ? 'statistically-separated' : monotonic ? 'directionally-higher' : 'inverted-or-tied',
      uncertainty: summary.uncertainty
    };
  });
}

function league(a, b, { pairs = 1, seed = 10, openings = [[]] } = {}) {
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 100000 || !openings.length) throw Error('INVALID_LEAGUE');
  const games = [];
  for (let i = 0; i < pairs; i++) {
    const opening = openings[i % openings.length];
    const options = { seed: seed + i, first: i % 2 ? 'O' : 'X', opening };
    for (const swap of [false, true]) games.push(play(a, b, { ...options, swap }));
  }
  const summary = summarize(games);
  summary.openingDiversity = openingDiversity(games);
  const rulesSha256 = crypto.createHash('sha256').update(fs.readFileSync('src/game.js')).digest('hex');
  const distinctFamilies = new Set(openings.map(o => family(o)));
  return {
    schemaVersion: 1,
    engineA: a.id,
    engineB: b.id,
    versionA: a.version,
    versionB: b.version,
    budgetA: a.budget,
    budgetB: b.budget,
    rulesSha256,
    ruleset: C.RULESET,
    modelHash: a.modelHash || b.modelHash || 'no-model-search',
    seed,
    pairs,
    holdoutFamiliesCount: distinctFamilies.size,
    leakageExcluded: openings.every(o => o.length === 0 || splitFor(family(o)) === 'holdout'),
    promotionApproved: false,
    summary,
    games
  };
}

function scripted(script, fallback = legacy('Easy')) {
  return {
    id: 'memorized-script-v1',
    version: C.RULESET,
    budget: fallback.budget,
    choose(state, rng) {
      const m = script[state.moves.length];
      return G.legal(state).some(x => C.sameMove(x, m)) ? m : fallback.choose(state, rng);
    }
  };
}

module.exports = {
  family,
  splitFor,
  holdoutFamilies,
  legacy,
  play,
  league,
  summarize,
  openingDiversity,
  tierCalibration,
  scripted
};

if (require.main === module) {
  const [a = 'Easy', b = 'Beginner', pairs = '8', budget = 'nodes'] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(league(legacy(a, { budget }), legacy(b, { budget }), { pairs: Number(pairs) }), null, 2) + '\n');
}
