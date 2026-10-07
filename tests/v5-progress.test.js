'use strict';
// Consumer-visible regression for scripts/v5/progress.js.
//
// `record --status IN_PROGRESS` without --evidence must leave task_evidence[id].evidence_refs
// as a valid array, so the ledger the CLI just wrote is accepted by `inspect`, and the task
// still blocks its dependent from completing. Everything runs through the real CLI entry
// point against a private temp ledger derived from the immutable original graph; the
// repository's actual progress/pack/projection files are never written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const progress = require('../scripts/v5/progress.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const GRAPH_REL = 'Mega-XO-V5-Implementation-Pack/tasks.json';
const ACCEPTANCE_REL = 'Mega-XO-V5-Implementation-Pack/acceptance.json';

// Build a private ledger in the graph's own initial state, so it carries no mutable execution
// claims. The pack graph and acceptance contracts are copied into the temp root so inspect can
// cross-check them; only non-status contract fields and graph-relative paths are used there.
function fixture(t) {
  const graph = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, GRAPH_REL), 'utf8'));
  const acceptance = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ACCEPTANCE_REL), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-v5-progress-'));
  const root = path.join(dir, 'root');
  const packDir = path.join(root, path.dirname(GRAPH_REL));
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'v5', 'evidence'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, GRAPH_REL), path.join(root, GRAPH_REL));
  fs.copyFileSync(path.join(REPO_ROOT, ACCEPTANCE_REL), path.join(root, ACCEPTANCE_REL));
  const ledgerPath = path.join(root, 'docs', 'v5', 'progress.json');
  const todoPath = path.join(root, 'docs', 'v5', 'TODO.md');
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const ledger = {
    schema_version: 1,
    updated_at_utc: '2000-01-01T00:00:00.000+00:00',
    goal: 'fixture',
    source: { goal: 'AGENT-GOAL.md', pack: 'Mega-XO-V5-Implementation-Pack', task_graph: GRAPH_REL, acceptance: ACCEPTANCE_REL },
    baseline: { selected_sha: graph.baseline_sha, selected_branch: 'V4.1' },
    current: { phase: 'P00', active_task: null, completed_task_ids: [], passed_phase_gates: [] },
    program: {
      schema_version: graph.schema_version,
      project: graph.project,
      prepared_date: graph.prepared_date,
      baseline_sha: graph.baseline_sha,
      integration_branch: graph.integration_branch,
      scope: graph.scope,
      status_vocabulary: graph.status_vocabulary,
      phase_gate_policy: graph.phase_gate_policy,
      phases: copy(graph.phases),
      tasks: copy(graph.tasks),
    },
    acceptance_cases: copy(acceptance.cases),
    task_evidence: {},
    known_observations: [],
    carried_local_work: {},
    production_safety: {},
    storage: {},
    references: {},
    setup: {},
  };
  for (const phase of ledger.program.phases) phase.status = phase.execution_mode === 'DEFERRED_BY_OWNER' ? 'DEFERRED_BY_OWNER' : 'PLANNED';
  for (const task of ledger.program.tasks) task.status = 'PLANNED';
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  // Genuine evidence for the dependent, so its refusal is about the dependency, not evidence.
  fs.writeFileSync(path.join(root, 'docs', 'v5', 'evidence', 'V5-00-04.json'),
    JSON.stringify({ schema_version: 1, status: 'PASS', task_ids: ['V5-00-04'], observed_at_utc: '2000-01-01T00:00:00.000+00:00', commands: ['fixture'] }, null, 2) + '\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    root,
    ledgerPath,
    todoPath,
    read: () => JSON.parse(fs.readFileSync(ledgerPath, 'utf8')),
    write: (value) => fs.writeFileSync(ledgerPath, JSON.stringify(value, null, 2) + '\n'),
  };
}

// Drive the real CLI in-process. A refusal throws a CliError (main's exit-code mapping lives
// in the executable wrapper), which is reported here as a non-zero exit code.
function cli(f, argv) {
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    progress.main([...argv, '--ledger', f.ledgerPath, '--todo', f.todoPath, '--root', f.root, '--no-render']);
    return { output: chunks.join(''), exitCode: 0 };
  } catch (error) {
    assert.ok(error instanceof progress.CliError, 'unexpected error: ' + error.message);
    return { output: '', exitCode: error.kind === 'usage' ? 64 : 1, error };
  } finally {
    process.stdout.write = write;
  }
}

test('no-evidence IN_PROGRESS record keeps evidence_refs valid and still blocks its dependent', t => {
  const f = fixture(t);
  const inspect = () => progress.inspect({ root: f.root, ledgerPath: f.ledgerPath, todoPath: f.todoPath });

  // First mutable transition on V5-00-03, with no --evidence at all. V5-00-03 depends on
  // V5-00-02, which is still PLANNED, so IN_PROGRESS (non-closing) must be accepted.
  const recorded = cli(f, ['record', '--task', 'V5-00-03', '--status', 'IN_PROGRESS', '--note', 'branch work started']);
  assert.equal(recorded.exitCode, 0, 'no-evidence IN_PROGRESS record must succeed');

  const entry = f.read().task_evidence['V5-00-03'];
  assert.ok(Array.isArray(entry.evidence_refs), 'evidence_refs must be an array after a no-evidence record');
  assert.equal(entry.evidence_refs.length, 0);
  assert.equal(f.read().program.tasks.find((task) => task.id === 'V5-00-03').status, 'IN_PROGRESS');

  // Consumer-visible workflow: the ledger the CLI just wrote is accepted by inspect.
  const report = inspect();
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
  assert.equal(report.tasks.status_counts.IN_PROGRESS, 1);

  // The dependent stays blocked while its dependency is IN_PROGRESS, even with real evidence.
  const depend = cli(f, ['record', '--task', 'V5-00-04', '--status', 'COMPLETE', '--evidence', 'docs/v5/evidence/V5-00-04.json', '--note', 'done']);
  assert.equal(depend.exitCode, 1);
  assert.equal(depend.error.code, 'TASK_DEPENDENCY_NOT_TERMINAL');
  assert.equal(f.read().program.tasks.find((task) => task.id === 'V5-00-04').status, 'PLANNED');

  // Re-recording an existing entry whose refs are missing repairs them to a valid array.
  const damaged = f.read();
  delete damaged.task_evidence['V5-00-03'].evidence_refs;
  f.write(damaged);
  assert.equal(cli(f, ['record', '--task', 'V5-00-03', '--status', 'IN_PROGRESS', '--note', 'still going']).exitCode, 0);
  assert.deepEqual(f.read().task_evidence['V5-00-03'].evidence_refs, []);
  assert.deepEqual(inspect().errors, []);

  // Existing refs survive a later transition that supplies no new evidence.
  const carrying = f.read();
  carrying.task_evidence['V5-00-03'].evidence_refs = ['docs/v5/evidence/V5-00-04.json'];
  f.write(carrying);
  assert.equal(cli(f, ['record', '--task', 'V5-00-03', '--status', 'IN_PROGRESS', '--note', 'kept refs']).exitCode, 0);
  const kept = f.read().task_evidence['V5-00-03'];
  assert.deepEqual(kept.evidence_refs, ['docs/v5/evidence/V5-00-04.json']);
  assert.equal(kept.transitions.length, 3);
});
