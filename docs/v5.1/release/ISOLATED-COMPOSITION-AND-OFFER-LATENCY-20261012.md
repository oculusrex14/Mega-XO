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
