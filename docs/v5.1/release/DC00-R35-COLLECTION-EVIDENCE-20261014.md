# DC00 / R35 — day-one gameplay collection: staging canary evidence, 2026-10-14

**Scope.** Make the merged DC00–DC12 gameplay-capture collector, its policy, its operational controls
and its release gate **real and evidence-backed** on the isolated staging environment, under the
owner's 2026-10-14 day-one collection authorization. **No model was trained or promoted. No V4 write
occurred. Production was not enabled. No legal approval was invented.**

**Result in one line.** Collection is **enabled on staging only**, 15 real terminal matches were
reconciled, sealed and independently re-validated with zero missing eligible games and an empty
backlog; the supervised schedules, rollback and every chaos control ran for real; the receipt carries
**13 of 15** evidence categories, and the real gate returns
`BLOCKED` on exactly the two categories that are outside this operator's authority
(`MISSING_privacyPurpose`, `MISSING_retention`).

---

## 1. What is enabled where

| Target | State | Evidence |
| --- | --- | --- |
| Isolated staging Neon `lively-shadow-52629967` / `mega_xo_v5_staging` | `learning.policy.enabled=true`, `environment='staging'`; collection, retention sweep, export purge and journal scheduled | §2, §3 |
| Staging origin `https://command.tail95c48c.ts.net` | `p21-staging-server.cjs` PID 2441819, deployed source commit `3e51ba0c95d1083fe89e7c6f909e7590cee1a600`, unchanged by this work | `/opt/mega-xo-v51-staging/deploy-receipt.json` (`backend_source_unchanged: true`) |
| Disposable lab (owned loopback PG16) | Used for the destructive controls; **torn down** at the end of each run | §5 |
| **Production** `blue-sun-85454968` / `mega_xo_v5_production` | **NOT TOUCHED.** No policy row written, no capture function invoked | — |

The deployed staging bytes are **identical** to local `HEAD` for every capture file: `git diff
3e51ba0c… HEAD -- packages/learning scripts/gameplay-capture.cjs src/game.js packages/migrations` is
empty except for `0050`/`0051` and the manifest, which were added by later commits. Confirmed by
matching `sha256` on every file against `/opt/mega-xo-v51-staging/repo`. (The deployed tree is an
rsync, not a git checkout, so identity was proven by digest — and by the run itself, below.)

**Source commit choice.** `learning.policy.source_commit` is
`3e51ba0c95d1083fe89e7c6f909e7590cee1a600`, the commit the staging origin actually serves. That
commit already contains migrations `0044`–`0049` byte-identical to `HEAD`, so `rules_hash`
(`sha256(src/game.js)` = `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`) matches
both the running origin and local `HEAD`.

---

## 1b. Exact staging state at hand-off

| Fact | Value |
| --- | --- |
| `learning.policy` | `enabled=true`, `policy_version=mxv5-capture-2026Q4-stage1`, `source_commit=3e51ba0c…`, `rules_hash=e6e14c25…`, `environment=staging`, `capture_after=2026-10-08T00:00:00Z`, `privacy_epoch=0` |
| `learning.captures` | 15 rows, all `state='sealed'` |
| `learning.capture_subjects` | 30 rows |
| `learning.export_runs` | 1 row, `state='revoked'` (revoked on purpose), 0 `export_members` |
| `learning.rejections` / `erasure_tombstones` / `suppressions` | 0 / 0 / 0 |
| `learning.metrics()` | `pending 0, quarantined 0, expiredUnpurged 0, sealed 15` |
| Supervised units | `mega-xo-v51-capture-worker.timer` and `mega-xo-v51-capture-maintenance.timer`, both `enabled`; the worker timer has been observed firing autonomously every 2 min |
| Migrations | ledger at 49 applied / max 49; this work added none |

Because `privacy_epoch` is still 0, an export may be created again on request; nothing in this
hand-off depends on a live export.

---

## 2. The real staging canary

Driver: `.artifacts/dc00/staging-canary.cjs` (operator artifact, gitignored). It drives the
**shipped** `scripts/gameplay-capture.cjs` one-shot CLI against real staging through the exact-role
connection lane (`CAPTURE_ENV=staging`, `CAPTURE_TARGET_FILE=docs/v5/environments/staging.json`,
pinned CA, `CAPTURE_POOL_MAX=2`).

### 2a. Baseline and the reconciler

Collection was enabled **after** the staging terminal matches had already finalised, so their
deferred trigger could not have fired for them. The collector's own reconciler is what registered
them, which is a stronger check than a fresh trigger firing:

```
before:        eligible terminal = 15, capture rows = 0, capture outbox rows = 0
reconcile  ->  {"scanned":15,"repaired":15}   captures 15, outbox 15
```

### 2b. Worker drain (shipped one-shot `worker`, exact-role lane)

```
tick 1  -> {"claimed":8,"sealed":8,"quarantined":0,"excluded":0,"retry":0,"errors":{}}
tick 2  -> {"claimed":7,"sealed":7,"quarantined":0,"excluded":0,"retry":0,"errors":{}}
tick 3  -> {"claimed":0,...}
metrics -> {"purged":0,"sealed":15,"pending":0,"excluded":0,"suppressed":0,
            "quarantined":0,"expiredUnpurged":0,"oldestPendingSeconds":0}
```

### 2c. `zeroMissingEligible`, computed by SQL rather than asserted

```
eligible terminal              = 15
captures joined to those sources = 15
missing                        = 0
state histogram                = [{"state":"sealed","n":15}]
```

### 2d. Independent re-validation of every sealed archive

`.artifacts/dc00/staging-controls.cjs` re-reads all 15 sealed payloads and re-derives everything
without the worker:

- `validate(payload, payload_sha256)` → `allValid: true` for 15/15;
- `source.revision` equals the live `match.matches.revision` for 15/15;
- `game.reason` equals the live `receipt_reason` for 15/15;
- the stored `source_token` equals a freshly recomputed `sha256(learning.source(capture_id))` for
  15/15 — i.e. each archive is still cryptographically bound to its live source row.

Sample: capture `0d553f1d…c8396c6` ← source `queue:9125c983-…12593f`, 50 plies, boardWinner `O`,
payloadSha256 `5b7b4c63…fef5cd66c`, provenance `{environment: staging, population: test-fixture,
verification: server-authoritative}`.

**Population is honestly `test-fixture`, not `human-v-human`.** Staging actors carry no
classification; the exporter refuses them, so the staging archive contains **0 games** (15
population-excluded). That is the correct fail-closed behaviour, not an omission, and it is why the
record-level export path is evidenced on the lab instead.

### 2e. Encrypted archive, export revocation and purge (real staging)

```
export        -> runId b2ef8e0a-efbd-4dc0-a12f-40c42b17f40e, 616 B,
                 plainSha256 4329b283…0af117fa, cipherSha256 e89cd9b2…e2ac217a2,
                 manifest scanned 15 / excludedPopulation 15
readBack      -> records 1 (manifest), ok true
revoke_export -> state "revoked"
purge-exports -> {"purged":1}; file gone (fileExistsAfterPurge false)
purge again   -> {"purged":0}   (idempotent)
journal       -> records 1, epoch 0, cipherSha256 1beb2b6b…3d23b19f3bb, verifyFile true
```

### 2f. Chaos, then restore to clean (real staging)

`.artifacts/dc00/staging-chaos.cjs`:

| Control | Real result |
| --- | --- |
| Source drift on an already-sealed capture (`UPDATE match.matches SET revision=revision+1`) | audited `reconcile` → capture `quarantined`, rejection `CAPTURE_SOURCE_DRIFT` ×1, `sealed 14 / quarantined 1`, and the quarantine **revoked the open export** (1 run invalidated) |
| Repair and resume (documented operator path) | revision restored, the terminal quarantine row retired with its rejection/subjects/outbox rows, `reconcile` → `repaired 1` → row back to `pending` → worker `sealed 1` → metrics clean |
| Abandoned lease (`claim('dc00-abandoned-worker',1,1500)`) | lease live immediately after claim = `true`, after 1.8 s = `false`; shipped `worker` reclaimed it → `{"claimed":1,"sealed":1}`, row `sealed`, exactly 1 row for that capture id |
| Final state | `eligible 15, sealed-for-eligible 15, missing 0, rejections 0`, histogram `[{"state":"sealed","n":15}]`, `pending/quarantined/expiredUnpurged = 0` |

**Truthfulness note.** Two earlier chaos attempts died on foreign-key ordering and left 2 poisoned
rows behind. Those rows, their sources already restored, were retired in a recorded pre-clean step
(`steps.precLean`) and rebuilt by the reconciler. The quarantine audit trail is cited, not erased:
the quarantine and its rejection record really happened and are in the same report.

### 2g. Rollback drill (real staging)

`.artifacts/dc00/staging-rollback.cjs` against the LIVE policy:

```
disable  -> worker {"disabled":true,"claimed":0,...} (all claim/seal counters zero because it
            short-circuits before claiming);
            learning.metrics() still reports the retained truth: sealed 15, pending 0, quarantined 0;
            reconcile -> CAPTURE_DISABLED (exit 1); direct learning.claim(...) -> 0 rows
            retained data untouched: captures 15 -> 15, subjects 30 -> 30, tombstones 0 -> 0
re-enable-> {"enabled":true, policy_version mxv5-capture-2026Q4-stage1, e 0, captures 15, sealed 15};
            worker {"disabled":false,"claimed":0}; metrics sealed 15, pending 0, quarantined 0
```

(Note on precision: `learning.metrics()` is a plain count over `learning.captures` and therefore keeps
reporting the retained rows while disabled — it is not zeroed by a disable, and the receipt quotes it
verbatim. What a disable removes is every *write* path: claims, seals, reconciles and exports.)

---

## 3. Operational controls: on the host and on schedule

Installed on `command` (root, 0600, outside Git):

| Unit | Cadence | Runs |
| --- | --- | --- |
| `mega-xo-v51-capture-worker.timer` → `mega-xo-v51-capture@worker.service` | 2 min, `Persistent=true` | `/opt/mega-xo-v51-staging/bin/capture-job.sh worker` |
| `mega-xo-v51-capture-maintenance.timer` → `mega-xo-v51-capture-maintenance.service` | 15 min | `reconcile, metrics, worker, erase, purge-exports, journal, metrics` in that order |

`capture-job.sh` re-resolves the role-appropriate direct URL from `capture-roles.json` (0600) per
mode, pins `CAPTURE_ENV=staging`, the staging target inventory and the CA, and `exec`s the shipped
one-shot CLI. Real systemd runs:

```
mega-xo-v51-capture@worker.service:      Result=success ExecMainStatus=0
  {"disabled":false,"claimed":0,"sealed":0,"quarantined":0,"suppressed":0,"excluded":0,"retry":0,"stale":0,"errors":{}}
mega-xo-v51-capture-maintenance.service: Result=success ExecMainStatus=0
  {"at":"2026-10-14T02:22:49Z","mode":"reconcile","result":{"scanned":15,"repaired":0}}
  {"at":"...","mode":"metrics","result":{"purged":0,"sealed":15,"pending":0,"excluded":0,"suppressed":0,"quarantined":0,"expiredUnpurged":0,"oldestPendingSeconds":0}}
  {"at":"...","mode":"worker","result":{"disabled":false,"claimed":0,...}}
  {"at":"...","mode":"erase","result":{"erased":0}}
  {"at":"...","mode":"purge-exports","result":{"purged":0}}
  {"at":"...","mode":"journal","result":{"records":1,"epoch":0,"suppressions":0,"erasures":0,"cipherSha256":"62481e95…"}}
```

Both timers are `enabled`. The **worker** timer was observed to fire **on its own** on cadence at
02:24:51, 02:26:55 and 02:29:09 UTC (each run reporting `{"disabled":false,"claimed":0,...}` —
nothing pending, backlog already clean), which is supervision by the host's own scheduler rather
than a manual invocation loop. The maintenance chain was last observed on activation plus one
explicit run; its first independently-timed fire is due at 02:38 UTC and is not claimed here.

**One deliberate non-action.** `suppress` was **not** called on staging. The shipped CLI requires a
`user-choice`/`account-deletion` reason, and writing that reason for a synthetic staging actor who
never made such a choice would plant a **false privacy fact** in the durable ledger. The suppression
and erasure path is instead demonstrated on the lab, where a genuinely authenticated deletion exists
(§5). This is a refusal, not a gap in the implementation.

---

## 4. Disposable-lab controls

Driver: `.artifacts/dc00/lab-controls.cjs`, run on an owned loopback PG16 cluster created by the
process (real checksummed chain `0001`–`0051`, real Core service). Lab-only population classification
is written **solely** so the export selector has a candidate; it never touches staging or production.

| Control | Real result |
| --- | --- |
| Disabled by default | `worker {"disabled":true,"claimed":0}`; metrics all zero |
| Real games drained | 6 intents → `claimed 6 / sealed 5 / excluded 1` (the never-started void is an explicit exclusion, not a fabricated game) → `pending 0` |
| **Authenticated deletion** | `accounts.deleteAccount(token, tag)` → `privacy.requests(kind=deletion, state=requested)` → trigger → `learning.suppress(actor,'account-deletion')`; epoch `0→1`; the participant's already-sealed capture `sealed → suppressed` with `payload IS NULL` and `capture_subjects → 0`; the scheduled sweep then reported `{"erased":1}` |
| Export lineage | `export` wrote run `b501f860…`, 115 records / 2 games / 112 positions, cipherSha256 `c382f326…`; the offline reader authenticated all 115 records (`ok true`, no time leak). A first attempt with a **stale** epoch was refused with `CAPTURE_EXPORT_PRIVACY_FENCE`, and after revocation the reader refused with `CAPTURE_EXPORT_REVOKED` |
| Export purge | `revoke_export` → `revoked`; `purge-exports` → `{"purged":1}`; file gone |
| **Restore journal** | Encrypted journal at epoch 2 (records 3, suppressions 1, erasures 1, cipherSha256 `92fb6675…`) replayed by `restore-journal` into a **second** database with `CAPTURE_ISOLATED_RESTORE=1` and the digest pinned: `{"sourceEpoch":2,"targetEpoch":2,"entries":2,"enabled":false}` — the suppression and the erasure tombstone were re-applied and the target was left collection-disabled |
| **Postgres restart** | `pg_ctl -m fast restart` under a live backlog: `8 captures / 1 pending` before, `8 / 1 / 5 sealed` after, connection healthy; the shipped worker then reclaimed and sealed the survivor (`{"claimed":1,"sealed":1}`) → `pending 0`. Nothing lost, nothing duplicated |
| **Redis loss equivalent** | Real Core games settled with **no `ephemera` adapter at all** (`publishMatchHint` → `{published:false,available:false,conservative:true}`): the durable intent appeared anyway (`pending 0→1`) because it is written by the deferred Postgres trigger inside the settlement transaction, and the worker sealed it |
| Final state | `sealed 33, pending 0, excluded 1, suppressed 1, quarantined 0, expiredUnpurged 0`; `missingEligible 0` (counting sealed/excluded/suppressed **and** erasure-tombstoned identities); `erasedTombstones 1` |

> An earlier version of the missing-capture check counted a *suppressed* row as missing because
> erasure deliberately drops the `source_id` reverse link. The check was corrected to resolve the
> deterministic capture id and consult the tombstone table — the raw wrong number is recorded in the
> run's history because it was reported before the fix.

### Latency and quota — bounded, and scoped honestly

Paired measurement over **24 real Core games + 2 warmup**, toggling `learning.policy.enabled` per
game (the capture cost lands on the deferred settlement trigger):

| | ON | OFF | Δ |
| --- | --- | --- | --- |
| move p50 / p95 (ms) | 17.56 / 20.77 | 17.68 / 19.48 | −0.13 / +1.29 |
| settlement p50 / p95 (ms) | 18.19 / 20.12 | 18.12 / 19.07 | +0.07 / +1.05 |

Across repeated runs every delta **flips sign**. The honest reading is *inside loopback noise at
this sample size*. Quota inputs from real sealed payloads: raw 1419 / 1421 / 5493 bytes and gzip
594 / 598 / 1200 bytes (min / p50 / max) per game.

**Scope limit.** Laptop loopback with a warm local PG16. A 0.25-CU Neon staging path and a real
player cohort are **not** represented. No staging latency SLA and no alert threshold is claimed.

---

## 5. The receipt and the real gate run

Builder: `.artifacts/dc00/build-receipt.cjs`. It **derives every quoted number** from the recorded
evidence JSONs, refuses to emit `PASS` when the underlying run did not happen, and asserts each
artifact is inside the gate's 1000-character budget. Receipt:
`.artifacts/dc00/release-receipt.staging.json`, bound to `sourceCommit
3e51ba0c…`, `rulesHash e6e14c25…`, `policyVersion mxv5-capture-2026Q4-stage1`, `environment staging`,
`privacyEpoch 0`.

Command (exactly as the shipped CLI documents it):

```
CAPTURE_PG_URL='postgresql://capture_runtime:…@<direct-staging-host>/mega_xo_v5_staging?sslmode=verify-full' \
CAPTURE_ENV=staging CAPTURE_TARGET_FILE=docs/v5/environments/staging.json \
CAPTURE_PG_ROOTCERT=<ca.pem> CAPTURE_POOL_MAX=2 \
CAPTURE_RELEASE_RECEIPT=.artifacts/dc00/release-receipt.staging.json \
CAPTURE_SOURCE_COMMIT=3e51ba0c95d1083fe89e7c6f909e7590cee1a600 \
  node scripts/gameplay-capture.cjs gate
```

**Verbatim output (exit code 2):**

```
{"gate":"day-one-gameplay-capture/v1","result":"BLOCKED","sourceCommit":"3e51ba0c95d1083fe89e7c6f909e7590cee1a600","rulesHash":"e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0","failures":["MISSING_privacyPurpose","MISSING_retention"],"productionAuthorized":false,"trainingAuthorized":false}
```

### Positive control (clearly labelled, not evidence)

To prove the other thirteen categories are individually sufficient and that the gate is not simply
rejecting everything, the **same** configuration was run with a receipt whose only difference is two
explicitly-labelled placeholders. Verbatim output (exit 0):

```
{"gate":"day-one-gameplay-capture/v1","result":"RECEIPTS_READY_FOR_MAIN_REVIEW","sourceCommit":"3e51ba0c95d1083fe89e7c6f909e7590cee1a600","rulesHash":"e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0","failures":[],"productionAuthorized":false,"trainingAuthorized":false}
```

The control receipt (`release-receipt.staging.control.json`) states in its own `note` and in each
placeholder artifact that it is **not** an approval and must never be cited as one. It is retained
only so a reviewer can distinguish "the gate is satisfied" from "the gate is blocked on authority".

---

## 6. Demonstrated · missing · formal sign-off

### Demonstrated (13 categories, each on a real run)

`encryptedStorage`, `userChoiceDelivery`, `workerScheduler`, `reconcilerScheduler`, `deletionSweep`,
`exportPurge`, `restoreJournal`, `postgresRestart`, `redisLoss`, `latencyAndQuota`, `stagingReplay`,
`zeroMissingEligible`, `rollback`.

### Missing evidence (2 categories) — no receipt is filed for these

| Key | Why it is absent |
| --- | --- |
| `privacyPurpose` | The purpose is **derived and recorded** (`docs/v5.1/data/DC00-COLLECTION-POLICY-20261014.md`) and the owner authorization is in `approval_ref`, but no privacy-controller sign-off exists. Left out rather than asserted. |
| `retention` | The windows are configured **and enforced** (90/30/35 days, `capture_after` 2026-10-08) and the backup window matches the existing Restic prune set, but the numbers themselves are unapproved. Left out rather than asserted. |

### Formal sign-off still owed

1. Purpose/lawful basis for capturing gameplay; the public-policy notice naming this use; a
   **capture-specific opt-out control** in the clients (none exists today).
2. Retention approval for capture/export/backup, plus a V5 prune schedule that implements it.
3. Processor register / region entry for this private store and its keys; key rotation/expiry and
   off-host custody with separation of duties.
4. Apple App Privacy and Google Play Data-safety answers for this data class.
5. Anything production: a green gate returns `productionAuthorized:false` /
   `trainingAuthorized:false` and requires a separate human go/no-go.

### Places where a claim was deliberately refused

- **Staging `suppress` was not called** — it would have recorded a false user choice.
- **No population was labelled "human"** on staging; the staging archive is honestly empty of games.
- **No alert threshold or staging latency SLA is claimed** from the loopback measurement.
- **No backup-window approval is claimed**; the Restic evidence is what the repo already implements.
- **No production policy row was written and no V4 data was touched.**
- **`0050`/`0051` and the manifest changes** visible in `git diff 3e51ba0c…HEAD` are other agents'
  work, not this ticket's.

---

## 7. Reproduce

```sh
# 1. write the derived policy (refuses any non-staging inventory; prints before/after)
MIGRATION_TARGET_URL='postgresql://migration_owner:…@<direct-staging-host>/mega_xo_v5_staging' \
  node .artifacts/dc00/enable-policy.cjs            # dry run
MIGRATION_TARGET_URL='…' node .artifacts/dc00/enable-policy.cjs --apply

# 2. canary + export + journal on staging (shipped CLI, exact-role lane)
node .artifacts/dc00/staging-canary.cjs .artifacts/dc00/staging-canary-clean.json clean

# 3. independent re-validation + idempotent sweeps
node .artifacts/dc00/staging-controls.cjs .artifacts/dc00/staging-controls.json

# 4. chaos (drift, repair-and-resume, abandoned lease) and rollback
node .artifacts/dc00/staging-chaos.cjs   .artifacts/dc00/staging-chaos.json
node .artifacts/dc00/staging-rollback.cjs .artifacts/dc00/staging-rollback.json

# 5. operational controls on the owned PG16 lab (destructive; loopback only)
V5_PG_DISPOSABLE=1 node .artifacts/dc00/lab-controls.cjs .artifacts/dc00/lab-controls.json

# 6. receipt (derived, never transcribed) and the real gate
node .artifacts/dc00/build-receipt.cjs
CAPTURE_ENV=staging CAPTURE_TARGET_FILE=docs/v5/environments/staging.json \
CAPTURE_PG_ROOTCERT=<ca.pem> CAPTURE_POOL_MAX=2 \
CAPTURE_RELEASE_RECEIPT=.artifacts/dc00/release-receipt.staging.json \
CAPTURE_SOURCE_COMMIT=3e51ba0c95d1083fe89e7c6f909e7590cee1a600 \
CAPTURE_PG_URL='postgresql://capture_runtime:…@<direct>/mega_xo_v5_staging?sslmode=verify-full' \
  node scripts/gameplay-capture.cjs gate

# rollback of the staging policy at any time
MIGRATION_TARGET_URL='…' node .artifacts/dc00/enable-policy.cjs --disable
```

## 8. Files

- `docs/v5.1/data/DC00-COLLECTION-POLICY-20261014.md` — derived collection policy, its citations,
  the exact `learning.policy` values, and what remains sign-off.
- `docs/v5.1/release/DC00-R35-COLLECTION-EVIDENCE-20261014.md` — this report.
- `.artifacts/dc00/*` — the drivers and the recorded evidence
  (`staging-canary-clean.json`, `staging-controls.json`, `staging-chaos.json`,
  `staging-rollback.json`, `lab-controls.json`, `release-receipt.staging.json`,
  `release-receipt.staging.control.json`, `gate-staging-blocked.txt`, `gate-staging-control.txt`).
- Nothing under `packages/learning/` or `scripts/gameplay-capture.cjs` was modified: no defect
  required a fix.
