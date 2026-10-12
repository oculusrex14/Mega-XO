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

function game({ seed, simulations = 32, openingPlies = 4, neuralEngine = null, teacher = 'Expert', targetSimulations = null, roster = DEFAULT_ROSTER, exploreRate = 0.2 } = {}) {
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < openingPlies; i++) { const moves = G.legal(state); state = G.apply(state, moves[Math.floor(rng() * moves.length)]); }
  const opening = state.moves.map(({ b, c }) => ({ b, c })), openingFamily = family(opening), split = splitFor(openingFamily);
  const gameId = 'bootstrap-' + seed + '-' + openingFamily, rows = [];
  const targetBudget = targetSimulations === null ? simulations : targetSimulations;
  let weakDisagreements = 0;
  while (!state.winner) {
    const analysis = neuralEngine ? null : targetSearch(state, { seed: Math.floor(rng() * 4294967296), simulations: targetBudget, budgetMs: 2000 });
    const encoding = E.encode(state);
    const policyTarget = analysis ? analysis.policy : neuralEngine.policy(state);
    const visits = analysis ? analysis.diagnostics.visits : targetBudget;
    const modelVersion = neuralEngine ? neuralEngine.version : ('no-neural-bootstrap-' + S.VERSION);
    rows.push({ schemaVersion: 1, gameId, openingFamily, split, seed, revision: state.moves.length, first: state.moves[0].player,
      moves: state.moves, player: state.turn, encodingVersion: E.VERSION, planes: [...encoding.planes], legalMask: [...encoding.mask],
      visitTarget: policyTarget, searchVisits: visits, modelVersion });
    // Behavior policy: a strong teacher plays the search-best move, but a small, explicit fraction of
    // moves explore a DIFFERENT legal move so coverage is not wholly on-policy for one engine.
    const explore = rng() < exploreRate;
    const opponent = roster[(seed + state.moves.length) % roster.length];
    let move, behavior;
    if (neuralEngine && !explore) { move = neuralEngine.choose(state, rng); behavior = 'neural-uct'; }
    else if (explore) { const moves = G.legal(state); move = moves[Math.floor(rng() * moves.length)]; behavior = 'explore'; }
    else if (opponent === null) { move = analysis.move; behavior = 'uct-teacher-' + targetBudget; }
    else { move = G.choose(state, opponent, rng); behavior = 'frozen-' + opponent; }
    // Hard-state flag: the strong teacher's best move differs from the frozen weak engine's choice.
    const weak = G.choose(state, 'Easy', C.seeded(seed + state.moves.length));
    if (weak.b !== analysis.move.b || weak.c !== analysis.move.c) weakDisagreements++;
    rows.at(-1).behavior = behavior;
    rows.at(-1).opponent = opponent === null ? 'uct' : opponent;
    rows.at(-1).playedMove = move;
    rows.at(-1).hardState = (weak.b !== analysis.move.b || weak.c !== analysis.move.c);
    state = G.apply(state, move);
  }
  for (const row of rows) { row.terminalOutcome = state.winner; row.valueTarget = E.value(state.winner, row.player); row.completeGameMoves = state.moves.length; }
  return { gameId, openingFamily, split, rows, winner: state.winner, moves: state.moves, weakDisagreements };
}

function generate({ output, games = 16, seed = 1000, simulations = 32, trainingStatus = 'BOOTSTRAP_ONLY', neuralEngine = null,
  teacher = 'Expert', targetSimulations = null, roster = DEFAULT_ROSTER, exploreRate = 0.2, profile = null } = {}) {
  if (!output || !Number.isInteger(games) || games < 1 || games > 100000 || !Number.isInteger(simulations) || simulations < 1 || simulations > 50000) throw Error('INVALID_GENERATION_OPTIONS');
  if (typeof exploreRate !== 'number' || exploreRate < 0 || exploreRate > 1) throw Error('INVALID_EXPLORE_RATE');
  if (!Array.isArray(roster) || roster.length === 0) throw Error('INVALID_ROSTER');
  if (targetSimulations !== null && (!Number.isInteger(targetSimulations) || targetSimulations < 1)) throw Error('INVALID_TARGET_SIMULATIONS');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'wx'), hash = crypto.createHash('sha256'), counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let records = 0, hardStates = 0;
  try {
    for (let i = 0; i < games; i++) {
      const result = game({ seed: seed + i, simulations, neuralEngine, teacher, targetSimulations, roster, exploreRate });
      counts[result.split]++; ids.push({ gameId: result.gameId, openingFamily: result.openingFamily, split: result.split });
      for (const row of result.rows) { if (row.hardState) hardStates++; const text = JSON.stringify(row) + '\n'; fs.writeSync(fd, text); hash.update(text); records++; }
    }
  } finally { fs.closeSync(fd); }
  const manifest = { schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync('src/game.js')), searchSha256: digest(fs.readFileSync('src/bot/search.js')),
    records, games, seed, simulations, counts, gameIndex: ids, sha256: hash.digest('hex'), trainingStatus,
    perspective: 'value target is terminal outcome for side to move; draw=0',
    targetPolicy: 'UCT visits at every retained position; mixed behavior creates off-policy coverage',
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    teacher: { ...(profile || {}), teacher, targetSimulations: targetSimulations === null ? simulations : targetSimulations, roster: [...roster], exploreRate, hardStates } };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
module.exports = { family, splitFor, game, generate, DEFAULT_ROSTER };
if (require.main === module) { const [output = '.artifacts/v51/bootstrap.jsonl', games = '16', seed = '1000', simulations = '32'] = process.argv.slice(2); console.log(JSON.stringify(generate({ output, games: Number(games), seed: Number(seed), simulations: Number(simulations) }), null, 2)); }
