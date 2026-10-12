'use strict';
// Canonical complete-game training data. Large outputs belong outside Git.
//
// CL10 ("bootstrap with stronger teachers, diverse frozen opponents and more independent opening
// families, not just more copies of the current weak self-play"). The default `generate()` keeps the
// original mixed-strength behavior policy so existing manifests/tests stay valid. The CL10 profile:
//
//   * BEHAVIOR: a strong teacher (Expert or a deeper search budget) plays most moves, with a small,
//     explicit fraction of weaker/exploration moves so the visited positions are not all on-policy
//     for the strongest engine (off-policy coverage is labeled, never implicit).
//   * TARGET: UCT visit counts from a MUCH larger search budget than the behavior move - the earlier
//     bootstrap labeled positions with the same weak budget that chose the move, so the labels were
//     barely better than the behavior. Stronger search labels are the point of CL10.
//   * DIVERSITY: opponents come from a frozen roster of the five tiers; the opening family is drawn
//     from randomized play so independent games reach genuinely different positions.
//   * RETENTION: a per-game `provenance` block records teacher/opponent/search budgets, seed and the
//     behavior policy, so downstream mixing and hard-state mining can select on it. A `hardStates`
//     flag marks positions where the teacher's best move disagrees with the weak engine's choice
//     (the states a compact student most needs).
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const G=require('../../src/game.js'),C=require('../../src/bot/contracts.js'),E=require('../../src/bot/encoding.js'),S=require('../../src/bot/search.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function family(moves){return Array.from({length:8},(_,s)=>moves.map(m=>{const t=E.mapMove(m,s);return t.b*9+t.c;}).join(',')).sort()[0];}
function splitFor(f){const n=parseInt(digest('split-v1:'+f).slice(0,8),16)%100;return n<80?'train':n<90?'validation':'holdout';}

/* The frozen teacher roster. `null` = the UCT teacher whose visit counts label the position. */
const DEFAULT_ROSTER = Object.freeze(['Expert', 'Hard', 'Expert', 'Medium', null]);

/* The strong teacher's target search. A larger budget than the behavior move is the whole point:
 * the earlier bootstrap used ONE weak budget for both, so the visit target was only as good as the
 * move that produced it. */
function targetSearch(state, { seed, simulations, budgetMs }) {
  return S.mcts(state, { seed, simulations, budgetMs, clock: () => 0 });
}

/* The neural producer for CL10 self-play (WEB-AI-04). An approved-research producer exposes
 * `choose(state, rng)` returning either a bare move `{b,c}` or an analysis `{move, policy?, visits?}`.
 * It is invoked directly so the producer IS wired; the previous code set `analysis = null` and then
 * dereferenced `analysis.move`, so the injected engine was never called. Behaviour (the move played)
 * stays separate from the training target (the visit/policy label the caller selects). */
function neuralProducer(engine, state, rng) {
  if (!engine || typeof engine.choose !== 'function') throw Error('NEURAL_PRODUCER_INVALID');
  const out = engine.choose(state, rng);
  if (out && typeof out.then === 'function') throw Error('NEURAL_PRODUCER_ASYNC: call generateAsync for an async producer');
  return normalizeAnalysis(out, engine);
}
async function resolveProducer(engine, state, rng) {
  if (!engine || typeof engine.choose !== 'function') throw Error('NEURAL_PRODUCER_INVALID');
  const out = engine.choose(state, rng);
  const resolved = (out && typeof out.then === 'function') ? await out : out;
  return normalizeAnalysis(resolved, engine);
}
function normalizeAnalysis(out, engine) {
  const version = (engine && engine.version) || 'neural-producer';
  if (out && typeof out === 'object' && out.move) return { move: out.move, policy: out.policy || null, visits: out.visits || 0, version: out.version || version };
  return { move: out, policy: null, visits: 0, version };
}

/* Shared per-move decision AFTER the producer/search analysis is resolved. Keeping this in one place
 * means the synchronous (`game`) and asynchronous (`gameAsync`) loops cannot drift. RNG consumption
 * order is preserved exactly (expert seed, then explore, then opponent) so existing datasets and
 * manifests remain reproducible. */
function finishMove({ state, seed, rng, analysis, labelSource, targetBudget, roster, exploreRate, neural }) {
  const encoding = E.encode(state);
  const teacherMove = analysis.move;
  if (!teacherMove || !Number.isInteger(teacherMove.b) || !Number.isInteger(teacherMove.c)) throw Error('TEACHER_MOVE_INVALID');
  let policyTarget, visits, modelVersion;
  if (labelSource === 'expert') {
    // LABEL EQUIVALENCE: this MUST be the same teacher the league benchmarks against, or the
    // experiment compares two different players. neural_league's `improvedExpert` is
    // S.choose({difficulty:'Expert'}) (a bounded UCT search), NOT the heuristic G.choose used by
    // the frozen roster - labeling with G.choose while matching against S.choose measures nothing.
    const expert = S.choose(state, { difficulty: 'Expert', seed: Math.floor(rng() * 4294967296), budgetMs: 2000 });
    policyTarget = new Array(81).fill(0);
    if (expert && expert.move) policyTarget[expert.move.b * 9 + expert.move.c] = 1;
    visits = 0;
    modelVersion = 'expert-label-improvedExpert';
  } else {
    // A neutral producer supplies its own visit policy; otherwise the UCT target of the same state is
    // the label. The candidate policy is NEVER the label of its own move (behaviour stays separate).
    const target = analysis.policy ? analysis : targetSearch(state, { seed: Math.floor(rng() * 4294967296), simulations: targetBudget, budgetMs: 2000 });
    policyTarget = target.policy;
    visits = target.visits !== undefined ? target.visits : (target.diagnostics ? target.diagnostics.visits : 0);
    modelVersion = neural ? (analysis.version || 'neural-producer') : ('no-neural-bootstrap-' + S.VERSION);
  }
  const explore = rng() < exploreRate;
  const opponent = roster[(seed + state.moves.length) % roster.length];
  let move, behavior;
  if (neural && !explore) { move = teacherMove; behavior = 'neural-producer:' + (analysis.version || 'neural-producer'); }
  else if (explore) { const moves = G.legal(state); move = moves[Math.floor(rng() * moves.length)]; behavior = 'explore'; }
  else if (opponent === null) { move = teacherMove; behavior = 'uct-teacher-' + targetBudget; }
  else { move = G.choose(state, opponent, rng); behavior = 'frozen-' + opponent; }
  const weak = G.choose(state, 'Easy', C.seeded(seed + state.moves.length));
  const hardState = (weak.b !== teacherMove.b || weak.c !== teacherMove.c);
  const row = { schemaVersion: 1, gameId: null, openingFamily: null, split: null, seed, revision: state.moves.length, first: state.moves[0].player,
    moves: state.moves, player: state.turn, encodingVersion: E.VERSION, planes: [...encoding.planes], legalMask: [...encoding.mask],
    visitTarget: policyTarget, searchVisits: visits, modelVersion, behavior, opponent: opponent === null ? 'uct' : opponent, playedMove: move, hardState };
  return { row, move, hardState };
}

function game({ seed, simulations = 32, openingPlies = 4, neuralEngine = null, teacher = 'Expert', targetSimulations = null, roster = DEFAULT_ROSTER, exploreRate = 0.2, labelSource = 'search' } = {}) {
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < openingPlies; i++) { const moves = G.legal(state); state = G.apply(state, moves[Math.floor(rng() * moves.length)]); }
  const opening = state.moves.map(({ b, c }) => ({ b, c })), openingFamily = family(opening), split = splitFor(openingFamily);
  const gameId = 'bootstrap-' + seed + '-' + openingFamily, rows = [];
  const targetBudget = targetSimulations === null ? simulations : targetSimulations;
  if (labelSource !== 'search' && labelSource !== 'expert') throw Error('INVALID_LABEL_SOURCE');
  let weakDisagreements = 0;
  while (!state.winner) {
    // NEURAL FEEDBACK (WEB-AI-04). The earlier code set `analysis = null` whenever a neuralEngine was
    // supplied and then dereferenced `analysis.move`, throwing a TypeError before the injected engine
    // was ever called - so the producer was never wired and neural self-play never ran. The producer
    // is now invoked directly (an async producer uses generateAsync); behaviour stays separate from
    // the selected training target.
    const analysis = neuralEngine
      ? neuralProducer(neuralEngine, state, rng)
      : targetSearch(state, { seed: Math.floor(rng() * 4294967296), simulations: targetBudget, budgetMs: 2000 });
    const { row, move, hardState } = finishMove({ state, seed, rng, analysis, labelSource, targetBudget, roster, exploreRate, neural: Boolean(neuralEngine) });
    row.gameId = gameId; row.openingFamily = openingFamily; row.split = split;
    rows.push(row);
    if (hardState) weakDisagreements++;
    state = G.apply(state, move);
  }
  for (const row of rows) { row.terminalOutcome = state.winner; row.valueTarget = E.value(state.winner, row.player); row.completeGameMoves = state.moves.length; }
  return { gameId, openingFamily, split, rows, winner: state.winner, moves: state.moves, weakDisagreements };
}

/* Asynchronous twin of `game` for a REAL neural producer (e.g. NS.choose over onnxruntime-node) whose
 * `choose` returns a promise. Identical RNG order and identical per-move decision (shared
 * `finishMove`), so a two-cycle self-play proof consumes the previous cycle's frozen artifact. */
async function gameAsync(options = {}) {
  const { seed, simulations = 32, openingPlies = 4, neuralEngine = null, targetSimulations = null,
    roster = DEFAULT_ROSTER, exploreRate = 0.2, labelSource = 'search' } = options;
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < openingPlies; i++) { const moves = G.legal(state); state = G.apply(state, moves[Math.floor(rng() * moves.length)]); }
  const opening = state.moves.map(({ b, c }) => ({ b, c })), openingFamily = family(opening), split = splitFor(openingFamily);
  const gameId = 'bootstrap-' + seed + '-' + openingFamily, rows = [];
  const targetBudget = targetSimulations === null ? simulations : targetSimulations;
  if (labelSource !== 'search' && labelSource !== 'expert') throw Error('INVALID_LABEL_SOURCE');
  let weakDisagreements = 0;
  while (!state.winner) {
    const analysis = neuralEngine
      ? await resolveProducer(neuralEngine, state, rng)
      : targetSearch(state, { seed: Math.floor(rng() * 4294967296), simulations: targetBudget, budgetMs: 2000 });
    const { row, move, hardState } = finishMove({ state, seed, rng, analysis, labelSource, targetBudget, roster, exploreRate, neural: Boolean(neuralEngine) });
    row.gameId = gameId; row.openingFamily = openingFamily; row.split = split;
    rows.push(row);
    if (hardState) weakDisagreements++;
    state = G.apply(state, move);
  }
  for (const row of rows) { row.terminalOutcome = state.winner; row.valueTarget = E.value(state.winner, row.player); row.completeGameMoves = state.moves.length; }
  return { gameId, openingFamily, split, rows, winner: state.winner, moves: state.moves, weakDisagreements };
}

function generate({ output, games = 16, seed = 1000, simulations = 32, trainingStatus = 'BOOTSTRAP_ONLY', neuralEngine = null,
  teacher = 'Expert', targetSimulations = null, roster = DEFAULT_ROSTER, exploreRate = 0.2, profile = null, labelSource = 'search' } = {}) {
  if (!output || !Number.isInteger(games) || games < 1 || games > 100000 || !Number.isInteger(simulations) || simulations < 1 || simulations > 50000) throw Error('INVALID_GENERATION_OPTIONS');
  if (typeof exploreRate !== 'number' || exploreRate < 0 || exploreRate > 1) throw Error('INVALID_EXPLORE_RATE');
  if (!Array.isArray(roster) || roster.length === 0) throw Error('INVALID_ROSTER');
  if (targetSimulations !== null && (!Number.isInteger(targetSimulations) || targetSimulations < 1)) throw Error('INVALID_TARGET_SIMULATIONS');
  if (labelSource !== 'search' && labelSource !== 'expert') throw Error('INVALID_LABEL_SOURCE');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'wx'), hash = crypto.createHash('sha256'), counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let records = 0, hardStates = 0;
  try {
    for (let i = 0; i < games; i++) {
      const result = game({ seed: seed + i, simulations, neuralEngine, teacher, targetSimulations, roster, exploreRate, labelSource });
      counts[result.split]++; ids.push({ gameId: result.gameId, openingFamily: result.openingFamily, split: result.split });
      for (const row of result.rows) { if (row.hardState) hardStates++; const text = JSON.stringify(row) + '\n'; fs.writeSync(fd, text); hash.update(text); records++; }
    }
  } finally { fs.closeSync(fd); }
  const manifest = { schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync('src/game.js')), searchSha256: digest(fs.readFileSync('src/bot/search.js')),
    records, games, seed, simulations, counts, gameIndex: ids, sha256: hash.digest('hex'), trainingStatus,
    perspective: 'value target is terminal outcome for side to move; draw=0',
    targetPolicy: labelSource === 'expert' ? 'behaviour cloning of the SAME improvedExpert (S.choose UCT) the league benchmarks against, move one-hot' : 'UCT visits at every retained position; mixed behavior creates off-policy coverage',
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    teacher: { ...(profile || {}), teacher, labelSource, targetSimulations: targetSimulations === null ? simulations : targetSimulations, roster: [...roster], exploreRate, hardStates } };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
async function generateAsync({ output, games = 16, seed = 1000, simulations = 32, trainingStatus = 'BOOTSTRAP_ONLY', neuralEngine = null,
  teacher = 'Expert', targetSimulations = null, roster = DEFAULT_ROSTER, exploreRate = 0.2, profile = null, labelSource = 'search' } = {}) {
  if (!output || !Number.isInteger(games) || games < 1 || games > 100000 || !Number.isInteger(simulations) || simulations < 1 || simulations > 50000) throw Error('INVALID_GENERATION_OPTIONS');
  if (typeof exploreRate !== 'number' || exploreRate < 0 || exploreRate > 1) throw Error('INVALID_EXPLORE_RATE');
  if (!Array.isArray(roster) || roster.length === 0) throw Error('INVALID_ROSTER');
  if (targetSimulations !== null && (!Number.isInteger(targetSimulations) || targetSimulations < 1)) throw Error('INVALID_TARGET_SIMULATIONS');
  if (labelSource !== 'search' && labelSource !== 'expert') throw Error('INVALID_LABEL_SOURCE');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'wx'), hash = crypto.createHash('sha256'), counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let records = 0, hardStates = 0;
  try {
    for (let i = 0; i < games; i++) {
      const result = await gameAsync({ seed: seed + i, simulations, neuralEngine, teacher, targetSimulations, roster, exploreRate, labelSource });
      counts[result.split]++; ids.push({ gameId: result.gameId, openingFamily: result.openingFamily, split: result.split });
      for (const row of result.rows) { if (row.hardState) hardStates++; const text = JSON.stringify(row) + '\n'; fs.writeSync(fd, text); hash.update(text); records++; }
    }
  } finally { fs.closeSync(fd); }
  const manifest = { schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync('src/game.js')), searchSha256: digest(fs.readFileSync('src/bot/search.js')),
    records, games, seed, simulations, counts, gameIndex: ids, sha256: hash.digest('hex'), trainingStatus,
    perspective: 'value target is terminal outcome for side to move; draw=0',
    targetPolicy: labelSource === 'expert' ? 'behaviour cloning of the SAME improvedExpert (S.choose UCT) the league benchmarks against, move one-hot' : 'UCT visits at every retained position; mixed behavior creates off-policy coverage',
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    producer: neuralEngine ? { kind: 'neural', version: neuralEngine.version || 'neural-producer' } : { kind: 'uct-search', version: S.VERSION },
    teacher: { ...(profile || {}), teacher, labelSource, targetSimulations: targetSimulations === null ? simulations : targetSimulations, roster: [...roster], exploreRate, hardStates } };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
module.exports = { family, splitFor, game, gameAsync, generate, generateAsync, DEFAULT_ROSTER };
if (require.main === module) { const [output = '.artifacts/v51/bootstrap.jsonl', games = '16', seed = '1000', simulations = '32'] = process.argv.slice(2); console.log(JSON.stringify(generate({ output, games: Number(games), seed: Number(seed), simulations: Number(simulations) }), null, 2)); }
