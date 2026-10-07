# Acceptance and definition of done

These scenarios supplement each phase gate. They are required evidence contracts, not claims that the tests already exist or have passed. Implement them in the repository and retain exact code/environment references. Full source/provider/device data stays restricted; publish sanitized summaries.

## Test matrix

### A01 - Product/source freeze (Phases 0-23)

**Exercise:** Compare approved rule/policy constants, differential game outcomes and four-theme screenshots on representative screens/devices.
**Pass condition:** No unapproved game/economy/visual/archived-feature change; justified native exceptions individually recorded.
**Evidence:** Commit-pinned hashes, screenshots, regression logs and exception register.

### A02 - Baseline and CI (Phases 0,17)

**Exercise:** Resolve actual green base and run V5 validation on meaningful commits.
**Pass condition:** V5 branch is covered; V4 pipeline/tags remain; no fake passed tests or secret artifacts.
**Evidence:** Git SHA, Actions run ID, commands/results and branch ancestry.

### A03 - Reported backup conflict (Phases 0,15,22)

**Exercise:** Inspect current ops status, actual backup repository and fresh restore; compare handoff and ledger.
**Pass condition:** Current fact is established; stale statement is explained; no destructive repository initialization.
**Evidence:** Snapshot/target IDs, timestamps, retrieval/checksum and restore result.

### A04 - Environment and role isolation (Phases 2,13)

**Exercise:** Use API/worker/preview credentials to attempt forbidden economic/DDL/production access.
**Pass condition:** Negative tests fail as designed; correct service role succeeds only on its authority.
**Evidence:** Role/grant tests and actual environment IDs without credentials.

### A05 - Migration framework (Phases 2,17)

**Exercise:** Create from zero and upgrade supported schemas under concurrent migrator attempts.
**Pass condition:** Only one migrator; checksums/history correct; runtime never alters schema.
**Evidence:** Migration IDs/checksums, create/upgrade logs and lock tests.

### A06 - Complete source coverage (Phases 3,22)

**Exercise:** Inventory SQLite relational schema and every serialized root/nested field variant; compare migration coverage.
**Pass condition:** All durable source data mapped or deliberately accounted for; unknowns not silently dropped.
**Evidence:** Coverage manifest and source snapshot/schema fingerprint.

### A07 - Per-actor reconciliation (Phases 3,4,22)

**Exercise:** Import accounts/identities/assets/ranks/receipts/history/social/privacy state; inject swapped-wallet test.
**Pass condition:** Exact per-actor/relationship values match; aggregate-only false success is detected.
**Evidence:** Restricted diff and sanitized zero-unexplained-difference summary.

### A08 - Deterministic restartable import (Phases 3)

**Exercise:** Repeat import, interrupt each batch and re-run near a quarterly boundary with non-UUID IDs.
**Pass condition:** No generated identities/default grants/time rollover; canonical target is equivalent.
**Evidence:** Rerun/interruption fixtures and canonical hashes.

### A09 - Escrow and ledger (Phases 3,4)

**Exercise:** Reconcile liquid/reserved/escrow and replay transaction fixtures including conversions/burn/grants.
**Pass condition:** No double counting or reapplication of legacy journal; postings match approved policy.
**Evidence:** Per-asset invariants, source-linked migration accounting baseline and transaction tests.

### A10 - Concurrent spending (Phases 4,7,9)

**Exercise:** Race entry, challenge, conversion and tournament reservation for the same actor.
**Pass condition:** No overspend, conflicting occupancy or changed charge timing; losing request has safe outcome.
**Evidence:** Parallel test trace, final wallet/reservation/operation rows, no PII in public output.

### A11 - Atomic result and payout (Phases 4,8,9)

**Exercise:** Inject failures between wallet/ledger/result/rating/outbox writes and race settlement/refund.
**Pass condition:** Everything commits once or rolls back; no duplicate result or payout.
**Evidence:** Transaction fault-injection logs and before/after invariants.

### A12 - Shared actor identity (Phases 5,20)

**Exercise:** Login/link supported email/Google/Apple across browser-style, Android and iOS clients.
**Pass condition:** Same actor and permanent bindings; no email-based merge or separate mobile account.
**Evidence:** Actor-hash comparison and real provider/device evidence, not raw tokens.

### A13 - Refresh and revocation (Phases 5,13,20)

**Exercise:** Race refresh, replay old refresh, revoke device/all devices, rotate keys with active sockets.
**Pass condition:** Legitimate parallel retry handled; real replay/revocation enforced; bounded documented revocation delay.
**Evidence:** Session-family/generation traces, key IDs and test outcomes.

### A14 - One-use realtime tickets (Phases 5,8)

**Exercise:** Redeem concurrently on two nodes, replay after Redis loss, try wrong session/env/audience.
**Pass condition:** Exactly one valid redemption; failures cannot join protected matches.
**Evidence:** Ticket-hash/redeem test result without ticket values.

### A15 - Redis complete loss (Phases 6,19)

**Exercise:** Wipe isolated staging Redis during queues, active games and pending effects.
**Pass condition:** Assets/results/identity intact; ephemeral state rebuilds or clients rejoin without losing money.
**Evidence:** Database before/after invariant report and recovery metrics.

### A16 - Matcher concurrency (Phases 7)

**Exercise:** Run multiple matchers with cancellation/heartbeat expiry/dead workers and conflicting entry paths.
**Pass condition:** At most one compatible durable assignment; no stranded paid reservation.
**Evidence:** Actor occupancy and assignment constraints tested under load.

### A17 - Committed move recovery (Phases 8,16)

**Exercise:** Kill Core before/after commit, publish and response; reconnect through other Core.
**Pass condition:** Latest acknowledged revision survives; duplicate retry returns prior result; no restart void.
**Evidence:** Operation/revision trace and recorded failover demonstration.

### A18 - Clock correctness (Phases 8,9)

**Exercise:** Race exact-deadline move/timeout and reconnect after process/clock disruptions.
**Pass condition:** Same accepted timer rule; no free extension, stale timer effect or double settlement.
**Evidence:** Deterministic clock boundary tests and durable deadline evidence.

### A19 - Transport recovery (Phases 8,20)

**Exercise:** Drop/reorder notifications, disconnect network, background/foreground app, use HTTP fallback.
**Pass condition:** Snapshot/revision reconciliation succeeds without speculative reapply or duplicate match.
**Evidence:** Network/device logs and match-state comparisons.

### A20 - Tournament behavior (Phases 9)

**Exercise:** Run public/private tournament lifecycle with host leave, concurrent timers and worker death.
**Pass condition:** Approved CANCELLED host-leave behavior; original cohort/payout/rank rules and escrow intact.
**Evidence:** Existing fixtures plus multi-worker end-to-end evidence.

### A21 - Jobs and outbox (Phases 10)

**Exercise:** Crash worker at claim/I/O/completion; deliver duplicates and exhaust retries.
**Pass condition:** Durable recovery, current fence required, idempotent effect and visible DLQ.
**Evidence:** Job state trace, provider idempotency evidence and private retry audit.

### A22 - UTC scheduled economics (Phases 10)

**Exercise:** Run duplicate workers and catch-up across week/quarter boundary.
**Pass condition:** Existing qualification, snapshot and payout rules; no fabricated missing reward periods.
**Evidence:** Seeded calendar tests and unique business-operation records.

### A23 - Vercel/Core ownership (Phases 11,13)

**Exercise:** Attempt direct wallet write and forged/replayed service assertion with altered actor/body.
**Pass condition:** API cannot grant; Core independently checks authorization/idempotency.
**Evidence:** Negative permission/security tests and sanitized distributed request trace.

### A24 - Retained browser compatibility (Phases 11,18,22)

**Exercise:** Run approved old-origin client against V5 facade and callback/session continuity.
**Pass condition:** Existing UI/contracts work; no shared-cookie-domain fiction or residual SQLite writer.
**Evidence:** Old-client E2E, CSRF/callback checks and authority-path evidence.

### A25 - Cache correctness and privacy (Phases 12)

**Exercise:** Clear caches, deliver old projection events, request private data across accounts.
**Pass condition:** Correct fallback, no old-version overwrite or shared-cache leakage; caches never authorize spending.
**Evidence:** Projection/cache replay and isolation test report.

### A26 - Private operations and audit (Phases 13)

**Exercise:** Probe public metrics/operator/server paths, verify migrated/new audit chain under concurrency.
**Pass condition:** Private surfaces inaccessible publicly; audit uses dedicated key and preserves historical verification.
**Evidence:** External/private probe results and audit verification without keys.

### A27 - Operational diagnosis and alerting (Phases 14)

**Exercise:** Force a staging failure/recovery and trace its support ID across services.
**Pass condition:** Alerts actually arrive; safe diagnosis possible; ops reflects backup/backlog not just liveness.
**Evidence:** Delivered alert references, trace sample and endpoint observations.

### A28 - Independent restore (Phases 15)

**Exercise:** Restore encrypted R2 logical backup to isolated PostgreSQL outside original project; run all invariants.
**Pass condition:** Data/config prerequisites reconstructable; privacy/deletion/revocation protections applied before service.
**Evidence:** Measured RPO/RTO, hashes, target IDs, invariant results and cleanup record.

### A29 - Process vs host availability (Phases 16)

**Exercise:** Stop one Core during active games and separately document shared host/edge failure impact.
**Pass condition:** Process failover works; same-host test not mislabeled host HA.
**Evidence:** Topology diagram and measured process outage/reconnect result.

### A30 - Immutable release compatibility (Phases 17)

**Exercise:** Deploy components in supported skew order and roll to prior PostgreSQL-compatible build.
**Pass condition:** Exact tested image/deployment used; migrations compatible; no data rollback hidden in app rollback.
**Evidence:** Release manifests, digest verification and rollout/recovery logs.

### A31 - Capacity and degradation (Phases 18,19)

**Exercise:** Run realistic mixed traffic/history tiers and dependency saturation/failure.
**Pass condition:** Measured safe envelope and backpressure; durable invariants remain true under overload.
**Evidence:** Reproducible load profile, p95/p99/resource metrics, recovery/alert outcomes.

### A32 - Real native artifacts and offline bundle (Phases 20)

**Exercise:** Compile/install genuine Android/iOS targets; inspect asset bundles; launch clean install offline.
**Pass condition:** Approved offline game works without new website; no server code/secrets or fake native target.
**Evidence:** APK/AAB/archive/IPA hashes where applicable; manifest and install/launch evidence.

### A33 - Native bridge security (Phases 20)

**Exercise:** Attempt untrusted-frame/navigation/request-path injection and inspect storage/backups.
**Pass condition:** Host tokens not exposed to arbitrary content; only trusted allowed operations; secure persistence.
**Evidence:** Bridge negative tests and storage/backup inspection without token values.

### A34 - Native purchases and restore (Phases 20)

**Exercise:** Run real sandbox pending/cancel/success/crash/replay/refund and cross-platform entitlement read.
**Pass condition:** One backend-verified grant; stored bindings preserved; finish/consume after delivery; no consumable remint.
**Evidence:** Device/build/store transaction references hashed or sanitized; grant/finalization evidence.

### A35 - Ads and consent (Phases 20)

**Exercise:** Test UMP state/forms before preload, reward callback delay/replay and interstitial entry conditions.
**Pass condition:** No premature ad requests, no client-only grant, no ads during prohibited gameplay; Remove Ads works.
**Evidence:** Device recording and SSV/ticket assertions with sensitive values removed.

### A36 - Native accessibility and parity (Phases 20)

**Exercise:** Exercise all four themes, keyboard/notch/small screen, VoiceOver/TalkBack and network lifecycle.
**Pass condition:** Approved layout/controls/game behavior preserved; unavoidable platform adjustments documented.
**Evidence:** Real device/OS/build matrix and before/after screenshots.

### A37 - Distribution and review truthfulness (Phases 20)

**Exercise:** Build/sign/upload with real authorized identities and inspect provider state.
**Pass condition:** Uploaded/submitted/reviewed/approved/enabled reported separately, no inferred approval.
**Evidence:** Version code/build number, track/TestFlight/submission IDs and provider status.

### A38 - Single writer and first-write fence (Phases 22)

**Exercise:** Rehearse all writer shutdown, exact import, read-only checks, epoch transfer, old endpoint/DNS overlap.
**Pass condition:** No dual authority; first post-import application write logged; stale V4 cannot resume.
**Evidence:** Cutover state/evidence timeline, source hash and mutating-path inventory.

### A39 - Rollback classes (Phases 22)

**Exercise:** Abort before first application write; fail after session/provider write and recover via PG-compatible build.
**Pass condition:** Only pre-write case may restore unchanged SQLite authority; post-write preserves PostgreSQL effects.
**Evidence:** Both rehearsals and actual release-compatible rollback references.

### A40 - Retirement and scaling discipline (Phases 23,24)

**Exercise:** Audit current writers/endpoints/archives and proposed scale actions against real metrics.
**Pass condition:** V4 not a dependency; retained evidence intact; only justified capacity added; website remains deferred.
**Evidence:** Final inventory, residual items, metrics/trigger/cost/rollback plan.

## Release-critical evidence levels

Code implementation and mock fixtures are only the first layers. PostgreSQL/Redis concurrency needs actual integration tests; Vercel/Oracle routing and restores need deployed staging; native identity/billing/consent/accessibility need real device evidence; store approval needs a provider-reported state. A source-only build cannot stand in for any later level.

Every phase report should list executed cases, actual failures, accepted scope exclusions and precise evidence gaps. The owner-deferred website is a scope exclusion, not a failed test. A real provider review still pending is reported as pending, not an engineering access blocker or invented approval.

## Final platform delivery

One production PostgreSQL authority, preserved actor/assets/rank/progress, compatible retained browser and genuine native apps, no unapproved product changes, independent proven restore, process failover, measurable operating envelope and a verifiable release manifest. Optional production SDK capabilities remain accurately flagged according to actual provider/device evidence; this does not disable the already-approved gameplay utility of existing currency.

## Residual item format

For every unresolved item give: task/case ID; evidence attempted; sanitized exact failure; target ID/environment; code/build completion state; who/what is needed; independent work completed; release impact; next executable action. Do not write only "external blocker" or silently mark a fixture as a device test.
