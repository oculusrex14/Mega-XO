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
| `v5-p08-restart-recovery` | **6/6 pass** (with `--test-force-exit`) — restart/rollback/idempotent-retry/Redis-hint/drain **and** the stalled-client 1008 close. The 1008 failure was a **genuine transport defect** (the bounded socket was `destroy()`ed right after writing the 1008 frame, discarding it) — fixed in `packages/services/realtime-transport.js` (`3adf278`). |
| `v5-p08-snapshot-recovery` | **5/5 pass** (`--test-force-exit`); the earlier apparent hang is the node test runner's teardown on this host, not a test failure — `--test-force-exit` gives a clean summary. |
| `v5-p15-sealed-archive` | 3/3 pass; fixed a real destroy-then-unlink race that could leave the `.partial` ciphertext behind on Linux (`ac452fa`), 20/20 stress runs green. |
| `gameplay-capture` (merged PR #12) | 58 non-PG + 11 PG tests pass, 1 skip (needs a container); `V5.1 gameplay capture` CI **success**. |

## Real defects fixed from this run

1. **P08 slow-client close-frame delivery** (`3adf278`): the bound tripped and `closeSocket(…, 1008)`
   ran, but the hard-close path `destroy()`ed the socket immediately after writing the close frame, so
   for a peer that was not reading the 1008 frame never reached the wire (`closeCode=null`). Collapsed
   to one delivered path (`socket.end(closeFrame)` with the unref'd grace backstop).
2. **P15 partial-ciphertext cleanup race** (`ac452fa`): a WriteStream whose async `open` had not
   completed recreated the file after `destroy()`, undoing the synchronous unlink.

## CI trigger gap (the reason green CI masked the DB gates)

Ten workflows triggered only on the retired `V5-platform` branch, so the PostgreSQL-backed suites
skipped silently in the generic job. Fixed in `6e914f0`/`4f907d2`/`ae288ff`; the newly-enabled V5.1
workflows now run and pass.

## Honest limits

- Local disposable PG/Redis ≠ provider Neon/Upstash recovery; the deployed RPO/RTO and delivered
  alerts remain open (R08/R09).
- The node test runner does not self-exit on this host after some WS suites; `--test-force-exit`
  gives a clean summary and does not change any assertion. This is teardown behavior, not a test
  failure, and it is independent of the transport fix.

## Additional suites executed (real disposable PG16 + Redis)

| Suite | Result |
| --- | --- |
| `v5-p13-security` + `v5-p11-session-boundary` + `v51-audit-ticket-boundary` | **22/22 pass**, 0 skipped — deployed service-identity, session boundary, ticket boundary and negative authorization with real PG |
| `v5-p04-services` (PG authority contention/atomicity, commands, provisioning) | **37/37 pass**, 0 skipped — transaction idempotency, wallet readiness gate, economic outcomes |
| `v5-p08-restart-recovery` | **6/6 pass** (stalled-client 1008 now fixed) |
| `v5-p09-fencing` | **7/7 pass** |
| `v5-p10-worker-hardening` (+ `v5-p09-recovery`) | **6/6 pass** |

Commands (disposable lab, loopback only):
```
V5_PG_URL=postgres://postgres@127.0.0.1:54329/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
REDIS_URL=redis://127.0.0.1:6389 V5_REDIS_REQUIRED=1 V5_TARGET=test \
node --test --test-force-exit tests/<suite>
```

## Load / chaos / capacity (real disposable PG16 + Redis on the owned loopback ports)

| Suite | Result |
| --- | --- |
| `v5-p19-real-services` (real disposable load: persistent wallet/Crown effects exactly once at all four tiny concurrency tiers) | **1/1 pass** (evidence `.artifacts/p19-real-disposable.json`, source SHA = HEAD) |
| `v5-p19-real-chaos` | **1/1 pass** |
| `v51-bot-tutorial` + `v51-p21-bot` | **72/72 pass**, 0 skipped — tutorial/practice/Expert-bot correctness |

Command contract (owned-loopback only, ports 5432/6379):
```
V5_PG_URL=postgres://postgres@127.0.0.1:5432/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
REDIS_URL=redis://127.0.0.1:6379 V5_REDIS_REQUIRED=1 V5_REDIS_DISPOSABLE=1 V5_TARGET=test \
V5_P19_DISPOSABLE=1 V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 P19_SOURCE_SHA=$(git rev-parse HEAD) \
node --test --test-force-exit tests/v5-p19-real-services.test.js
```
These also run in the `V5 P19 disposable load and chaos foundations` CI lane (now targeted at V5.1).
Realistic-history sizing, delivered provider alerts and production headroom remain open (R09/R19/R32).
