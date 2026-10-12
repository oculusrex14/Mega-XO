'use strict';
/* training/bot/search-labels.cjs - CL10 "stronger training targets" dataset generator.
 *
 * The compact CNN's failure was diagnosed (DGX1 2026-10-13): with weak self-play games the VALUE target
 * is near-unpredictable (within-group variance 0.662 of 0.731; material->outcome agreement 0.23 early),
 * so the value head cannot generalise (holdout MSE 1.15, worse than predicting zero 0.73). The fix is
 * genuinely stronger LABELS, which is what this generator produces:
 *
 *   * POLICY target = the deep classical search's visit distribution (S.mcts at a large budget), not the
 *     weak mixed-strength bootstrap's moves.
 *   * VALUE target = the deep search's ROOT SCORE (a bounded, consistent, look-ahead evaluation
 *     normalised to [-1,1]), not the noisy terminal outcome of a weakly-played game.
 *   * Hard states (teacher best move differs from the weak engine) are flagged for curriculum mining.
 *
 * Family-safe split (identical to generate.cjs) so no D4 opening family crosses train/validation/holdout.
 * Output rows are format-compatible with generate.cjs (train.py consumes them unchanged).
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const E = require('../../src/bot/encoding.js');
const S = require('../../src/bot/search.js');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
function family(moves) { return Array.from({ length: 8 }, (_, s) => moves.map((m) => { const t = E.mapMove(m, s); return t.b * 9 + t.c; }).join(',')).sort()[0]; }
function splitFor(f) { const n = parseInt(digest('split-v1:' + f).slice(0, 8), 16) % 100; return n < 80 ? 'train' : n < 90 ? 'validation' : 'holdout'; }

/* Normalise an alpha-beta root score to a bounded value target. The search returns board.evaluate units
 * where +-1e6 is a forced win/loss; tanh gives a smooth, centred, learnable target. SCALE controls how
 * saturating the near-terminal positions are. */
const SCALE = 400;
function valueFromScore(score) { return Math.tanh(score / SCALE); }

function searchTarget(state, { seed, budgetMs, simulations, depth }) {
  // The deep classical search exposes its root scores/depth in diagnostics; S.choose is the bounded
  // alpha-beta Expert, S.mcts is the visit distribution. We run the alpha-beta search for the VALUE
  // (root score) and a bounded MCTS for the POLICY (visits), both far stronger than the weak bootstrap.
  const ab = S.choose(state, { difficulty: 'Expert', seed, budgetMs: Math.max(budgetMs, 200), maxDepth: depth });
  const rootScores = (ab.diagnostics && ab.diagnostics.rootScores) || [];
  const top = rootScores.length ? Math.max(...rootScores.map((r) => r.score)) : 0;
  const mcts = S.mcts(state, { seed: seed ^ 0x9e3779b9, simulations, budgetMs: Math.max(50, budgetMs) });
  return { move: ab.move, policy: mcts.policy, visits: (mcts.diagnostics && mcts.diagnostics.visits) || 0, rootScore: top, abMove: ab.move };
}

function game({ seed, simulations = 128, budgetMs = 300, openingPlies = 4, roster = ['Expert', 'Hard', 'Expert', 'Medium', null], exploreRate = 0.15 }) {
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < openingPlies; i++) { const moves = G.legal(state); state = G.apply(state, moves[Math.floor(rng() * moves.length)]); }
  const opening = state.moves.map(({ b, c }) => ({ b, c })), openingFamily = family(opening), split = splitFor(openingFamily);
  const gameId = 'searchlabel-' + seed + '-' + openingFamily, rows = [];
  let hardStates = 0;
  while (!state.winner) {
    const target = searchTarget(state, { seed: Math.floor(rng() * 4294967296), budgetMs, simulations });
    const encoding = E.encode(state);
    const valueTarget = valueFromScore(target.rootScore);
    const weak = G.choose(state, 'Easy', C.seeded(seed + state.moves.length));
    const hard = weak.b !== target.abMove.b || weak.c !== target.abMove.c;
    if (hard) hardStates++;
    rows.push({ schemaVersion: 1, gameId, openingFamily, split, seed, revision: state.moves.length, first: state.moves[0].player,
      moves: state.moves, player: state.turn, encodingVersion: E.VERSION, planes: [...encoding.planes], legalMask: [...encoding.mask],
      visitTarget: [...target.policy], searchVisits: target.visits, valueTarget, rootScore: target.rootScore,
      valueTargetSource: 'deep-search-root-score', modelVersion: 'searchlabel-' + S.VERSION, hardState: hard });
    // Behavior: mostly the strong teacher move, a small explicit explore fraction for off-policy coverage.
    const explore = rng() < exploreRate;
    const opponent = roster[(seed + state.moves.length) % roster.length];
    let move, behavior;
    if (explore) { const moves = G.legal(state); move = moves[Math.floor(rng() * moves.length)]; behavior = 'explore'; }
    else if (opponent === null) { move = target.move; behavior = 'strong-teacher'; }
    else { move = G.choose(state, opponent, rng); behavior = 'frozen-' + opponent; }
    rows.at(-1).behavior = behavior;
    rows.at(-1).opponent = opponent === null ? 'strong' : opponent;
    rows.at(-1).playedMove = move;
    state = G.apply(state, move);
  }
  // Terminal outcome is recorded for reference/diagnostics, NOT used as the value target.
  for (const row of rows) { row.terminalOutcome = state.winner; row.terminalValue = E.value(state.winner, row.player); row.completeGameMoves = state.moves.length; }
  return { gameId, openingFamily, split, rows, winner: state.winner, weakDisagreements: hardStates };
}

function generate({ output, games = 16, seed = 8000, simulations = 128, budgetMs = 300, trainingStatus = 'STRONG_SEARCH_LABELS', profile = null }) {
  if (!output || !Number.isInteger(games) || games < 1 || games > 100000) throw Error('INVALID_GENERATION_OPTIONS');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw Error('OUTPUT_EXISTS');
  const tmp = output + '.partial';
  const fd = fs.openSync(tmp, 'w'), hash = crypto.createHash('sha256'), counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let records = 0, hardStates = 0;
  try {
    for (let i = 0; i < games; i++) {
      const result = game({ seed: seed + i, simulations, budgetMs });
      counts[result.split]++; ids.push({ gameId: result.gameId, openingFamily: result.openingFamily, split: result.split });
      for (const row of result.rows) { if (row.hardState) hardStates++; const text = JSON.stringify(row) + '\n'; fs.writeSync(fd, text); hash.update(text); records++; }
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, output);
  const manifest = { schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'game.js'))),
    searchSha256: digest(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'search.js'))),
    records, games, seed, simulations, budgetMs, counts, gameIndex: ids, sha256: hash.digest('hex'), trainingStatus, hardStates,
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    targetPolicy: 'POLICY = deep alpha-beta/MCTS visit distribution (strong); VALUE = deep-search root score normalised to [-1,1] (strong, consistent), NOT the weak self-play terminal outcome',
    teacher: { ...(profile || {}), budgetMs, simulations, note: 'strong-search labels for CL10 stronger-target training' } };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

module.exports = { family, splitFor, game, generate, valueFromScore };
if (require.main === module) {
  const [output = '.artifacts/v51/search-labels.jsonl', games = '16', seed = '8000', simulations = '128', budgetMs = '300'] = process.argv.slice(2);
  console.log(JSON.stringify(generate({ output, games: Number(games), seed: Number(seed), simulations: Number(simulations), budgetMs: Number(budgetMs) }), null, 2));
}
