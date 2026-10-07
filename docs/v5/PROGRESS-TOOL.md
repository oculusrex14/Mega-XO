# V5 progress tool

`scripts/v5/progress.js` is the runnable CLI over the mutable execution ledger
[progress.json](progress.json). It never invents acceptance: it validates what is
declared, refuses illegal transitions and records what the operator actually stated.

```
node scripts/v5/progress.js <inspect|record|gate|render> [options]
```

The tool never edits `AGENTS.md`, application code, the implementation pack, or the
rich narrative [PROGRESS.md](PROGRESS.md). It only atomically rewrites the ledger and
regenerates [TODO.md](TODO.md).

## Common options

| Option | Meaning |
|---|---|
| `--ledger <path>` | Ledger JSON. Default `docs/v5/progress.json`, resolved against the current directory. |
| `--todo <path>` | Projection markdown. Default `docs/v5/TODO.md`, resolved against the current directory. |
| `--root <dir>` | Repository root for ledger-internal references (`source.sha256`, `source.task_graph`, evidence paths). Default: the repository containing this script. |
| `--json` | Machine-readable result on stdout; failures emit a JSON error object on stderr. |

`--ledger`, `--todo` and `--root` are the documented way to run an isolated private
smoke against a copied ledger without touching the real program records.

Exit codes: `0` success, `1` refusal/invalid (or `render --check` drift, or `inspect`
reporting findings), `64` usage error. Under `--json`, failures print
`{"ok":false,"error":<code>,"detail":…,"kind":…}` on stderr.

## Status vocabulary

`PLANNED`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTED_LOCAL`, `VERIFIED_STAGING`,
`DEVICE_VERIFIED`, `SUBMITTED`, `PROVIDER_APPROVED`, `PRODUCTION_ENABLED`,
`COMPLETE`, `EVIDENCE_GAP`, `DEFERRED_BY_OWNER`, `NOT_TRIGGERED`.

Closed statuses are exact — `SUBMITTED` never means approved and `PROVIDER_APPROVED`
is never inferred from an upload. `IMPLEMENTED`, `TESTED_LOCAL`, `VERIFIED_STAGING`,
`DEVICE_VERIFIED`, `SUBMITTED`, `PROVIDER_APPROVED` and `PRODUCTION_ENABLED` record an
evidence level but keep the task **open**: they carry the evidence, count as progress,
and still block dependents and their phase gate until the operator explicitly records
accepted `COMPLETE`. `EVIDENCE_GAP` is open in exactly the same way.

| Status | Closes task | Requires `--evidence` | Notes |
|---|---|---|---|
| `PLANNED` | no | no | initial state; `--evidence` is validated when supplied |
| `IN_PROGRESS` | no | no | stamps the owning phase `IN_PROGRESS` |
| `IMPLEMENTED`, `TESTED_LOCAL`, `VERIFIED_STAGING`, `DEVICE_VERIFIED`, `SUBMITTED`, `PROVIDER_APPROVED`, `PRODUCTION_ENABLED` | no | yes | evidence level recorded; dependencies and the phase gate stay blocked until `COMPLETE` |
| `EVIDENCE_GAP` | no | yes | explicit factual gap; only when the task verification itself allows a reported/unresolved classification; `--note` enforced; never enters `completed_task_ids` and always blocks its phase gate |
| `DEFERRED_BY_OWNER` | yes | yes | only inside an `execution_mode: DEFERRED_BY_OWNER` phase |
| `NOT_TRIGGERED` | yes | yes | only when the task declares an `execution_condition` |
| `COMPLETE` | yes | yes | the only status that accepts a task and unblocks dependents; prerequisites, gates and `--note` enforced |

## `inspect`

Read-only. Validates the ledger and prints status counts, current/eligible tasks, blocked
reasons, gate readiness, plus errors and warnings. Add `--json` for the full report.

Checks performed: task/phase ID shape and uniqueness, phase ↔ task membership both ways,
dependency targets, `requires_phase_gates` holding `Pxx` phase IDs (a `Gxx` exit-gate
label is reported as invalid), phase dependency existence and cycles, status vocabulary
membership, task-graph and acceptance-case contract parity with the untouched pack,
recorded source hashes, evidence files existing and being genuine (non-template,
executed), `task_evidence` status agreeing with the task, terminal tasks carrying
evidence, projection checkbox/order drift, and `current.completed_task_ids` consistency.

## `record`

```
node scripts/v5/progress.js record --task <V5-xx-yy> --status <STATUS> \
  [--evidence <repo-relative json>] [--note <text>] [--clear-remaining] [--no-render]
```

Refuses, by design:

- `TASK_DEPENDENCY_NOT_TERMINAL` / `PHASE_GATE_NOT_PASSED` — a closing status before
  every `depends_on_tasks` target is closed or every `requires_phase_gates` phase gate
  has passed.
- `EVIDENCE_FILE_MISSING`, `EVIDENCE_JSON_INVALID`, `EVIDENCE_IS_TEMPLATE`,
  `EVIDENCE_NOT_EXECUTED` — missing, unparseable, template or `executed: false` evidence.
- `EVIDENCE_TASK_ID_MISMATCH` — evidence whose `task_id`/`task_ids` name a different task.
- `EVIDENCE_GAP_NOT_PERMITTED_BY_VERIFICATION` — `EVIDENCE_GAP` where the source task
  verification has no reported/unresolved/classified semantics.
- `NOT_TRIGGERED_REQUIRES_EXECUTION_CONDITION`, `DEFERRED_STATUS_NOT_APPLICABLE`.
- `EVIDENCE_GAP_STILL_OPEN` — lowering an `EVIDENCE_GAP` task back to an intermediate
  level instead of recording accepted `COMPLETE`; an open gap is only ever closed by
  explicit `COMPLETE`.
- `NOTE_REQUIRED` when closing a task or reopening a closed one without an explanation.

Path arguments are repository-relative and must not escape the root. When `--evidence`
is omitted for a task that requires it, the last recorded `evidence_refs` entry is
revalidated and `EVIDENCE_REUSED` is reported. `--clear-remaining` moves
`task_evidence.remaining` into the transition record; a closed task that still lists
remaining work warns `TASK_TERMINAL_WITH_REMAINING`.

Every accepted record appends a `transitions` entry (`from`, `to`, `at_utc`, optional
`evidence`/`note`/`cleared_remaining`), keeps `task_evidence.status`,
`current.completed_task_ids`, `current.active_task`, `current.phase` and
`updated_at_utc` consistent. Phase status is never derived from status counts.

## `gate`

```
node scripts/v5/progress.js gate --phase <Pxx> --evidence <repo-relative json> \
  --note <text> [--measured-evidence <json>] [--no-render]
```

Marks a phase `COMPLETE` only after every task it lists is closed, each
evidence-requiring task has recorded evidence, the phase's own prerequisites are already
gated, and a gate evidence record is supplied. Invariants:

- A phase is never completed from status counts or from "the files exist".
- `DEFERRED_BY_OWNER` phases (P21) are never gated; `gate --phase P21` is refused and P21
  can never block or enable another phase.
- `MEASUREMENT_GATED` phases (P24) additionally require `--measured-evidence` recording
  actual measurements (`metrics`/`measurements`/`baseline`/`thresholds`/`triggers`/
  `operating_envelope`/`capacity`) plus a trigger decision
  (`decision`/`trigger_decision`/`trigger_met`). When a task is `NOT_TRIGGERED`, the
  evidence must name that task id. Without measured data the gate is refused, so
  "conditional not triggered" is a measured outcome, not an assumption.
- Unresolved factual gaps always refuse the gate. There is no `--accept-gaps` option and
  no textual waiver: `EVIDENCE_GAP` tasks are reported as `PHASE_TASKS_HAVE_EVIDENCE_GAPS`
  and each must first be closed with an explicit accepted `COMPLETE` (evidence + note).
- The gate entry records phase, gate label, timestamp, task ids and their statuses,
  task evidence references, the gate evidence path, note, and — for P24 — the measured
  evidence path, trigger decision and not-triggered task ids.

## `render`

Regenerates the human projection from the ledger: all 117 tasks exactly once in original
phase order, one `## Pxx` section per phase in order, every phase contract link, exit
gate and P21 owner-deferral note preserved. Checkboxes are ticked only for `COMPLETE` and
`NOT_TRIGGERED`. `--check` reports drift (first differing line) without writing. The rich
`PROGRESS.md` is never written by this tool.

`TODO.md` is a generated file: `render` owns its whole content and `--check` compares
byte-exactly, so hand-edited prose counts as drift and is replaced on the next `render`.
`inspect` reports any checkbox that disagrees with the ledger as `TODO_CHECKBOX_MISMATCH`
and a missing/duplicated/reordered task line as `TODO_TASK_SET_MISMATCH`.

## Ledger guarantees

All commands preserve `schema_version`, `goal`, `source` (including original source
hashes), `baseline`, `acceptance_cases`, `known_observations`, `carried_local_work`,
`production_safety`, `storage`, `references`, `setup`, and every phase/task contract field
other than `status`. Writes are atomic: a unique `.<pid>.<random>.tmp` sibling is
`fsync`ed and renamed over the target, then the directory is `fsync`ed. There are no
dependencies beyond Node's `fs`, `path` and `crypto`.
