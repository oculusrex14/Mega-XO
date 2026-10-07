# V5 progress and resumption record

## Current state

**Full V5 execution active. G00 and G01 passed.** P00 (6/6) and P01 (5/5) accepted with executed evidence. P02 starts with the stored schema design; V4.1.2 remains the only production authority. Latest pushed checkpoint was `af11caa` (P00 evidence, run `37681523230` success); the P01 boundary extraction follows in the next commit on `V5-platform`.

- Goal: V5 hybrid platform plus genuine Android/iOS applications; approved game/retained browser preserved; new website/browser product deferred.
- Selected integration base: `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`, exact-head [Actions run 37658524961](https://github.com/oculusrex14/Mega-XO/actions/runs/37658524961), completed/success.
- Shipped application: `v4.1.2` / `f1e5577d42809fc3da889ba76b87ca6c87e68575`; guest-auth fix `79e56d6896ec372ddd585499475a045b3595f458` retained as baseline.
- Checkout is `V5-platform`, created from pinned `455b8ec`. Checkpoint `783ed22d39fa3a7182fd6c307eaa8f777a3e7336` is pushed; [first V5 CI run 37668446768](https://github.com/oculusrex14/Mega-XO/actions/runs/37668446768) passed all original Node/browser validation in 1m54s. Publish/images correctly skipped; V4.1/main/tags/runtime unchanged.
- Complete program: 25 phases, 117 actionable tasks, 40 acceptance cases. P21 is `DEFERRED_BY_OWNER`; P22 depends on P20, not P21. P24 is measurement-gated.
- Mutable task/case ledger: [progress.json](progress.json); generated checklist: [TODO.md](TODO.md); guarded CLI: `node scripts/v5/progress.js`. 11 tasks COMPLETE (P00 6/6, P01 5/5) and both gates passed; full A01–A40 acceptance cases remain separately unexecuted.

## Evidence-backed setup work

| Unit | Command/action | Target/result | Evidence |
|---|---|---|---|
| Goal/contract inventory | Read goal, pack/core/source/phase/specification documents; read-only repository-contract scout | Full scope/preservation rules captured; no application changes | AGENTS.md; DECISIONS.md; original pack references |
| Latest green base | Entry Git status/log/ref inspection; authenticated GitHub branch/run/release reads | Current local/remote SHA and successful exact-head CI; full release digest resolved | BASELINE.md; evidence/setup.json |
| Pack integrity | `python3 tools/validate-pack.py .` in implementation pack | PASS: 25 phases, 117 tasks, 40 cases, 64 checksums, original sources intact | evidence/setup.json |
| Actual provider/native/storage inventory | 25 provider and 37 native readonly command probes | Neon intended Free org/admin/zero projects and Hostinger DNS verified; toolchain/device/signing/quotas/auth gaps classified; APFS22GB, exFAT T9~922GB, DGX ext4/SMB~2.33TB | evidence/phase00-provider-inventory.json; evidence/phase00-native-inventory.json |
| Persisted ledger smoke | Resume/task eligibility, dependency/deferral and retained-contract assertions | PASS: 20 assertions; next task and P20→P22 deferral bypass exercised; initial harness gate-label mismatch corrected without changing ledger contracts | [evidence/ledger-smoke.json](evidence/ledger-smoke.json) |
| Live V4 recovery baseline | Tailscale SSH filtered runtime metadata; Restic check/retrieve; isolated restore hash/schema comparison | PASS: app digest/revision, livez/opsz true; snapshot f884e43b recovered byte-identically; sole edge and timers intact | [evidence/phase00-live-operations.json](evidence/phase00-live-operations.json) |
| Frozen ownership | Source-backed full route/write/constructor manifest and read-only exact snapshot schema | All35 source tables/eight serialized roots owned; Core/API/worker/private/ephemeral boundaries explicit | ROUTE-AND-DATA-INVENTORY.md; ARCHITECTURE.md; evidence/phase00-ownership.json |
| Actual visual baseline | Existing isolated HTTP/SQLite fixture, original Google Fonts/Lucide, four themes/four viewports, actual signed/guest/offline UI | 348 captured/344 eligible frames;696 PNG/metadata hashes verified;21 approved source files unchanged; generated fields and retained quirks explicit | evidence/phase00-visual-baseline.json; evidence/phase00-source-baseline.json |
| Executed progress CLI | Real record/inspect/render/gate refusal smoke plus targeted regression | PASS8 isolated command scenarios,117 tasks/25 phases; starter evidence-array defect reproduced and fixed, regression1/1; Markdown documentary ref classified separately | evidence/progress-tool-smoke.json; tests/v5-progress.test.js |
| G00 acceptance | Explicit gate evidence; actual CLI gate command | P00 COMPLETE with precisely scoped later prerequisites; production authority/data untouched | evidence/phase00-gate.json |
| P01 integration | `node --test --test-force-exit tests/*.test.js` over the four-slice extraction | 397 tests: 395 pass, 1 skip, only pre-existing opsz failure; live signup→convert replay/conflict/missing-key on new UoW; `/packages/*` 404; deterministic bundle `a41ef156…` launched offline in four themes with zero remote requests | evidence/phase01-gate.json + four task evidence files |

Owner-reported 340/342 and pre-existing opsz backup-freshness failure remain ground truth and were not rerun merely to confirm. The meaningful V5 CI checkpoint independently passed full original regression/browser/model gates; that does not claim the known local failure was repaired.

## Production safety

- Durable authority: V4 Node/SQLite remains active until gated P22. No V5 import, authority epoch or first post-import application write.
- Current v4.1.2 running app digest/revision and public livez/opsz ok:true directly verified. Older immutable v4.1.1 backup image is still running; successful repository/read/restore proves compatibility, not an assumed app-version match.
- Installed deployment directory is `/tmp/mega-release-f1e5577/deploy`; release.sh, enable-backups.sh, compose.yaml and Caddyfile hashes match the selected checkout. Snapshot f884e43b retrieved/verified and restored to an isolated owned temporary target, with byte hash/schema match; production DB untouched, temporary target removed.
- One public ingress owns 80/443. Preserve production/co-hosted services, monitoring and dedicated audit key.
- No provider object/DNS/signing/credential/legal/account changes. No commits/ref changes to V4.1/main. Supplied originals deliberately preserved in783ed22; unrelated `.agents/` and skill lock remain carried. New verification/CLI records enter an explicitly scoped V5 checkpoint.

## Next executable gates

Begin P02: live Neon capability verification (V5-02-01), normalized schema implementation from stored design `local://v5-p02-schema-design.md`, checksummed migrations/role grants, connection guards, then the nonserving isolated-staging deploy. P03 has a complete extraction design (`local://v5-p03-extraction-design.md`) but no import runs until its gates. Vercel authentication remains a concrete owner-side prerequisite before P11.

Actual later prerequisites: Vercel CLI authentication missing; GitHub package metadata403 requires read:packages; UptimeRobot numeric IDs/access unresolved; Neon effective quotas/always-on/restore capability must be verified for P02. Native tools execute, but zero physical devices connected and zero valid signing identities; cached Apple team is not membership/approval. T9 is exFAT archival-only, not a native cache root. Continue reachable foundations; obtain only specific mandatory approvals/access when needed.

## Restart protocol

Read this file, progress.json, TODO.md, BASELINE.md, DECISIONS.md, OPEN-ITEMS.md and the current phase/specifications. Inspect Git/CI once at entry. Preserve `.agents/`, goal/pack, `docs/Handoff/` and skill lock additions. Advance only from observed task/gate state; never infer completed migrations/grants/native/store approval from files or template checkboxes. Update exact commands, environments, SHAs, evidence and accurate statuses after each meaningful unit.
