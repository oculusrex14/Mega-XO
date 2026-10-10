# P16 isolated Core failover foundations (co-development)

**Canonical work branch:** `co-dev/v5-integration` / [single draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9). Original `co-dev/v5-p16-core-failover` / PR #8 is superseded and closed. This branch is additive to upstream G06 and leaves V5-platform, the P07 execution agent, P15 private provider settings, V4 deployment, production credentials, ingress, and the owner-controlled execution ledger untouched.

## What exists

`packages/services/core-instance-lifecycle.js` provides an instance-local lifecycle with BOOTING, READY, DRAINING and STOPPED states. It prevents admission before dependencies are ready, rejects new realtime connections during a drain or when at capacity, preserves the original drain deadline across repeated shutdown requests, and reports a timed-out drain as failure. Leases release idempotently, and an aborted waiter does not stop the process. Its tests are in `tests/v5-p16-lifecycle.test.js`. `core-drain-connections.js` adds transport-only registration, idempotent release, one synchronous reconnect notice and strict rejection of promise-valued callbacks that could hide failures. `scripts/v5/p16/core-failover-plan.js` is the fail-closed private A/B topology and readiness preflight; no config is deployed by it.

The lifecycle tracks **connection admission only**. It is not a distributed lease, socket router, durable game state, match ownership, or a PostgreSQL/Redis replacement. Runtime must hold/release one lease for every accepted socket, send a client-safe retry/reconnect response when not READY, and never mark a node ready before database/realtime state recovery. Do not run forced socket closing from this utility.

## Disposable Core failover proof authored (unexecuted CI)

`tests/v5-p16-process-failover.test.js` uses genuine P06 Core factories in separate OS child processes, a uniquely owned PostgreSQL 16 database and private disposable Redis 7.4. It creates an active paid match, ACKs a move, SIGKILLs Core A, checks surviving Core B's durable revision/unchanged deadline/escrow/occupancy, replays without duplicate outbox, commits another legal move, wipes Redis, and reloads the committed state in Core C. The strict PR workflow requires no skipped tests and locally bound disposable database/Redis services, but its GitHub jobs currently fail before runner assignment (zero executed steps); **this is a committed test, not a passing acceptance result**. It does not exercise a post-commit/pre-publish crash, real WebSocket recovery, tournament completion or in-production performance.

## Later phase integration

1. P08/Core runtime to expose actual readiness, upgrade admission, pinned session verification and revision replay. Wire one lifecycle per Core process; no new sessions after drain begins.
2. Deploy two independently managed Core services on a dedicated V5 network and loopback/private ingress. **Do not reuse or rewrite V4 Compose/Caddy or bind another public 80/443 listener.**
3. Measure rolling drain with real sockets, old/new protocol compatibility, persisted deadlines and a real post-commit/pre-publish failure.
4. Prove A died / B recovered with actual match and tournament data and revoked session; assert ledger/settlement/outbox once-only, no lost acknowledged revision and unchanged absolute deadlines.
5. Document DNS/edge/Oracle host failures separately. Two containers on one VPS deliver process redundancy, **not** host or zone high availability.

## Evidence/acceptance boundary

This is preparatory code, **not** completion of V5-16-01 through 04, A-cases or G16. The P16 read-only and failover jobs in `.github/workflows/v5-p16-core-failover.yml` need **actual exact-head CI execution**. The local re-created primitive smoke is not an exact-branch test. See [P16 operator and acceptance matrix](P16-OPERATIONS-AND-ACCEPTANCE.md) and [the maintained unified README](../../../CO-DEV-README.md); require CI execution and real staging proof before integration. Never infer a successful staging or provider failover from a local state-machine test.
