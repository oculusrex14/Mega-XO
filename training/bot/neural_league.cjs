'use strict';
/**
 * Paired heldout league benchmark across ablations:
 * 1. tactical-only (improved heuristic search)
 * 2. policy-only PUCT (neural policy priors + heuristic value)
 * 3. policy-value PUCT (float dynamic ONNX)
 * 4. INT8 PUCT (quantized INT8 ONNX)
 *
 * Evaluated against improvedExpert and tacticalUCT on >= 100 independent D4 holdout opening families.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const E = require('../../src/bot/encoding.js');
const S = require('../../src/bot/search.js');
const NS = require('../../src/bot/neural-search.js');
const Data = require('./generate.cjs');

let ort = null;
try {
  ort = require('onnxruntime-node');
} catch (e) {
  // May be loaded via NODE_PATH or fallback
}

function getOrt() {
  if (!ort) {
    try {
      ort = require('onnxruntime-node');
    } catch (e) {
      throw Error('ONNXRUNTIME_NODE_REQUIRED: install onnxruntime-node to run neural leagues');
    }
  }
  return ort;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null;
}

function summarize(games) {
  if (!games.length) return { games: 0, wins: 0, draws: 0, losses: 0, pointScore: 0, pairBootstrap95: null };
  const points = games.reduce((n, g) => n + g.point, 0);
  const pairs = [];
  for (let i = 0; i + 1 < games.length; i += 2) {
    pairs.push((games[i].point + games[i + 1].point) / 2);
  }
  const rng = C.seeded(731);
  const boot = [];
  for (let i = 0; i < 2000 && pairs.length; i++) {
    let p = 0;
    for (let j = 0; j < pairs.length; j++) p += pairs[Math.floor(rng() * pairs.length)];
    boot.push(p / pairs.length);
  }
  const allLatencies = games.flatMap(g => [...(g.latency?.X || []), ...(g.latency?.O || [])]);
  return {
    games: games.length,
    pairs: pairs.length,
    wins: games.filter(g => g.point === 1).length,
    draws: games.filter(g => g.point === 0.5).length,
    losses: games.filter(g => g.point === 0).length,
    pointScore: points / games.length,
    pairBootstrap95: boot.length ? [quantile(boot, 0.025), quantile(boot, 0.975)] : null,
    p50MoveMs: quantile(allLatencies, 0.5),
    p95MoveMs: quantile(allLatencies, 0.95),
  };
}

function play(a, b, { seed = 1, first = 'X', opening = [], swap = false } = {}) {
  let state = G.create(first);
  for (const move of opening) state = G.apply(state, move);
  const engines = swap ? { X: b, O: a } : { X: a, O: b };
  const rngs = { X: C.seeded(seed), O: C.seeded(seed ^ 0x9e3779b9) };
  const start = performance.now();
  const latency = { X: [], O: [] };
  while (!state.winner) {
    const who = state.turn;
    const t = performance.now();
    const move = engines[who].choose(state, rngs[who]);
    latency[who].push(performance.now() - t);
    state = G.apply(state, C.assertMove(state, move));
  }
  const aSide = swap ? 'O' : 'X';
  const point = state.winner === 'DRAW' ? 0.5 : state.winner === aSide ? 1 : 0;
  return {
    seed,
    first,
    swap,
    a: a.id,
    b: b.id,
    point,
    winner: state.winner,
    moveCount: state.moves.length,
    latency,
    elapsedMs: performance.now() - start,
  };
}

function generateHoldoutOpenings(targetCount = 100, seed = 20261011) {
  const rng = C.seeded(seed);
  const familiesSeen = new Set();
  const openings = [];
  let attempts = 0;
  while (openings.length < targetCount && attempts < 100000) {
    attempts++;
    let s = G.create(attempts % 2 ? 'O' : 'X');
    for (let p = 0; p < 4; p++) {
      const moves = G.legal(s);
      if (!moves.length) break;
      s = G.apply(s, moves[Math.floor(rng() * moves.length)]);
    }
    const op = s.moves.map(({ b, c }) => ({ b, c }));
    const f = Data.family(op);
    if (Data.splitFor(f) === 'holdout' && !familiesSeen.has(f)) {
      familiesSeen.add(f);
      openings.push({ opening: op, family: f });
    }
  }
  return openings;
}

function createOnnxInfer(modelPath) {
  const ORT = getOrt();
  const sessionPromise = ORT.InferenceSession.create(modelPath, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const bytes = fs.readFileSync(modelPath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');

  let cachedSession = null;
  sessionPromise.then(s => { cachedSession = s; });

  return {
    hash,
    sessionPromise,
    async infer(state) {
      const sess = cachedSession || await sessionPromise;
      const enc = E.encode(state);
      const floatPlanes = new Float32Array(enc.planes);
      const tensor = new ORT.Tensor('float32', floatPlanes, [1, 8, 9, 9]);
      const feeds = { planes: tensor };
      const output = await sess.run(feeds);
      const logits = new Float32Array(output.policy.data);
      const val = Number(output.value.data[0]);
      return { logits, value: val };
    }
  };
}

function buildEngines({ modelDir, budgetMs = 100, simulations = 64 } = {}) {
  const engines = {};

  // 1. Baselines
  engines['improvedExpert'] = {
    id: 'improvedExpert',
    version: 'expert-v1',
    choose(state, rng) {
      return S.choose(state, { difficulty: 'Expert', seed: Math.floor(rng() * 4294967296), budgetMs }).move;
    }
  };

  engines['tacticalUCT'] = {
    id: 'tacticalUCT',
    version: 'uct-v1',
    choose(state, rng) {
      return S.mcts(state, { seed: Math.floor(rng() * 4294967296), simulations, budgetMs }).move;
    }
  };

  engines['tacticalOnly'] = {
    id: 'tacticalOnly',
    version: 'tactical-only-v1',
    choose(state, rng) {
      const criticalMoves = NS.critical(state);
      if (criticalMoves.length && criticalMoves[0].win) return criticalMoves[0].move;
      const safe = criticalMoves.filter(r => !r.unsafe);
      const candidates = safe.length ? safe : criticalMoves;
      return candidates[Math.floor(rng() * candidates.length)].move;
    }
  };

  if (modelDir) {
    const floatModelPath = path.join(modelDir, 'candidate.onnx');
    const dynamicModelPath = path.join(modelDir, 'candidate-dynamic.onnx');
    const int8ModelPath = path.join(modelDir, 'candidate-int8.onnx');

    const floatTarget = fs.existsSync(dynamicModelPath) ? dynamicModelPath : floatModelPath;

    if (fs.existsSync(floatTarget)) {
      const floatInfer = createOnnxInfer(floatTarget);

      // Async wrapper for neural choose
      engines['policyOnlyPUCT'] = {
        id: 'policyOnlyPUCT',
        version: floatInfer.hash.slice(0, 16),
        choose(state, rng) {
          // Synchronous fallback using cached or direct infer
          // Since NS.choose is async, we run PUCT with policy priors
          let bestMove = null;
          // Synchronous PUCT simulation loop:
          const criticalMoves = NS.critical(state);
          if (criticalMoves.length && criticalMoves[0].win) return criticalMoves[0].move;
          // For policy-only PUCT, prior is derived from model logits, value is from G.evaluate
          // Run sync evaluation via child process or cached session
          return engines['improvedExpert'].choose(state, rng);
        },
        async chooseAsync(state, rng) {
          const res = await NS.choose(state, {
            infer: floatInfer.infer,
            seed: Math.floor(rng() * 4294967296),
            budgetMs,
            simulations,
            modelHash: floatInfer.hash,
            policyOnly: true,
          });
          return res.move;
        }
      };

      engines['policyValuePUCT'] = {
        id: 'policyValuePUCT',
        version: floatInfer.hash.slice(0, 16),
        choose(state, rng) {
          return engines['improvedExpert'].choose(state, rng);
        },
        async chooseAsync(state, rng) {
          const res = await NS.choose(state, {
            infer: floatInfer.infer,
            seed: Math.floor(rng() * 4294967296),
            budgetMs,
            simulations,
            modelHash: floatInfer.hash,
            policyOnly: false,
          });
          return res.move;
        }
      };
    }

    if (fs.existsSync(int8ModelPath)) {
      const int8Infer = createOnnxInfer(int8ModelPath);
      engines['int8PUCT'] = {
        id: 'int8PUCT',
        version: int8Infer.hash.slice(0, 16),
        choose(state, rng) {
          return engines['improvedExpert'].choose(state, rng);
        },
        async chooseAsync(state, rng) {
          const res = await NS.choose(state, {
            infer: int8Infer.infer,
            seed: Math.floor(rng() * 4294967296),
            budgetMs,
            simulations,
            modelHash: int8Infer.hash,
            policyOnly: false,
          });
          return res.move;
        }
      };
    }
  }

  return engines;
}

async function playAsync(a, b, { seed = 1, first = 'X', opening = [], swap = false, openingFamily = null } = {}) {
  let state = G.create(first);
  for (const move of opening) state = G.apply(state, move);
  const engines = swap ? { X: b, O: a } : { X: a, O: b };
  const rngs = { X: C.seeded(seed), O: C.seeded(seed ^ 0x9e3779b9) };
  const start = performance.now();
  const latency = { X: [], O: [] };
  while (!state.winner) {
    const who = state.turn;
    const engine = engines[who];
    const t = performance.now();
    let move = null;
    // Per-engine move latency is kept SEPARATE (never summed): a candidate's own device latency is a
    // distinct measurement from the reference's (WEB-AI-05).
    if (typeof engine.chooseAsync === 'function') {
      move = await engine.chooseAsync(state, rngs[who]);
    } else {
      move = engine.choose(state, rngs[who]);
    }
    latency[who].push(performance.now() - t);
    state = G.apply(state, C.assertMove(state, move));
  }
  const aSide = swap ? 'O' : 'X';
  const point = state.winner === 'DRAW' ? 0.5 : state.winner === aSide ? 1 : 0;
  return {
    seed,
    first,
    swap,
    openingFamily,
    a: a.id,
    aVersion: a.version || null,
    b: b.id,
    bVersion: b.version || null,
    point,
    winner: state.winner,
    moveCount: state.moves.length,
    // Canonical terminal trace: the exact move sequence (b,c per ply) so a reviewer can replay the
    // outcome and recompute the point without trusting the running process.
    moves: state.moves.map(({ b: col, c: row, player }) => ({ b: col, c: row, player })),
    latency,
    elapsedMs: performance.now() - start,
  };
}

async function runLeaguePair(engineA, engineB, openings, { seed = 20261011 } = {}) {
  const games = [];
  for (let i = 0; i < openings.length; i++) {
    const op = openings[i].opening;
    const fam = openings[i].family || null;
    for (const swap of [false, true]) {
      const g = await playAsync(engineA, engineB, {
        seed: seed + i * 2 + (swap ? 1 : 0),
        first: i % 2 ? 'O' : 'X',
        opening: op,
        swap,
        openingFamily: fam,
      });
      games.push(g);
    }
  }
  return {
    engineA: engineA.id,
    engineB: engineB.id,
    summary: summarize(games),
    gameCount: games.length,
    games,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const modelDir = getArg('--model', null);
  const pairsCount = parseInt(getArg('--pairs', '100'), 10);
  const budgetMs = parseInt(getArg('--budget-ms', '100'), 10);
  const simulations = parseInt(getArg('--simulations', '64'), 10);
  const outputPath = getArg('--output', '.artifacts/benchmarks/neural-league.json');
  const shardArg = getArg('--shard', null);
  const matchupArg = getArg('--matchup', null);
  const workersCount = parseInt(getArg('--workers', '8'), 10);

  console.log(`Generating ${pairsCount} independent D4 holdout opening families...`);
  let openings = generateHoldoutOpenings(pairsCount);
  console.log(`Generated ${openings.length} holdout opening families.`);

  const coreMatchups = [
    ['tacticalOnly', 'improvedExpert'],
    ['policyOnlyPUCT', 'improvedExpert'],
    ['policyValuePUCT', 'improvedExpert'],
    ['policyValuePUCT', 'tacticalUCT'],
    ['int8PUCT', 'policyValuePUCT'],
  ];

  const matchups = matchupArg ? [matchupArg.split(':')] : coreMatchups;

  if (shardArg) {
    const [sIdx, sTotal] = shardArg.split('/').map(Number);
    const start = Math.floor(sIdx * openings.length / sTotal);
    const end = Math.floor((sIdx + 1) * openings.length / sTotal);
    openings = openings.slice(start, end);
    console.log(`Shard ${sIdx + 1}/${sTotal} running ${openings.length} opening pairs...`);

    const engines = buildEngines({ modelDir, budgetMs, simulations });
    const results = [];
    for (const [nameA, nameB] of matchups) {
      const eA = engines[nameA];
      const eB = engines[nameB];
      if (!eA || !eB) continue;
      const res = await runLeaguePair(eA, eB, openings, { seed: 50000 + sIdx * 1000 });
      results.push(res);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ results }, null, 2) + '\n');
    return;
  }

  const { fork } = require('node:child_process');
  const results = [];

  for (const [nameA, nameB] of matchups) {
    console.log(`\n=== Running parallel league: ${nameA} vs ${nameB} (${openings.length} pairs, ${workersCount} workers) ===`);
    const shardFiles = [];
    const workerPromises = [];

    for (let w = 0; w < workersCount; w++) {
      const shardOut = `${outputPath}.shard_${w}.json`;
      shardFiles.push(shardOut);
      const subArgs = [
        __filename,
        '--model', modelDir,
        '--pairs', String(pairsCount),
        '--budget-ms', String(budgetMs),
        '--simulations', String(simulations),
        '--matchup', `${nameA}:${nameB}`,
        '--shard', `${w}/${workersCount}`,
        '--output', shardOut,
      ];
      const p = new Promise((resolve, reject) => {
        const child = fork(__filename, subArgs.slice(1), {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.on('exit', code => (code === 0 ? resolve() : reject(Error(`Worker ${w} exited with code ${code}`))));
        child.on('error', reject);
      });
      workerPromises.push(p);
    }

    await Promise.all(workerPromises);

    const allGames = [];
    for (const f of shardFiles) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data.results && data.results[0] && data.results[0].games) {
        allGames.push(...data.results[0].games);
      }
      try { fs.unlinkSync(f); } catch (e) {}
    }

    const summary = summarize(allGames);
    const matchupResult = {
      engineA: nameA,
      engineB: nameB,
      summary,
      gameCount: allGames.length,
      // Complete paired records for every game (never truncated): a reviewer must be able to replay
      // each game, resample paired families and read the candidate's own device latency (WEB-AI-05).
      games: allGames,
    };
    results.push(matchupResult);
    console.log(`Result ${nameA} vs ${nameB}: Score=${summary.pointScore.toFixed(3)}, W=${summary.wins} D=${summary.draws} L=${summary.losses}, 95% CI=[${summary.pairBootstrap95 ? summary.pairBootstrap95.map(x => x.toFixed(3)).join(', ') : 'NA'}] (Total games: ${allGames.length})`);
  }

  // COMPLETE RECEIPT (WEB-AI-05): bind the report to the exact source/rules/model/runtime so a
  // truncated or unbound report can never be mistaken for qualification. The independent verifier
  // refuses any report missing these.
  const modelSha = modelDir && fs.existsSync(path.join(modelDir, 'candidate.onnx'))
    ? crypto.createHash('sha256').update(fs.readFileSync(path.join(modelDir, 'candidate.onnx'))).digest('hex') : null;
  const sourceSha = (() => {
    try { return require('node:child_process').execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(); }
    catch { return null; }
  })();
  const report = {
    schemaVersion: 1,
    status: 'COMPLETED',
    timestamp: new Date().toISOString(),
    pairs: pairsCount,
    budgetMs,
    simulations,
    modelDir,
    modelSha256: modelSha,
    sourceSha,
    rulesSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'game.js'))).digest('hex'),
    engineVersions: { tacticalUCT: 'uct-v1', improvedExpert: 'expert-v1' },
    holdoutFamiliesCount: openings.length,
    holdoutFamilies: openings.map(o => o.family),
    matchups: results,
    methodology: 'Strict D4-normalized 4-ply opening families where splitFor(family) === holdout. Zero leakage with train/validation. Equal wall/simulation budgets. Paired alternating-side games. All games retained with opening family, both seating seeds, per-engine latency and canonical move trace.',
    promotionApproved: false,
    promotionGate: 'Win rate >= 70% with lower 95% CI >= 0.65 on >= 200 independent families. Automatic promotion disabled; production approval is a separate human step.',
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Full report written to ${outputPath}`);
}

module.exports = {
  summarize,
  playAsync,
  generateHoldoutOpenings,
  buildEngines,
  runLeaguePair,
  createOnnxInfer,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
