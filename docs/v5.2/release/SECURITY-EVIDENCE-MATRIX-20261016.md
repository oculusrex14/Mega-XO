# LR06 — security evidence matrix (2026-10-16)

**Purpose:** concrete negative-test evidence for every area of the LR06 security-preparation list, so Main's independent audit starts from a mapped baseline instead of a blank page. **Method:** repository test inventory mapped to areas; the seven core security suites were executed today at the LR06 working head (all exit 0 — the exit code is the authoritative signal; the repo's runner counts suites). No production change; no secrets printed.

## Today's executed suites (all PASS, exit 0)

| Suite | Covers |
| --- | --- |
| tests/v5-p13-security.test.js | origin checks, CSRF posture, security header expectations |
| tests/v5-p11-session-boundary.test.js | session cookie boundary, host-only scoping |
| tests/v5-p05-tickets.test.js | one-use realtime tickets, expiry |
| tests/production-auth.test.js | production auth lane negative paths |
| tests/provider-authorization.test.js | provider identity ownership/authorization |
| tests/v51-audit-ticket-boundary.test.js | ticket issuer boundary after the V5.1 audit fixes |
| tests/v52-web-oauth.test.js | web OAuth lane (state/nonce), web sign-in composition |

## Area-by-area evidence

| Area | Concrete tests (negative paths) | Status | Notes / gaps |
| --- | --- | --- | --- |
| Authentication & session fixation | v5-p11-native-session, community.test, community-http.test, v52-web-oauth | suites present; web-oauth RUN green today | rotation-on-privilege-change assertions live in the community suites; a dedicated fixation negative test does not exist by name — Main's audit should confirm the rotation is asserted somewhere explicit or add one. |
| CSRF / CORS / origin | v5-p13-security (RUN green), v5-p11-session-boundary (RUN green), v5-p11-browser-compat | green | The retired-host origin expectations were retargeted at d8d304b; browser-compat suite pins the canonical origin. |
| Core HMAC ingress | v5-p11-core-gateway, v5-p04-services, v51-v5-production-server | green (composition role/refusal tests), gateway suite present | Live unsigned probe returns 401 (LR05 report, 2026-10-16) — fail-closed observed in production. |
| Actor impersonation / authorization | v5-p04-differential, v5-p21-realtime, authority.test, v5-p09-fencing, provider-authorization (RUN green) | green | Differential suite proves cross-actor access refusals. |
| Realtime ticket replay | v5-p05-tickets (RUN green), v51-audit-ticket-boundary (RUN green), v5-p21-realtime | green | One-use + expiry + boundary audits. |
| Rate limiting | v5-p04-services (rate buckets), v5-p10-workflows, accounts lane (email-otp-session/address limits in accounts.js) | green | No dedicated negative test for the V5 monetization routes yet — they do not exist until LR12 lands; add with that PR. |
| Wallet / ledger integrity | v5-p04-differential, operator-service, v5-migrations, authority.test | green | Wallet rows are Core-readiness facts; API holds no economy DML (role separation asserted in v51-v5-production-server). |
| Replay / idempotency | v5-p04-services, v5-p04-differential (idempotent writers), v52-mail-resend (provider Idempotency-Key + deterministic outbox ids) | green | The LR10 sink makes a producer retry a structural no-op — tested. |
| Secrets & logging | operator-service (sanitized log records), production-lifecycle (mode-0600 secret files, absolute non-symlink reads), v52-mail-resend (key never logged) | green | Worker log lines carry only id/kind/fault-code (worker-workflows contract). |
| OAuth nonce / state / PKCE | v52-web-oauth, v5-p10-provider; LIVE: the 2026-10-16 Google roundtrip captured code_challenge(S256) + nonce + state and Apple state + nonce (LR07 report) | green + live evidence | Apple roundtrip completion pending owner credentials. |
| Payment / ad callback verification | monetization-policy, v5-contracts (SSV fail-closed: no grant from empty probe / show() success), v5-p22-rollback-policy | green | V5 monetization routes land with LR12; the SSV contract tests are already in place. |
| SQL permissions / role separation | v51-v5-production-server (role assertion, composition separation, wrong-target deploy refusal), v5-migrations (grant chain), v5-p04-differential | green | PR #25 adds DEPLOY_REFUSED_WRONG_TARGET + schema-regression guards. |
| Sensitive endpoint caching | v5-contracts, v5-p21-seo (no-store on private/auth), v5-p11-session-boundary | green | Live: /livez//readyz//opsz + API answers carry no-store (LR05 probes). |
| Age / consent / deletion access | v52-consent-retention, v52-research-consent-routes, account-deletion, privacy-export, v5-p23-retention-manifest | present | Live consent-route verification is LR17 (scheduled after Stage 2). |
| Supply chain / dependency advisories | production-lifecycle: runtime dependencies pinned by immutable multi-arch digest; GitHub release workflow uses immutable action revisions | green | A live npm audit advisory scan was NOT run (network/policy); recommend Main or a scheduled job run it against the release lockfile and file advisories as issues. |

## Fixes this cycle contributed to the evidence base

- PR #25: deploy-time wrong-target refusal (serve.sh binding vs host inventory), schema-regression refusal, unconditional host-managed restores — negative-tested.
- PR #27: provider Idempotency-Key discipline + wrong-secret seal refusal — negative-tested.
- PR #22: CSP/X-Frame-Options/nosniff/Referrer-Policy restored on the production origin (security headers were absent live).

## Honest gaps for Main's audit

1. No single named session-fixation negative test — confirm existing rotation assertions or add one.
2. No live npm audit/lockfile advisory evidence — run against the release lockfile.
3. Monetization-route rate-limit negatives arrive with LR12 (routes do not exist on the trunk yet).
4. Device-lane security (key attestation, store signing chain) is LR08/LR20, not covered by unit evidence.
