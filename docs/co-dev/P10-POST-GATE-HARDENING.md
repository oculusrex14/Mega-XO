# P10 post-gate hardening and integration handoff — 2026-10-09

**Branch:** `co-dev/v5-integration` | **Base:** primary accepted P10 G10 at `ca789f9c` | **Production:** unchanged V4.1.2 authority.

## Integration provenance

A two-parent commit `ba1be63b` imported all 26 P10-owned files from primary unchanged and combined the shared PostgreSQL workflow instead of overwriting P07/P08/P09 post-gate security suites. The merged workflow now requires all five original P10 real-PostgreSQL suites, the extra P08 security cases, and zero skipped suites. The co-dev branch keeps the P04 frozen-clock fixture fix absent from primary `ca789f9c`; the latter has a reproducible P04 assertion failure at line 356 in GitHub CI. This is a fixture-clock defect, not proof of a production database write error.

## Corrections on top of G10

1. **Mail dispatch budgets (`worker-workflows.js`).** Before: remaining allowance was checked only for nonzero, but a full `limit` batch could still be claimed and dispatched. Now the claim limit is `min(configuredLimit, remaining daily/monthly allowance)`. This is still process-local/advisory, not a durable globally coordinated provider quota.
2. **Worker graceful stop (`worker-workflows.js`).** Before: `stop()` cleared `inFlight` and returned while provider delivery or durable settlement was still executing. Now it clears the interval and rejects new work, but awaits the actual in-flight pass and closes workflows in `finally`. Shutdown is a drain barrier, not a provider cancellation guarantee.
3. **Provider finalize duplicate-enqueue fencing (`provider-workflows.js`).** Before: a duplicate receipt verification upsert reset even an unexpired `lease_owner/token` and could admit a second consuming finalizer mid-call. Now all fields on terminal `done` or actively leased rows remain unchanged; only unleased/expired pending work can be refreshed. `completeFinalization()` refuses to call the provider when its claimed lease already elapsed.
4. **Refund/provider race (`provider-workflows.js`).** Finalization now checks immutable `monetization.store_revocations` as well as `monetization.receipts.refunded`: a recorded chargeback/void cannot be consumed while the separate Core receipt-reversal workflow remains pending.
5. **Provider diagnostics and operator token custody.** Notification failures persist only allowlisted error categories; raw exception strings may quote credentials or player data and must never enter `last_error`. `listPendingFinalizations()` now reports a token-presence boolean, never the raw provider purchase credential. The actual worker claim still receives the credential for authorized provider delivery.
6. **Dead-letter retry (`jobs.js`).** A failed job seals its payload `NULL`. Previously `retryDeadLetter({id})` requeued that empty body and could allow a worker to claim and treat an undeliverable business event as completed. The operator must now supply a new validated `payload` (and optional version/businessKey/fresh expiry); the retry atomically restores the new envelope. Missing payload or stale expiry fails closed before any database mutation. This is a deliberate P10 operator API change: update future callers rather than relying on payload-free retries.

## Evidence and tests

- Additional real PostgreSQL cases in `tests/v5-p10-provider.test.js`: duplicate enqueue cannot invalidate a live provider lease, operator pending-list token redaction, expired claim cannot contact provider, refund tombstone blocks consume before Core reversal, and raw provider error strings are never persisted.
- Original real PostgreSQL `tests/v5-p10-jobs.test.js` now asserts a payload-free dead-letter retry fails and a deliberate replacement body survives requeue/claim.
- New provider-free `tests/v5-p10-worker-hardening.test.js` asserts claim count respects near-exhausted mail allowance and shutdown awaits an outstanding dispatch/settle. It is a mandatory Node24 step with no-skip TAP coverage in `.github/workflows/v5-postgresql.yml`.
- Treat **only GitHub Actions successes for the exact combined source SHA** as executed proof; older G10 acceptance evidence belongs to primary, and the earlier 11/11 green co-dev code lacked P10. Do not mark new fixes accepted from static review alone.

## Remaining high-value integration work

- P11 must wire trusted P05 HTTP identity and revoke checks into the hardened P08 HTTP polling/socket transport, never use user-supplied `actor` query parameters as identity.
- P10 should use unique per-process worker IDs; P09 timer claims need claim-specific release and cross-room economic concurrency validation. A worker crash after a provider call but before durable acknowledgement still requires real provider idempotency and reconciliation: local lease fencing cannot guarantee exactly-once delivery over an external network.
- Real provider notification authentication, callback ingress, Google Play/Apple store configuration, production email transport, global rate allowances and integrated worker scheduling must be verified in isolated staging. `createWorkerApp` covers mail/privacy; do not assume its timer automatically drives every separate provider/season service unless explicitly composed.
- P15–P20 source CI and simulator proofs do not substitute for integrated staging/provider/device tests or production transfer. V4 production and Crown/gameplay rules were not modified.

**Do not merge solely because draft PR #9 is structurally mergeable.** Sync any newer primary commits, review exact-head CI with no skips, and preserve owner gate/evidence policy. No live environment, store, Neon, Redis, Vercel, VPS or secret changes were made here.
