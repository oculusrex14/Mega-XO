# SEC-V52 owner decisions - delegated advisory (2026-10-16)

The owner delegated both MEDIUM decisions from docs/v5.2/release/V52-SECURITY-REVIEW-20261016.md to a
Sol 6.1 xhigh advisory subagent. The subagent reviewed V5.2 @ da47480, ran the six affected suites as a
baseline (41 passed / 0 failed / 0 skipped, disposable-PG commerce journeys included), and returned two
IMPLEMENT NOW decisions with full specs. Decision authority was explicitly delegated by the owner for
this run; production deployment and live migration remain separately gated as always.

## Decision 1 - SEC-V52-SSV-UNLIMITED-DOS: IMPLEMENT NOW (DONE this run, commit 0e3c486)

Policy: 600 requests per canonical source IP per UTC minute, independently per provider
(callback-admob / callback-cashfree / callback-polar), reusing ops.rate_buckets (no migration).
AdMob GET+POST share one budget. Admission happens after method validation and BEFORE the signed
gateway call; missing admission protection returns 503; storage failure remains 503
RATE_LIMIT_UNAVAILABLE; exhaustion returns 429 RATE_LIMITED with Retry-After and no-store; a rejected
callback is never acknowledged with 200.

Source-IP trust: X-Mega-Client-IP only when the immediate socket peer matches the explicit
trusted-proxy allowlist AND X-Mega-Proxy-Key passes a constant-time comparison against the
host-managed proxy secret (loaded through readSecretFile; never the Core ingress HMAC secret).
Unauthenticated proxy assertions refuse 403. Client Forwarded / X-Forwarded-For and provider-supplied
identity fields are ignored. IPv4, IPv6 and IPv4-mapped IPv6 are canonicalized before hashing; the
bucket key is a purpose-separated HMAC of the address (no raw address persisted or logged).

Deployment notes: the production secrets dir needs proxy.secret (the same value the Caddy edge sends
as X-Mega-Proxy-Key; MEGA_PROXY_SECRET_FILE may point at the deployment path) and
MEGA_TRUSTED_PROXIES should include the edge container network (e.g. 172.18.0.0/16,127.0.0.1/32).
No Caddyfile change required (it already sets both headers). Rollout: stage through the real proxy and
replay representative callback bursts before the separately approved production rollout; monitor 429/503
aggregates without logging payloads or addresses. AdMob retries unsuccessful callbacks only five times
at one-second intervals, so verify burst headroom explicitly. Roll back to a verified limiter-bearing
build or prior tested thresholds; never silently disable admission protection.

Implementation (commit 0e3c486): packages/services/provider-callback-limit.js (limiter + edge-only
source resolver + canonicalizer), the three admission gates in apps/api/routes/monetization.js
(before signature work, 429 + Retry-After + no-store on refusal, fail-closed 503 when absent), the
facade checkCallback(req, provider) in scripts/v51/v5-production-server.cjs, and
tests/v52-provider-callback-rate-limit.test.js (11 cases: budget, provider/source independence,
two-instance aggregate on one pool, fail-closed storage, the proxy-trust matrix, equivalent-IP
spellings, route 429/Retry-After, byte-for-byte SSV pass-through, fail-closed missing admission).

P0 latent defect found and fixed on the same lanes (same commit): apps/api/routes/monetization.js used
sendJson WITHOUT importing it - every monetization response path (status/ticket/claim/... and BOTH
webhooks and the SSV callback) would have thrown ReferenceError, failed the route's own code/status
classification, fallen through to the API 404, and silently broken all commerce the moment the merged
trunk deployed. The route now imports sendJson from ./helpers, and route-level regression tests
exercise the real handler end to end (admission order, refusal response, byte-for-byte SSV
pass-through, fail-closed missing protection). No production deployment happened with the defect: the
live src-final tree predates the commerce routes entirely (verified read-only on the VPS).

## Decision 2 - SEC-V52-CASHFREE-IDEMPOTENCY-RACE: IMPLEMENT NOW (SPEC RECORDED, implementation open)

Both createCashfreeOrder (packages/services/commerce.js:607) and createPolarCheckout
(packages/services/commerce.js:764) call the provider BEFORE the durable (actor, op_key) fence: a
concurrent same-key race orphans one provider order (never double-grants). The fix is
reserve-then-create; the subagent approved it as an owner-level economic-state-model change with this
exact spec:

- New additive migration packages/migrations/migrations/0058_commerce_create_requests.sql in the
  0056/0057 style (runner: current-role comment, explicit grants): monetization.commerce_create_requests
  with request_id UUID PK (app-generated), actor_id TEXT NOT NULL REFERENCES identity.actors(actor_id)
  ON DELETE CASCADE, op_key TEXT NOT NULL (1-160 commerce grammar) with UNIQUE(actor_id, op_key) across
  both providers, provider TEXT constrained to cashfree|polar, product_id, the SHA-256 command
  fingerprint, and an immutable server-selected price snapshot (Cashfree INR amount or Polar price id
  plus cents with provider-specific shape checks), state TEXT constrained to PENDING|READY|UNKNOWN|FAILED,
  nullable provider_object_id TEXT (provider-specific ID grammar when present, UNIQUE
  (provider, provider_object_id)), nullable bounded response_text (only the successful response
  projection), nullable sanitized error_code, created_at/updated_at, CHECK that READY requires a
  provider id and response, and an index on (state, updated_at) for reconciliation. Grants: SELECT,
  INSERT, UPDATE to core_runtime; SELECT to backup_reader. No runtime DELETE, no API/worker access.
  Append the checksummed manifest.json and conformance.json entries; add the relation to
  packages/db/pg/readiness.js.

- Flow: (1) validate inputs, keep the existing account/wallet-readiness/catalog gates, and return
  historical completed orders without another provider create. (2) In a short Core transaction,
  acquire the existing actor lock order, check V35_COMMANDS outcomes, and reserve the unique
  (actor, op_key) row as PENDING with the frozen {type, productId} fingerprint and server price
  snapshot. (3) COMMIT before external I/O; ONLY the successful reservation inserter calls the
  provider; a conflicting provider/product/type returns IDEMPOTENCY_CONFLICT and a matching concurrent
  request returns 503 CHECKOUT_CREATE_PENDING with Retry-After: 2. (4) Cashfree uses the order id
  allocated and stored during reservation; Polar carries request_id in server-owned checkout metadata
  next to the existing actor/product binding (do not assume Polar provides external idempotency).
  (5) Persist the returned provider id, then atomically commit the existing provider-ledger row, the
  successful command outcome, and the reservation READY state; keep account checks; a failure after
  provider creation must retain the returned id for reconciliation; expose a checkout response only
  after finalization commits.

- Safeguards: do NOT use the existing transaction() helper to cache a PENDING response (it would
  become a permanent successful replay) - extend its operation-key checks so no other commerce command
  can claim a key reserved for creation. Never hold PostgreSQL transactions, wallet locks or advisory
  locks across provider I/O; never use process-local promises as the fence.

- Failure/recovery: bound provider creation to a 10-second transport deadline. Timeouts,
  disconnects, malformed successful responses and failures after dispatch become UNKNOWN; a PENDING
  request older than 60 seconds is treated as UNKNOWN. NEVER automatically repeat an ambiguous create
  or steal its reservation after a timeout; a late response from the original attempt finalizes only
  its matching request id. Only an explicit provider rejection proving creation failed becomes
  terminal FAILED (replay returns its stored sanitized failure). Reconcile UNKNOWN through provider
  reads using the reserved Cashfree order id or the Polar request metadata, then finalize the SAME
  reservation; never tell clients to mint a fresh key for an unresolved request. Preserve all existing
  independent settlement verification, amount/currency/metadata binding, refund tombstones and
  receipt identity locks.

- Two transport defects to fix while in these paths: commerceCommand
  (packages/services/core-gateway.js:342) drops productId, customer, orderId and checkoutId - forward
  them as explicitly allowlisted fields while retaining signed-header authority; and both provider
  adapters' default fetch wrappers discard the second argument - preserve (url, init) so method,
  authentication, body and the timeout signal reach native fetch
  (packages/services/cashfree.js, packages/services/polar.js).

- Tests (tests/v52-commerce-create-race.test.js plus the existing suites): barrier-controlled
  same-key concurrency across TWO commerce instances sharing REAL PostgreSQL (exactly one provider
  create, one recorded order); conflicting products/providers/ops fail before external creation while
  independent actors stay independent; completed replay returns the recorded response without another
  create; crash after reservation, lost provider response, failed finalization and restart never
  trigger automatic re-creation; UNKNOWN reconciliation and late completion cannot overwrite another
  request or duplicate settlement; a reservation alone changes no balance, entitlement or ledger; the
  actual API -> signed gateway -> Core path preserves all creation/status fields; and the fresh
  migration, the 0057->0058 upgrade, replay/checksum verification, constraints, backup reads and
  least-privilege denials all pass.

- Rollout/rollback: serialize the migration with the integration owner; stage the 0057->0058 upgrade
  and interrupted-create recovery before production; drain creation requests during the approved
  migration/application swap (never run old and new creators concurrently); RETAIN the new table and
  all reservations during rollback; never reverse the schema or reactivate SQLite. An unmodified
  pre-0058 binary is NOT a valid rollback (packages/db/pg/readiness.js:60 requires the exact migration
  count) - prepare and test a PostgreSQL-compatible rollback build that recognizes 0058, preserves
  reservations and disables new creation while settlement/reconciliation continues.
