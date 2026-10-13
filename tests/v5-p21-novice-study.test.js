'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { COLUMNS, fixtures, parseResponses, score } = require('../scripts/p21/novice-study.cjs');
const header = COLUMNS.join(',') + '\n';

test('R21-STUDY-01: canonical probes preserve the lesson handoff and required destinations', () => {
  const pack = fixtures();
  assert.deepEqual(pack.probes[0].accepted_boards, [2]);
  assert.deepEqual(pack.probes[1].accepted_boards, [8]);
  const free = pack.probes[2];
  assert.deepEqual(free.accepted_boards, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(free.state.mini[0], 'X');
  assert.equal(free.state.turn, 'X');
  assert.equal(free.state.required, null);
  assert.equal(free.state.moves.length, 6);
  assert.match(pack.rules_sha256, /^[a-f0-9]{64}$/);
});

test('R21-STUDY-02: incomplete/coached/no-answer cases stay in the primary denominator', () => {
  const rows = [
    'P001,true,false,true,false,correct,correct,correct',
    'P002,true,false,false,false,no_answer,no_answer,no_answer',
    'P003,true,false,true,true,correct,correct,correct',
    'P004,true,true,false,false,no_answer,no_answer,no_answer',
    'P005,false,false,true,false,correct,correct,correct',
  ];
  const result = score(header + rows.join('\n'));
  assert.equal(result.eligible_nonwithdrawn, 3);
  assert.equal(result.required_board_score.numerator, 1);
  assert.equal(result.required_board_score.denominator, 3);
  assert.equal(result.required_board_score.observed_80_percent_target_met, false);
  assert.equal(result.coached, 1);
  assert.equal(result.withdrawn_eligible, 1);
  assert.equal(result.excluded_ineligible, 1);
  assert.equal(result.completed, 2);
  assert.equal(result.participants, undefined, 'aggregate report excludes participant rows/codes');
});

test('R21-STUDY-03: empty templates, identities, duplicates and ambiguous values are refused', () => {
  assert.throws(() => score(header), /NO_RESPONSES/);
  assert.throws(() => parseResponses('email,' + header), /COLUMNS_INVALID/);
  assert.throws(() => parseResponses(header + 'person@example.com,true,false,true,false,correct,correct,correct'), /CODE_INVALID/);
  const row = 'P001,true,false,true,false,correct,correct,correct';
  assert.throws(() => parseResponses(header + row + '\n' + row), /DUPLICATE/);
  assert.throws(() => parseResponses(header + row.replace('true', 'yes')), /BOOLEAN_INVALID/);
  assert.throws(() => parseResponses(header + row.replace('correct', 'maybe')), /ANSWER_INVALID/);
  assert.throws(() => score(header + 'P001,false,false,true,false,correct,correct,correct'), /NO_ELIGIBLE/);
});

test('R21-STUDY-04: observed target and uncertainty are separate, without invented human acceptance', () => {
  const rows = Array.from({ length: 5 }, (_, i) => 'P00' + (i + 1) + ',true,false,true,false,correct,' + (i === 4 ? 'incorrect' : 'correct') + ',correct');
  const result = score(header + rows.join('\n'));
  assert.equal(result.required_board_score.percent, 80);
  assert.equal(result.required_board_score.observed_80_percent_target_met, true);
  assert.ok(result.required_board_score.wilson_95_percent[0] < 80);
  assert.ok(result.required_board_score.wilson_95_percent[1] > 80);
  assert.match(result.acceptance, /Human review required/);
  assert.equal(result.result, undefined);
});
