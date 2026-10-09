# P22 — Production authority transfer: preparation only

**Branch:** co-dev/v5-integration / [unified PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)  
**Primary agent:** owns the V5-platform execution ledger and P07–P14 runtime  
**Actual P22 gate:** OPEN. **No production operations have been performed.**

This report implements *static, offline and synthetic* safeguards before the P22 prerequisite (P20 and other acceptance gates) is complete. It follows [P22](../../Mega-XO-V5-Implementation-Pack/phases/22-production-transfer.md) and [the cutover specification](../../Mega-XO-V5-Implementation-Pack/specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md). It does not build the owner-deferred P21 website.

## Implemented (six planned P22 tasks)

| Task | Committed component | Proof scope |
|---|---|---|
| V5-22-01 | scripts/v5/p22/readiness.js | Requires accepted G00–G20, exact SHA/immutable image IDs, all 12 evidence classes; always denies live deployment |
| V5-22-02/03 | scripts/v5/p22/writer-fence.js | 16 *minimum* mutation classes, frozen V4 restart fencing, prewrite V5 denial, provider retry-no-ACK |
| V5-22-04 | scripts/v5/p22/import-reconciliation.js | Frozen source/run/schema equality, zero unknown/differences/invariant faults and 12 durable-family hashes |
| V5-22-05 | scripts/v5/p22/rollback-policy.js | P18 cutover-state integration; even a session or provider inbox write makes V4 rollback unsafe; UNKNOWN is quarantine |
| V5-22-05 | scripts/v5/p22/compatibility-map.js | Retained browser/native and old callback mapping through one PostgreSQL authority; old-domain cookie continuity |
| V5-22-06 | .github/workflows/v5-p22-cutover-readiness.yml and tests/v5-p22-*.test.js | Read-only V5 push/PR CI, pinned checkout, zero-skip suites; no provider access |

**Important:** all operator packets are declarations, not independently authenticated observations. Every result has cutoverAuthorized:false or an equivalent denial. Do not wire an assessment into runtime write admission. No production authorizer, migrator or deployer has been added.

## V5-22-01: release go/no-go

1. Confirm exact running V4 immutable image/tag, true source health, recent verified backup and **real independent restore**.
2. Require G00–G20 accepted by the owner ledger. G15 DR, G16 Core A/B, G17 immutable releases, G18 staging, G19 capacity and G20 real native/device/store evidence must be actual executions, not fixture claims. P21 new website is deferred.
3. Verify candidate Git SHA, Core/Worker immutable registry digests, production schema manifest, API/Vercel deployment ID, supported client/protocol versions, all required CI run conclusions, provider regions and billing constraints. Do not rely on an uploaded JSON's claim that CI passed.
4. Run offline: node scripts/v5/p22/readiness.js --sha EXACT_40_CHARACTER_SHA. It reads the owner ledger and reports missing gates. Optional sanitized operator packet: --packet .artifacts/p22-readiness.json. Even an all-claimed-PASS packet only returns CLAIMED_COMPLETE_UNVERIFIED.

## V5-22-02: nonserving production preparation

Only after prerequisites, stage production-configured API/Core/Worker **without admitting any application write**. Audit actual HTTP methods including lazy GET bootstrap/session, queues that advance clocks, workers, timers, provider callbacks/inbox, webhooks and maintenance/ops mutations. Health probes GET/HEAD /livez, /readyz or /healthz must be independently shown not to write. **GET is not automatically read-only.**

Use the writer-fence module as a **minimum inventory**, not proof that all real V4 paths were discovered. Add every uncovered route/job to the owner-maintained inventory. No new VPS public listener or override of existing V4 Caddy is implied.

## V5-22-03: drain and freeze sole V4 writer

Use existing maintenance behavior to stop *new* competitive entries but preserve active games, unexpired timers, escrow, purchase state and provider retries. Do not void active games or refund Crowns merely to simplify deployment. Freeze every V4 mutating path, scheduler, operator job, pending callback and automatic restart. Verify the fence survives a process restart and an actual host/container reboot. Record final consistent immutable SQLite backup, source release/schema/snapshot hash and audit observation.

**Frozen callbacks:** return retryable failure, never HTTP success/ACK before durable persistence. If V5 has already durably accepted a provider event, the irrevocable first-write boundary has been crossed even if no game move occurred.

## V5-22-04: final import/reconciliation

Use the already-built P03 snapshot/extract/load/verify tools against the actual frozen source and intentionally nonserving V5 production target; earlier P03 production-copy evidence is **not** this final snapshot. Preserve run ID, source model fingerprint, schema checksum and detailed private row-ledger differences. Compare per-actor wallet/ledger/escrow/receipts, identities, privacy tombstones, sessions, pending provider inbox/outbox and all other durable families. Zero unclassified source locators, zero unexplained differences, zero invariant faults and zero unverified rows required. Never invent import grants, reset deadlines or ignore an unexpected source family.

The P22 import-reconciliation module validates **sanitized family count/hash receipts** anchored to the same frozen snapshot, model, run and target. Actual CLI results and source/target private database hashes still require independent verification; source-level success does not authorize write activation.

## V5-22-05: one authority and the first-write boundary

The retained browser game runs at https://play.antimatterinnovations.com. Its host-only cookies do **not** cross automatically to api.megaxo.online. Keep the approved old-origin facade or use a verified bounded one-time session exchange. Never create a second actor to compensate for an old cookie. Android/iOS and old email/store/ad callbacks use the same permanent actor and PostgreSQL backend. Before transfer, old callbacks retry safely; afterward, they forward through one durable deduplicating inbox and ACK only **after commit**. P21 apex website remains dormant.

The first accepted post-import **application** write to V5 PG—login, session refresh, profile save, queued job, callback inbox, currency or gameplay—is the irreversible boundary. Record exact epoch/reference; keep V4 permanently fenced.

- **Prewrite:** restore sole V4 only after independently proven zero V5 application writes, unchanged frozen SQLite and a complete V4 reboot-fence audit. Explicit human/operator review still required.
- **Postwrite:** use a tested PostgreSQL-compatible previous image/forward fix. Never restore old SQLite or assume DNS/Vercel rollback undoes effects.
- **UNKNOWN, stale evidence or incomplete writer inventory:** quarantine and reconcile; do not guess that a missing application-write log means no write was accepted.
- **At all times:** no independent concurrent SQLite and PostgreSQL application writers even during old-origin DNS/cookie propagation.

Synthetic P18 state-model exercises in tests/v5-p22-rollback-policy.test.js check these two rollback classes but are not cutover acceptance.

## V5-22-06: controlled post-transfer smoke

After authorized transfer, verify real old-client/native identity and wallet/rank, game revision/deadline and payout, worker/inbox/callback idempotency, session revocation, safe support lookup, private ops health, external alerts, backup freshness plus a **retrieved and independently restored PG backup**. Record actual production release digests, source checksum, first-write reference, support/trace ID and recovery class. Do not mistake liveness, synthetic rehearsals or a provider dashboard screenshot for full acceptance.

## Development checks and blockers

Run node --test tests/v5-p22-*.test.js and node scripts/v5/p22/readiness.js --sha EXACT_SHA. Both trusted V5-push and PR workflow executions require **zero failures and zero skips**. An exact fetched-code V8 harness with Node stubs executed 31/31 P22 pure test bodies without failure at co-dev SHA a04f623e1aa8; this is not Node24 CI, provider or actual staging evidence. The current P08 owner ledger (G00–G07 passed; G08–G20 missing) MUST produce BLOCKED; that is the expected safe result, not authorization.

- G08–G20 (including G20 real native device/store evidence) are not accepted; the primary agent must finish them independently.
- Actual V4 restart fence, live no-write proof, final production import, old-domain cookie/legacy callback routing, first-write epoch, production smoke and backup/alerts are **NOT_EXECUTED** here.
- GitHub Actions on PR #9 has been failing before runner allocation (0 executed steps). Root cause requires owner GitHub Actions runner/billing/service investigation. No exact-head green CI claim until jobs run.
- No V4 stop, Neon/Redis/R2/Vercel provider mutation, paid upgrade, domain change, deployment or store submission was made by this P22 work.

**Gate G22 stays OPEN.** The integration agent may merge static foundations after reviewed CI and keep this runbook for later actual cutover, when prerequisites and provider/device evidence exist.
