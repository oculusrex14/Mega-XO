# DC00 on the staging host: journal defect fixed, retention scheduled (2026-10-14)

Executed by Main on the Oracle staging host (`/opt/mega-xo-v51-staging`). All output is real command
output; no secret, URL or password appears here.

## The defect, and why it mattered

`mega-xo-v51-capture-maintenance.service` runs every ~15 minutes and logs one JSON line per mode.
Every mode except one succeeded: `reconcile`, `metrics`, `erase`, `purge-exports`, `worker`. The
`journal` mode **failed on every run** with the uninformative `CAPTURE_COMMAND_FAILED`.

Root cause (read from the code, then reproduced): `packages/learning/privacy.js::exportPrivacyJournal`
publishes through `createWriter`, which uses an atomic **no-replace** `link()` so that "a repeated run
can never overwrite an old export", and its own comment says *the caller retries a new immutable
filename*. But the deployed job set a single fixed `CAPTURE_JOURNAL_FILE`, which existed after the
first run. After that, `link()` threw `EEXIST` forever, and the CLI's catch-all masked it.

This was not cosmetic. The V5 backup sweep refuses to prune backups while the privacy journal is
stale — that is the mechanism stopping a restored backup from resurrecting withdrawn research records.
With the journal never refreshing, `journalObligation` could never become `CURRENT`, so 35-day backup
pruning could never be enabled.

## The fix (ConsentRetention's design, reviewed and deployed by Main)

`CAPTURE_JOURNAL_FILE` is now a **base path**; the published file is
`<base minus .mxojournal>-YYYYMMDDTHHMMSSZ.mxojournal`. UTC and lexicographically sortable, so the
newest journal is the last name; previous journals are never overwritten or deleted. A rerun within
the same second still fails closed, now with the `CAPTURE_`-prefixed `CAPTURE_JOURNAL_TARGET_EXISTS`.
`restore-journal` is unchanged and still takes an exact path.

## Proof on the real host, through the shipped job

Two consecutive runs of the **deployed** `capture-job.sh journal` (after applying migration 0052 to
the staging database, which added `learning.record_journal_watermark`):

```
{"records":1,"plainSha256":"9222ebe4…","cipherSha256":"2b0930e8…","bytes":373,"epoch":0,
 "suppressions":0,"erasures":0,
 "file":"/opt/mega-xo-v51-staging/capture-dc00/privacy-journal-20261014T164308Z.mxojournal",
 "watermark":"3"}
```

and in the same window, the whole maintenance chain with **no failing mode**:

| mode | result |
| --- | --- |
| `reconcile` | `{"scanned":15,"repaired":0}` |
| `metrics` | `{"sealed":15,"pending":0,"quarantined":0,"expiredUnpurged":0,"oldestPendingSeconds":0}` |
| `worker` | `{"disabled":false,"claimed":0,"sealed":0,"errors":{}}` |
| `erase` | `{"erased":0}` |
| `purge-exports` | `{"purged":0}` |
| **`journal`** | **`{"records":1,…,"watermark":"4"}` — previously always `CAPTURE_COMMAND_FAILED`** |

The watermark advanced 1 → 2 → 3 → 4 across consecutive runs. Six journal files coexist; none was
deleted. The original fixed-path `privacy-journal.mxojournal` was kept untouched.

## Retention now actually scheduled and exercised

Four weekly systemd timers were installed, one per schedule, each a bounded one-shot in the
least-privilege `capture_privacy` lane:

```
mega-xo-v52-retention@captures.timer   Mon 04:26 UTC (RandomizedDelaySec 600, Persistent)
mega-xo-v52-retention@exports.timer    Mon 04:21 UTC
mega-xo-v52-retention@spool.timer      Mon 04:22 UTC
mega-xo-v52-retention@backups.timer    Mon 04:24 UTC
```

Each was started by hand and each succeeded:

| sweep | real output |
| --- | --- |
| `captures` | `{"kind":"captures","windowDays":730,"erased":0}` |
| `exports` | `{"kind":"exports","windowDays":90,"runsClosed":0}` |
| `spool` | `{"kind":"spool","windowDays":7,"purged":0}` |
| `backups` | `{"kind":"backups","windowDays":35,"pruneReady":false,"pruneAllowed":false,"journalEpoch":0,"liveEpoch":0,"journalObligation":"CURRENT","watermarksPruned":0}` |

`journalObligation: "CURRENT"` is the outcome the journal fix bought. `pruneReady:false` /
`pruneAllowed:false` is the system correctly refusing to prune backups before pruning itself has
been validated — the sweep reports rather than acts when it is not yet safe.

Two host-side changes were needed and are recorded for audit:
1. `capture-job.sh`'s role map did not know the new modes and refused them with
   `CAPTURE_EXACT_ROLE_REQUIRED`; `erase|suppress|journal|restore-journal` was extended with
   `retention|withdraw` (both `capture_privacy`). The original script is backed up at
   `/opt/mega-xo-v51-staging/capture-backup-20261014/capture-job.sh`, along with the six replaced
   repo files.
2. A first timer draft used a service-template name that did not match the timer template, so
   systemd refused to load it ("service to trigger not loaded"); it was replaced with a matching
   `@.service` / `@.timer` pair.

## What is real here vs still open

Real: the journal export succeeds repeatedly on the production-grade staging host; the retention
jobs are scheduled and have each executed; the backup sweep now sees a current journal obligation.

Still open, and not claimed: **production** capture is not enabled (these units are the staging
ones); the production database now has migration 0052 applied but no systemd unit there calls
`retention`; nothing has been cut over; the V5.1-era unit and directory names are retained on the host
for continuity rather than renamed. Also, `withdraw` was exercised by the agent against a lab, not
yet against this host.

## Update — the gate now passes live on staging

After the bundle deploy and the policy corrections, the real shipped CLI run on the staging host
returns:

```json
{"gate":"day-one-gameplay-capture/v1","result":"RECEIPTS_READY_FOR_MAIN_REVIEW",
 "sourceCommit":"320bb6900d6d4d3ce612de30acdd4da27a6811f0",
 "rulesHash":"e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0",
 "failures":[],"productionAuthorized":false,"trainingAuthorized":false}
```

with `configuration()` reporting `enabled:true, environment:staging, privacyEpoch:0,
policyVersion:mxv5-capture-2026Q4-stage2` and `metrics()` reporting `sealed:15, pending:0,
quarantined:0, expiredUnpurged:0, excluded:0, suppressed:0`.

Two real policy defects were fixed to get here, both found by the gate refusing rather than by
inspection:

| Defect | Before | After | Why |
| --- | --- | --- | --- |
| `source_commit` named a historical commit | `3e51ba0c…` | `320bb69…` | The field means "the commit the origin serves"; after the V5.2 bundle deploy it no longer did. The gate refused with `DEPLOYED_POLICY_SOURCE_MISMATCH`. |
| Retention windows disagreed with the approved schedule | `retention_days 90`, `export_retention_days 30` | `730`, `90` | Migration 0052 declares 730 days for consented adult gameplay and 90 for working research exports. The deployed policy contradicted the schedule the migration itself writes. The 35-day backup window was already right. |

`privacy_epoch` stays **0** deliberately: nothing has been withdrawn, so raising it would be a false
claim. The change was applied through the migration role; `capture_runtime` correctly refused with
`permission denied for table policy`, which is the least-privilege split working.
