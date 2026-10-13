# P6 backend/reliability locally exercised on V5.1 (2026-10-13)

Ran the PostgreSQL/Redis-backed V5 authority suites locally against a **disposable** PostgreSQL
16.15 + Redis lab (not the provider, not production) after enabling the previously-untargeted CI
workflows. This is real execution evidence for the durability/recovery paths, complementing the CI
runs.

## Enabling the DB/failover/chaos CI for V5.1 (real defect)

Ten workflows triggered **only** on the retired `V5-platform` branch, so the PostgreSQL-backed gates
(and P15/P16/P18/P19/P22/P23/P24) never ran for V5.1 — their suites silently SKIPPED in the generic
"Mega XO validation" job, which is why green CI masked the gap. Commits `6e914f0` (triggers),
`4f907d2` (perimeter/workflow-shape guards now accept the `[V5-platform, V5.1]` set), `ae288ff`
(P18 source job needs `npm ci`). After the fix the newly-enabled workflows pass for V5.1:
`V5 release engineering`, `V5 P15 isolated backup and recovery`, `V5 P16 process failover`,
`V5 P19 disposable load and chaos`, `V5 P22 cutover readiness`, `V5 P23 retirement foundations`,
`V5 P24 scaling` — all **success**.

## Local disposable lab

- PostgreSQL 16.15 (`initdb` at `/tmp/pgv5`, port 54329), Redis 7.4 (`redis-server --port 6389`), both
  discarded afterward. `V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 V5_REDIS_REQUIRED=1`.

## Results (real executions)

| Suite | Result |
| --- | --- |
| `v5-p08-timers` (durable timers, concurrency, replay) | **8/8 pass** — due timeout settles under the revision key + pays the opponent and survives Redis loss; concurrent move/timeout commits exactly one effect; replayed timeout key pays once; `reapDueRooms` expires OFFERED exactly once |
| `v5-p09-fencing` | **7/7 pass** |
| `v5-p09-recovery` | **6/6 pass** (with `v5-p10-worker-hardening`) |
| `v5-p10-worker-hardening` (graceful stop waits for in-flight delivery) | **pass** |
| `v5-p11-account-social` (incl. the account-deletion ack fix `1a80ebc`) | **6/6 pass** |
| `v5-p22-*` (cutover readiness, writer-fence, rollback, import-reconciliation, compat, workflow) | **30/30 pass** |
| `v5-p18-*` (acceptance registry, isolation, topology, public head) | **41 pass / 1 skip** |
| `v5-p08-restart-recovery` | restart/rollback/idempotent-retry/Redis-hint/drain all pass; **one** assertion (`stalled client closed 1008`) fails on this Darwin host and two files hang on an open handle — under investigation (`P08StalledClient`); being treated as a real defect until proven otherwise |
| `v5-p08-snapshot-recovery` | **5/5 assertions pass**; the file hangs after completion on an open handle (same class as above) |

## Honest limits

- Local disposable PG/Redis ≠ provider Neon/Upstash recovery; the deployed RPO/RTO and delivered
  alerts remain open (R08/R09).
- The stalled-client 1008 failure is **not** claimed fixed; it is recorded as an open defect under
  investigation, not written off as a CI artifact.
