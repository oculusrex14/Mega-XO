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

function searchTarget(state, { seed, budgetMs, simulations, maxDepth, nodeBudget }) {
  // The deep classical search exposes its root scores/depth/nodes in diagnostics; S.choose is the
  // bounded alpha-beta Expert, S.mcts is the visit distribution. We run the alpha-beta search for the
  // VALUE (root score) and a bounded MCTS for the POLICY (visits), both far stronger than the weak
  // bootstrap. The ACTUAL completed depth is recorded (a deeper request is NOT assumed to have been
  // reached: node/time budgets can stop the iterative deepening early), so downstream training and
  // provenance never claim a depth the search did not achieve.
  const ab = S.choose(state, { difficulty: 'Expert', seed, budgetMs: Math.max(budgetMs, 200), ...(maxDepth ? { maxDepth } : {}), ...(nodeBudget ? { nodeBudget } : {}) });
  const d = ab.diagnostics || {};
  const scores = (d.rootScores || []).map((r) => r.score).sort((a, b) => b - a);
  const top = scores.length ? scores[0] : 0;
  const rootMargin = scores.length > 1 ? top - scores[1] : null; // >=0; 0 => the top move was NOT uniquely best
  const mcts = S.mcts(state, { seed: seed ^ 0x9e3779b9, simulations, budgetMs: Math.max(50, budgetMs) });
  return {
    move: ab.move, abMove: ab.move, policy: mcts.policy,
    visits: (mcts.diagnostics && mcts.diagnostics.visits) || 0,
    rootScore: top, rootMargin,
    searchDepth: d.completedDepth || 0, searchNodes: d.nodes || 0, searchReason: d.reason || 'unknown',
    requestedDepth: d.thinkingBudget && d.thinkingBudget.maxDepth != null ? d.thinkingBudget.maxDepth : (maxDepth || null),
  };
}

function game({ seed, simulations = 128, budgetMs = 300, openingPlies = 4, roster = ['Expert', 'Hard', 'Expert', 'Medium', null], exploreRate = 0.15, depth = null }) {
  const rng = C.seeded(seed);
  let state = G.create(seed % 2 ? 'O' : 'X');
  for (let i = 0; i < openingPlies; i++) { const moves = G.legal(state); state = G.apply(state, moves[Math.floor(rng() * moves.length)]); }
  const opening = state.moves.map(({ b, c }) => ({ b, c })), openingFamily = family(opening), split = splitFor(openingFamily);
  const gameId = 'searchlabel-' + seed + '-' + openingFamily, rows = [];
  let hardStates = 0, minDepth = Infinity, maxNodes = 0, minNodes = Infinity, forcedWinStates = 0, completedSims = 0;
  while (!state.winner) {
    const target = searchTarget(state, { seed: Math.floor(rng() * 4294967296), budgetMs, simulations, maxDepth: depth });
    const encoding = E.encode(state);
    const valueTarget = valueFromScore(target.rootScore);
    const weak = G.choose(state, 'Easy', C.seeded(seed + state.moves.length));
    const hard = weak.b !== target.abMove.b || weak.c !== target.abMove.c;
    if (hard) hardStates++;
    // Only an alpha-beta ROOT SCORE that clears the forced-win unit (1e6) is a proven forced win; a
    // heuristic material margin must not be mistaken for one. rootMargin 0 means the top move was not
    // uniquely best, so its value label is less trustworthy than a unique-best state.
    const forcedWin = target.rootScore >= 1e6;
    if (forcedWin) forcedWinStates++;
    completedSims += target.visits;
    minDepth = Math.min(minDepth, target.searchDepth); maxNodes = Math.max(maxNodes, target.searchNodes); minNodes = Math.min(minNodes, target.searchNodes);
    rows.push({ schemaVersion: 1, gameId, openingFamily, split, seed, revision: state.moves.length, first: state.moves[0].player,
      moves: state.moves, player: state.turn, encodingVersion: E.VERSION, planes: [...encoding.planes], legalMask: [...encoding.mask],
      visitTarget: [...target.policy], searchVisits: target.visits, valueTarget, rootScore: target.rootScore,
      rootMargin: target.rootMargin, searchDepth: target.searchDepth, searchNodes: target.searchNodes,
      searchReason: target.searchReason, requestedDepth: target.requestedDepth, forcedWin,
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
  return { gameId, openingFamily, split, rows, winner: state.winner, weakDisagreements: hardStates,
    searchQuality: { requestedDepth: depth, minCompletedDepth: minDepth === Infinity ? null : minDepth, maxCompletedDepth: Math.max(...rows.map((r) => r.searchDepth)),
      minNodes: minNodes === Infinity ? null : minNodes, maxNodes, forcedWinStates, meanSearchVisits: rows.length ? completedSims / rows.length : 0 } };
}

function generate({ output, games = 16, seed = 8000, simulations = 128, budgetMs = 300, depth = null, trainingStatus = 'STRONG_SEARCH_LABELS', profile = null }) {
  if (!output || !Number.isInteger(games) || games < 1 || games > 100000) throw Error('INVALID_GENERATION_OPTIONS');
  if (depth !== null && (!Number.isInteger(depth) || depth < 1 || depth > 20)) throw Error('INVALID_DEPTH');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw Error('OUTPUT_EXISTS');
  const tmp = output + '.partial';
  const fd = fs.openSync(tmp, 'w'), hash = crypto.createHash('sha256'), counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let records = 0, hardStates = 0, forcedWinStates = 0, depthSamples = [], minCompletedDepth = null, maxCompletedDepth = null;
  try {
    for (let i = 0; i < games; i++) {
      // The requested depth MUST reach the search, or a "depth-16" dataset is silently depth-12.
      const result = game({ seed: seed + i, simulations, budgetMs, depth });
      counts[result.split]++; ids.push({ gameId: result.gameId, openingFamily: result.openingFamily, split: result.split });
      const q = result.searchQuality;
      if (q.minCompletedDepth !== null) minCompletedDepth = minCompletedDepth === null ? q.minCompletedDepth : Math.min(minCompletedDepth, q.minCompletedDepth);
      if (q.maxCompletedDepth !== null) maxCompletedDepth = maxCompletedDepth === null ? q.maxCompletedDepth : Math.max(maxCompletedDepth, q.maxCompletedDepth);
      depthSamples.push(q.maxCompletedDepth); forcedWinStates += q.forcedWinStates;
      for (const row of result.rows) { if (row.hardState) hardStates++; const text = JSON.stringify(row) + '\n'; fs.writeSync(fd, text); hash.update(text); records++; }
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, output);
  const manifest = { schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'game.js'))),
    searchSha256: digest(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bot', 'search.js'))),
    records, games, seed, simulations, budgetMs, requestedDepth: depth, counts, gameIndex: ids, sha256: hash.digest('hex'), trainingStatus, hardStates,
    // ACTUAL search realisation (a requested depth is not a claim the search reached it).
    searchQuality: { requestedDepth: depth, minCompletedDepth, maxCompletedDepth, forcedWinStates, perGameMaxCompletedDepth: depthSamples },
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    targetPolicy: 'POLICY = deep alpha-beta/MCTS visit distribution (strong); VALUE = deep-search root score normalised to [-1,1] (strong, consistent), NOT the weak self-play terminal outcome',
    teacher: { ...(profile || {}), budgetMs, simulations, requestedDepth: depth, note: 'strong-search labels for CL10 stronger-target training' } };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

module.exports = { family, splitFor, game, generate, valueFromScore };
if (require.main === module) {
  const [output = '.artifacts/v51/search-labels.jsonl', games = '16', seed = '8000', simulations = '128', budgetMs = '300', depth = ''] = process.argv.slice(2);
  console.log(JSON.stringify(generate({ output, games: Number(games), seed: Number(seed), simulations: Number(simulations), budgetMs: Number(budgetMs), depth: depth ? Number(depth) : null }), null, 2));
}
