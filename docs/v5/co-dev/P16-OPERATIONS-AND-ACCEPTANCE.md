# P16 — process redundancy, rollout and acceptance contract

**Owner branch:** `co-dev/v5-integration` | **formal gate G16: OPEN**

This is a future V5 Core integration plan. Nothing here is deployed, and no production V4 ingress, Caddy, Compose, store, backup or player database is touched. The primary agent currently owns P06–P14 runtime evolution.

## Implemented reusable primitives

| Component | Intended integration | What the test proves | What it does NOT prove |
|---|---|---|---|
| `packages/services/core-instance-lifecycle.js` | Boot / ready / drain / stopped transition; admission lease per accepted session; monotonic drain deadline | Readiness/capacity/drain transitions and lease accounting | Durable matches, distributed coordination or reconnection |
| `packages/services/core-drain-connections.js` | Register authenticated transport, send approved drain notice once, close expired transports without inventing release | Callback race, no new session after drain, actual socket-close release | The correct V5 WebSocket protocol or session replay |
| `scripts/v5/p16/core-failover-plan.js` | Validate proposed A/B private topology and filter authenticated private health | No public second edge, immutable images, unique private upstreams, rejection of stale/draining nodes | Actual provider access, Caddy registration or host high availability |
| `tests/v5-p16-real-sockets.test.js` | Loopback TCP compatibility check for socket transport callbacks | Real local streams can receive a drain hint, reject new admissions and close cleanly | Real client UI/gameplay/realtime semantics |
| `.github/workflows/v5-p16-core-failover.yml` | Read-only tests on V5 push and PR | Separate owned local lifecycle and disposable PG16/Redis 7.4 integration jobs (zero-skip required) | P16 full acceptance or SLO proof |
| `tests/v5-p16-process-failover.test.js` | Real P06 factories in 2 independent Core child processes, then SIGKILL A and resume B, restart C after Redis wipe | In disposable CI, ACKed paid-match move, durable revision/deadline/occupancy/outbox and dedupe are asserted across failure | Actual V5 WebSocket ingress, post-commit/pre-publish crash, production recovery time |

Transport callbacks must be wired by the **real** authenticated Core runtime, not by the public API, browser or native app. Only a committed PostgreSQL revision is authoritative; Redis state and process memory cannot recreate a spend, settlement, accepted move, match timer or purchase.

## P16-01: A/B staging deployment checklist

1. Wait for the actual P08 service startup command and P15 backup/recovery dependency; pin tested Core image digests to source SHA, schema and realtime protocol version. Do not fabricate or implicitly fallback to a mutable `:latest` tag.
2. Define **two independently managed** `core-a`/`core-b` processes on the isolated V5 staging backend network. Both use role-limited direct/pool access to the **same** authoritative Neon PostgreSQL, and the already chosen managed Redis environment; use separate process resources, restart/liveness and private readiness.
3. Keep existing Caddy as the **sole** public :80/:443 ingress. Add only private upstreams through a verified staged configuration, atomic reload and rollback; do not create an additional public listener or share V4 app secrets.
4. Configure bounded CPU, memory, PID, shutdown grace and in-flight socket limits per container; do not exceed Oracle VPS headroom or starve unrelated services and Restic.
5. Before routing staging traffic, check proposed private topology using `verifyCorePair`. **Static validation is not proof the network exists.** Verify that each process independently answers private readiness, has durable transaction access, and cannot expose metrics/operator endpoints through public ingress.

A/B on one Oracle VPS = **process redundancy only**. One dead VPS, one dead public Caddy edge, one unavailable PostgreSQL region, one unavailable Redis service or power/network failure can still affect both Core processes. A second VPS and independent edge only become justifiable under separately measured load/failure requirements and owner approval.

## P16-02: health-aware routing and rolling drain

1. Only `READY` instances under their admitted capacity may accept a **new** session. The per-process admission registry denies new sessions during `DRAINING`. The private router must reject missing, stale, malformed, unhealthy or draining health evidence. No client-supplied readiness field is trusted.
2. On rollout, mark **A** draining before any new socket is assigned; send the existing approved reconnect/resume hint to each authenticated socket. The callback only queues the hint and never assumes the client received it.
3. Allow active sessions to close normally. A timeout is a failed drain while a socket is still registered. After the actual deadline, transport closure may be requested, but the instance cannot report `STOPPED` until its close handlers **release all leases**. Runtime must own SIGTERM and socket completion; the pure primitives do not call `process.exit()` or force database mutation.
4. Promote tested **B** while A is draining, verify B's receipt of durable session/revision state, and then perform the symmetric B rollout. For mixed image revisions, require measured and documented API/Core/client protocol compatibility before choosing different immutable image digests.
5. Roll back an unhealthy instance to the prior **PostgreSQL-compatible** image without reverting committed durable business state. Never take both A/B down for a normal code deployment.

## P16-03: real in-flight failure test matrix (partially implemented; not accepted)

**Added source-level disposable integration:** `tests/v5-p16-process-failover.test.js` uses real P06 Core child factories with distinct PIDs on a single owned PostgreSQL 16 and Redis 7.4 service. It creates a paid direct match through the frozen commands, receives a committed move acknowledgement, kills Core A with SIGKILL, verifies Core B sees the acknowledged revision and unchanged absolute deadline, replays the identical operation with one outcome/outbox, rejects a changed retry, commits another legal move, wipes Redis and verifies a freshly booted Core C still sees the exact durable occupancy and escrow. A read-only P16 CI job provisions disposable loopback services and rejects skips. **The job has not executed successfully on GitHub: GitHub Actions reports failure before runner allocation (zero job steps). These assertions are NOT recorded as passing integrated evidence.**

**What this does not test yet:** an unacknowledged transaction interrupted mid-commit, a post-commit/pre-publish crash before the publisher gets a chance to emit a hint, a Core socket transport or reconnecting real client, timed turn expiration arbitrated by the worker, a tournament close/payout, actual two-instance edge deployment, or a measured 10-second reconnect objective. Those depend on the real P08–P10 runtime and qualified staging.


In an isolated environment with two actual Core processes, distinct authorized **synthetic** clients, real PostgreSQL and managed-compatible Redis:

- Kill A after a move transaction **commits** but before its event is published. Reconnect the exact actor via B; acknowledge the committed revision once, deliver/reconcile outbox exactly once, and reject the same command with a changed payload.
- Kill A during a live turn countdown. B loads the persisted **absolute** deadline; no extra seconds awarded. Race deadline timeout against a legal move under the same durable arbitration.
- Kill A with an unsettled tournament/escrow or match outcome. Ensure durable resume/settle once and exactly the same wallets/ledger/receipts/participants; no refund or Crown grant fabricated by socket recreation.
- Revoke a device/session while A is dying. B rejects it after durable eligibility/ticket/session recheck even if Redis/cache still has a hint.
- Drain A during a user reconnect, then repeat the rolling operation B→A. Attempt a new socket on the drained instance and verify it is rejected. Bound the interval of no available healthy Core by measured readiness/snapshot recovery, not optimistic code comments.
- Remove Redis hints and repeat reconnect. Durable PostgreSQL assets, rank, awards and match outcomes remain unchanged; queue/presence degradation is conservative.
- Prove public operator/metrics routes remain denied and old V4 routes stay unaffected throughout.

Collect exact image digests, source SHA, staging inventory IDs, UTC fault/start/recovery timestamps, client-visible reconnect and revision logs **without session tokens**, durable before/after PostgreSQL checksums, queue/outbox states, socket counts, decisions, and diff from the approved UI/rules. A test that cannot isolate the cause is inconclusive, not green.

## P16-04: failure-domain and rollback matrix

| Fault | Expected target behavior | Limitation / escalation |
|---|---|---|
| One Core process exits | Fresh sessions routed to surviving READY process; resume from PG truth | Requires P08 runtime wiring and executed failover proof |
| One Core process drains | No new admissions; bounded notification and release; remaining process serves | An unclosed transport is not silently counted as drained |
| Redis unavailable | Cache/queue/presence degrade conservatively; no balance/grant recreation | Both nodes may have degraded matchmaking |
| Neon unavailable | No authoritative economic/match write succeeds | Both Core processes share this failure domain |
| Oracle VPS/network offline | Both same-host processes unavailable | Process A/B is not host HA |
| Shared Caddy/ACME failure | Public realtime entry may be unavailable | Preserve single edge and documented rollback |
| Incompatible new image | Reject rollout and keep compatible prior image | No rollback of PG business writes or silent schema downgrade |

**Execution status (2026-10-09):** No G16 acceptance claimed. The pure admission/loopback contract was exercised in an isolated Node 22 re-creation (4/4 checks) and the async-rejection failure contract was exercised separately; this is not a test of the exact GitHub branch. The actual PG16/Redis SIGKILL test is committed but GitHub Actions jobs have shown zero executed steps/no runner assignment, including the parent P06 workflows. Obtain true source-head CI execution first.

**G16 requires real instance A/B + real committed in-flight recovery + verified timestamps and data integrity.** This runbook, primitives, local tests or a green PR by themselves do not close any G16 task/acceptance case.
