'use strict';

// Local, anonymous study preparation/scoring. No browser, analytics or API I/O.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const G = require('../../src/game.js');
const ROOT = path.resolve(__dirname, '../..');
const COLUMNS = ['participant_code', 'eligible', 'withdrawn', 'completed', 'coached', 'overall_goal', 'required_board', 'free_route'];
const ANSWERS = new Set(['correct', 'incorrect', 'no_answer']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function source() {
  return {
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    rules_sha256: hash(fs.readFileSync(path.join(ROOT, 'src/game.js'))),
    scorer_sha256: hash(fs.readFileSync(__filename)),
  };
}

function fixtures() {
  const sequences = [
    { id: 'routing-a', moves: [{ b: 0, c: 4 }, { b: 4, c: 2 }] },
    { id: 'routing-b', moves: [{ b: 2, c: 4 }, { b: 4, c: 8 }] },
    { id: 'free-route', moves: [{ b: 0, c: 4 }, { b: 4, c: 0 }, { b: 0, c: 3 }, { b: 3, c: 0 }, { b: 0, c: 5 }, { b: 5, c: 0 }] },
  ];
  const probes = sequences.map(({ id, moves }) => {
    const state = moves.reduce((previous, move) => G.apply(previous, move), G.create());
    const legal = G.legal(state);
    if (state.winner || !legal.length) throw Error('STUDY_FIXTURE_INVALID');
    const accepted_boards = [...new Set(legal.map(move => move.b))];
    if (id === 'free-route' && (state.mini[0] !== 'X' || state.required !== null || state.turn !== 'X' || state.moves.length !== 6)) throw Error('STUDY_HANDOFF_INVALID');
    if (id !== 'free-route' && (accepted_boards.length !== 1 || accepted_boards[0] !== state.required)) throw Error('STUDY_ROUTE_INVALID');
    return { id, moves, state, accepted_boards, accepted_board_names: accepted_boards.map(index => G.NAMES[index]), legal_cell_count: legal.length };
  });
  return { schema_version: 1, task_ids: ['R21', 'B03.14', 'B07.08'], ...source(), probes, authority: 'Canonical local rules only. Preparation is not novice comprehension evidence.' };
}

function parseResponses(text) {
  // Intentionally narrow CSV: anonymous codes and fixed enum fields only.
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines[0] !== COLUMNS.join(',')) throw Error('STUDY_COLUMNS_INVALID: use the exact anonymous template header');
  if (lines.length < 2) throw Error('STUDY_NO_RESPONSES: an empty template is not an executed study');
  const seen = new Set();
  return lines.slice(1).map((line, index) => {
    const values = line.split(',');
    if (values.length !== COLUMNS.length) throw Error('STUDY_ROW_INVALID: row ' + (index + 2));
    const row = Object.fromEntries(COLUMNS.map((key, column) => [key, values[column]]));
    if (!/^P\d{3}$/.test(row.participant_code) || seen.has(row.participant_code)) throw Error('STUDY_CODE_INVALID_OR_DUPLICATE: row ' + (index + 2));
    seen.add(row.participant_code);
    for (const key of ['eligible', 'withdrawn', 'completed', 'coached']) {
      if (!['true', 'false'].includes(row[key])) throw Error('STUDY_BOOLEAN_INVALID: row ' + (index + 2));
      row[key] = row[key] === 'true';
    }
    for (const key of ['overall_goal', 'required_board', 'free_route']) if (!ANSWERS.has(row[key])) throw Error('STUDY_ANSWER_INVALID: row ' + (index + 2));
    return row;
  });
}

function score(text) {
  const rows = parseResponses(text);
  const participants = rows.filter(row => row.eligible && !row.withdrawn);
  if (!participants.length) throw Error('STUDY_NO_ELIGIBLE_PARTICIPANTS');
  const n = participants.length;
  const unaided = key => participants.filter(row => !row.coached && row[key] === 'correct').length;
  const routing = unaided('required_board');
  // Wilson interval conveys cohort uncertainty; the 80% observed target is separate.
  const z = 1.959963984540054, p = routing / n, denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return {
    schema_version: 1, task_ids: ['R21', 'B03.14', 'B07.08'], ...source(),
    response_sha256: hash(Buffer.from(text)),
    denominator_policy: 'All eligible, non-withdrawn participants, including incomplete, coached and no-answer sessions. Coached answers never count as unaided correct.',
    enrolled: rows.length, eligible_nonwithdrawn: n, excluded_ineligible: rows.filter(row => !row.eligible).length,
    withdrawn_eligible: rows.filter(row => row.eligible && row.withdrawn).length,
    completed: participants.filter(row => row.completed).length, coached: participants.filter(row => row.coached).length,
    unaided_correct: { overall_goal: unaided('overall_goal'), required_board: routing, free_route: unaided('free_route') },
    required_board_score: { numerator: routing, denominator: n, percent: 100 * p, wilson_95_percent: [100 * Math.max(0, center - margin), 100 * Math.min(1, center + margin)], observed_80_percent_target_met: routing * 5 >= n * 4 },
    acceptance: 'Human review required; this scorer does not verify recruitment, assign PASS, approve narration/UI or generalize the observed cohort.',
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--fixtures') process.stdout.write(JSON.stringify(fixtures(), null, 2) + '\n');
    else if (args.length === 1 && args[0] === '--template') process.stdout.write(COLUMNS.join(',') + '\n');
    else if (args.length === 2 && args[0] === '--score') process.stdout.write(JSON.stringify(score(fs.readFileSync(args[1], 'utf8')), null, 2) + '\n');
    else throw Error('usage: node scripts/p21/novice-study.cjs --fixtures | --template | --score anonymous-responses.csv');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { COLUMNS, fixtures, parseResponses, score };
