# Backup / Restore Evidence

**Status: NOT launch-ready.** Two verified defects stand between the current state and a defensible recovery claim; both are Main-lane with the evidence recorded in MASTER-FINDINGS.csv.

## What IS verified

- P15 real encrypted copy to a second isolated PostgreSQL 16 (CI green on the audit head: job 117336167384 lineage, run 39012267045) — the encryption/restore mechanics work in isolation.
- PostgreSQL 16 schema and runtime guards (CI lane green on the audit head).
- Writer-fence negative tests green (Pure cutover state, writer-fence and negative tests) — no legacy SQLite writer can become a competing authority.

## Verified defects blocking the claim

1. **MXA-INF-001 (P0)** — the deploy rollback path strips the host-managed launcher and node_modules from the archived tree; an unhealthy rollback restores an unstartable runtime. Fix + proven rehearsal required (release/ROLLBACK-PLAN.md). No rehearsal was run this audit.
2. **MXA-INF-002 (P0)** — production-named retention services on the VPS execute the STAGING capture-job.sh; production retention is not evidenced and a misbound job could sweep the wrong authority (LR18 P0, still open).
3. **MXA-INF-003 (P1)** — the live R2 helper lacks pagination; freshness reporting is understated (~116,098s vs the 900s RPO target), so backup freshness cannot be certified from the current helper output.
4. **MXA-INF-010 (P2)** — the exact-release production-backup restore, safe-prune rehearsal and storage-policy/alert-delivery verification have not been executed.

## Required before the recovery claim is defensible

1. Rebind production retention units to the production authority (non-destructive, reviewed) — Main lane, owner-visible.
2. Fix the deploy rollback (complete archive) and run the unhealthy-restore rehearsal in isolation with recorded commands/hashes.
3. Run one exact-release backup restore + safe-prune rehearsal; record artifacts under evidence/.
4. Fix the R2 listing pagination so freshness is reported from complete data.

Per the owner rules the Codex lane performed read-only live checks only; every production mutation above belongs to Main with owner visibility.
