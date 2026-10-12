'use strict';
/* tests/bot/decision-teacher.test.cjs - CL18-CL20 decision-teacher schema contract.
 *
 * The actual fine-tune runs on the DGX (torch/unsloth, GPU). This test covers the pure Python
 * conversion logic that must match Unsloth's typed-decisions schema so the real run does not fail on
 * a shape error: questions{type,instructions,criteria}, gold{question:{type,label,...}}, and the
 * row->HF mapping. It runs the module's own functions via python3 and skips if python is absent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TEACHER = path.join(ROOT, 'training', 'bot', 'unsloth_teacher.py');

function pythonBin() {
  for (const c of [process.env.V5_OPERATOR_PYTHON, 'python3', 'python']) {
    if (c && spawnSync(c, ['-c', 'import sys'], { encoding: 'utf8' }).status === 0) return c;
  }
  return null;
}
const PY = pythonBin();

function run(body) {
  const script = `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'training', 'bot'))})\nimport unsloth_teacher as T\nprint(json.dumps(${body}))`;
  return spawnSync(PY, ['-c', script], { encoding: 'utf8', cwd: ROOT });
}

test('decision teacher: gold is a per-question answer object, not a bare bool/string', { skip: PY ? false : 'no python3' }, () => {
  const row = { state: 'Player to move: X', questions: { winNow: { instructions: 'win?' }, opponentThreat: { instructions: 'threat?' }, bestMove: { instructions: 'move?', criteria: { '0,0': 'cell' } } }, gold: { winNow: { label: 'true' }, opponentThreat: { label: 'false' }, bestMove: { label: '0,0', probabilities: { '0,0': 1 } } } };
  const res = run(`T.gold_block(${JSON.stringify(row)})`);
  assert.equal(res.status, 0, res.stderr);
  const gold = JSON.parse(res.stdout);
  assert.equal(gold.winNow.label, 'true');
  assert.equal(gold.winNow.type, 'noul');
  assert.equal(gold.bestMove.label, '0,0');
  assert.equal(gold.bestMove.type, 'choice');
  assert.equal(typeof gold.bestMove.probabilities, 'object');
});

test('decision teacher: questions carry type/instructions/criteria for the choice question', { skip: PY ? false : 'no python3' }, () => {
  const row = { state: 's', questions: { winNow: { instructions: 'win?' }, opponentThreat: { instructions: 'threat?' }, bestMove: { instructions: 'move?', criteria: { '1,2': 'cell 1,2' } } }, gold: { winNow: { label: 'false' }, opponentThreat: { label: 'false' }, bestMove: { label: '1,2' } } };
  const res = run(`T.questions_block(${JSON.stringify(row)})`);
  assert.equal(res.status, 0, res.stderr);
  const q = JSON.parse(res.stdout);
  assert.equal(q.bestMove.type, 'choice');
  assert.deepEqual(Object.keys(q.bestMove.criteria), ['1,2']);
  assert.equal(q.winNow.type, 'noul');
});
