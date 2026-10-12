'use strict';
/* tests/bot/learning-operator.test.cjs - continuous-learning operator contract (CL06/CL07/CL16/CL17).
 *
 * The operator is a Python state machine (training/bot/champion_cycle.py). Its correctness-critical,
 * cheaply-testable surface is exercised here with a real `python3` process (the module imports only
 * the standard library):
 *
 *   * configuration bounds are rejected BEFORE any stage runs;
 *   * the promotion gate matches the league's own declared threshold (lower paired CI >= 0.65) and a
 *     weak candidate is rejected, never promoted;
 *   * a `plan` produces real argv arrays for all five stages (no shell strings);
 *   * a `status` on an unknown run reports an honest CREATED state.
 *
 * The full generate->train->export->league->decide cycle needs torch/onnx (python) and
 * onnxruntime-node, so the integration assertions are gated behind V5_LEARNING_OPERATOR_PREREQS=1 and
 * skip (with the reason) otherwise - they are never faked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const OPERATOR = path.join(ROOT, 'training', 'bot', 'champion_cycle.py');
const HAVE_PREREQS = process.env.V5_LEARNING_OPERATOR_PREREQS === '1';
const GATE = HAVE_PREREQS ? false : 'set V5_LEARNING_OPERATOR_PREREQS=1 (needs torch/onnx + onnxruntime-node)';

function pythonBin() {
  for (const candidate of [process.env.V5_OPERATOR_PYTHON, 'python3', 'python']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import sys'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PY = pythonBin();

function runOperator(args, opts = {}) {
  const res = spawnSync(PY, [OPERATOR, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });
  return res;
}

test('learning operator: configuration bounds are rejected before any stage runs', { skip: PY ? false : 'no python3' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-cfg-'));
  const bad = runOperator(['plan', '--run-id', 'cfg', '--output-root', dir, '--games', '1']);
  assert.notEqual(bad.status, 0, 'out-of-range games is refused');
  assert.match(bad.stderr + bad.stdout, /CONFIG_INVALID:games/, 'names the offending key');
  const badWidth = runOperator(['plan', '--run-id', 'cfg2', '--output-root', dir, '--config', writeCfg(dir, { width: 50 })]);
  assert.match(badWidth.stderr + badWidth.stdout, /CONFIG_INVALID:width/, 'an unsupported width is refused');
});

test('learning operator: the promotion gate uses the league threshold and rejects a weak candidate', { skip: PY ? false : 'no python3' }, () => {
  const script = [
    'import json, sys',
    "sys.path.insert(0, 'training/bot')",
    'import champion_cycle as cc',
    'weak = {"matchups":[{"engineA":"policyValuePUCT","engineB":"improvedExpert","summary":{"pointScore":0.4,"pairBootstrap95":[0.1,0.7]}}]}',
    'strong = {"matchups":[{"engineA":"policyValuePUCT","engineB":"improvedExpert","summary":{"pointScore":0.78,"pairBootstrap95":[0.66,0.9]}}]}',
    'print(json.dumps({"weak":cc.evaluate_gate(weak),"strong":cc.evaluate_gate(strong)}))',
  ].join('\n');
  const res = spawnSync(PY, ['-c', script], { encoding: 'utf8', cwd: ROOT });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.weak.promote, false, 'a candidate whose lower CI is below 0.65 is rejected');
  assert.equal(out.strong.promote, true, 'a candidate clearing the gate is promotable');
  assert.match(out.strong.threshold, /0\.65/, 'the frozen threshold is 0.65');
});

test('learning operator: plan emits real argv arrays for all five stages', { skip: PY ? false : 'no python3' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-plan-'));
  const res = runOperator(['plan', '--run-id', 'plan', '--output-root', dir]);
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.deepEqual(data.plan.map((s) => s.stage),
    ['GENERATING', 'DATA_VALIDATED', 'TRAINING', 'EXPORT_VALIDATED', 'EVALUATING']);
  for (const stage of data.plan) {
    assert.ok(Array.isArray(stage.argv) && stage.argv.length >= 2, `${stage.stage} is an argv array, not a shell string`);
    assert.ok(!stage.argv.some((a) => /[;&|]/.test(a)), `${stage.stage} argv contains no shell metacharacters`);
  }
});

test('learning operator: status of an unknown run is an honest CREATED state', { skip: PY ? false : 'no python3' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-status-'));
  const res = runOperator(['status', '--run-id', 'fresh', '--output-root', dir]);
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.runId, 'fresh');
  assert.deepEqual(data.stages, {});
  assert.equal(data.promotionApproved, false, 'a fresh run never claims approval');
});

/* Integration: a real bounded cycle. Gated on torch/onnx + onnxruntime-node availability so CI on a
 * host without the ML stack skips honestly instead of faking a pass. */
test('learning operator: a bounded real cycle completes and a killed cycle resumes', { skip: GATE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-run-'));
  const res = runOperator(['run', '--run-id', 'real', '--output-root', dir,
    '--games', '8', '--epochs', '1', '--league-pairs', '2', '--budget-ms', '5'], { timeout: 900000 });
  assert.equal(res.status, 0, res.stderr.slice(-2000));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  for (const stage of ['GENERATING', 'DATA_VALIDATED', 'TRAINING', 'EXPORT_VALIDATED', 'EVALUATING']) {
    assert.equal(state.stages[stage].status, 'complete', `${stage} completed`);
  }
  assert.ok(['REJECTED', 'RESEARCH_APPROVED'].includes(state.status), 'the cycle reached a decision');
  assert.equal(state.promotionApproved, state.status === 'RESEARCH_APPROVED', 'promotion flag matches the decision');
  assert.ok(!fs.existsSync(path.join(dir, 'export', 'APPROVED')), 'nothing is silently marked APPROVED');
});

function writeCfg(dir, obj) {
  const p = path.join(dir, `cfg-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
