'use strict';
// V5 progress ledger CLI: inspect / record / gate / render over docs/v5/progress.json.
// The JSON ledger is the mutable execution record; docs/v5/TODO.md is its generated projection.
// This tool never invents acceptance: it validates declared evidence, refuses completion
// without terminal prerequisites and records what the operator actually stated.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LEDGER = 'docs/v5/progress.json';
const DEFAULT_TODO = 'docs/v5/TODO.md';

// Statuses that close a task and let a dependent task or phase gate proceed.
// EVIDENCE_GAP is deliberately NOT here: an unresolved factual gap keeps the task open,
// blocks its dependents and blocks its phase gate until the operator records COMPLETE.
const TERMINAL_STATUSES = new Set(['COMPLETE', 'NOT_TRIGGERED', 'DEFERRED_BY_OWNER']);
// Evidence-bearing but still open: the operator recorded an evidence level, not acceptance.
const INTERMEDIATE_STATUSES = new Set([
  'IMPLEMENTED', 'TESTED_LOCAL', 'VERIFIED_STAGING', 'DEVICE_VERIFIED',
  'SUBMITTED', 'PROVIDER_APPROVED', 'PRODUCTION_ENABLED',
]);
const GAP_STATUS = 'EVIDENCE_GAP';
const PHASE_STATUSES = new Set(['PLANNED', 'IN_PROGRESS', 'COMPLETE', 'DEFERRED_BY_OWNER', 'NOT_TRIGGERED']);
const EXECUTION_MODES = new Set(['EXECUTE', 'DEFERRED_BY_OWNER', 'MEASUREMENT_GATED']);
const KNOWN_CASE_STATUSES = new Set(['NOT_RUN', 'RUNNING', 'PASS', 'FAIL', 'BLOCKED', 'INVALID', 'DEFERRED_BY_OWNER']);
// Ledger sections this tool must never rewrite.
const PRESERVED_KEYS = [
  'schema_version', 'goal', 'source', 'baseline', 'acceptance_cases', 'known_observations',
  'carried_local_work', 'production_safety', 'storage', 'references', 'setup',
];
const TASK_ID_PATTERN = /^V5-\d{2}-\d{2}$/;
const PHASE_ID_PATTERN = /^P\d{2}$/;
const GATE_LABEL_PATTERN = /^G\d{2}$/;
const LEDGER_TOP_LEVEL_KEYS = [
  'schema_version', 'updated_at_utc', 'goal', 'source', 'baseline', 'current', 'program',
  'acceptance_cases', 'task_evidence', 'known_observations', 'carried_local_work',
  'production_safety', 'storage', 'references', 'setup',
];
const TODO_CHECKED_STATUSES = new Set(['COMPLETE', 'NOT_TRIGGERED']);

const MEASUREMENT_DATA_KEYS = ['metrics', 'measurements', 'baseline', 'thresholds', 'triggers', 'operating_envelope', 'capacity'];
const MEASUREMENT_DECISION_KEYS = ['decision', 'trigger_decision', 'trigger_met'];

class CliError extends Error {
  constructor(code, detail, kind = 'refusal') {
    super(detail ? code + ': ' + detail : code);
    this.code = code;
    this.detail = detail || '';
    this.kind = kind;
  }
}

const usage = (code, detail) => new CliError(code, detail, 'usage');
const refuse = (code, detail) => new CliError(code, detail, 'refusal');

// ------------------------------------------------------------------ helpers

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw refuse('FILE_NOT_FOUND', file);
    throw refuse('FILE_UNREADABLE', file + ' (' + error.code + ')');
  }
}

function readJsonFile(file, code) {
  const text = readText(file);
  try {
    return { file, text, value: JSON.parse(text) };
  } catch (error) {
    const match = /position (\d+)/.exec(error.message);
    let where = '';
    if (match) {
      const offset = Number(match[1]);
      const before = text.slice(0, offset);
      where = ' at line ' + before.split('\n').length + ' column ' + (offset - before.lastIndexOf('\n'));
    }
    throw refuse(code || 'JSON_INVALID', file + where + ' (' + error.message + ')');
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const handle = fs.openSync(temp, 'wx', mode);
  try {
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    while (written < buffer.length) written += fs.writeSync(handle, buffer, written, buffer.length - written);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  const dirHandle = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dirHandle); } catch { /* directory fsync is best effort on some filesystems */ } finally { fs.closeSync(dirHandle); }
}

function nowUtc() {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1+00:00');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function gateLabel(phase) {
  const match = /^([A-Z0-9_]+):/.exec(String(phase.exit_gate || ''));
  return match ? match[1] : null;
}

function repoRelative(value, label) {
  if (!nonEmptyString(value)) throw usage('MISSING_ARGUMENT', label + ' requires a repository-relative path');
  if (path.isAbsolute(value)) throw usage('REPOSITORY_RELATIVE_PATH_REQUIRED', label + ' must be repository-relative, got ' + value);
  const normalized = value.split('\\').join('/').replace(/^\.\//, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw usage('REPOSITORY_RELATIVE_PATH_REQUIRED', label + ' must not escape the repository root: ' + value);
  }
  return normalized;
}

function deepCopy(value) {
  return structuredClone(value);
}

function assertPreserved(before, after) {
  for (const key of PRESERVED_KEYS) {
    if (JSON.stringify(before.preserved[key]) !== JSON.stringify(after[key])) throw refuse('INTERNAL_STATE_CHANGED', 'preserved section changed: ' + key);
  }
  for (const [index, phase] of after.program.phases.entries()) {
    const original = before.program.phases[index];
    for (const key of Object.keys(original)) {
      if (key === 'status') continue;
      if (JSON.stringify(original[key]) !== JSON.stringify(phase[key])) throw refuse('INTERNAL_STATE_CHANGED', 'phase contract changed: ' + phase.id + '.' + key);
    }
  }
  for (const [index, task] of after.program.tasks.entries()) {
    const original = before.program.tasks[index];
    for (const key of Object.keys(original)) {
      if (key === 'status') continue;
      if (JSON.stringify(original[key]) !== JSON.stringify(task[key])) throw refuse('INTERNAL_STATE_CHANGED', 'task contract changed: ' + task.id + '.' + key);
    }
  }
}

function snapshot(ledger) {
  return deepCopy({ preserved: pickPreserved(ledger), program: ledger.program });
}

// ------------------------------------------------------------ ledger reading

function readLedger(file) {
  const text = readText(file);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const match = /position (\d+)/.exec(error.message);
    let where = '';
    if (match) {
      const offset = Number(match[1]);
      const before = text.slice(0, offset);
      where = ' at line ' + before.split('\n').length + ' column ' + (offset - before.lastIndexOf('\n'));
    }
    throw refuse('LEDGER_JSON_INVALID', file + where + ' (' + error.message + '); repair the ledger first, this tool never rewrites an unparseable ledger');
  }
  if (!isPlainObject(value)) throw refuse('LEDGER_NOT_OBJECT', file);
  if (!isPlainObject(value.program) || !Array.isArray(value.program.phases) || !Array.isArray(value.program.tasks)) {
    throw refuse('LEDGER_PROGRAM_MISSING', file + ' has no program.phases/program.tasks graph');
  }
  return value;
}

function taskIndex(ledger) {
  return new Map(ledger.program.tasks.map((task) => [task.id, task]));
}

function phaseIndex(ledger) {
  return new Map(ledger.program.phases.map((phase) => [phase.id, phase]));
}

function passedGateIds(ledger) {
  const entries = ledger.current && Array.isArray(ledger.current.passed_phase_gates) ? ledger.current.passed_phase_gates : [];
  const ids = [];
  for (const entry of entries) {
    if (typeof entry === 'string') ids.push(entry);
    else if (isPlainObject(entry) && typeof entry.phase === 'string') ids.push(entry.phase);
  }
  return ids;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function taskEvidenceEntry(ledger, id) {
  if (!isPlainObject(ledger.task_evidence)) return null;
  const entry = ledger.task_evidence[id];
  return isPlainObject(entry) ? entry : null;
}

function blockedReasons(ledger, task) {
  const tasks = taskIndex(ledger);
  const gates = new Set(passedGateIds(ledger));
  const reasons = [];
  for (const id of task.depends_on_tasks || []) {
    const dependency = tasks.get(id);
    if (!dependency) reasons.push('unknown dependency ' + id);
    else if (!isTerminal(dependency.status)) reasons.push('waits task ' + id + ' (' + dependency.status + ')');
  }
  for (const gate of task.requires_phase_gates || []) {
    if (!gates.has(gate)) reasons.push('waits phase gate ' + gate);
  }
  return reasons;
}

function eligibleTasks(ledger) {
  return ledger.program.tasks.filter((task) => !isTerminal(task.status) && blockedReasons(ledger, task).length === 0);
}

function terminalTasks(ledger) {
  return ledger.program.tasks.filter((task) => isTerminal(task.status));
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

// -------------------------------------------------------- evidence checks

function collectStrings(value, output) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (isPlainObject(value)) for (const [key, item] of Object.entries(value)) { output.push(key); collectStrings(item, output); }
  return output;
}

function evidenceTaskIds(value) {
  const ids = new Set();
  if (nonEmptyString(value.task_id)) ids.add(value.task_id);
  if (Array.isArray(value.task_ids)) for (const id of value.task_ids) if (nonEmptyString(id)) ids.add(id);
  return ids;
}

// Returns { value, warnings }. Throws when the file is not genuine evidence.
function loadEvidence(relativePath, root, label) {
  const relative = repoRelative(relativePath, label);
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw refuse('EVIDENCE_FILE_MISSING', relative + ' does not exist under ' + root);
  const loaded = readJsonFile(file, 'EVIDENCE_JSON_INVALID');
  const value = loaded.value;
  const warnings = [];
  if (!isPlainObject(value)) throw refuse('EVIDENCE_NOT_AN_OBJECT', relative);
  const status = typeof value.status === 'string' ? value.status : '';
  if (/TEMPLATE|NOT_EXECUTED|UNEXECUTED|PLACEHOLDER|TODO_FILL/i.test(status)) {
    throw refuse('EVIDENCE_IS_TEMPLATE', relative + ' declares status ' + status);
  }
  const executed = isPlainObject(value.result) && 'executed' in value.result ? value.result.executed : value.executed;
  if (executed === false) throw refuse('EVIDENCE_NOT_EXECUTED', relative + ' records executed=false');
  if (!status && !nonEmptyString(value.observed_at_utc) && !Array.isArray(value.commands)) {
    warnings.push('EVIDENCE_UNSTRUCTURED: ' + relative + ' declares no status, observation time or commands');
  }
  return { relative, file, value, warnings };
}

function requireEvidenceMentionsTask(evidence, taskId, warnings) {
  const declared = evidenceTaskIds(evidence.value);
  if (declared.size === 0) warnings.push('EVIDENCE_TASK_NOT_DECLARED: ' + evidence.relative + ' declares no task_id/task_ids');
  else if (!declared.has(taskId)) {
    throw refuse('EVIDENCE_TASK_ID_MISMATCH', evidence.relative + ' declares ' + [...declared].join(',') + ' but the recorded task is ' + taskId);
  }
}

// ------------------------------------------------------------ ledger writes

function persist(ledger, { ledgerPath, todoPath, render: doRender, root }) {
  const serialized = JSON.stringify(ledger, null, 2) + '\n';
  writeAtomic(ledgerPath, serialized);
  const result = { ledger: ledgerPath, written: true, bytes: Buffer.byteLength(serialized) };
  if (doRender) {
    const text = renderTodo(ledger, { root, ledgerPath, todoPath });
    const current = fs.existsSync(todoPath) ? fs.readFileSync(todoPath, 'utf8') : null;
    if (current !== text) {
      writeAtomic(todoPath, text);
      result.todo = { path: todoPath, written: true, bytes: Buffer.byteLength(text) };
    } else {
      result.todo = { path: todoPath, written: false, bytes: Buffer.byteLength(text) };
    }
  }
  return result;
}

function refreshCurrent(ledger) {
  const terminalIds = new Set(terminalTasks(ledger).map((task) => task.id));
  ledger.current.completed_task_ids = ledger.program.tasks.filter((task) => terminalIds.has(task.id)).map((task) => task.id);
  const next = eligibleTasks(ledger)[0] || null;
  ledger.current.active_task = next ? next.id : null;
  if (next) ledger.current.phase = next.phase;
}

function stampPhase(ledger, phaseId, fallback) {
  const phase = phaseIndex(ledger).get(phaseId);
  if (!phase || phase.execution_mode === 'DEFERRED_BY_OWNER') return fallback;
  if (phase.status === 'PLANNED') phase.status = 'IN_PROGRESS';
  return phase.status;
}

// ------------------------------------------------------------------ record

function record(ledger, options) {
  const { taskId, status, evidenceRef, note, clearRemaining, root } = options;
  const tasks = taskIndex(ledger);
  const task = tasks.get(taskId);
  if (!task) throw refuse('UNKNOWN_TASK', taskId + ' is not in the task graph (expected V5-xx-yy)');
  const vocabulary = Array.isArray(ledger.program.status_vocabulary) ? ledger.program.status_vocabulary : [];
  if (!vocabulary.includes(status)) throw usage('UNKNOWN_STATUS', status + '; vocabulary is ' + vocabulary.join(','));
  const previous = task.status;
  if (previous === status && !note && !evidenceRef && !clearRemaining) {
    throw usage('NO_CHANGE_REQUESTED', taskId + ' is already ' + status + '; pass --note/--evidence or a different --status');
  }
  const warnings = [];

  if (status === GAP_STATUS && !/unresolved|reported|classif|unknown/i.test(String(task.verification || ''))) {
    throw refuse('EVIDENCE_GAP_NOT_PERMITTED_BY_VERIFICATION',
      taskId + ' verification does not permit a reported/unresolved classification: ' + task.verification + '; record the task as executed or keep it open');
  }
  if (status === 'NOT_TRIGGERED' && !nonEmptyString(task.execution_condition)) {
    throw refuse('NOT_TRIGGERED_REQUIRES_EXECUTION_CONDITION', taskId + ' declares no execution_condition');
  }
  if (status === 'DEFERRED_BY_OWNER') {
    const phase = phaseIndex(ledger).get(task.phase);
    if (!phase || phase.execution_mode !== 'DEFERRED_BY_OWNER') {
      throw refuse('DEFERRED_STATUS_NOT_APPLICABLE', taskId + ' belongs to ' + task.phase + ' (' + (phase ? phase.execution_mode : 'unknown mode') + '); owner deferral is recorded on the phase');
    }
  }

  let evidence = null;
  if (status === 'PLANNED' || status === 'IN_PROGRESS') {
    if (evidenceRef) evidence = loadEvidence(evidenceRef, root, '--evidence');
  } else if (evidenceRef) {
    evidence = loadEvidence(evidenceRef, root, '--evidence');
  } else {
    if (task.evidence_required !== false) {
      const entry = taskEvidenceEntry(ledger, taskId);
      if (!entry || !Array.isArray(entry.evidence_refs) || entry.evidence_refs.length === 0) {
        throw usage('EVIDENCE_REQUIRED', taskId + ' -> ' + status + ' requires --evidence <repository-relative json>');
      }
      evidence = loadEvidence(entry.evidence_refs[entry.evidence_refs.length - 1], root, '--evidence');
      warnings.push('EVIDENCE_REUSED: no --evidence given for ' + taskId + '; revalidated recorded ' + evidence.relative);
    }
  }
  if (evidence) requireEvidenceMentionsTask(evidence, taskId, warnings);

  if (isTerminal(status)) {
    for (const id of task.depends_on_tasks || []) {
      const dependency = tasks.get(id);
      if (!dependency) throw refuse('UNKNOWN_DEPENDENCY_TARGET', taskId + ' depends on missing task ' + id);
      if (!isTerminal(dependency.status)) {
        throw refuse('TASK_DEPENDENCY_NOT_TERMINAL', taskId + ' cannot be ' + status + ' while ' + id + ' is ' + dependency.status);
      }
    }
    const gates = new Set(passedGateIds(ledger));
    for (const gate of task.requires_phase_gates || []) {
      if (!gates.has(gate)) throw refuse('PHASE_GATE_NOT_PASSED', taskId + ' requires a passed phase gate ' + gate + '; run gate --phase ' + gate);
    }
  } else if (previous === GAP_STATUS) {
    throw refuse('EVIDENCE_GAP_STILL_OPEN',
      taskId + ' has an unresolved factual gap; close it with COMPLETE (evidence + note) or leave it open. No waiver closes a gap.');
  }
  if (isTerminal(status) && !nonEmptyString(note)) {
    throw usage('NOTE_REQUIRED', taskId + ' -> ' + status + ' requires --note describing the operator acceptance and its scope');
  }
  if (isTerminal(previous) && !isTerminal(status) && !nonEmptyString(note)) {
    throw usage('NOTE_REQUIRED', 'reopening terminal task ' + taskId + ' requires --note');
  }

  const before = snapshot(ledger);
  task.status = status;
  if (isPlainObject(ledger.task_evidence)) {
    const entry = isPlainObject(ledger.task_evidence[taskId]) ? ledger.task_evidence[taskId] : {};
    entry.status = status;
    // Always leave a valid array, even on a first PLANNED/IN_PROGRESS record without
    // --evidence or on an existing entry whose refs are missing/not an array. Existing
    // refs are preserved; only a non-array is replaced.
    if (!Array.isArray(entry.evidence_refs)) entry.evidence_refs = [];
    if (evidence && !entry.evidence_refs.includes(evidence.relative)) entry.evidence_refs.push(evidence.relative);
    if (!Array.isArray(entry.completed_portions)) entry.completed_portions = [];
    if (!Array.isArray(entry.remaining)) entry.remaining = [];
    if (nonEmptyString(note)) {
      entry.review_notes = nonEmptyString(entry.review_notes) ? entry.review_notes + ' ' + note : note;
    }
    const transitions = Array.isArray(entry.transitions) ? entry.transitions : [];
    const transition = { at_utc: nowUtc(), from: previous, to: status };
    if (evidence) transition.evidence = evidence.relative;
    if (nonEmptyString(note)) transition.note = note;
    if (clearRemaining) {
      transition.cleared_remaining = deepCopy(entry.remaining);
      entry.remaining = [];
    }
    transitions.push(transition);
    entry.transitions = transitions;
    ledger.task_evidence[taskId] = entry;
  } else {
    warnings.push('LEDGER_TASK_EVIDENCE_MISSING: recorded status without a task_evidence section');
  }
  refreshCurrent(ledger);
  stampPhase(ledger, task.phase, null);
  ledger.updated_at_utc = nowUtc();
  assertPreserved(before, ledger);
  const entry = taskEvidenceEntry(ledger, taskId);
  if (isTerminal(status) && entry && Array.isArray(entry.remaining) && entry.remaining.length) {
    warnings.push('TASK_TERMINAL_WITH_REMAINING: ' + taskId + ' is ' + status + ' but task_evidence.remaining is non-empty; re-record with --clear-remaining to move those items into the transition record');
  }
  return { task: taskId, from: previous, to: status, evidence: evidence ? evidence.relative : null, warnings };
}

function pickPreserved(ledger) {
  const copy = {};
  for (const key of PRESERVED_KEYS) copy[key] = deepCopy(ledger[key]);
  return copy;
}

// -------------------------------------------------------------------- gate

function validateMeasuredEvidence(relative, root, phaseTasks) {
  const evidence = loadEvidence(relative, root, '--measured-evidence');
  const value = evidence.value;
  const hasData = MEASUREMENT_DATA_KEYS.some((key) => {
    const item = value[key];
    if (Array.isArray(item)) return item.length > 0;
    if (isPlainObject(item)) return Object.keys(item).length > 0;
    return item !== undefined && item !== null && item !== '';
  });
  if (!hasData) {
    throw refuse('MEASURED_EVIDENCE_NOT_MEASURED', evidence.relative + ' records none of ' + MEASUREMENT_DATA_KEYS.join(','));
  }
  const decision = MEASUREMENT_DECISION_KEYS.find((key) => value[key] !== undefined && value[key] !== null);
  if (!decision) {
    throw refuse('MEASURED_EVIDENCE_MISSING_TRIGGER_DECISION', evidence.relative + ' must record one of ' + MEASUREMENT_DECISION_KEYS.join(','));
  }
  const deferred = phaseTasks.filter((task) => task.status === 'NOT_TRIGGERED').map((task) => task.id);
  if (deferred.length) {
    const strings = new Set(collectStrings(value, []));
    const missing = deferred.filter((id) => !strings.has(id));
    if (missing.length) {
      throw refuse('MEASURED_EVIDENCE_MISSING_TASK_IDS', evidence.relative + ' must name the not-triggered task(s) ' + missing.join(','));
    }
  }
  return { evidence, decision, deferred };
}

function gate(ledger, options) {
  const { phaseId, evidenceRef, measuredRef, note, root } = options;
  const phases = phaseIndex(ledger);
  const phase = phases.get(phaseId);
  if (!phase) throw refuse('UNKNOWN_PHASE', phaseId + ' is not in the phase graph (expected Pxx)');
  if (phase.execution_mode === 'DEFERRED_BY_OWNER' || phase.status === 'DEFERRED_BY_OWNER') {
    throw refuse('PHASE_DEFERRED_BY_OWNER', phaseId + ' stays DEFERRED_BY_OWNER; owner-deferred phases are never gated');
  }
  const known = taskIndex(ledger);
  const tasks = (phase.task_ids || []).map((id) => known.get(id)).filter(Boolean);
  if (tasks.length === 0) throw refuse('PHASE_HAS_NO_TASKS', phaseId + ' declares no tasks to gate');
  if (!nonEmptyString(note)) throw usage('NOTE_REQUIRED', 'gate --phase ' + phaseId + ' requires --note recording who accepted the gate');
  if (!evidenceRef) throw usage('EVIDENCE_REQUIRED', 'gate --phase ' + phaseId + ' requires --evidence <repository-relative json>');
  const already = passedGateIds(ledger);
  if (already.includes(phaseId)) throw refuse('PHASE_ALREADY_GATED', phaseId + ' is already recorded as passed');

  const warnings = [];
  const seen = new Set();
  for (const id of phase.task_ids || []) {
    if (seen.has(id)) throw refuse('PHASE_TASK_DUPLICATED', phaseId + ' lists ' + id + ' twice');
    seen.add(id);
  }
  for (const task of ledger.program.tasks) {
    if (task.phase === phaseId && !seen.has(task.id)) {
      throw refuse('PHASE_TASK_NOT_LISTED', task.id + ' belongs to ' + phaseId + ' but is missing from its task_ids');
    }
  }
  const gaps = tasks.filter((task) => task.status === GAP_STATUS);
  if (gaps.length) {
    throw refuse('PHASE_TASKS_HAVE_EVIDENCE_GAPS',
      phaseId + ' has unresolved factual gaps ' + gaps.map((task) => task.id).join(',') + '; a phase gate is never waived. Close each with an explicit accepted COMPLETE (evidence + note) first.');
  }
  const open = tasks.filter((task) => !isTerminal(task.status));
  if (open.length) {
    throw refuse('PHASE_TASKS_NOT_TERMINAL', phaseId + ' still has ' + open.map((task) => task.id + ':' + task.status).join(', '));
  }
  const gateEvidence = loadEvidence(evidenceRef, root, '--evidence');
  const declaredLabels = new Set(collectStrings(gateEvidence.value, []));
  const label = gateLabel(phase);
  if (!declaredLabels.has(phaseId) && !(label && declaredLabels.has(label))) {
    warnings.push('GATE_EVIDENCE_PHASE_NOT_DECLARED: ' + gateEvidence.relative + ' names neither ' + phaseId + ' nor ' + label);
  }
  const evidenceRefs = [];
  for (const task of tasks) {
    const entry = taskEvidenceEntry(ledger, task.id);
    const refs = entry && Array.isArray(entry.evidence_refs) ? entry.evidence_refs : [];
    if (task.evidence_required !== false && refs.length === 0) {
      throw refuse('TASK_EVIDENCE_NOT_RECORDED', task.id + ' is ' + task.status + ' without recorded evidence_refs; record it before gating ' + phaseId);
    }
    for (const ref of refs) {
      const loaded = loadEvidence(ref, root, 'evidence_refs');
      warnings.push(...loaded.warnings);
      if (!evidenceRefs.includes(loaded.relative)) evidenceRefs.push(loaded.relative);
    }
  }
  for (const dependency of phase.depends_on || []) {
    if (!phases.has(dependency)) throw refuse('UNKNOWN_PHASE_DEPENDENCY', phaseId + ' depends on missing ' + dependency);
    if (!already.includes(dependency)) {
      throw refuse('PHASE_DEPENDENCY_NOT_GATED', phaseId + ' requires passed phase gate ' + dependency + ' first');
    }
  }
  let measured = null;
  if (phase.execution_mode === 'MEASUREMENT_GATED') {
    if (!measuredRef) throw usage('MEASURED_EVIDENCE_REQUIRED', phaseId + ' is MEASUREMENT_GATED and requires --measured-evidence <repository-relative json>');
    const result = validateMeasuredEvidence(measuredRef, root, tasks);
    measured = result;
    for (const loadedWarning of result.evidence.warnings) warnings.push(loadedWarning);
    if (result.deferred.length) warnings.push('PHASE_NOT_TRIGGERED_TASKS: ' + result.deferred.join(',') + ' remain NOT_TRIGGERED with measured evidence in ' + result.evidence.relative);
  }
  const before = snapshot(ledger);
  const entry = {
    phase: phaseId,
    gate: gateLabel(phase),
    completed_at_utc: nowUtc(),
    task_ids: [...(phase.task_ids || [])],
    task_statuses: Object.fromEntries(tasks.map((task) => [task.id, task.status])),
    evidence_refs: evidenceRefs,
    gate_evidence: gateEvidence.relative,
    note,
  };
  if (measured) {
    entry.measured_evidence = measured.evidence.relative;
    entry.trigger_decision = measured.evidence.value[measured.decision];
    entry.not_triggered_task_ids = measured.deferred;
  }
  if (!Array.isArray(ledger.current.passed_phase_gates)) ledger.current.passed_phase_gates = [];
  ledger.current.passed_phase_gates.push(entry);
  phase.status = 'COMPLETE';
  refreshCurrent(ledger);
  ledger.updated_at_utc = nowUtc();
  assertPreserved(before, ledger);
  return { phase: phaseId, gate: entry.gate, status: 'COMPLETE', tasks: entry.task_ids, measured_evidence: entry.measured_evidence || null, warnings };
}

// ---------------------------------------------------------------- validate

function validate(ledger, { root, todoFile, graphOverride }) {
  const errors = [];
  const warnings = [];
  const err = (code, detail) => errors.push({ code, detail });
  const warn = (code, detail) => warnings.push({ code, detail });
  const program = ledger.program;

  for (const key of LEDGER_TOP_LEVEL_KEYS) {
    if (!(key in ledger)) err('LEDGER_SECTION_MISSING', key);
  }
  if (ledger.schema_version !== program.schema_version) err('LEDGER_SCHEMA_VERSION_MISMATCH', 'top-level ' + ledger.schema_version + ' vs program ' + program.schema_version);
  if (!nonEmptyString(ledger.updated_at_utc) || Number.isNaN(Date.parse(ledger.updated_at_utc))) err('UPDATED_AT_INVALID', String(ledger.updated_at_utc));
  if (!nonEmptyString(ledger.goal)) err('GOAL_MISSING', 'ledger.goal');
  if (!Array.isArray(program.status_vocabulary) || program.status_vocabulary.length === 0) err('STATUS_VOCABULARY_MISSING', 'program.status_vocabulary');

  const phaseIds = new Set();
  for (const [index, phase] of program.phases.entries()) {
    const where = 'phases[' + index + ']';
    if (!nonEmptyString(phase.id) || !PHASE_ID_PATTERN.test(phase.id)) { err('PHASE_ID_INVALID', where + ' id ' + phase.id); continue; }
    if (phaseIds.has(phase.id)) err('PHASE_ID_DUPLICATED', phase.id);
    phaseIds.add(phase.id);
    if (phase.number !== index) err('PHASE_NUMBER_MISMATCH', phase.id + ' number ' + phase.number + ' at index ' + index);
    if (phase.id !== 'P' + String(phase.number).padStart(2, '0')) err('PHASE_ID_NUMBER_MISMATCH', phase.id + ' vs number ' + phase.number);
    for (const [key, value] of Object.entries({ title: phase.title, slug: phase.slug, milestone: phase.milestone, exit_gate: phase.exit_gate, rollback: phase.rollback, file: phase.file })) {
      if (!nonEmptyString(value)) err('PHASE_CONTRACT_INCOMPLETE', phase.id + '.' + key);
    }
    if (!EXECUTION_MODES.has(phase.execution_mode)) err('PHASE_EXECUTION_MODE_INVALID', phase.id + ' ' + phase.execution_mode);
    if (!PHASE_STATUSES.has(phase.status)) err('PHASE_STATUS_INVALID', phase.id + ' ' + phase.status);
    if (!Array.isArray(phase.deliverables) || phase.deliverables.length === 0) err('PHASE_DELIVERABLES_MISSING', phase.id);
    if (!Array.isArray(phase.specs)) err('PHASE_SPECS_MISSING', phase.id);
    if (!Array.isArray(phase.task_ids)) err('PHASE_TASK_IDS_MISSING', phase.id);
    if (!Array.isArray(phase.depends_on)) err('PHASE_DEPENDS_ON_MISSING', phase.id);
    if (phase.execution_mode === 'DEFERRED_BY_OWNER' && phase.status !== 'DEFERRED_BY_OWNER') err('DEFERRED_PHASE_STATUS_NOT_DEFERRED', phase.id + ' is ' + phase.status);
    if (gateLabel(phase) === null) err('PHASE_GATE_LABEL_MISSING', phase.id);
  }
  for (const phase of program.phases) {
    for (const dependency of phase.depends_on || []) {
      if (!phaseIds.has(dependency)) err('UNKNOWN_PHASE_DEPENDENCY', phase.id + ' -> ' + dependency);
      if (dependency === phase.id) err('PHASE_SELF_DEPENDENCY', phase.id);
    }
  }
  // cycle detection over phase prerequisites
  const state = new Map();
  const walk = (id, trail) => {
    const colour = state.get(id);
    if (colour === 'done') return;
    if (colour === 'open') { err('PHASE_DEPENDENCY_CYCLE', trail.concat(id).join(' -> ')); return; }
    state.set(id, 'open');
    const phase = program.phases.find((item) => item.id === id);
    for (const dependency of phase ? phase.depends_on || [] : []) walk(dependency, trail.concat(id));
    state.set(id, 'done');
  };
  for (const phase of program.phases) walk(phase.id, []);

  const taskIds = new Set();
  const tasksByPhase = new Map();
  for (const [index, task] of program.tasks.entries()) {
    const where = 'tasks[' + index + ']';
    if (!nonEmptyString(task.id) || !TASK_ID_PATTERN.test(task.id)) { err('TASK_ID_INVALID', where + ' id ' + task.id); continue; }
    if (taskIds.has(task.id)) err('TASK_ID_DUPLICATED', task.id);
    taskIds.add(task.id);
    if (!phaseIds.has(task.phase)) err('UNKNOWN_TASK_PHASE', task.id + ' -> ' + task.phase);
    else if (task.id.slice(3, 5) !== task.phase.slice(1)) err('TASK_PHASE_PREFIX_MISMATCH', task.id + ' vs ' + task.phase);
    const vocabulary = program.status_vocabulary || [];
    if (!vocabulary.includes(task.status)) err('TASK_STATUS_INVALID', task.id + ' ' + task.status);
    for (const [key, value] of Object.entries({ title: task.title, action: task.action, verification: task.verification })) {
      if (!nonEmptyString(value)) err('TASK_CONTRACT_INCOMPLETE', task.id + '.' + key);
    }
    if (typeof task.evidence_required !== 'boolean') err('TASK_EVIDENCE_REQUIRED_INVALID', task.id);
    if (!Array.isArray(task.depends_on_tasks)) err('TASK_DEPENDS_ON_INVALID', task.id);
    if (!Array.isArray(task.requires_phase_gates)) err('TASK_PHASE_GATES_INVALID', task.id);
    for (const dependency of task.depends_on_tasks || []) {
      const target = program.tasks.find((item) => item.id === dependency);
      if (!target) err('UNKNOWN_DEPENDENCY_TARGET', task.id + ' -> ' + dependency);
      else if (target.phase !== task.phase && !(task.requires_phase_gates || []).includes(target.phase)) {
        warn('CROSS_PHASE_TASK_DEPENDENCY', task.id + ' -> ' + dependency + ' without a phase gate on ' + target.phase);
      }
    }
    for (const gate of task.requires_phase_gates || []) {
      if (GATE_LABEL_PATTERN.test(gate)) {
        err('PHASE_GATE_LABEL_NOT_PHASE_ID', task.id + ' lists ' + gate + '; requires_phase_gates takes Pxx phase IDs, not Gxx exit-gate labels');
      } else if (!PHASE_ID_PATTERN.test(gate)) {
        err('PHASE_GATE_ID_INVALID', task.id + ' -> ' + gate);
      } else if (!phaseIds.has(gate)) {
        err('UNKNOWN_PHASE_GATE_TARGET', task.id + ' -> ' + gate);
      }
    }
    if (!tasksByPhase.has(task.phase)) tasksByPhase.set(task.phase, []);
    tasksByPhase.get(task.phase).push(task.id);
  }
  for (const phase of program.phases) {
    const listed = phase.task_ids || [];
    const actual = tasksByPhase.get(phase.id) || [];
    const listedSet = new Set(listed);
    for (const id of listed) if (!taskIds.has(id)) err('PHASE_TASK_ID_UNKNOWN', phase.id + ' -> ' + id);
    for (const id of actual) if (!listedSet.has(id)) err('PHASE_TASK_NOT_LISTED', phase.id + ' -> ' + id);
    if (listed.length !== new Set(listed).size) err('PHASE_TASK_DUPLICATED', phase.id);
    if (listed.length !== actual.length) err('PHASE_TASK_COUNT_MISMATCH', phase.id + ' lists ' + listed.length + ' but has ' + actual.length);
    for (const id of listed) {
      const task = program.tasks.find((item) => item.id === id);
      if (task) {
        for (const gate of task.requires_phase_gates || []) {
          const target = program.phases.find((item) => item.id === gate);
          if (target && target.execution_mode === 'DEFERRED_BY_OWNER') err('DEFERRED_PHASE_USED_AS_GATE', task.id + ' -> ' + gate);
        }
      }
    }
  }

  const passed = passedGateIds(ledger);
  if (!Array.isArray(ledger.current.passed_phase_gates)) err('PASSED_PHASE_GATES_INVALID', 'current.passed_phase_gates');
  for (const [index, raw] of (ledger.current.passed_phase_gates || []).entries()) {
    const id = typeof raw === 'string' ? raw : isPlainObject(raw) ? raw.phase : null;
    if (!PHASE_ID_PATTERN.test(String(id))) { err('PASSED_GATE_ID_INVALID', 'passed_phase_gates[' + index + ']'); continue; }
    const phase = program.phases.find((item) => item.id === id);
    if (!phase) { err('UNKNOWN_PASSED_GATE_PHASE', id); continue; }
    if (phase.execution_mode === 'DEFERRED_BY_OWNER') err('DEFERRED_PHASE_GATED', id);
    if (isPlainObject(raw) && raw.gate && raw.gate !== gateLabel(phase)) err('PASSED_GATE_LABEL_MISMATCH', id + ' ' + raw.gate + ' vs ' + gateLabel(phase));
    if (isPlainObject(raw)) {
      const taskStates = raw.task_statuses;
      if (isPlainObject(taskStates)) {
        for (const [taskId, status] of Object.entries(taskStates)) {
          const task = program.tasks.find((item) => item.id === taskId);
          if (task && task.status !== status) err('PASSED_GATE_TASK_STATUS_STALE', id + ' ' + taskId + ' recorded ' + status + ' but is ' + task.status);
          if (status === GAP_STATUS) err('PASSED_GATE_TASK_HAS_GAP', id + ' was gated while ' + taskId + ' held an unresolved factual gap');
        }
      }
    }
  }
  const passedSet = new Set(passed);

  const terminalNow = program.tasks.filter((task) => isTerminal(task.status)).map((task) => task.id);
  const terminalSet = new Set(terminalNow);
  const recordedCompleted = Array.isArray(ledger.current.completed_task_ids) ? ledger.current.completed_task_ids : [];
  if (!Array.isArray(ledger.current.completed_task_ids)) err('COMPLETED_TASK_IDS_INVALID', 'current.completed_task_ids');
  for (const id of recordedCompleted) if (!taskIds.has(id)) err('COMPLETED_TASK_ID_UNKNOWN', id);
  for (const id of terminalNow) if (!recordedCompleted.includes(id)) err('COMPLETED_IDS_INCOMPLETE', id + ' is terminal but missing from current.completed_task_ids');
  for (const id of recordedCompleted) if (!terminalSet.has(id)) err('COMPLETED_IDS_STALE', id + ' is not terminal but is listed in current.completed_task_ids');
  const activeTask = ledger.current.active_task;
  if (activeTask !== null && activeTask !== undefined && !taskIds.has(activeTask)) err('ACTIVE_TASK_UNKNOWN', String(activeTask));
  if (nonEmptyString(ledger.current.phase) && !phaseIds.has(ledger.current.phase)) err('CURRENT_PHASE_UNKNOWN', ledger.current.phase);

  if (!isPlainObject(ledger.task_evidence)) err('TASK_EVIDENCE_INVALID', 'task_evidence');
  else {
    for (const [id, entry] of Object.entries(ledger.task_evidence)) {
      if (!taskIds.has(id)) { err('TASK_EVIDENCE_UNKNOWN_TASK', id); continue; }
      if (!isPlainObject(entry)) { err('TASK_EVIDENCE_NOT_OBJECT', id); continue; }
      const task = program.tasks.find((item) => item.id === id);
      if (task && entry.status !== task.status) err('TASK_EVIDENCE_STATUS_MISMATCH', id + ' evidence ' + entry.status + ' vs task ' + task.status);
      if (!Array.isArray(entry.evidence_refs)) err('TASK_EVIDENCE_REFS_INVALID', id);
      const refs = Array.isArray(entry.evidence_refs) ? entry.evidence_refs : [];
      for (const ref of refs) {
        const resolved = path.join(root, ref);
        if (!fs.existsSync(resolved)) warn('EVIDENCE_FILE_MISSING', id + ' -> ' + ref);
      }
      if (task && (isTerminal(task.status) || task.status === GAP_STATUS || INTERMEDIATE_STATUSES.has(task.status)) && task.evidence_required !== false && refs.length === 0) {
        err('TERMINAL_TASK_WITHOUT_EVIDENCE', id + ' is ' + task.status + ' without evidence_refs');
      }
      if (task && isTerminal(task.status) && Array.isArray(entry.remaining) && entry.remaining.length) {
        warn('TASK_TERMINAL_WITH_REMAINING', id + ' is ' + task.status + ' with ' + entry.remaining.length + ' remaining item(s)');
      }
      if (task && task.status === GAP_STATUS && !/unresolved|reported|classif|unknown/i.test(String(task.verification || ''))) {
        err('EVIDENCE_GAP_NOT_PERMITTED_BY_VERIFICATION', id);
      }
      if (task && task.status === 'NOT_TRIGGERED' && !nonEmptyString(task.execution_condition)) {
        err('NOT_TRIGGERED_REQUIRES_EXECUTION_CONDITION', id);
      }
    }
  }

  if (!Array.isArray(ledger.acceptance_cases)) err('ACCEPTANCE_CASES_INVALID', 'acceptance_cases');
  else {
    const caseIds = new Set();
    for (const [index, entry] of ledger.acceptance_cases.entries()) {
      const where = 'acceptance_cases[' + index + ']';
      if (!nonEmptyString(entry.id)) { err('CASE_ID_INVALID', where); continue; }
      if (caseIds.has(entry.id)) err('CASE_ID_DUPLICATED', entry.id);
      caseIds.add(entry.id);
      for (const key of ['phases', 'title', 'exercise', 'expected', 'evidence', 'status']) {
        if (!nonEmptyString(entry[key])) err('CASE_CONTRACT_INCOMPLETE', entry.id + '.' + key);
      }
      if (!KNOWN_CASE_STATUSES.has(entry.status)) warn('CASE_STATUS_UNRECOGNISED', entry.id + ' ' + entry.status);
    }
  }

  for (const [relPath, expected] of Object.entries((ledger.source && ledger.source.sha256) || {})) {
    const file = path.join(root, relPath);
    if (!fs.existsSync(file)) { warn('SOURCE_FILE_MISSING', relPath); continue; }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== expected) err('SOURCE_HASH_MISMATCH', relPath + ' expected ' + expected + ' got ' + actual);
  }

  const graphPath = graphOverride || path.join(root, String((ledger.source && ledger.source.task_graph) || ''));
  let graph = { path: graphPath, present: false, matches: null, checks: 0 };
  if (fs.existsSync(graphPath)) {
    graph.present = true;
    const loaded = readJsonFile(graphPath, 'GRAPH_JSON_INVALID').value;
    const problems = [];
    if (loaded.phases.length !== program.phases.length) problems.push('phase count ' + loaded.phases.length + ' vs ' + program.phases.length);
    if (loaded.tasks.length !== program.tasks.length) problems.push('task count ' + loaded.tasks.length + ' vs ' + program.tasks.length);
    for (const [index, source] of loaded.phases.entries()) {
      const copy = program.phases[index];
      if (!copy) { problems.push('phase[' + index + '] missing'); continue; }
      for (const [key, value] of Object.entries(source)) {
        if (key === 'status') continue;
        if (JSON.stringify(value) !== JSON.stringify(copy[key])) problems.push(source.id + '.' + key);
      }
    }
    for (const [index, source] of loaded.tasks.entries()) {
      const copy = program.tasks[index];
      if (!copy) { problems.push('task[' + index + '] missing'); continue; }
      for (const [key, value] of Object.entries(source)) {
        if (key === 'status') continue;
        if (JSON.stringify(value) !== JSON.stringify(copy[key])) problems.push(source.id + '.' + key);
      }
    }
    graph.checks = loaded.phases.length + loaded.tasks.length;
    graph.matches = problems.length === 0;
    for (const problem of problems.slice(0, 20)) err('GRAPH_CONTRACT_DRIFT', problem);
    if (problems.length > 20) err('GRAPH_CONTRACT_DRIFT', (problems.length - 20) + ' more differences');

    const acceptancePath = path.join(root, String((ledger.source && ledger.source.acceptance) || ''));
    if (fs.existsSync(acceptancePath)) {
      const acceptance = readJsonFile(acceptancePath, 'ACCEPTANCE_JSON_INVALID').value;
      if (acceptance.cases.length !== ledger.acceptance_cases.length) {
        err('ACCEPTANCE_CASE_COUNT_MISMATCH', acceptance.cases.length + ' vs ' + ledger.acceptance_cases.length);
      }
      for (const [index, source] of acceptance.cases.entries()) {
        const copy = ledger.acceptance_cases[index];
        if (!copy) { err('ACCEPTANCE_CASE_MISSING', source.id); continue; }
        for (const [key, value] of Object.entries(source)) {
          if (key === 'status') continue;
          if (JSON.stringify(value) !== JSON.stringify(copy[key])) err('ACCEPTANCE_CONTRACT_DRIFT', source.id + '.' + key);
        }
      }
    } else {
      warn('ACCEPTANCE_SOURCE_MISSING', acceptancePath);
    }
  } else {
    warn('GRAPH_SOURCE_MISSING', graphPath);
  }

  let todo = { path: todoFile, present: false, tasks: 0, checked: 0, mismatches: [], orderMismatch: false };
  if (fs.existsSync(todoFile)) {
    todo.present = true;
    const lines = fs.readFileSync(todoFile, 'utf8').split(/\r?\n/);
    const seen = [];
    for (const line of lines) {
      const match = /^- \[( |x)\] \*\*(V5-\d{2}-\d{2})/.exec(line);
      if (!match) continue;
      seen.push(match[2]);
      const task = program.tasks.find((item) => item.id === match[2]);
      if (!task) { todo.mismatches.push(match[2] + ':unknown'); continue; }
      const expectChecked = TODO_CHECKED_STATUSES.has(task.status);
      if (expectChecked !== (match[1] === 'x')) todo.mismatches.push(match[2] + ':' + task.status);
    }
    todo.tasks = seen.length;
    todo.checked = seen.length - todo.mismatches.length;
    const expected = program.tasks.map((task) => task.id);
    todo.orderMismatch = seen.length !== expected.length || seen.some((id, index) => id !== expected[index]);
    if (todo.orderMismatch) warn('TODO_TASK_SET_MISMATCH', 'projection lists ' + seen.length + ' task(s) of ' + expected.length + (seen.join(',') === expected.join(',') ? '' : ' (order/set differs)'));
    for (const mismatch of todo.mismatches) err('TODO_CHECKBOX_MISMATCH', mismatch + ' - run: node scripts/v5/progress.js render');
  } else {
    warn('TODO_MISSING', todoFile);
  }

  const gateReady = [];
  for (const phase of program.phases) {
    if (phase.execution_mode === 'DEFERRED_BY_OWNER' || passedSet.has(phase.id)) continue;
    const tasks = (phase.task_ids || []).map((id) => program.tasks.find((task) => task.id === id)).filter(Boolean);
    if (!tasks.length || tasks.some((task) => !isTerminal(task.status))) continue;
    const missing = (phase.depends_on || []).filter((id) => !passedSet.has(id));
    gateReady.push({ phase: phase.id, gate: gateLabel(phase), ready: missing.length === 0, waiting_on: missing });
  }

  return { errors, warnings, graph, todo, gateReady, terminalTaskIds: terminalNow };
}

// ------------------------------------------------------------------ render

const TODO_POLICY_LINES = [
  '# V5 todos',
  '',
  "The mutable execution source is [progress.json]({ledger}); this is its readable projection. Task actions, verification criteria and dependencies are retained in that JSON and the original [tasks.json]({graph}). Update both status projections after meaningful work; never tick a task without its required evidence.",
  '',
  '**Goal:** {goal}',
  '',
  '**Integration base:** `{baseline}`. **Active phase/task:** {active}. **Progress:** {progress}',
  '',
  'Required path: {path}. The foundation gate P00–P03 passes before dependent distributed work, and V5 CI starts in the foundation rather than only at P17.',
  '',
];
const TODO_CLOSING = [
  '## Acceptance and evidence',
  '',
  'All {cases} original acceptance cases ({first}–{last}) are preserved in progress.json; current statuses: {counts}. [Acceptance contracts]({acceptance}) specify real integration/staging/device/provider proof; a planned checklist is not proof.',
  '',
  'After each verified unit: record exact source SHA, command, target/environment, observed result, evidence reference and accurate evidence level; update PROGRESS/DECISIONS/OPEN-ITEMS and checkpoint on V5. Never mark uploads, submissions or reviews as approvals.',
];

function phaseRuns(phases, mode) {
  const ids = phases.filter((phase) => phase.execution_mode === mode).map((phase) => phase.id);
  const runs = [];
  for (const id of ids) {
    const number = Number(id.slice(1));
    const last = runs[runs.length - 1];
    if (last && Number(last[1].slice(1)) === number - 1) last[1] = id;
    else runs.push([id, id]);
  }
  return runs.map(([from, to]) => (from === to ? from : from + '–' + to)).join(', ');
}

function renderTodo(ledger, { root, ledgerPath, todoPath }) {
  const program = ledger.program;
  const todoDir = path.dirname(todoPath);
  const link = (target) => path.relative(todoDir, target).split(path.sep).join('/');
  const graphRef = path.resolve(root, String((ledger.source && ledger.source.task_graph) || ''));
  const packDir = path.dirname(graphRef);
  const acceptanceRef = path.join(packDir, 'ACCEPTANCE.md');
  const eligible = eligibleTasks(ledger);
  const activeTask = (() => {
    const recorded = program.tasks.find((task) => task.id === ledger.current.active_task && !isTerminal(task.status));
    return recorded || eligible[0] || null;
  })();
  const terminalCount = terminalTasks(ledger).length;
  const passed = passedGateIds(ledger).filter((id) => phaseIndex(ledger).has(id)).length;
  const caseCounts = countBy(ledger.acceptance_cases.map((entry) => entry.status));
  const header = TODO_POLICY_LINES.join('\n')
    .replace('{ledger}', link(path.resolve(ledgerPath)))
    .replace('{graph}', link(graphRef))
    .replace('{goal}', String(ledger.goal))
    .replace('{baseline}', String(ledger.baseline.selected_sha))
    .replace('{active}', activeTask ? activeTask.phase + ' / ' + activeTask.id + ' (' + activeTask.status + ')' : 'none (no task is eligible)')
    .replace('{progress}', terminalCount + '/' + program.tasks.length + ' tasks terminal; ' + passed + '/' + program.phases.length + ' phase gates passed')
    .replace('{path}', 'execute ' + phaseRuns(program.phases, 'EXECUTE') + '; owner-deferred ' + phaseRuns(program.phases, 'DEFERRED_BY_OWNER') + ' executes nothing; ' + phaseRuns(program.phases, 'MEASUREMENT_GATED') + ' is measurement-gated; phase prerequisites are gates, not status assumptions, and a deferred or measurement-gated phase is never used as another phase prerequisite');
  const lines = [header];
  for (const phase of program.phases) {
    lines.push('## ' + phase.id + ' — ' + phase.title, '');
    lines.push('Milestone: ' + phase.milestone + '; status: `' + phase.status + '`; prerequisites: ' + ((phase.depends_on || []).join(', ') || 'none') + '. [Phase contract](' + link(path.resolve(root, String((ledger.source && ledger.source.pack) || ''), phase.file)) + ').', '');
    if ((phase.task_ids || []).length === 0) {
      const dependents = program.phases.filter((item) => (item.depends_on || []).includes(phase.id)).map((item) => item.id);
      lines.push('Owner-deferred phase: 0 tasks. ' + (dependents.length ? 'Declared dependents: ' + dependents.join(', ') + '; a deferred phase never gates them.' : 'No phase lists ' + phase.id + ' as a prerequisite.'), '');
    }
    for (const id of phase.task_ids || []) {
      const task = program.tasks.find((item) => item.id === id);
      if (!task) continue;
      const checked = TODO_CHECKED_STATUSES.has(task.status);
      lines.push('- [' + (checked ? 'x' : ' ') + '] **' + task.id + ' — ' + task.title + '** (`' + task.status + '`).');
    }
    if ((phase.task_ids || []).length) lines.push('');
    lines.push('**Exit gate:** ' + phase.exit_gate, '');
  }
  lines.push(TODO_CLOSING.join('\n')
    .replace('{cases}', String(ledger.acceptance_cases.length))
    .replace('{first}', ledger.acceptance_cases[0] ? ledger.acceptance_cases[0].id : '')
    .replace('{last}', ledger.acceptance_cases.length ? ledger.acceptance_cases[ledger.acceptance_cases.length - 1].id : '')
    .replace('{counts}', Object.entries(caseCounts).map(([status, count]) => status + ' ' + count).join(', ') || 'none')
    .replace('{acceptance}', link(acceptanceRef)));
  return lines.join('\n') + '\n';
}

function renderCommand({ root, ledgerPath, todoPath, check }) {
  const ledger = readLedger(ledgerPath);
  const text = renderTodo(ledger, { root, ledgerPath, todoPath });
  const current = fs.existsSync(todoPath) ? fs.readFileSync(todoPath, 'utf8') : null;
  if (check) {
    if (current === text) return { todo: { path: todoPath }, checked: true, stale: false };
    const currentLines = current === null ? [] : current.split('\n');
    const wanted = text.split('\n');
    let firstDifference = 0;
    while (firstDifference < Math.max(currentLines.length, wanted.length) && currentLines[firstDifference] === wanted[firstDifference]) firstDifference += 1;
    return {
      todo: { path: todoPath, written: false, bytes: Buffer.byteLength(text) },
      checked: true,
      stale: true,
      first_difference_line: firstDifference + 1,
      current: current === null ? null : currentLines[firstDifference],
      expected: wanted[firstDifference],
    };
  }
  if (current === text) return { todo: { path: todoPath, written: false, bytes: Buffer.byteLength(text) } };
  writeAtomic(todoPath, text);
  return { todo: { path: todoPath, written: true, bytes: Buffer.byteLength(text) } };
}

// ------------------------------------------------------------------ inspect

function inspect(options) {
  const { root, ledgerPath, todoPath } = options;
  const ledger = readLedger(ledgerPath);
  const result = validate(ledger, { root, todoFile: todoPath });
  const program = ledger.program;
  const eligible = eligibleTasks(ledger);
  const blocked = program.tasks.filter((task) => !isTerminal(task.status) && !eligible.includes(task)).map((task) => ({ id: task.id, phase: task.phase, reasons: blockedReasons(ledger, task) }));
  const taskCounts = countBy(program.tasks.map((task) => task.status));
  const phaseCounts = countBy(program.phases.map((phase) => phase.status));
  return {
    ok: result.errors.length === 0,
    ledger: ledgerPath,
    todo: todoPath,
    updated_at_utc: ledger.updated_at_utc,
    graph: result.graph,
    projection: result.todo,
    tasks: { total: program.tasks.length, terminal: terminalTasks(ledger).length, status_counts: taskCounts },
    phases: { total: program.phases.length, status_counts: phaseCounts, passed_gates: passedGateIds(ledger) },
    acceptance: { total: ledger.acceptance_cases.length, status_counts: countBy(ledger.acceptance_cases.map((entry) => entry.status)) },
    current: { phase: ledger.current.phase, active_task: ledger.current.active_task },
    eligible: eligible.map((task) => ({ id: task.id, phase: task.phase, title: task.title, conditional: nonEmptyString(task.execution_condition) })),
    blocked,
    ready_for_gate: result.gateReady,
    errors: result.errors,
    warnings: result.warnings,
  };
}

function printInspect(report) {
  const out = [];
  out.push('V5 progress ledger — inspect');
  out.push('  ledger: ' + report.ledger + (report.graph.present ? '  graph: ' + report.graph.path + ' (contract match: ' + report.graph.matches + ')' : '  graph: missing'));
  out.push('  updated_at_utc: ' + report.updated_at_utc);
  out.push('  tasks: ' + report.tasks.total + ' total, ' + report.tasks.terminal + ' terminal  [' + formatCounts(report.tasks.status_counts) + ']');
  out.push('  phases: ' + report.phases.total + ' total  [' + formatCounts(report.phases.status_counts) + ']  gates passed: ' + (report.phases.passed_gates.length ? report.phases.passed_gates.join(', ') : 'none'));
  out.push('  acceptance: ' + report.acceptance.total + ' cases  [' + formatCounts(report.acceptance.status_counts) + ']');
  out.push('  current: ' + report.current.phase + ' / ' + report.current.active_task);
  if (report.eligible.length) {
    out.push('  eligible (' + report.eligible.length + '):');
    for (const task of report.eligible.slice(0, 10)) out.push('    - ' + task.id + ' — ' + task.title + (task.conditional ? ' (conditional)' : ''));
    if (report.eligible.length > 10) out.push('    … ' + (report.eligible.length - 10) + ' more (use --json)');
  } else {
    out.push('  eligible: none');
  }
  if (report.blocked.length) {
    out.push('  blocked (' + report.blocked.length + '); sample:');
    for (const task of report.blocked.slice(0, 8)) out.push('    - ' + task.id + ': ' + task.reasons.join('; '));
    if (report.blocked.length > 8) out.push('    … ' + (report.blocked.length - 8) + ' more (use --json)');
  }
  for (const phase of report.ready_for_gate) {
    out.push('  gate ' + (phase.gate || phase.phase) + ' for ' + phase.phase + ': ' + (phase.ready ? 'tasks terminal — ready: node scripts/v5/progress.js gate --phase ' + phase.phase + ' --evidence <json> --note <text>' : 'waiting on ' + phase.waiting_on.join(', ')));
  }
  out.push('  errors (' + report.errors.length + ')');
  for (const error of report.errors.slice(0, 40)) out.push('    ! ' + error.code + ': ' + error.detail);
  if (report.errors.length > 40) out.push('    … ' + (report.errors.length - 40) + ' more (use --json)');
  out.push('  warnings (' + report.warnings.length + ')');
  for (const warning of report.warnings.slice(0, 40)) out.push('    ~ ' + warning.code + ': ' + warning.detail);
  if (report.warnings.length > 40) out.push('    … ' + (report.warnings.length - 40) + ' more (use --json)');
  return out.join('\n');
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => key + ' ' + value).join(', ') : 'none';
}

// ---------------------------------------------------------------------- CLI

const VALUE_OPTIONS = new Set(['--ledger', '--todo', '--root', '--task', '--status', '--evidence', '--note', '--measured-evidence', '--phase']);
const FLAG_OPTIONS = new Set(['--json', '--check', '--no-render', '--clear-remaining', '--help', '-h']);

function parseArgv(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (VALUE_OPTIONS.has(token)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw usage('MISSING_ARGUMENT', token + ' requires a value');
      options[token.slice(2)] = value;
      index += 1;
    } else if (FLAG_OPTIONS.has(token)) {
      const key = token === '-h' ? 'help' : token.replace(/^--?/, '');
      options[key] = true;
    } else {
      throw usage('UNKNOWN_OPTION', token + ' (see --help)');
    }
  }
  return options;
}

const HELP = [
  'V5 progress ledger CLI',
  '',
  'Usage: node scripts/v5/progress.js <inspect|record|gate|render> [options]',
  '',
  'Common options',
  '  --ledger <path>   ledger JSON (default docs/v5/progress.json, resolved against cwd)',
  '  --todo <path>     projection markdown (default docs/v5/TODO.md, resolved against cwd)',
  '  --root <dir>      repository root for ledger-internal references (default: repository of this script)',
  '  --json            machine-readable output',
  '',
  'inspect',
  '  Validates graph/evidence/contracts and reports status counts, current/eligible tasks and gate readiness.',
  '',
  'record',
  '  --task <V5-xx-yy> --status <STATUS> [--evidence <repo-relative json>] [--note <text>] [--clear-remaining] [--no-render]',
  '  Statuses: PLANNED IN_PROGRESS IMPLEMENTED TESTED_LOCAL VERIFIED_STAGING DEVICE_VERIFIED SUBMITTED',
  '            PROVIDER_APPROVED PRODUCTION_ENABLED COMPLETE EVIDENCE_GAP DEFERRED_BY_OWNER NOT_TRIGGERED',
  '  Closing statuses are COMPLETE, NOT_TRIGGERED and (inside a deferred phase) DEFERRED_BY_OWNER.',
  '  IMPLEMENTED..PRODUCTION_ENABLED record an evidence level but keep the task open, and EVIDENCE_GAP',
  '  keeps it open too: only an explicit COMPLETE (evidence + note) closes a task or unblocks dependents.',
  '  Refuses closing without dependencies/gates passing, template/unexecuted evidence or evidence that',
  '  names another task.',
  '',
  'gate',
  '  --phase <Pxx> --evidence <repo-relative json> --note <text> [--measured-evidence <json>] [--no-render]',
  '  Marks a phase COMPLETE only when every listed task is closed with recorded evidence and the phase',
  '  prerequisites are already gated. Unresolved factual gaps (EVIDENCE_GAP) always refuse the gate;',
  '  there is no waiver. MEASUREMENT_GATED phases (P24) additionally require a measured evidence record',
  '  carrying a trigger decision and the ids of any NOT_TRIGGERED tasks. Owner-deferred P21 is never gated.',
  '',
  'render',
  '  Regenerates docs/v5/TODO.md from the ledger (all tasks once, in phase order). --check compares without writing.',
].join('\n');

function main(argv = process.argv.slice(2)) {
  const options = parseArgv(argv);
  if (options.help || options.command === 'help') {
    process.stdout.write(HELP + '\n');
    return { help: true };
  }
  if (!options.command) throw usage('MISSING_COMMAND', 'expected inspect|record|gate|render (see --help)');
  const root = options.root ? path.resolve(options.root) : REPO_ROOT;
  const ledgerPath = path.resolve(options.ledger || path.join(root, DEFAULT_LEDGER));
  const todoPath = path.resolve(options.todo || path.join(root, DEFAULT_TODO));
  if (options.command === 'inspect') {
    const report = inspect({ root, ledgerPath, todoPath });
    process.stdout.write((options.json ? JSON.stringify(report, null, 2) : printInspect(report)) + '\n');
    process.exitCode = report.ok ? 0 : 1;
    return report;
  }
  if (options.command === 'render') {
    const result = { operation: 'render', ...renderCommand({ root, ledgerPath, todoPath, check: Boolean(options.check) }) };
    process.stdout.write((options.json ? JSON.stringify(result, null, 2) : describeResult(result)) + '\n');
    if (result.stale) process.exitCode = 1;
    return result;
  }
  if (options.command === 'record') {
    if (!options.task) throw usage('MISSING_ARGUMENT', 'record requires --task <V5-xx-yy>');
    if (!options.status) throw usage('MISSING_ARGUMENT', 'record requires --status <STATUS>');
    const ledger = readLedger(ledgerPath);
    const outcome = record(ledger, {
      taskId: options.task,
      status: options.status,
      evidenceRef: options.evidence,
      note: options.note,
      clearRemaining: Boolean(options['clear-remaining']),
      root,
    });
    const result = { operation: 'record', ...outcome, ...persist(ledger, { ledgerPath, todoPath, render: !options['no-render'], root }) };
    process.stdout.write((options.json ? JSON.stringify(result, null, 2) : describeResult(result)) + '\n');
    return result;
  }
  if (options.command === 'gate') {
    if (!options.phase) throw usage('MISSING_ARGUMENT', 'gate requires --phase <Pxx>');
    const ledger = readLedger(ledgerPath);
    const outcome = gate(ledger, {
      phaseId: options.phase,
      evidenceRef: options.evidence,
      measuredRef: options['measured-evidence'],
      note: options.note,
      root,
    });
    const result = { operation: 'gate', ...outcome, ...persist(ledger, { ledgerPath, todoPath, render: !options['no-render'], root }) };
    process.stdout.write((options.json ? JSON.stringify(result, null, 2) : describeResult(result)) + '\n');
    return result;
  }
  throw usage('UNKNOWN_COMMAND', options.command + ' (see --help)');
}

function describeResult(result) {
  const out = [result.operation + ': ok'];
  const rows = [
    ['task', result.task && result.task + ' ' + result.from + ' -> ' + result.to],
    ['phase', result.phase && result.phase + ' gate ' + result.gate + ' -> ' + result.status],
    ['evidence', result.evidence],
    ['measured_evidence', result.measured_evidence],
    ['ledger', result.ledger && result.ledger + ' (' + result.bytes + ' bytes written)'],
    ['todo', result.todo && (result.checked
      ? result.todo.path + (result.stale ? ' STALE: first difference at line ' + result.first_difference_line : ' up to date')
      : result.todo.path + (result.todo.written === false ? ' unchanged' : ' (' + result.todo.bytes + ' bytes written)'))],
  ];
  for (const [label, value] of rows) if (value) out.push('  ' + label + ': ' + value);
  for (const warning of result.warnings || []) out.push('  ! ' + warning);
  return out.join('\n');
}

if (require.main === module) {
  const wantsJson = process.argv.slice(2).includes('--json');
  try {
    main();
  } catch (error) {
    const cli = error instanceof CliError;
    const code = cli ? error.code : 'INTERNAL_ERROR';
    const detail = cli ? error.detail : error.message;
    const exitCode = cli ? (error.kind === 'usage' ? 64 : 1) : 1;
    if (wantsJson) process.stderr.write(JSON.stringify({ ok: false, error: code, detail, kind: cli ? error.kind : 'internal' }) + '\n');
    else process.stderr.write('progress: ' + (cli ? error.message : 'INTERNAL_ERROR: ' + error.message) + '\n');
    process.exitCode = exitCode;
  }
}

module.exports = {
  main, inspect, record, gate, renderCommand, renderTodo, validate, readLedger, eligibleTasks,
  blockedReasons, passedGateIds, parseArgv, TERMINAL_STATUSES, INTERMEDIATE_STATUSES, CliError,
};
