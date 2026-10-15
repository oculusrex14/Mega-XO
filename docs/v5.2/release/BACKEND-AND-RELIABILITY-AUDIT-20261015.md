# Backend and reliability audit (2026-10-15)

Objective priority (6), re-exercised against live/disposable real services rather than trusting the
phase gates. Every suite below ran on this host: a disposable PostgreSQL 16.15 (loopback, trust auth,
`postgres` control DB) and the loopback Redis, using the project's own harness contracts (all required
`V5_*_DISPOSABLE`/`_REQUIRED` markers, ambient provider credentials unset).

## Security

| Suite | Result |
| --- | --- |
| `tests/v5-p13-security.test.js` | credentials separation (hybrid rejected, cookie CSRF enforced, bearer exempt), header sanitizer (cannot spoof `x-actor-id`/`x-test-actor`/`x-forwarded-for`), body limit (413), audit-HMAC chain verification, public operator-route rejection (`/admin/*`, `/metrics`, `/operator/*`) |
| `tests/v5-p14-observability.test.js` | **15/15 pass** — role-specific health (`opsz` red on stale backup / DLQ>0 / stalled worker while `livez` stays ok), metrics + Prometheus exposition, support triage without PII leakage |

Found and fixed a real security defect in this pass: `/auth/callback/:provider` returned a false
`linked: true` for a bogus callback. Now fail-closed (`d61e5ed`), deployed to both the Oracle authority
and the Vercel API, and re-verified live on both.

## Idempotency

Real signed gateway replay against the production authority with one operation key:

```
forwardCommand(actor, opKey=idem-probe-<ts>, /ingress/queue/status) twice
first : {"state":"idle"}
replay: {"state":"idle"}     → identical outcome (idempotent)
```

Backed by the P19 chaos case (below) which asserts exactly-once wallet/Crown effects under a Redis wipe
and an idempotent retry.

## Core failover (P16)

| Case | Result |
| --- | --- |
| `v5-p16-process-failover.test.js` | **PASS** — real SIGKILL of Core A after a committed move; Core B reconstructs the revision, paid occupancy, the same deadline and dedupe |
| other P16 suites (real sockets, connections, topology, lifecycle, CI perimeter) | 17/17 then 21/21 pass |

Topology note recorded honestly: the P16 gate describes a Core A/B pair (upstreams 8081/8082) and the
process-failover property is proven; production currently runs **one** Core process on 8080. Per the
project's own D12 decision, two same-host Core processes satisfy *process* failover only — host HA needs
a separate failure domain — so running a single process in production is a deliberate, labeled
reduction of the process-failover margin, not host HA.

## Load / chaos (P19)

| Case | Result |
| --- | --- |
| `v5-p19-real-services.test.js` | **PASS** — persistent wallet/Crown effects are exactly once at all four tiny concurrency tiers (smoke/warm/ramp/ceiling) |
| `v5-p19-real-chaos.test.js` | **PASS** — actual disposable Redis wipe, Core reopen, idempotent retry and a bounded PG stall preserve durable truth |
| metrics / chaos-contract / workload-profile / capacity-report | 15/15 pass |

Combined P15+P16+P19 run: **100 tests, 99 pass, 1 skipped, 0 fail**. The single skip is the P15
twin-PostgreSQL-container archive roundtrip, which requires a Docker daemon this host does not run; that
path is covered by the recorded isolated DR restore instead.

## Recovery (P15)

- `P15-DR-RESTORE-PROVEN-20261014.md`: a full restore into an isolated PostgreSQL with invariant checks.
- `NEON-PITR-VERIFIED-20261014.md`: an independent Neon PITR recovery point.
- Live now: the 5-minute R2 backup cycle with `readbackCheckedAtUtc` on every receipt, and `/opsz` red
  on a stale backup.

## Monitoring

- `/opsz` is backup-aware and queue-aware on the production authority; a forced stale backup flips it
  to 503 while `/livez` stays 200 (re-verified this session).
- `mega-xo-v5-health.timer`, `mega-xo-v5-db-integrity.timer`, `mega-xo-v5-backup.timer` and
  `mega-xo-v5-freshness.timer` are active; the V5 host monitor and read-only PostgreSQL integrity
  checker replaced the V4 units that probed the retired container.
- A forced-failure alert was delivered and the recovery alert followed (`8b4220c` fixed the key path).

## Packaging and release engineering

- `release-gate.test.js` and the `v5-release-*` suites pass; the release workflow is gated and emits an
  immutable manifest; the production image was deployed by immutable digest.
- The frozen release is byte-verified: the web bundle built from `c172aa57` equals the deployed bundle,
  and the deployed server file equals HEAD.

## Honest limits

- Not exercised here: the Docker-only P15 twin-container roundtrip, a real rewarded ad, and host-level
  (as opposed to process-level) Core HA.
