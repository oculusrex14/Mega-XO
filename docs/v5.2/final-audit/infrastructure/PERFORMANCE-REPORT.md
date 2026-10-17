# Performance Report

**Method note (owner rule): no fabricated benchmarks.** Only measurements with a recorded environment are listed. Everything not measured on a real device this audit is explicitly NOT_RUN.

## Measured this audit

| Metric | Value | Environment | Source |
|---|---|---|---|
| Android cold start (offline) | TotalTime 4010ms / WaitTime 4024ms, COLD, UI initialized | GitHub Actions emulator (API image per workflow), 2026-10-17 | run 39011945869 job 117337464780 + earlier 39006747061 job 117320920404 |
| Web presentation matrix | 935 checks, 0 failures, desktop/tablet/390/320 | CI chromium headless, run 39012267039 | browser-presentation job 117337254306 |
| Full Node regression | 1921 tests: 1574 pass / 1 fail (fixed) / 346 skipped, 62.8s | GitHub Actions ubuntu runner | validate job 117337126457 |
| P18 disposable journeys | pass 2m16s | GitHub Actions disposable PG/Redis | job 117337126774 |
| Architecture graph generation | 13 artifacts, byte-identical regeneration, ~0.5s | local Mac mini (deterministic generator) | scripts/audit run 2026-10-17 |

## NOT_RUN (honest gaps — no invented numbers)

- Real-device cold start, frame rate, touch latency, battery (both phones pending owner device pass).
- Core Web Vitals on production (requires the authorized deploy; Lighthouse not run against a stale live surface).
- API latency under load, matchmaking latency distribution, soak tests (P19/P24 bounded lanes cover integrity, not production-scale load; no destructive tests against live production per owner rule).
- Bot inference latency on-device ( Impossible pack optional and unverified by contract).

Regression baseline: the 320px reflow fix and the routing/cookie fixes changed no measured performance surface; CI timings are within the historical envelope (browser-presentation 4m13s vs 3m19s-4m28s historical range).
