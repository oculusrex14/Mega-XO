# PR #12 `feat/v51-gameplay-data-capture` — independent review (V5.1)

**Reviewer:** Main integration owner (Priority 7 review pass).
**Date:** 2026-10-13. **Decision: READY_WITH_FIXES → INTEGRATED.** Merged into `V5.1` after the fixes below.

## Integration disposition (fixes applied by the integration owner)

| Blocker | Fix | Commit |
| --- | --- | --- |
| B1 — encrypted suite fails on darwin (realpath stub) | test now resolves `fs.realpath(dir)` before stubbing `fs.promises.open`; 5/5 pass locally | `a972af8` |
| B2 — branch behind V5.1 (deletion-ack regression risk) | merged with a **reviewed two-parent merge** (`--no-ff`) that keeps V5.1's `packages/services/accounts.js` (6-key ack) and V5.1's release docs / `scripts/v51/*`; verified `tombstone`/`actorHash` intact post-merge | `c384b4d` |
| B3 — capture gate not a required check | `V5.1 gameplay capture` added to `ALWAYS_REQUIRED` in `scripts/v5/ci-impact.js` and the release-engineering workflow's required-gate assertion (fail-closed) | `5513866` |

Post-merge verification: 45/45 capture PG+capture+worker+tournament tests, 5/5 encrypted, 58/58
non-PG capture tests; `node scripts/v5/migrate.js --dry-run` plan OK over 49 migrations.


| Field | Value |
| --- | --- |
| Review target | `origin/feat/v51-gameplay-data-capture` @ `741cad4` |
| Merge base | `5dd037e225db3d86bb9e8a4d949254588af11bca` |
| Integration branch reviewed against | `V5.1` @ `2bb1caa` (manifest tip 0043) |
| Actual PR content (`git diff V5.1...origin/...`) | 34 files, +2253/−266 |
| Contract | `docs/v5.1/data/PLAYER-GAMEPLAY-TRAINING-IMPLEMENTATION-PACK-20261013.md` (DC00–DC12), `...-ARCHITECTURE-20261013.md` |
| Environment | disposable PG16 `postgres://postgres@127.0.0.1:54329/postgres` + Redis `redis://127.0.0.1:6389`; `V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 V5_REDIS_REQUIRED=1 V5_TARGET=test`; Node v26.8.2 / macOS arm64 |
| Method | read-only worktree `origin/feat/v51-gameplay-data-capture`; no PR file modified; all numbers below are from this machine |

> **Scope note on the diff.** The PR *content* against `V5.1` is the 34 capture files only. A naive `git diff V5.1 origin/feat/...` reports 69 files including `packages/services/accounts.js`, `scripts/v51/p21-*.cjs` and six `docs/v5.1/release/*.md` deletions; these are the PR branch being **behind** commits `1a80ebc` (deletion acknowledgement now returns `tombstone`/`actorHash`) and `ea782d0`…`2bb1caa`. `git diff V5.1...origin/...` is empty for `accounts.js`, so a normal merge preserves V5.1's newer work. **Integration is not blocked by this, but the PR branch should be refreshed onto current `V5.1` before merge so the deletion-acknowledgement contract is not silently regressed by a careless `git checkout`-style merge.**

---

## 1. Contract coverage — DC00–DC12

| ID | Pack done-condition | PR delivers | Evidence (verified on this machine) | Verdict |
| --- | --- | --- | --- | --- |
| **DC00** | Documented privacy/legal review; sources enumerated; no implicit training consent | `docs/legal/DATA-INVENTORY-RETENTION.md` §9 (V5.1 proposal marked *PURPOSE/NOTICE/RETENTION APPROVAL PENDING*); schema refuses enablement without approvals; sources enumerated in both data docs | `0044_gameplay_capture.sql:25-38` (CHECK requires `approval_ref`,`encryption_ref`,`choice_ref`,`capture_after`,`*_retention_days`,`source_commit`,`rules_hash`,`environment` before `enabled`); `0044:39` inserts disabled default; probe: `UPDATE learning.policy SET enabled=true` → `23514 policy_check`. **No actual legal approval exists** | **PARTIAL** (human decision outstanding; correctly not fabricated) |
| **DC01** | Exact source SHAs, real `ops.outbox` kind ownership, no contradictory writer | Ledger of SHAs in `CAPTURE-IMPLEMENTATION.md`; role/data-flow described in `DAY-ONE-INTEGRATION-HANDOFF-20261013.md`; **no standalone threat-model document was added** | All 8 ledger SHAs resolve in-repo (`git cat-file -e` OK for `2bcf894`,`b7c1833`,`1e74ee8`,`db88085`,`25dce08`,`fce0fd6`,`65656e0`,`4e7d385`). Kind ownership independently verified: `learning.claim` filters `o.kind='learning.capture'` (`0045:9-11`); capture role holds `EXECUTE` on exactly `claim,configuration,finish,metrics,project,reconcile,reject` and **zero** table privileges | **DONE** (in-repo); threat-model artifact is prose, not a numbered deliverable |
| **DC02** | `game-capture/v1` serializer + independent validator; canonical index; hash; truthful terminals; all fixture classes | `packages/learning/capture.js` (148 lines) | `capture.js:28-37` canonical replay from `src/game.js`; `:53` X-first only; `:54` `moves.length===revision`; `:57-62` line/draw/resign/timeout/no-show/void classification; `:89-97` bounded payload; `:103-135` validator; `:122-125` replay re-derivation; `:136-147` positions with POV value. Suites: `tests/gameplay-capture.test.js` **31 pass / 0 fail** — 200 complete legal games (`:17-21`), 24 corruption cases (`:26-35`) | **DONE** |
| **DC03** | Additive versioned schema, private archive, subject index, quarantine+manifests, no core economic grants widened | Migrations 0044–0049 + manifest | Manifest 49 entries, all 49 sha256 recomputed and matching (`sha256(name+'\n'+sql)`); **no existing hash changed, none removed** — purely additive. `v5-migrations.test.js` **11 pass / 0 fail / 0 skip**. Fresh apply + reapply (`gameplay-pg.test.js:38` `appliedCount===0`). All learning SECURITY DEFINER functions have pinned `search_path` (probe: 0 offenders) | **DONE (disposable PG)**; real-staging apply still Main-owned |
| **DC04** | One sanitized intent at FIRST confirmed terminal transition inside the existing Core tx; idempotent replay ignored; once-only, no lost terminal | Deferred constraint triggers + `learning.enqueue` | `0044:151-164` `learning_match_terminal` `AFTER INSERT OR UPDATE … DEFERRABLE INITIALLY DEFERRED … WHEN(NEW.settled AND NEW.status IN ('FINISHED','VOID'))` — no command-name keying; `:120-149` deterministic `learning.capture:<sha256>` id, `ON CONFLICT DO NOTHING`. `gameplay-pg.test.js:51-61`: 6 terminals (line/draw/resign/timeout/void/direct-rated) → `count()==6` **and** outbox `kind='learning.capture'` `==6`; `:62-64` rollback leaves neither source nor intent. Independent probe: started-void → sealed, offered-only void → `excluded` (no fabricated game) | **DONE** |
| **DC05** | Kind-scoped worker, allowlisted projection, checksummed archive, quarantine conflicts, crash-safe retry, never steals jobs | `packages/learning/worker.js` + `learning.claim/finish/reject` | `0045:3-16` `FOR UPDATE OF o SKIP LOCKED` + kind join; `worker.js:12-15` disabled/rules-hash gate *before* claims. `gameplay-pg.test.js:65-72`: two concurrent claims yield **1** row total, unrelated `email` job stays `queued`, stale lease rejected (`CAPTURE_STALE_LEASE`). `gameplay-recovery.test.js:24-30`: real SIGKILL of a child mid-claim and mid-`finish` → source stays `pending`, replacement worker seals. My own probe confirmed 3 injected foreign-kind jobs (`core.command`,`email`,`commerce.command`) untouched (`state='queued'`, `lease_owner=NULL`, `attempts=0`) after a tick | **DONE (disposable PG)**; supervisor install pending |
| **DC06** | Reconciler detects settled-not-captured, repairs missing intents, exposes backlog/age; **blocks pruning uncaptured** | `learning.repair_intent`/`reconcile`/`metrics` + `learning.prune_guard` | `0045:85-126`, `0046:117-145`; `0044:274-311` + `0046:80-115` prune guard. Independent probe: with intent **and** capture row deleted, `DELETE FROM match.matches` → **refused `CAPTURE_UNREGISTERED_SOURCE`**; with a pending capture → refused `CAPTURE_SOURCE_STILL_REQUIRED`; after reconcile repaired the intent and the worker sealed it, deletion became allowed. `gameplay-pg.test.js:73-79` covers repair + `CAPTURE_SOURCE_STILL_REQUIRED`. `metrics()` exposes `pending/quarantined/expiredUnpurged/oldestPendingSeconds` (`0047:145-151`) | **DONE (in-repo)**; alerting/cadence Main-owned (PR self-labels PARTIAL) |
| **DC07** | Independent fixture extractor; distinguishes fixture attempts/adjudication; never marks incomplete fixtures complete | `learning.fixture_intents` + 3 triggers | `0044:168-208`; history-ordinal keying survives fixture `attempt` resets (`:166-167` comment + `:179`). `gameplay-tournament.test.js:23-40`: 4 real attempts through pause/resume and repository replacement → `source_attempt [1,2,3,4]`, 4 sealed, `reason` `draw,draw,draw,resign`, seat mappings preserved, `HISTORY_ONLY` flagged | **DONE (disposable PG)** |
| **DC08** | Deletion, consent/opt-out, export lineage, backup post-restore suppression; no raw identifiers in exports | `learning.suppress/erase/replay_erasure/restore_watermark` + `privacy.js` | `0045:136-191`; trigger on `privacy.requests` (`:147-151`). `gameplay-pg.test.js:83-92`: suppression synchronously invalidates a live export, erase zeroes `capture_subjects` and all payloads, replay tombstone persists when the capture is absent, restore watermark disables collection and re-fences exports (`CAPTURE_EXPORT_PRIVACY_FENCE`). `gameplay-recovery.test.js:33-40` real-PG journal round-trip. Exporter strips `startedAt/endedAt` (`exporter.js:54`) and HMAC-pseudonymises game ids (`:52`); my export probe found no actor id in any streamed record | **PARTIAL** (privacy approval, user-choice UI, real restore drill external) |
| **DC09** | Deterministic streaming offline export; group-safe splits + reserved untouched set; human/search and terminal/adjudicated separated; **two independent validators** | `packages/learning/exporter.js` | `exporter.js:31,36-45,48-67` two-pass keyset streaming; `:38-40` population/risk/no-play exclusions; `:14` D4-invariant split; `:44,50` transposition/symmetry dedup; `:49` qualification rank 0 **never emitted**; `:59-64` positions carry `policyTargetSource:'observed-player-action'`, `searchPolicy:null`, `valueTargetSource`; `:78-87` re-checks eligibility *before every record*. `gameplay-export.test.js` **7 pass / 0 fail**. **Only one validator implementation exists** (`capture.js`); the "second validator" is test-side replay, not an independent artifact | **PARTIAL** (single validator; everything else DONE) |
| **DC10** | Real isolated staging Core + two disposable actors; full game/resign/timeout/void/crash/queue/direct/both symbols; counts reconcile 100% | Disposable-PG equivalent only | `gameplay-pg.test.js` covers line/draw/resign/timeout/void/queue/direct-unrated/direct-rated, both seats, crash/retry/fencing, Redis-free by construction. Real staging cohort, Redis denial drill and backup restore **not run**; the PG-restart test **skipped on this machine** (needs `CAPTURE_TEST_PG_CONTAINER`) | **PARTIAL** |
| **DC11** | Reproducible benchmark; P19 budgets; real-fixture archive size/cost | `tests/gameplay-benchmark.test.js` | Ran locally: 10 paired blocks, move p95 enabled **13.55 ms** vs disabled **22.08 ms** (`moveP95DeltaMs −8.53`, i.e. within runner noise, not a regression); settlement p95 14.19 vs 12.96 ms; 200 games, plies p50 59 / p95 68; `sealMs`/`rawBytes`/`gzipBytes` summarised into `.artifacts/gameplay-tests/benchmark.json`, self-labelled `SYNTHETIC_OWNED_LOOPBACK_NOT_STAGING`. No staging p50/p95/p99, no real-fixture storage-cost projection | **PARTIAL** |
| **DC12** | Non-serving CI + explicit V5 release-readiness check requiring DC02–DC11 + privacy authorization; preserve V4 production/disabled catalog/economy | `.github/workflows/v51-gameplay-capture.yml`, `packages/learning/release-gate.js`, `scripts/gameplay-capture.cjs` | Workflow is non-serving, `permissions: contents: read`, pinned actions + pinned PG16 digest, `--test-concurrency=1`, artifacts retained 7 days. `release-gate.js:4-6` requires 15 named evidence keys, `:7-22` refuses missing/stale/mismatched receipts and always returns `productionAuthorized:false`/`trainingAuthorized:false`. **The gate is not wired into the V5 release checklist** and nothing forces it as a required check; it returns `RECEIPTS_READY_FOR_MAIN_REVIEW`, never a pass | **PARTIAL / RELEASE BLOCKED** |
| **DC13–15** | Optional, post-launch | Not implemented (correct) | `grep -rni "impossible\|train\|gpu\|spend\|staging provider"` in `packages/learning/`+CLI returns only comments disclaiming them | **N/A — correctly absent** |

---

## 2. Safety review

Each item below was tested independently of the PR's own suites.

| Invariant | Result | Evidence |
| --- | --- | --- |
| **No external network I/O inside the game transaction** | **CONFIRMED** | `grep -rn "node:http\|node:https\|fetch(\|net.connect\|dns\.\|axios" packages/learning/ scripts/gameplay-capture.cjs` → no hits. Migrations 0044–0049 contain no `dblink`/`pg_net`/`http_get`/`COPY … PROGRAM`. The Core hook is a **deferred in-DB trigger** inserting one row into `ops.outbox`; the archive is built post-commit by a separate process. `ops.outbox` insert happens inside the same transaction (by design) but performs no I/O. |
| **Worker is kind-scoped; cannot steal existing outbox jobs** | **CONFIRMED** | `0045:9-11` joins `o.kind='learning.capture'` and only IDs prefixed `learning.capture:`; `worker.js` never issues SQL against `ops.outbox` (asserted in `gameplay-worker.test.js:9`). Probe: injected `core.command`/`email`/`commerce.command` queued rows remained `queued`, `lease_owner=NULL`, `attempts=0` across a full tick. `gameplay-pg.test.js:71` asserts the unrelated `dc-unrelated` job stays `queued`. |
| **Least-privilege DB roles** | **CONFIRMED** (catalog probe, real migrated DB) | `api_runtime`,`core_runtime`,`worker_runtime`,`backup_reader`,`audit_runtime`: **no** `learning` USAGE, **no** table privilege, **no** function EXECUTE. `capture_runtime` → `claim,finish,reject,reconcile,metrics,project,configuration`; `capture_exporter` → `begin_export,export_page,export_member,finish_export,export_status,revoke_export,configuration`; `capture_privacy` → `suppress,erase,privacy_page,erasure_page,replay_erasure,restore_watermark,configuration`. All three: **0 table SELECT/INSERT/UPDATE anywhere in `learning`, 0 economy writable tables**. Direct `SELECT` on `learning.captures`/`capture_subjects`/`policy` as `capture_runtime` → `42501`. All 38 SECURITY DEFINER functions in `learning` have the pinned `search_path=pg_catalog, learning, pg_temp`; `learning` owner is `v5_owner`. `core_runtime` retains its pre-existing economy write set — **unchanged by this PR**. |
| **Terminal source cannot be pruned before a verified archive exists** | **CONFIRMED** | Probe: settled match with (a) pending capture → `CAPTURE_SOURCE_STILL_REQUIRED`; (b) *no* capture row and no intent at all → `CAPTURE_UNREGISTERED_SOURCE`; (c) sealed archive → deletion allowed. Guard runs `AFTER DELETE … DEFERRABLE INITIALLY DEFERRED` (`0044:310-311`) so normal fixture delete/reinsert cycles still work. Quarantined captures also block pruning (loop covers `pending,quarantined`, `0044:297`). |
| **Replay conflicts quarantine rather than overwrite** | **CONFIRMED** | `0047:61-69` fences `project()` on the immutable `intent_source_token`; `finish_validated` compares `payload_sha256` and calls `quarantine('CAPTURE_IMMUTABLE_CONFLICT')` (`0045:61-62`); `quarantine` also revokes all `building`/`ready` exports (`0045:31`). Probe: after mutating `move_timings`, `reconcile({audit:true})` → state `quarantined`, code `CAPTURE_SOURCE_DRIFT`, **sealed payload byte-identical to before**. Same-key/different-content therefore never overwrites. My vanished-source probe (`DELETE FROM match.matches` under `session_replication_role=replica`) → `quarantined` + `CAPTURE_INTENT_SOURCE_CHANGED`, **0 sealed payloads**, no fabrication. |
| **No second economic authority** | **CONFIRMED** | Capture roles hold **0 UPDATE/INSERT** on any `economy.*` table (probe). Migrations 0044–0049 touch no `economy`, `match`, `tournament`, `ops`, `identity` or `privacy` **schema** — only `CREATE SCHEMA learning` and `CREATE TRIGGER`s on existing tables (`grep` over 0044–0049 for `ALTER TABLE (match|tournament|ops|economy|identity|privacy)\.` → none). The `learning.capture` outbox kind is new and disjoint from `core.command`. |
| **No Impossible / training enablement** | **CONFIRMED** | No training, model, GPU, provider or catalog code in the PR; `release-gate.js:21` hard-codes `trainingAuthorized:false`; the 34-file diff contains no `src/`, `apps/`, `training/`, `deploy/` path. |
| **No production / catalog / spend change** | **CONFIRMED** | `git diff --name-only V5.1...origin/...` yields no `src/**`, `apps/**`, `training/**`, `deploy/**`, `packages/services/**` path. Manifest hashes for the 43 pre-existing migrations are **bit-identical**; the 6 new entries append only. Collection is disabled by default and cannot be enabled without approved references (`0044:33-37`, probe `23514`). |
| **Redis outage cannot lose a terminal intent** | **CONFIRMED (by construction)** | Nothing in `packages/learning/**` or `scripts/gameplay-capture.cjs` reads `REDIS_URL`/redis; the sole durable carrier is `ops.outbox` in PostgreSQL, and `ops.outbox` retention deletes only terminal rows (`worker-workflows.js:427-428` `state NOT IN ('queued','sending')`). Redis was never required by any capture suite. |

**Two residual observations (non-blocking, not safety violations):**

1. `learning.prune_guard` is gated on `learning.policy.enabled` (`0044:282`). With collection disabled, historical terminal sources remain prunable. That is the intended "collection off" semantics, but it means the guard is *not* a permanent retention guarantee — it only holds while policy is enabled. Worth recording in the runbook.
2. `learning.project_unfenced` remains executable by `migration_owner` (by design, for repair tooling), but `capture_runtime` is correctly denied it (`gameplay-integrity.test.js:24` asserts `42501`).

---

## 3. Real test execution

### 3.1 Exact commands and results

```
# PR gameplay suites
cd /tmp/gpreview   # read-only worktree @ origin/feat/v51-gameplay-data-capture (741cad4)
V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 V5_REDIS_REQUIRED=1 V5_TARGET=test \
V5_PG_URL=postgres://postgres@127.0.0.1:54329/postgres REDIS_URL=redis://127.0.0.1:6389 \
V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 \
node --test --test-reporter=tap --test-concurrency=1 'tests/gameplay-*.test.js'
```

```
# tests 75
# pass 73
# fail 1
# skipped 1
# todo 0
exit=1
```

```
# migration suite (PR adds 0044-0049, so this was run too)
node --test --test-reporter=tap --test-concurrency=1 tests/v5-migrations.test.js
# tests 11   # pass 11   # fail 0   # skipped 0   exit=0
```

```
node --test --test-reporter=tap --test-concurrency=1 tests/gameplay-benchmark.test.js
# pass 1 # fail 0 # skipped 0
# CAPTURE_BENCHMARK {... "moveP95DeltaMs": -8.530... "scope":"SYNTHETIC_OWNED_LOOPBACK_NOT_STAGING"}
```

Per-file (13 gameplay suites):

| Suite | pass | fail | skip |
| --- | --- | --- | --- |
| `gameplay-benchmark.test.js` | 1 | 0 | 0 |
| `gameplay-capture.test.js` | 31 | 0 | 0 |
| `gameplay-connection.test.js` | 4 | 0 | 0 |
| **`gameplay-encrypted.test.js`** | **4** | **1** | 0 |
| `gameplay-export.test.js` | 7 | 0 | 0 |
| `gameplay-gate-integrity.test.js` | 1 | 0 | 0 |
| `gameplay-integrity.test.js` | 5 | 0 | 0 |
| `gameplay-pg.test.js` | 8 | 0 | 0 |
| `gameplay-privacy.test.js` | 4 | 0 | 0 |
| `gameplay-recovery.test.js` | 1 | 0 | **1** |
| `gameplay-source-contract.test.js` | 1 | 0 | 0 |
| `gameplay-tournament.test.js` | 1 | 0 | 0 |
| `gameplay-worker.test.js` | 5 | 0 | 0 |

The PR ledger (`CAPTURE-IMPLEMENTATION.md`) claims **75 PASS / 0 FAIL / 0 SKIP** on GitHub Actions Node 24. **On this machine the suite is 73/1/1.** The discrepancy is environmental (see 3.2) and the ledger's numbers are not reproducible on darwin.

### 3.2 The one failure, with trace

```
# Subtest: failed directory sync after atomic publication cannot leave an untracked ciphertext
not ok 41 - failed directory sync after atomic publication cannot leave an untracked ciphertext
  duration_ms: 8.98
  location: '/tmp/gpreview/tests/gameplay-encrypted.test.js:29:1'
  failureType: 'testCodeFailure'
  error: 'Missing expected rejection.'
  code: 'ERR_ASSERTION'
  stack: |-
    async TestContext.<anonymous> (/tmp/gpreview/tests/gameplay-encrypted.test.js:39:6)
```

Root cause (isolated repro, `node /tmp/gpprobe/probe3.cjs`):

```
mkdtemp dir   : /var/folders/.../T/probe3-fTCe5v
realpath(dir) : /private/var/folders/.../T/probe3-fTCe5v
{"thrown":"EIO","leftover":[],"target":false}      # patched on the REALPATH -> works
{"thrown":null,"targetExists":true}                # patched on the mkdtemp string -> inert
```

`tests/gameplay-encrypted.test.js:32-38` monkeypatches `fs.promises.open` (correct object; `fsp === fsMod.promises` is `true`) but matches on `name === dir`, where `dir` is the raw `fs.mkdtemp(os.tmpdir())` string. `packages/learning/encrypted.js:18-23` (`privateDirectory`) resolves `fsp.realpath(dir)` and `:27` passes the **realpath** to `path.join`, so on macOS the module opens `/private/var/...` while the stub only intercepts `/var/...`. The injected `EIO` therefore never fires; `finish()` succeeds; `assert.rejects(w.finish())` at `:39` fails with "Missing expected rejection". On Linux `/tmp` is canonical, so CI's 75/0/0 is plausible.

**This is a test-harness path-canonicalisation defect, not a product defect.** `encrypted.js:47-66` post-publication cleanup is correct — with the stub matching the realpath the test passes and leaves no `.partial-` file and no target (probe output above).

**Failing assertion:** `tests/gameplay-encrypted.test.js:39` (`await assert.rejects(w.finish(), e => e.code === 'EIO')`).

### 3.3 The skip

```
# Subtest: DC10 committed capture intent survives actual isolated PostgreSQL container restart
ok 57 - DC10 ... # SKIP owned GitHub service-container restart hook not configured; Main must run staging restart
```

`tests/gameplay-recovery.test.js:43-45`: requires `CAPTURE_TEST_PG_CONTAINER` (the workflow passes `${{ job.services.postgres.id }}`, which does not exist on this workstation). **What is missing:** a GitHub Actions service container ID to `docker restart`. Not runnable here; it *did* run in the PR's own CI per the ledger. Also note the test asserts `process.env.CI === 'true'` (`:46`), so it is structurally CI-only.

### 3.4 Independent probes I ran against the same lab (not part of the PR)

| Probe | Result |
| --- | --- |
| `.review-grants.cjs` — full catalog ACL dump for 9 roles | as quoted in §2 |
| `.review-safety.cjs` — enable-without-fields, prune-pending, sealed→prune, conflict | `23514 policy_check`; `REFUSED CAPTURE_SOURCE_STILL_REQUIRED`; `ALLOWED(archive verified)`; `quarantined` + payload unchanged |
| `.review-prune.cjs` — total internal loss of intent+capture row | `REFUSED CAPTURE_UNREGISTERED_SOURCE` → reconcile `repaired:1` → `sealed:1` → prune then allowed |
| `.review-scope.cjs` — foreign kinds, direct reads, vanished source | 3 foreign jobs untouched; `42501`×3; `quarantined CAPTURE_INTENT_SOURCE_CHANGED`, 0 sealed payloads |
| `.review-fidelity.cjs` — replay/terminal fidelity | see §4 |
| `.review-void.cjs` — operator void round-trip | see §4 |
| Manifest recompute | 49/49 hashes match |

---

## 4. Replay / terminal fidelity

Independently driven through the **real Core service** (`packages/services/core.js` over the migrated disposable schema, `lab.coreFor`), then every sealed archive was replayed against `src/game.js` from the stored first symbol:

| Source | Core terminal | Archived `reason` | `boardWinner` | `adjudicatedWinner` | plies | replay legal | archive hash == `payload_sha256` | `terminalValueEligible` | value labels | source ids leaked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 56-ply natural win (`X` line) | `line`, O wins | `line` / `FINISHED` | `O` | `O` | 56 = revision | ✅ | ✅ | `true` | `{-1, +1}` from `terminal-board-outcome` | none |
| 68-ply natural draw | `draw` | `draw` / `FINISHED` | `DRAW` | `null` | 68 = revision | ✅ | ✅ | `true` | `{0}` | none |
| resign after 4 plies | `resign`, adjudicated | `resign` / `FINISHED` | **`null`** | `O` | 4 | ✅ | ✅ | **`false`** | `{null}`, `unlabelled-adjudication` | none |
| timeout after 4 plies | `timeout`, adjudicated | `timeout` / `FINISHED` | **`null`** | `O` | 4 | ✅ | ✅ | **`false`** | `{null}`, `unlabelled-adjudication` | none |
| started then operator void | `VOID`, `reason:'review'` | `void` / `VOID` | `null` | `null` | 1 | ✅ | ✅ | **`false`** | `{null}` | none |
| offered-only then operator void | `VOID` (never started) | **not sealed** → `excluded` (`CAPTURE_NOT_STARTED`) | — | — | — | — | — | — | — | — |

Worker tick for that batch: `{claimed:4, sealed:4, quarantined:0, excluded:0, errors:{}}`; void batch: `{claimed:2, sealed:1, excluded:1, quarantined:0}`.

Additional fidelity facts confirmed:

- **All 4 terminal reasons round-trip**, plus the fifth (`void`) and the sixth case (never-started void → `excluded`, no invented symbols/`winner`). Draws and lines are the *only* reasons eligible for terminal-board value supervision (`capture.js:134`); resign/timeout/no-show are adjudicated and correctly excluded (`capture.js:59`, `:142-143`).
- **Every emitted position is legal**: `legalMask[observedAction] === 1` and `observedAction === b*9+c` for all positions of all six archives.
- **`searchPolicy` is `null` everywhere** and `policyTargetSource === 'observed-player-action'` — human behaviour is never relabelled as a search visit distribution.
- **No raw identifiers** in any gameplay payload (`/svc_alice|svc_bob/` absent); actor→game linkage lives only in `learning.capture_subjects`.
- **Archive hash is the DB hash**: `C.sha256(payload) === payload_sha256` for every row; a tampered archive fails `CAPTURE_HASH` (`gameplay-capture.test.js:24`).
- **First symbol is always `X`** (`capture.js:53`), and an O-first online match is rejected (`gameplay-capture.test.js:33`), matching the architecture's "do not invent an O-first match".
- **Both seat assignments preserved** without identifiers (`gameplay-capture.test.js:23`).

---

## 5. Blocking issues

| # | Severity | Issue | Exact location | Fix |
| --- | --- | --- | --- | --- |
| **B1** | **Blocking for a locally-green suite** | The encrypted-archive suite fails on darwin: the monkeypatch matches the raw `mkdtemp` path while `encrypted.js` opens the **realpath**, so the injected `EIO` never fires and `finish()` resolves. Test-only; the product path is correct. | `tests/gameplay-encrypted.test.js:29-42` (failing assertion at `:39`), versus `packages/learning/encrypted.js:18-27` | Patch `await fs.realpath(dir)` (as `probe3.cjs` demonstrates) before stubbing `fs.promises.open`, or match on both `dir` and its realpath. Must be fixed so "75 PASS" is reproducible off CI. |
| **B2** | **Blocking for merge hygiene** | The PR branch is behind `V5.1` by `1a80ebc` + `ea782d0…2bb1caa`. A `git diff V5.1 origin/feat/...` shows `packages/services/accounts.js` reverting the deletion acknowledgement from 6 keys back to 4, and deletes 6 `docs/v5.1/release/*.md` and `scripts/v51/p21-*.cjs` that V5.1 owns. A careless merge would regress the P11 deletion contract. | `packages/services/accounts.js:1686` (branch) vs `:1690` (V5.1) | Refresh/rebase `feat/v51-gameplay-data-capture` onto current `V5.1`, or merge with an explicit resolution that keeps V5.1's `accounts.js`. `git diff V5.1...origin/feat/...` is already empty for that file. |
| **B3** | **Blocking for DC12 as written** | The release gate is implemented but **not wired** into the V5 release-readiness checklist, and its best outcome is `RECEIPTS_READY_FOR_MAIN_REVIEW` — never a pass. DC12's done-condition ("explicit V5 release-readiness check requiring DC02–DC11 plus privacy authorization") is therefore not met as a gate. | `.github/workflows/v51-gameplay-capture.yml` (not a required check); `packages/learning/release-gate.js:21` | Add `gameplay-capture` as a required check for `V5.1`, and have the cutover checklist fail closed until `node scripts/gameplay-capture.cjs gate` returns non-`BLOCKED`. |
| **B4** | Non-blocking (record) | `learning.prune_guard` only enforces retention while `learning.policy.enabled` is true; disabled collection makes historical sources prunable again. | `packages/migrations/migrations/0044_gameplay_capture.sql:282` | Document in the runbook; if retention must survive a disable, add a separate retention flag rather than overloading `enabled`. |
| **B5** | Non-blocking (record) | DC09's "two independent validators replay everything" is satisfied by one validator (`capture.js`) plus test-side replay, not by two independent implementations. | `packages/learning/exporter.js:37,51` (only consumer of `C.validate`) | Either accept the single validator with the test-side replay as the second, or state the deviation explicitly in the ledger. |
| **B6** | Non-blocking (record) | A never-started **fixture** void is handled by the `hints.void` branch (`0046:73-76`) which requires fixture `players`; it is not covered by a dedicated test the way the match case is (`gameplay-integrity.test.js:32-34`). | `packages/migrations/migrations/0046_gameplay_source_fidelity.sql:73-76` | Add one synthetic never-started-fixture case to `gameplay-tournament.test.js`. |

**Not blocking:** the two `docs/v5.1/data/CAPTURE-IMPLEMENTATION.md` claims that I could not reproduce locally are the 75/0/0 count (B1) and the "74 passing PostgreSQL tests" figure; everything else in the ledger that I checked (SHA existence, migration order, roles gaining no private archive read, collection disabled by default, no training) is accurate.

---

## 6. Verdict

**READY_WITH_FIXES.**

The capture lane is, on the evidence above, safe to integrate once B1–B3 are addressed. It is additive (no `src/`, `apps/`, `packages/services/`, `training/`, `deploy/` change; 43 pre-existing migration hashes unchanged), fails closed by default (collection disabled, approvals required, unknown population, one validator, one hash), and every stop/reject condition in the pack's list was tested and held:

- no online move without Core authority, and no invented player/game/move/winner/value — confirmed by the fidelity probe;
- no external network call inside the game transaction, and no gameplay/economic change when the worker or Redis is absent — confirmed by code scan, the kind-scoped-claim probe, and the fact that Redis is never referenced;
- no role outside the three narrow capture roles can read subjects or mutate Core economic tables — confirmed by a full catalog ACL probe;
- no terminal source pruned before an archive exists, and replay conflicts quarantined rather than overwritten — confirmed by the prune and conflict probes;
- no second economic authority, no Impossible/training enablement, no production/catalog/spend change — confirmed by diff scope and grant probes.

**Remaining items before merge / before the day-one gate can pass:**

1. Fix B1 so the suite is reproducibly green off-CI (test-only, one-line realpath).
2. Refresh the branch onto current `V5.1` (B2) and merge keeping V5.1's `packages/services/accounts.js`.
3. Wire the capture gate into the V5 release checklist as a fail-closed required check (B3).
4. Main-owned, unchanged by this review: real isolated-staging migration with the managed owner, credential provisioning for the three `NOLOGIN` roles, scheduler/alerting installation, staging two-actor cohort + Redis-outage + PG-restart + backup-restore drills, real retention/latency/storage measurement, the human privacy/purpose/retention authorization, and the signed day-one receipt. **No training, model promotion or Impossible enablement is authorized by this review.**

*Review only — PR #12 was not merged or deployed.*
