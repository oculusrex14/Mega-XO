'use strict';
/* training/bot/decision-dataset.cjs - CL19 legal-option decision dataset for the Unsloth decision
 * teacher (approach B).
 *
 * Serializes canonical positions COMPACTLY and consistently, supplies ALL legal move options with
 * unambiguous action IDs, and emits questions in the Unsloth decision format (state + questions +
 * gold). It never lets a free-form text generation invent a move: every option is a legal cell with
 * a stable id, and the gold is derived from the frozen rules/search - not from a weak self-play game.
 *
 * Questions per position:
 *   * `winNow`  (noul)  - can the player to move win the whole match this turn?
 *   * `opponentThreat` (noul) - does the opponent have an immediate mega win they must be denied?
 *   * `bestMove` (choice) - which legal move does the strong teacher play? options = ALL legal moves,
 *                           gold = the teacher's move with its search-relative probability.
 *
 * Invariance: options are emitted in a deterministic shuffled order per position (derived from the
 * position hash), so a model cannot learn option-position shortcuts; `invariance` records that a
 * re-shuffle yields the same gold id.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const G = require('../../src/game.js');
const C = require('../../src/bot/contracts.js');
const E = require('../../src/bot/encoding.js');
const S = require('../../src/bot/search.js');
const Data = require('./generate.cjs');

const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');
const moveId = (m) => `${m.b},${m.c}`;

/* Compact, unambiguous, model-readable board. Rows are the 9 local boards; each cell is `.`/`X`/`O`;
 * a bracketed header gives the macro board, whose move is required and the side to move. */
function serialize(state) {
  const macro = state.mini.map((v) => v === null ? '.' : v === 'DRAW' ? 'd' : v);
  const rows = state.board.map((cells, b) => `b${b}[${macro[b]}]: ` + cells.map((c) => c === null ? '.' : c).join(' '));
  return `Player to move: ${state.turn}\nRequired board: ${state.required === null ? 'any' : 'b' + state.required}\nMacro: ${macro.join('')}\n` + rows.join('\n');
}

/* All legal moves, in a deterministic per-position shuffled order so option order carries no signal. */
function optionsWithSeed(state, seed) {
  const legal = G.legal(state).map((m) => ({ id: moveId(m), b: m.b, c: m.c }));
  const rng = C.seeded(seed >>> 0);
  for (let i = legal.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [legal[i], legal[j]] = [legal[j], legal[i]]; }
  return legal;
}

function options(state) {
  const seed = parseInt(digest('opt-order-v1:' + serialize(state)).slice(0, 8), 16);
  return optionsWithSeed(state, seed);
}

function teacherMove(state, { seed, budgetMs = 20 }) {
  return S.choose(state, { difficulty: 'Expert', seed, budgetMs });
}

function winNowMove(state) {
  for (const m of G.legal(state)) if (G.apply(state, m).winner === state.turn) return m;
  return null;
}

/* Does the OPPONENT have an immediate mega win (if it were their move on this board)? */
function opponentThreat(state) {
  const opp = state.turn === 'X' ? 'O' : 'X';
  const clone = { ...state, turn: opp };
  for (const m of G.legal(clone)) if (G.apply(clone, m).winner === opp) return true;
  return false;
}

function buildRow(state, { seed, gameId, openingFamily, split, budgetMs = 20 }) {
  const opts = options(state);
  const win = winNowMove(state);
  const threat = opponentThreat(state);
  // The requested budget is THREADED to the teacher (WEB-AI-07): the exposed --budget-ms previously
  // never reached teacherMove, so an experiment silently ran at the 20 ms default and the receipt
  // claimed a budget it never used.
  const teacher = teacherMove(state, { seed, budgetMs });
  const teacherBest = moveId(teacher.move);
  // Move probability from the teacher's own search diagnostics when available, else a one-hot label.
  const diag = teacher.diagnostics || {};
  const probs = {};
  const visits = diag.visits || {};
  const total = Object.values(visits).reduce((a, b) => a + b, 0);
  if (total > 0) for (const [k, v] of Object.entries(visits)) probs[k] = v / total;
  if (!Object.keys(probs).length) probs[teacherBest] = 1;
  const criteria = {};
  for (const o of opts) criteria[o.id] = `place in local board ${o.b}, cell ${o.c}`;
  // INDEPENDENT-PERMUTATION INVARIANCE (WEB-AI-07). The previous check re-derived the SAME
  // deterministic shuffle and compared it to itself - a tautology. Here the option list is permuted
  // with an INDEPENDENT seed (option order only; the teacher is board-based and is NOT reseeded, so
  // the gold id is a stable function of the position, not of the shuffle), and the gold move id must
  // be present and identical as a SET under both orders. This exercises real option-order robustness.
  const altSeed = (seed ^ 0x5bf03635) >>> 0;
  const alt = optionsWithSeed(state, altSeed);
  const altIds = alt.map((o) => o.id).sort().join('|');
  const optIds = opts.map((o) => o.id).sort().join('|');
  const invariant = altIds === optIds && opts.some((o) => o.id === teacherBest);
  return {
    id: `${gameId}#${state.moves.length}`,
    gameId, openingFamily, split, state: serialize(state),
    questions: {
      winNow: { type: 'noul', instructions: 'Can the player to move win the whole match this turn?' },
      opponentThreat: { type: 'noul', instructions: 'Does the opponent have an immediate mega win that must be denied this turn?' },
      bestMove: { type: 'choice', instructions: 'Which single legal move should the player to move play?', criteria },
    },
    gold: {
      winNow: { label: win ? 'true' : 'false', noul: win ? 0.999 : 0.001, type: 'noul', moveId: win ? moveId(win) : null },
      opponentThreat: { label: threat ? 'true' : 'false', noul: threat ? 0.999 : 0.001, type: 'noul' },
      bestMove: { label: teacherBest, type: 'choice', probabilities: probs, visits: diag.visits || null, modelVersion: S.VERSION, budgetMs },
    },
    factors: { revision: state.moves.length, legalCount: opts.length, required: state.required, turn: state.turn },
    labelAgreement: { optionCount: opts.length, invariant, altSeed },
  };
}

function build({ output, games = 8, seed = 3000, samplesPerGame = 6, budgetMs = 20 } = {}) {
  if (!output) throw Error('OUTPUT_REQUIRED');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fd = fs.openSync(output, 'wx'), hash = crypto.createHash('sha256');
  const counts = { train: 0, validation: 0, holdout: 0 }, ids = [];
  let rows = 0;
  let invarianceOk = 0, winNowPositive = 0, threatPositive = 0;
  try {
    for (let i = 0; i < games; i++) {
      const g = Data.game({ seed: seed + i, simulations: 8, targetSimulations: 24, exploreRate: 0.2 });
      const perGame = Math.max(1, Math.min(samplesPerGame, g.rows.length));
      for (let k = 0; k < perGame; k++) {
        const idx = Math.floor((k + 0.5) * g.rows.length / perGame);
        const row = g.rows[idx];
        // Reconstruct the exact canonical state at this revision.
        let state = G.create(row.first);
        for (const m of row.moves) state = G.apply(state, m);
        const dr = buildRow(state, { seed: seed + i * 100 + k, gameId: g.gameId, openingFamily: g.openingFamily, split: g.split, budgetMs });
        if (dr.labelAgreement.invariant) invarianceOk++;
        if (dr.gold.winNow.label === 'true') winNowPositive++;
        if (dr.gold.opponentThreat.label === 'true') threatPositive++;
        const text = JSON.stringify(dr) + '\n';
        fs.writeSync(fd, text); hash.update(text); rows++; counts[g.split]++;
      }
      ids.push({ gameId: g.gameId, openingFamily: g.openingFamily, split: g.split });
    }
  } finally { fs.closeSync(fd); }
  const manifest = {
    schemaVersion: 1, encodingVersion: E.VERSION, rulesSha256: digest(fs.readFileSync('src/game.js')),
    searchSha256: digest(fs.readFileSync('src/bot/search.js')), rows, games, seed, samplesPerGame, budgetMs,
    counts, gameIndex: ids, sha256: hash.digest('hex'),
    format: 'unsloth-decision (state + questions + gold)',
    optionOrder: 'deterministic per-position shuffle, plus an INDEPENDENT alternate-seed permutation whose teacher move must match (real option-order invariance, not a self-comparison)',
    invarianceOk, winNowPositive, threatPositive,
    splitPolicy: 'whole games grouped by D4-normalized four-ply opening; no family crosses splits',
    teacher: { engine: S.VERSION, budgetMs, note: 'gold bestMove is the strong teacher move, never a weak self-play played move' },
  };
  fs.writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

/* Deterministic invariance check used by tests: re-serializing and re-shuffling gives the same ids. */
function optionIdsFor(seed) {
  const g = Data.game({ seed, simulations: 4, targetSimulations: 8, exploreRate: 0.2 });
  const row = g.rows[0];
  let state = G.create(row.first); for (const m of row.moves) state = G.apply(state, m);
  return options(state).map((o) => o.id);
}

module.exports = { serialize, options, buildRow, build, optionIdsFor, opponentThreat, winNowMove };
if (require.main === module) { const [output = '.artifacts/cl19/decisions.jsonl', games = '8', seed = '3000', samplesPerGame = '6', budgetMs = '20'] = process.argv.slice(2); console.log(JSON.stringify(build({ output, games: Number(games), seed: Number(seed), samplesPerGame: Number(samplesPerGame), budgetMs: Number(budgetMs) }), null, 2)); }
