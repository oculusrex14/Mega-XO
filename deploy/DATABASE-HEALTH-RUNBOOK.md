# V4.1 database growth and maintenance runbook

Mega XO V4.1 intentionally launches with one SQLite coordinator. The repository now measures database, WAL and serialized aggregate growth rather than assuming that design will remain cheap forever.

## Private telemetry

The loopback operator status includes a storage object with:

- main database, WAL and SHM bytes;
- SQLite page size, page count and freelist pages;
- logical/free bytes;
- serialized aggregate state bytes;
- idempotency command row count;
- growth warning names.

Default warning thresholds are:

- MEGA_DB_WARN_BYTES=1073741824
- MEGA_WAL_WARN_BYTES=134217728
- MEGA_STATE_WARN_BYTES=67108864

These are warning thresholds, not corruption limits. Tune them only from measured staging/VPS evidence.

## Daily integrity check

Production monitoring installs a daily read-only check using:

    node scripts/db-maintenance.js check

It runs SQLite quick_check and foreign_key_check and stores only the sanitized result in the deployment monitoring directory. The five-minute health monitor treats a missing, failed or stale daily integrity result as an operational alert.

## Safe maintenance commands

Status and integrity checking are read-only:

    node scripts/db-maintenance.js status
    node scripts/db-maintenance.js check

Checkpoint and optimize are intentionally guarded. First enter maintenance and confirm there is no active match or room work. Then run:

    node scripts/db-maintenance.js checkpoint --confirm-maintenance
    node scripts/db-maintenance.js optimize --confirm-maintenance

The commands refuse to run unless v4_controls has maintenance=1 and the authority/party tables report no OFFERED, PLAYING, LOBBY, RUNNING or PAUSED work.

checkpoint uses WAL TRUNCATE only during this guarded maintenance window. optimize uses SQLite PRAGMA optimize; it does not VACUUM or rewrite the database.

Always take and verify an off-box backup before planned database maintenance.

## Synthetic growth benchmark

Run on disposable state only:

    MEGA_GROWTH_ACCOUNTS=250 \
    MEGA_GROWTH_HISTORY=200 \
    node scripts/db-growth-smoke.js

Increase history depth on the Oracle ARM host to model months of retained match history. The report records aggregate JSON size, serialization time, authoritative read/parse time, write time, quick_check time and database/WAL telemetry.

Do not point this benchmark at a live database.

## Escalation trigger

A normalization or multi-store rewrite is not a launch prerequisite by itself. Revisit architecture when measured evidence shows one or more of:

- aggregate state consistently approaches the configured warning threshold;
- authoritative read/parse p95 becomes material to request latency;
- WAL repeatedly grows past its warning threshold under healthy traffic;
- checkpoints cannot complete inside a planned maintenance window;
- backup/restore duration breaches the recovery objective;
- Oracle capacity tests show serialization, not CPU/network, is the primary bottleneck.

Record the actual evidence before changing the storage architecture.
