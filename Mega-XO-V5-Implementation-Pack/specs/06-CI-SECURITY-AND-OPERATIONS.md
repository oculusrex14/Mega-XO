# CI/CD, security, observability, backups and operational readiness

Applies to all phases, with completion milestones 13-19. These controls must be introduced incrementally, not postponed until the platform is already deployed.

## 1. CI starts at the foundation

The inspected `.github/workflows/v35-validation.yml` only triggers V4-era branches and `v4.*` tags [R05]. Add V5 branch/PR validation immediately without removing the retained V4 pipeline or publishing production from every branch push. Carry forward existing Node regressions, design invariants, balance/economy models, abuse tests, deployment syntax, Chromium accessibility and monetization UI tests. Add wider UI parity coverage for the four themes.

Select/pin dependency versions and generate the actual lockfile when dependencies are introduced. Root `npm ci` is not a valid baseline command before that. New proposed scripts such as `test:v5:db` must be implemented before documentation claims they run. Keep an inventory of commands and their intended database/environment.

Incrementally add PostgreSQL repository/integration tests, migration replay/reconciliation, Redis compatibility/loss, multi-Core concurrency, realtime reconnect, worker interruption, schema permissions, provider fixtures and native compile/device evidence. Test fresh install and migration from each supported release schema. Production-data restore drills use restricted execution, not general PR infrastructure.

## 2. Independent immutable service deployment

Build separate Core and worker images from an exact commit, including tested ARM64 support for the Oracle host. Record immutable digest, source revision, version, configuration/schema/protocol compatibility, SBOM/provenance and test evidence. Publish to private GHCR with scoped authentication and verify authenticated pull on the actual host. Never retag an existing release to mean different bytes.

Vercel previews are nonproduction. For production, stage a production-configured build without moving public domains, run the allowed checks, then promote that exact production deployment. Do not assume promoting an arbitrary preview preserves the tested build and environment [E06,E07]. Keep production secrets out of untrusted PR builds and browser bundles.

Use expand -> compatible deployment -> backfill -> switch -> later contract. Only a dedicated migration identity applies schema changes under a lock. API, Core and worker do not all have to deploy simultaneously; publish an explicit compatibility matrix. Retain a prior PostgreSQL-compatible build for rollback after cutover. A Vercel rollback cannot reverse database mutations.

Native signing/distribution is a separate trusted pipeline. Source-only preview jobs never obtain store credentials or provisioning keys. Pin Actions to reviewed commit SHAs and explicitly restrict token permissions. Do not publish `.env`, `.vercel` pulled secrets, raw provider receipts, authenticated browser storage or production snapshots in artifacts.

## 3. Security boundaries and regression checks

Preserve isolated audit HMAC, existing OTP encryption, strict provider validation, runtime non-root/read-only constraints, no server fingerprint, safe diagnostics and loopback/Tailscale operator access. Audit-chain migration keeps historical verification keys and chain boundaries; never re-sign old records under the session key. Concurrent V5 audit append requires deterministic sequencing or separate verifiable chains with documented linkage, not racy global hash updates.

Enforce exact CORS/origin policy, cookie CSRF, request/body/message limits, service assertions, replay controls, field allowlists and session authorization. Rate limits are distributed but ephemeral-loss behavior is explicit. Do not let a forged forwarded-IP or actor header bypass controls. Support IDs stay opaque and user-safe; trace IDs never encode player identity.

Test API role attempting economic writes, worker role attempting payout, runtime DDL, forged/expired/wrong-audience credentials, replayed internal command, stolen ticket reuse, origin mismatch, account deletion races and unauthorized match subscriptions. Provider webhooks use actual signed/authenticated verification and durable dedupe; IP allowlisting alone is not verification.

Preserve moderation review-only behavior and approved gameplay. Architectural security controls are not permission to reintroduce restrictions on bought Crowns or auto-ban based on an abuse heuristic.

## 4. Operational telemetry and health

Emit structured, sanitized logs with environment, service/version, trace/request/support IDs, route template, duration, result code and operation ID reference. Redact authorization/cookies/provider receipts, sensitive query strings, emails, OTPs, credentials and raw bodies. Use bounded retention and sampling consistent with approved privacy policy.

Collect HTTP p50/p95/p99/error rate; Core move/settlement latency; WebSocket count/reconnect/disconnect/backpressure; active matches/queue wait; PostgreSQL latency/lock waits/pool saturation/storage; Redis latency/errors/eviction; worker backlog/oldest age/retries/dead letters; purchase/SSV failure/retry lag; audit failures; event-loop lag; host CPU/RAM/disk; backup age/size/duration and restore outcome. Avoid actor/match IDs as unbounded metric labels.

Separate:
- Liveness: process responsive; not an assertion every dependency is healthy.
- Readiness: can this instance safely receive its role's work?
- Operations health: freshness/recovery/backlog/critical system controls, including backups.

Detailed metrics stay private. Public endpoints remain minimal and do not leak schema/provider/host data. Do not turn a stale backup `/opsz` red status into green by redefining it as liveness. Health-check behavior during maintenance/drain must be tested so the load balancer does not route new work to a draining instance.

Retain existing UptimeRobot and mail alerts, then add independent API/realtime operational checks and private alerts. Force a staging failure and recovery to prove actual delivery. Logs alone are not monitoring evidence.

## 5. Recovery targets and independent backup design

Freeze numeric recovery/latency/capacity targets in an ADR before production enablement. Proposed starting objectives, not measured claims: independent database backup age at most 15 minutes under normal operation, tested full restoration within 60 minutes, and Core-process reconnection within 10 seconds on a controlled healthy network. Validate cost/load feasibility; change a target only with documented rationale, never quietly mark it met. Neon recovery characteristics must be established against the actual paid plan/configuration, not assumed from the product name.

Enable Neon restore history/PITR and prove a recovery point. Separately schedule consistent `pg_dump` logical backups through a **direct**, not transaction-pooled, endpoint [E01,E02]. Use a compatible pg_dump/pg_restore version. Encrypt before upload to an isolated R2 backup repository, protect keys off-host, verify upload/checksums and apply explicit retention. Backups contain sensitive user data; never store plaintext in repo/CI artifacts.

Include schema/migration version, release/config references, ownership/role restoration procedure and nonsecret provider inventory. Database dumps do not automatically reconstruct DNS, signing keys, encryption keys, all roles or store configuration. Recovery material and custody must cover those dependencies without mixing secret values into a public manifest.

Initial retention proposal for measurement: short-interval backups retained for one day, daily for 14 days and weekly for eight weeks. Apply only if compatible with the owner's approved retention/deletion policy and storage budget. Existing policy wins; do not invent legal retention. Estimate actual compressed/encrypted size and revise the obsolete V4 2 GiB assumption explicitly.

## 6. Restore proof

Restore a selected R2 backup into a completely isolated target and run schema, identity, per-actor wallet/escrow, purchases/revocations, match/tournament, privacy/tombstone and audit invariants. Demonstrate recovery into a separate PostgreSQL instance/project so it does not depend solely on the original Neon account. Disable outbound jobs/provider effects until recovery validation completes.

Exercise Neon PITR separately. Record actual RPO/RTO, source/backup/target IDs, encryption-key retrieval proof without values, checksum, invariant results and cleanup. A backup upload or `pg_restore` exit code alone is insufficient. Repeat after schema changes and on a scheduled basis; implement scheduling as part of V5, not a promise that this planning chat will run it later.

A restore older than a deletion or purchase notification can resurrect data or replay effects. Design tombstone/revocation/provider reconciliation and a quarantined restore workflow before re-enabling users. Never merge restored data over a live writer opportunistically.

## 7. Load, chaos and operational limits

Measure the actual baseline and define expected launch traffic; do not invent a customer forecast. Where no forecast exists, run increasing controlled tiers and publish measured safe limits rather than calling them launch guarantees. Exercise API reads/auth contention, sockets, live games, queue/tournament creation, settlements, provider retries and worker lag together. Target headroom above the chosen launch envelope; the original 10x suggestion is a stress objective, not evidence of capacity.

Test slow/down PostgreSQL, pool exhaustion, Redis wipe/outage, lost pubsub, Core death, worker kill, client network transition, duplicate/out-of-order commands and provider events, rolling drain and DNS/endpoint transitions. Show safe rejection/backpressure and recovery without inconsistent economic effects. Limit tests on the shared Oracle host to isolated controlled resources and protect V4/co-hosted workloads.

Report sustainable throughput, concurrent clients/matches, p95/p99 latency, saturation point, resource usage, recovery duration and configuration. An empty database benchmark does not prove behavior with historical data. Alerts must trigger before the measured cliff, with runbooks linked to the failure mode.

## 8. Operational handoff

Deliver startup/shutdown, migration, rollback, secret rotation, signing/key rotation, incident lockdown, private operator access, backup/restore, provider notification replay, DLQ inspection, data export/deletion and account support runbooks. Preserve the dedicated audit secret and historical V4 release/backup records. Every production release has an exact manifest and a prior compatible fallback; every unresolved issue has evidence and an owner, not a vague blocker label.
