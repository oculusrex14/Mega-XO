# V5 post-cutover incident, rollback and forward-recovery runbook (2026-10-14)

Actionable procedures for the V5 production authority. Everything here is written from mechanisms
this session actually exercised; each step names the real command or artifact.

**The governing rule:** before the **first V5 application write** a fenced, fully validated V4
rollback is permitted. **After** that write the stale SQLite writer must never be restarted and users
must never be moved backward into its data — use PostgreSQL forward-fix/PITR instead.

## 0. Establish which side of the boundary you are on

| Question | How to answer |
| --- | --- |
| Has the first V5 write happened? | `SELECT * FROM meta.authority_epoch` (or the recorded epoch receipt) — if no epoch row exists, you are pre-write |
| Is V4 still writing? | the app container on `command`: `docker inspect -f '{{.State.Running}}' mega-xo-production-app-1`; if it is running and mounted read-write, V4 is still the writer |
| Which database is production? | `docs/v5/environments/production.json` → project `blue-sun-85454968`, db `mega_xo_v5_production`; `nonserving` must be `false` only after cutover |

If V4 is still the writer, **E4 is not complete**; stop and finish the fence
(`docs/v5.1/release/E4-V4-WRITE-FENCE-INVENTORY-20261014.md`) before any forward work.

## 1. Pre-write failure (rollback path)

Symptom: cutover rehearsed, V5 started, but a mandatory gate fails before the first write is accepted.

1. **Stop V5 writers** so no write can be accepted:
   stop the V5 API/Core/worker processes.
2. **Verify V4 is intact and resumable**: the app container is stopped but the authority is untouched.
   Confirm the SQLite file hash equals the frozen pre-cutover snapshot
   (`~/Downloads/Mega-XO-private-evidence/v4-e1/mega.sqlite`,
   sha256 `c77632f02cd13a49be13ec6a86332e474aa78effec611f30bc9087ad9ce72554`).
3. **Restart the V4 writer** (the single `mega-xo-production-app-1`) and confirm
   `play.antimatterinnovations.com/livez` and `/opsz` are 200.
4. **Record the aborted epoch** in the release ledger with the exact reason; do not delete the V5
   artifacts — they are still the candidate.

## 2. Post-write data incident (forward recovery — never roll back)

Symptom: after the first V5 write, data is wrong/corrupted (bad import row, runaway command, operator
mistake).

**Never** restart the stale SQLite writer. Recover forward on PostgreSQL:

### 2a. Point-in-time recovery (Neon, 6-hour window)

The production project's history retention is **6 hours** (verified). Create a recovery branch at a
timestamp *before* the bad write and inspect it first:

```sh
neon branches create --project-id blue-sun-85454968 --name v5-recovery-<utc> --parent <ISO-8601-UTC>
neon connection-string v5-recovery-<utc> --project-id blue-sun-85454968 \
  --role-name migration_owner --database-name mega_xo_v5_production
```

Query the branch, confirm the row/ledger state, then either copy the affected rows forward or promote
the branch. Delete the drill branch when finished. Evidence shape:
`docs/v5.1/release/NEON-PITR-VERIFIED-20261014.md`.

### 2b. Logical-backup restore (the archival path)

Use the sealed archives in the V5-only R2 bucket (`mega-xo-v5-dr-archives`,
prefix `megaxo/v5/pg16-encrypted/v1/`). The full procedure is
`docs/v5.1/release/P15-PRODUCTION-RESTORE-PROCEDURE-20261014.md`; the proven result is
`docs/v5.1/release/P15-DR-RESTORE-PROVEN-20261014.md`.

Sequence: independent reader retrieve → verify the manifest sha256 → authenticated decrypt with the
**off-host** recovery private key → schema from the immutable migration chain → `pg_restore
--data-only --disable-triggers --single-transaction`.

### 2c. Economy-specific containment

If the fault is an unauthorized grant or a double-spend, `Only Core mutates competitive/economic
state` still holds: take a **Core** transaction-level correction (an operator command through the
existing command boundary), never a direct `UPDATE` on `economy.*` — direct writes bypass the outbox,
the ledger and the audit chain.

## 3. Infrastructure incidents

| Incident | Action |
| --- | --- |
| Core host process dies | the second Core process takes over; confirm the authority epoch is unchanged and that no two writers served simultaneously |
| Managed Redis/Upstash lost | coordination is disposable: matches resume from the PostgreSQL revision (`P2_06_reconnect_resume`, `P2_06_http_snapshot_fallback` in `r05-online-acceptance.json`); never rebuild authority from Redis |
| Backup stale or missing | the freshness checker alerts (Stage A); take an immediate manual backup with the host service and confirm the independent retrieval before continuing |
| Alert not delivered | verify the Resend send path with a single drill message (see `DELIVERED-ALERTS-20261014.md`); the key is send-only by design |
| Certificate expiry | the `core.megaxo.online` Let's Encrypt cert renews automatically through Caddy; verify `curl -I https://core.megaxo.online/` after any Caddy change |
| Staging contaminates production | refuse: production API must never resolve `MEGA_CORE_URL` to the staging Core. Check the deployed value and the Core pool's `describe().role` |

## 4. Rollback (post-write) is a code action, not a data action

If a **release** is bad, roll the *application* back to the previous immutable image digest while
keeping the PostgreSQL authority and its data:

1. Set `MEGA_IMAGE` to the previously verified digest.
2. Re-deploy with the same migration chain (do not reverse migrations; the schema is forward-only).
3. Confirm `/livez` and `/opsz`, then re-run the public smoke.

A PostgreSQL-compatible previous build is required; a build that only understands SQLite is not a
rollback candidate after the first write.

## 5. Verification after any recovery

Run, in order: `/livez`, `/opsz`, a real two-account match, wallet read-back, a leaderboard read, a
fresh backup plus independent retrieval, and the P15 reconcile (`verify` with zero unexplained
differences). Record the exact SHAs, digests and command output in the release ledger.

## 6. What this runbook does not claim

- No incident above has been rehearsed against the live production cutover; the mechanisms
  (fence, PITR, DR restore, alerts) are individually proven.
- The authority-epoch table/command name must be confirmed against the deployed release before use.
