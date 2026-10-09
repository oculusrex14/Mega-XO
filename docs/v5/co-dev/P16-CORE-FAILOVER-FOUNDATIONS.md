# P16 isolated Core failover foundations (co-development)

Branch: `co-dev/v5-p16-core-failover`. This branch is additive and does not edit V5-platform, P06 Core work, P15 recovery work, existing V4 deployment, production credentials, ingress, or the owner-controlled execution ledger.

## What exists

`packages/services/core-instance-lifecycle.js` provides an instance-local lifecycle with BOOTING, READY, DRAINING and STOPPED states. It prevents admission before dependencies are ready, rejects new realtime connections during a drain or when at capacity, preserves the original drain deadline across repeated shutdown requests, and reports a timed-out drain as failure. Leases release idempotently, and an aborted waiter does not stop the process. Its tests are in `tests/v5-p16-lifecycle.test.js`.

The lifecycle tracks **connection admission only**. It is not a distributed lease, socket router, durable game state, match ownership, or a PostgreSQL/Redis replacement. Runtime must hold/release one lease for every accepted socket, send a client-safe retry/reconnect response when not READY, and never mark a node ready before database/realtime state recovery. Do not run forced socket closing from this utility.

## Later phase integration

1. P08/Core runtime to expose actual readiness, upgrade admission, pinned session verification and revision replay. Wire one lifecycle per Core process; no new sessions after drain begins.
2. Deploy two independently managed Core services on a dedicated V5 network and loopback/private ingress. **Do not reuse or rewrite V4 Compose/Caddy or bind another public 80/443 listener.**
3. Measure rolling drain with real sockets, old/new protocol compatibility, persisted deadlines and a real post-commit/pre-publish failure.
4. Prove A died / B recovered with actual match and tournament data and revoked session; assert ledger/settlement/outbox once-only, no lost acknowledged revision and unchanged absolute deadlines.
5. Document DNS/edge/Oracle host failures separately. Two containers on one VPS deliver process redundancy, **not** host or zone high availability.

## Evidence/acceptance boundary

This is preparatory code, **not** completion of V5-16-01 through 04, A-cases or G16. Node suite may be run as `node --test tests/v5-p16-lifecycle.test.js` on the exact branch; require CI execution on the PR before integration. Never infer a successful staging or provider failover from a local state-machine test.
