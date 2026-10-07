# V5 progress and resumption record

## Current state

**Full V5 execution active.** No full phase gate has passed. P00 is IN_PROGRESS; V5-00-01 and V5-00-02 are COMPLETE with source/runtime/script/recovery facts separated and unresolved provider facts explicitly scoped. V5-00-03 branch checkpoint is in progress.

- Goal: V5 hybrid platform plus genuine Android/iOS applications; approved game/retained browser preserved; new website/browser product deferred.
- Selected integration base: `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`, exact-head [Actions run 37658524961](https://github.com/oculusrex14/Mega-XO/actions/runs/37658524961), completed/success.
- Shipped application: `v4.1.2` / `f1e5577d42809fc3da889ba76b87ca6c87e68575`; guest-auth fix `79e56d6896ec372ddd585499475a045b3595f458` retained as baseline.
- Checkout is now `V5-platform`, created from pinned `455b8ec` after baseline/live recovery checks. V4.1/main/tags/runtime remain unchanged; initial source/progress checkpoint and push are being prepared. Early CI now includes V5 pushes/PRs and retains V4-only release publishing.
- Complete program: 25 phases, 117 actionable tasks, 40 acceptance cases. P21 is `DEFERRED_BY_OWNER`; P22 depends on P20, not P21. P24 is measurement-gated.
- Mutable task/case ledger: [progress.json](progress.json); readable checklist: [TODO.md](TODO.md). All original contracts retained; V5-00-01 COMPLETE. V5-specific acceptance cases remain unexecuted unless their evidence is individually recorded.

## Evidence-backed setup work

| Unit | Command/action | Target/result | Evidence |
|---|---|---|---|
| Goal/contract inventory | Read goal, pack/core/source/phase/specification documents; read-only repository-contract scout | Full scope/preservation rules captured; no application changes | AGENTS.md; DECISIONS.md; original pack references |
| Latest green base | Entry Git status/log/ref inspection; authenticated GitHub branch/run/release reads | Current local/remote SHA and successful exact-head CI; full release digest resolved | BASELINE.md; evidence/setup.json |
| Pack integrity | `python3 tools/validate-pack.py .` in implementation pack | PASS: 25 phases, 117 tasks, 40 cases, 64 checksums, original sources intact | evidence/setup.json |
| Storage observation | `df -h / /Volumes /Volumes/T9`; Node/Python versions | Internal 22 GiB free; T9 858 GiB free; no relocation; DGX not inspected | BASELINE.md; progress.json |
| Persisted ledger smoke | Resume/task eligibility, dependency/deferral and retained-contract assertions | PASS: 20 assertions; next task and P20→P22 deferral bypass exercised; initial harness gate-label mismatch corrected without changing ledger contracts | [evidence/ledger-smoke.json](evidence/ledger-smoke.json) |
| Live V4 recovery baseline | Tailscale SSH filtered runtime metadata; Restic check/retrieve; isolated restore hash/schema comparison | PASS: app digest/revision, livez/opsz true; snapshot f884e43b recovered byte-identically; sole edge and timers intact | [evidence/phase00-live-operations.json](evidence/phase00-live-operations.json) |

Known suite/production observations in BASELINE.md are owner-reported and ledger-corroborated, not freshly rerun. The pre-existing opsz backup-freshness failure was not rerun to confirm.

## Production safety

- Durable authority: V4 Node/SQLite remains active until gated P22. No V5 import, authority epoch or first post-import application write.
- Current v4.1.2 running app digest/revision and public livez/opsz ok:true directly verified. Older immutable v4.1.1 backup image is still running; successful repository/read/restore proves compatibility, not an assumed app-version match.
- Installed deployment directory is `/tmp/mega-release-f1e5577/deploy`; release.sh, enable-backups.sh, compose.yaml and Caddyfile hashes match the selected checkout. Snapshot f884e43b retrieved/verified and restored to an isolated owned temporary target, with byte hash/schema match; production DB untouched, temporary target removed.
- One public ingress owns 80/443. Preserve production/co-hosted services, monitoring and dedicated audit key.
- No provider object/DNS/signing/credential/legal/account changes. No Git ref changes or commits to V4.1/main. Owner-carried inputs unchanged; new setup files remain local/uncommitted until a gated V5 checkpoint.

## Next executable gates

Complete the initial V5 checkpoint, then finish full route/data ownership and approved UI/rule baselines, inspect early V5 CI and close actual provider/native inventory. Provider monitor/package visibility remains specifically scoped under V5-00-06. G00 remains open until its entire exit gate has evidence; P00–P03 must pass before dependent distributed-runtime work.

No specific missing owner permission/device was demonstrated. Use the authorized authenticated tools; if an actual prerequisite fails, record the exact sanitized action/error and continue independent work. Do not use historical BLOCKED ledger rows as current access proof.

## Restart protocol

Read this file, progress.json, TODO.md, BASELINE.md, DECISIONS.md, OPEN-ITEMS.md and the current phase/specifications. Inspect Git/CI once at entry. Preserve `.agents/`, goal/pack, `docs/Handoff/` and skill lock additions. Advance only from observed task/gate state; never infer completed migrations/grants/native/store approval from files or template checkboxes. Update exact commands, environments, SHAs, evidence and accurate statuses after each meaningful unit.
