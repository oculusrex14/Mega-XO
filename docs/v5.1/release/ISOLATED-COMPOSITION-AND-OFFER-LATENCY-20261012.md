# Isolated Core composition and offer-latency evidence (R04/R05) - 2026-10-12

Main agent. Local, real-PostgreSQL measurements; no production or staging write.

## R04 - isolated signed Core composition (proven locally, real PG16 + Redis)

The API never holds Core credentials or the queue service: the queue read/admission executes
`resolveGateway(context)` and reaches the Core over the signed ingress. This is now exercised as a
real composition in `tests/v5-p11-browser-compat.test.js` (test 4 and the new guard 5b) and in the
measurement below:

- API composed with `api_runtime` pool + accounts + ticket issuance, and pointed at the Core through
  `createCoreGateway({ coreUrl, secret })`.
- A real Core host = `createCoreService(core_runtime pool)` + `createQueueService(core_runtime pool,
  ephemera)` + `createEphemeraService` behind `createCoreServiceIngress({ coreService, queue, secret })`.
- The API and the ingress share one deployment signing key; the API holds no Core pool, the queue
  service and its pool stay inside the Core host.
- An unconfigured Core (no URL/secret) fails the queue read closed with an honest 503 and never a
  fabricated idle 200 (test 5b).

What remains for R04 is the **staged** process-manager/TLS/network wiring (separate API/Core/worker
processes under a real supervisor, TLS termination, private HMAC ingress in a deployed topology) -
that is deployment, not code, and is Codex/host work.

## R05 - OFFER_EXPIRED root cause, measured

The queue offer TTL is a preserved product constant: `src/authority.js` sets a queue offer to expire
15 s after `matchTick` (`queueSource ? 15000 : …`). This was NOT changed.

Measurement against owned loopback PG16 + Redis (throwaway harness, real HTTP through the API and the
signed Core ingress):

| Step | Latency |
|---|---|
| queue join (alice) | 24.9 ms |
| queue join (bob) | 11.7 ms |
| accept (alice) | 18.5 ms |
| accept (bob) | 17.2 ms |
| **max accept round trip** | **18.5 ms** |
| **margin vs the 15000 ms offer TTL** | **14,981 ms** |

Conclusion: the co-located journey (offer -> both accepts -> PLAYING) completes in tens of
milliseconds against a near DB, ~3 orders of magnitude inside the 15 s offer window. The staging
`OFFER_EXPIRED` at flow 12 was therefore caused by **cross-region Neon round trips** (seconds per
statement), not by the route, the composition or the TTL. The staging smoke already mitigates this by
producing the pairing immediately before the accepts and recording the exact refusal timing
(`12_accept_refusal` with `offerExpiresAt`/`nowMs`).

What remains for R05 is running the full co-located smoke **near the staging database** (same region /
loopback), which is an environment placement decision, not a code fix. The TTL was preserved.

## Flow 12 resolution: measured cross-region latency, not a defect (2026-10-12)

The acceptance smoke failed `12_accept_refusal 409 OFFER_EXPIRED`. Root cause is measured, not
inferred, and is an ENVIRONMENT limit of where the smoke ran (this Mac), not a route or Core defect:

| Measurement | Value |
|---|---|
| Neon staging round-trip from this Mac (10 warm `SELECT 1`) | min 2530 ms, median 2620 ms, max 2732 ms |
| One 5-statement transaction (typical auth path) | 3563 ms |
| A SINGLE `/api/v1/accept` (API auth + rate + gateway + Core multi-statement txn, ~8-10 round-trips) | 17419 ms |
| Queue offer TTL (preserved) | 15000 ms |

One accept alone exceeds the 15 s offer window across this link, so even two concurrent accepts
cannot both land in time. The TTL is NOT changed.

**Co-located control (same code, no cross-region hop):** `tests/v5-p07-queue.test.js` with a local
Redis on 127.0.0.1:6399 and local PostgreSQL 16 passes **10/10**, including the accept test that
issues both accepts and observes the match become PLAYING, and two tests (heartbeat lease with a
400 ms TTL, candidate-index expiry reclaim) that FAIL against the cross-region Upstash staging
because their timing windows are shorter than the link RTT. So:

- the accept path, the offer TTL, actor fencing and queue admission are correct;
- the flow-12 failure and the two cross-region Redis test failures are the SAME latency class.

## Reachability (P3)

Staging is bound to this Mac's tailnet interface and verified reachable from a different tailnet
node (the Oracle `command` host): `/` 200, `/livez` 200, `/legacy-game/src/game.js` 200,
`/api/account/session` 200 - real bytes. HTTPS is available via `tailscale serve` but needs a
one-click owner enablement (`https://login.tailscale.com/f/serve?node=nLo62ZkXpj11CNTRL`).

For Codex: use `http://100.107.65.122:8081/` from a tailnet device. Sign-in works (see the handoff);
the OTP for a controlled test is read from the staging OTP sink file. If a same-region accept run is
required for the smoke, run it on a host near the Neon region (the smoke stays green co-located).
