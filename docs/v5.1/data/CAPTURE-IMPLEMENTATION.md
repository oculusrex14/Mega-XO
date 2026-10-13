# Day-one gameplay data collection — living implementation ledger

**Owner:** ChatGPT WebUI, isolated feature branch `feat/v51-gameplay-data-capture`; review PR [#12](https://github.com/oculusrex14/Mega-XO/pull/12) into integration branch `V5.1` only. **Base:** V5.1 `4e7d38584cde00dd4fe66fbd125470f6c8e74d19`. Main alone owns integration, migrations in real staging, provider/credentials, schedules and production authorization. Neural training/Impossible remain postponed. See [exact Main integration and day-one gate](DAY-ONE-INTEGRATION-HANDOFF-20261013.md) and [privacy inventory](../../legal/DATA-INVENTORY-RETENTION.md).

## Real completed evidence (evidence is scoped; does not imply staging PASS)

| Milestone | Source/CI evidence | Result |
|---|---|---|
| DC01–02 canonical replay | 2bcf89492e3f3c04d715b17138aadb899134a17a, Node22 local | **31 PASS / 0 FAIL / 0 SKIP**; 200 complete legal canonical games and adverse inputs; independently reproducible routing/legal masks, `b*9+c`, symbol/POV, board versus adjudication. |
| DC03–10 private PG + worker/chaos | b7c18335d6f14827195a6be01f2c9e01b348e4f1, GitHub Actions 38373759608, PG16/Node24 | Verified additive migrations/roles, signed source intent, terminal capture and deletion/export fencing in disposable PG. |
| DC03–10 recovery/tournament and CI 0048 | 1e74ee843b34c7b795a803832b5e9e71f96e1f0b, GitHub Actions push 38380755237 and PR 38380761443 | **72 PASS / 0 FAIL / 0 SKIP**. Worker SIGKILL/lease retry, actual PG restart, multi-attempt tournament, never-started void exclusion and malicious source regression included. |
| DC08–09 live-reader privacy fencing | db880856ad712e4c4c3ae787e518db6425c35869, Actions push 38381076934 and PR 38381082486 | **74 PASS / 0 FAIL / 0 SKIP**, latest pre-documentation source; revoke or change privacy epoch mid-stream stops NEXT record (not every 100th). |
| DC11 synthetic baseline | 65656e04c692afd0b93ce3ddcfb7f968aa77f42b, Actions 38375114036 / 38375119975 | Paired-order GitHub-runner move p95 **+1.094 ms** (26.591 enabled vs 25.497 off), settlement p95 **+2.306 ms** (23.642 vs 21.336), raw game archive p95 **5,403 B**, gzip p95 **1,197 B**, replay/seal CPU p95 **1.123 ms** over 200 games. Not staging latency, not full DB/WAL/backups capacity. |

**Migration order:** 0044 private learning schema/policy/roles/immutable replay records; 0045 recovery/privacy/exports; 0046 historical source fidelity; 0047 cryptographic terminal source intent check; **0048** exact never-started-void exclusion. All applied via the existing versioned migrator; original earlier migrations were not rewritten. API/Core/worker general-purpose roles gain **no direct private training archive read or economic authority**. Separate roles are **NOLOGIN** until explicitly and safely provisioned by Main.

## DC00–DC12 scoped completion, blockers and next accountable party

| Phase | State | In-repository delivery and remaining proof |
|---|---|---|
| **DC00** | **PARTIAL / HUMAN DECISION** | Data schema/disabled-by-default policy, server-source threat model and source-selection delivered. Human/privacy owner must explicitly approve gameplay-training purpose, notice/choice, storage/backup and positive retention windows; no implied player consent. |
| **DC01** | **DONE** | Audited authoritative Core/PG match/outbox/fixture, account deletion, encoder and existing JSON receipt types. `utttai` evaluated board positions remain separate from observed full human games. |
| **DC02** | **DONE** | Versioned `game-capture/v1`, deterministic full replay including legal board routing and turn, `b*9+c`, source/receipt hashes, strict schema/terminal checks, 200 full-game and corruption cases. Resign/timeout not treated as board loss. |
| **DC03** | **DONE (disposable PG)** | Additive 0044–0048 migration, 3 least-privilege private roles, restricted subject index, quarantine and export lineage; CI fresh PG apply/reapply/grant denials. Real-staging migration still NOT_RUN by Main. |
| **DC04** | **DONE (disposable PG)** | Deferred terminal DB triggers enqueue committed outbox inside existing Core tx; normal win/draw/resign/timeout/void; rollback/duplicate source intent; no synchronous worker or modified shared Core. |
| **DC05** | **DONE (disposable PG)** | Scoped leases, source re-read/hash, immutable seal, failed-source quarantine and idempotent retry; actual child SIGKILL and committed PG restart tests passed. Runtime supervisor still must be installed. |
| **DC06** | **PARTIAL** | Bounded keyset repair/reconcile, audits, missing intent recovery, hard source-pruning gates and metrics tested with PG; actual staging cadence, sustained throughput, alerts and quorum decision remain Main-owned. |
| **DC07** | **DONE (disposable PG)** | Tournament fixture attempts from durable ordered history, multi-attempt rematches and draw/decider symbols in CI. Historic missing timestamps are labeled unavailable; not invented. Real tournament staging still NOT_RUN. |
| **DC08** | **PARTIAL** | Verified request-time suppression, deletion/tombstone propagation, encrypted journaling, erasure/export revocation, reader per-record privacy fence and isolated restore in tests. Human privacy approvals, user-choice UI, backup/journal retention and real restoration/replay still BLOCKED/NOT_RUN. |
| **DC09** | **DONE (offline+disposable PG)** | Encrypted, manifest-bound streaming archives; optional observed-action positions, D4 game-family split, disk-backed transposition/symmetry deduplication, qualification entirely withheld; authenticated reader and source lineage. Export is OFF until policy approval; no training or model release. |
| **DC10** | **PARTIAL** | Full 74-test PG16/Node24 suite including failures/chaos succeeded. Real Core/staging two-actor game cohort, Redis denial, deployed PG restarts, backup restore and 100%-eligible source reconciliation still NOT_RUN. |
| **DC11** | **PARTIAL** | Synthetic CI p95 CPU/latency/size measurements above exist. Main must compare actual staging p50/p95/p99, backlog drain, PG/WAL growth, agreed quotas/storage budgets and P19 service levels. |
| **DC12** | **PARTIAL / RELEASE BLOCKED** | New capture CI, guarded one-shot CLI, 15-key receipt validator, exact Main integration handoff and PR delivered. Final reviewed integration, runbook schedule/role provisioning, valid privacy owner authorization, exact-SHA staging receipt and human go/no-go are external gates. |

## Operational safety, invariants and split rules

- **The database never silently enables capture.** An actual human-approved `learning.policy` is required to bind encryption/choice/retention/purpose before service use. Missing policy or rules hash disables/fails closed.
- **Population classification defaults `unknown`**; only authenticated, independently documented human-human records qualify for future export. Unverified client practice, search-generated trajectories and outside `utttai` positions cannot be relabeled observed online human actions.
- **Private participant-to-capture mapping** enables deletion, while export strips actor IDs, source IDs, timestamps and raw finance/session material; HMAC pseudonyms are not asserted anonymous. Encryption/journals require dedicated protected keys and post-restore replay.
- Source remains PostgreSQL. Redis outage, queue loss and notification failure cannot erase committed terminal intents. A played source mismatch quarantines; a never-started void gets an explicit exclusion rather than false `CAPTURE_SYMBOLS`.
- No training, distillation, automated model approval or Impossible release. Retained qualification split cannot be reused for training or concatenated across snapshot dates without a joint leakage/privacy audit.
- **Day-one gate:** `packages/learning/release-gate.js` checks 15 current evidence entries (purpose/retention/encryption/choice; worker, reconcile, deletion, export purge, restore; PG restart/Redis failure/performance; staging replays, zero missing games, rollback), SHA, rules, privacy epoch, canary and zero pending/quarantine/expired. Even a fully evidenced receipt gives `productionAuthorized:false`; Main+human authorization is separate.

## Shared-file boundary

Changed shared path: **`packages/migrations/manifest.json`**, only additive migration entries. New migrations are namespaced 0044–0048; no modifications to existing numbered files or game rules or Core source. New documentation appendix `docs/legal/DATA-INVENTORY-RETENTION.md` marks V5.1 proposal unapproved and leaves V4 requirements intact. Do not overwrite Main's staging P2/P21 work or rebase destructively. Review and safely integrate the feature branch into current V5.1 only after these acceptance notes are acknowledged.

