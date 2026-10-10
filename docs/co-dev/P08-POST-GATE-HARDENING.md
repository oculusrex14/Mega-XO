# P08 accepted-G08 post-gate hardening and integration handoff

**Canonical branch:** `co-dev/v5-integration` · [unified draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)  
**Owner checkpoint:** `V5-platform` G08 PASS at `a09c1578e8dc788207b47da0fb999c1345b97aaf`. Merged into the co-dev history as two-parent `1638ab671c66`, **22 upstream files / zero changed-path overlap**. Owner progress/evidence and primary branch remain unchanged.  
**Scope:** narrow realtime transport, Redis due-index and CI corrections. **No gameplay rules, turn-lengths, economy, Crown spend, rank policy, schema or production deployment modified.**

## Changes made after G08

### 1. HTTP snapshot fallback cannot authorize from `?actor=` (privacy/security)

**Previous:** `GET /realtime/v1/snapshot?match_id=...&actor=...` and the match alias took the request URL's `actor` directly into `core.readMatch(actor, matchId)`. `Core` correctly checks whether that actor is a durable match participant, but the HTTP caller was **not authenticated as that actor**. Anyone able to reach the endpoint and name a participant and match ID could receive the participant's private match data. The one-use WebSocket ticket never authenticated HTTP GET.

**Fix:** `packages/services/realtime-transport.js` accepts a caller-owned `authenticateHttp(req)` that MUST verify the actual request credential, expiry/revocation and actor eligibility before returning **`{actor: verifiedActorId}`**. Without a hook, private HTTP reads fail closed with **401** and never query the match. Invalid/unverified principals also fail 401, revoked sessions use the safe 401 code, transient verifier outages surface a generic 503. A supplied legacy `?actor=` is now a consistency assertion only: if it disagrees with verified identity, return **403 before reading**. If omitted, verified identity still works. Durable `Core.readMatch` retains independent participant checks. Unrelated host routes are not touched; no new browser site or cookie migration was introduced.

**Integration requirement:** The primary P09–P11 API/Core host must provide the real P05 session/bearer authenticator to `createRealtimeTransport` before shipping HTTP polling. **Do not** pass `req.query.actor`, `x-actor`, unsigned headers, or a constant principal. Verify session expiry, generation/revocation and identity/account eligibility against the proper durable authority. If that integration is not implemented yet, HTTP polling deliberately returns 401; WebSocket ticket authentication stays operational. The commented host integration snippet in `apps/game-core/realtime.js` was corrected accordingly.

**Tests:** `tests/v5-p08-http-auth.test.js` uses a real local HTTP server and deliberately mocked authenticated principals; exercises unauthenticated spoof, mismatched actor, rejected/revoked session, failed auth backend, participant check, HEAD and unrelated routes. The existing **real PG+Redis** snapshot recovery suite now models host authentication with random opaque test bearer credentials; it covers query-only and cross-actor impersonation as well as normal authenticated reads. Its fixture token map is **not** a production identity verifier.

### 2. Bounded socket command backlog

**Previous:** `enqueue(conn, task)` chained one Promise per inbound envelope indefinitely. An authenticated (or pre-auth pinging) peer could pipeline thousands of individually valid frames faster than a slow PostgreSQL command settled, accumulating memory and deferred authority calls without an upper bound. The 8 KiB **per-frame** limit did not bound the async queue.

**Fix:** `MAX_PENDING_ENVELOPES=64` is a conservative per-connection ceiling including in-flight work. Overflow closes that socket with policy close **1008**, and tasks queued before a socket close check `conn.destroyed||conn.closing` before dispatching. Legitimate clients reconnect and use existing bounded delta/snapshot recovery. No Core mutation is manufactured and no stored game state is changed.

**Test:** `tests/v5-p08-ingress-bounds.test.js` sends **96 actual RFC6455 masked ping envelopes in one TCP write** over a loopback HTTP upgrade, without a DB. It asserts close 1008 and bounded wait; ordinary masked WebSocket, durable revision/move and slow-client tests remain in the primary P08 suites.

### 3. Redis shared due-index TTL monotonicity

**Previous:** `scheduleTimeout` wrote a member then unconditionally `PEXPIRE`d the entire shared `due:timeout` ZSET for *that* match's deadline. Registering a 5-second timer after a 2-hour timer shortened the entire key TTL and evicted the latter's scheduling hint early. PostgreSQL due scans remained authoritative, so deadlines were not lost; the index nevertheless degraded unnecessarily.

**Fix:** Redis Lua now does atomic `ZADD`, `PTTL`, and `PEXPIRE` **only if the new deadline's TTL exceeds the existing positive TTL** (or the key has no expiry). This retains the longest pending hint while ensuring a newly created/no-TTL set gets an expiry. No Redis data becomes durable authority.

**Test:** added isolated real-Redis namespace `tmp08monotone` regression to `tests/v5-p08-timers.test.js`: distant registration, then near registration, `pTTL` remains within a small wall-clock tolerance of the long value and the later member remains present. The suite cleans only its owned namespace.

## Verification and unchanged evidence

At the co-dev checkpoint, the updated HTTP fallback behavior was exercised using the **exact fetched transport source in V8 with simulated Node HTTP primitives**: unauthenticated query →401, authenticated wrong actor →403, verified participant →200, revoked credential →401, and invalid host hook refused. The **same fetched transport source** processed 96 masked frames using simulated Node socket/buffer primitives and produced policy close **1008**. All four edited P08 JS test/source files parsed successfully; the cross-phase CI source test has **6/6** V8/stubbed checks passing. This is **not** a real Node24 or provider test run.

The primary agent's original `docs/v5/evidence/phase08-gate.json` documents **36/36** tests passed on its original source SHA against real owned PostgreSQL16 + Redis. That historical evidence remains accepted **only for that pinned source**, not for these later co-dev changes. No accepted G08 evidence files were overwritten.

`.github/workflows/v5-postgresql.yml` now runs the new HTTP and ingress suites as separate commands and requires their independent nonzero-pass/zero-skip TAP logs. The new timer case is included in its existing P08 timer suite. `tests/v5-cross-phase-integration.test.js` prevents dropping the P08 security suites from the CI coverage register. GitHub Actions on the co-dev PR still reports **zero-runner/zero-step failures**, not executed source-test failures, so no exact-head green claim or G08 reacceptance is made. Restore runners and rerun all current-head P06–P08 PG+Redis suites and P16 failure/recovery checks before merge.

## Remaining integration review items

- **Host-mounted HTTP verifier:** mandatory to make private polling available again; it must use actual P05 session/identity truth. Until mounted, the safe behavior is 401, not actor-based access.
- **Long-lived redeemed WebSocket session revocation:** `conn.sessionId` and `conn.generation` are recorded at ticket redemption, but the current P08 transport does not independently recheck session generation/revocation before every later subscription/command. This requires an explicit P05/Core integration review and a real revoked-after-redeem test before production. **Not resolved by the HTTP verifier change.** Do not treat cached Redis presence as durable session authority.
- **End-to-end current-head evidence:** retest P07 claim-ID consumer changes with P08 subscriptions, timer expiry, two-Core failover and P16 process shutdown; no live Core host, VPS, DNS, app store or provider was changed.
- **Owner ledger:** G08 remains owner-recorded PASSED; this co-dev review does not edit `docs/v5/progress.json`. G09 and later gates are still separately owner-controlled.

**No production behavior was changed or deployed; all co-dev changes are source-only on the single branch.**
