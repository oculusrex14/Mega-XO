# TRACK B - flow-12 accept latency resolved by co-location; staging ticket issuer wired

## Flow 12 (the 17.4 s accept) - RESOLVED by environment placement

Root cause (already measured): the offer TTL is the preserved **15 s** constant, and a single
`/api/v1/accept` (API auth + gateway + Core multi-statement transaction) is ~8-10 Neon round-trips. From
the Mac each Neon round-trip is ~2.5 s (`ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech`), so one
accept took 17.4 s and could not fit the window.

The Oracle production host `command` is in **Ashburn, us-east** - the SAME region as Neon. Measured TCP
connect to Neon: **8 ms** (vs ~2500 ms from the Mac). The staging stack (API + Core ingress + queue +
realtime) now runs **co-located on that host**, so the accept path is region-local.

Evidence (co-located smoke, real Neon staging + Upstash):

| Metric | From the Mac | Co-located (Oracle) |
| --- | --- | --- |
| Neon TCP connect | ~2500 ms | **8 ms** |
| `/api/v1/accept` per accept (2 concurrent) | 17.4 s | **244 / 413 ms** |
| Elapsed from pairing to both accepted | > 15 s (expired) | **468 ms** |

The 15 s timer is UNCHANGED. `12_concurrent_accepts` PASSES with 468 ms since-pair.

## Integration gap fixed: realtime ticket issuer

Running the smoke far enough to reach the realtime path exposed a real gap: `createApiHandler` was not
given a `ticketIssuer`, so `POST /api/v1/ticket` returned 503 (`TICKET_ISSUER_UNAVAILABLE`). Both the
staging server and the smoke now pass the SAME issuer the ingress uses. The full online journey then
passes: matchmaking -> concurrent accepts -> PLAYING -> realtime ticket issue/redeem -> move -> reconnect
-> snapshot fallback -> owned cleanup + all-table hash preservation.

## Result

`scripts/v51/p21-staging-smoke.cjs` co-located: **34 steps, 19 passed, 0 failed** (the rest are
informational observations). Two real accounts reach PLAYING and play over the realtime transport on the
real staging database, reproducibly, with the 15 s window intact.

## Deployment (private, isolated, no V4 impact)

- Host: Oracle `command` (100.64.128.46), co-located with Neon us-east-1.
- Path: `/opt/mega-xo-v51-staging/{repo,p21-web,secrets}` (secrets 0600); node at `/tmp/node`.
- Origin: `http://100.64.128.46:8085` (tailnet); bundle self-check passes; noindex enforced.
- V4 production untouched (ports 80/443 still V4's single ingress).
