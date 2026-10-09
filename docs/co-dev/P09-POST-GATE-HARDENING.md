# P09 post-gate tournament fencing and co-dev integration review

**Status:** post-G09 source hardening on `co-dev/v5-integration`; **original owner G09 remains accepted** at `f2863ab1b60fdc9fabce0193d486bc118acb2514` (21/21 original real PostgreSQL16 tests). **Main agent:** P10. **Production:** V4 remains sole live authority; no host, database, Redis, DNS, billing or player data touched.

## Merge and contract preservation

The completed owner G09 was integrated as a **two-parent Git merge** `cff167f8b163341c489d6580c17f6530cb945151` preserving 18 upstream source, test, progress, decision and evidence files byte-for-byte. The sole path conflict was `.github/workflows/v5-postgresql.yml`. It was resolved separately in `e40b149839c15bac6c8e66bb7d37828bfb5b6da0` by **combining** the five upstream P09 real PostgreSQL suites with all co-dev P07/P08 security, timer, recovery and no-skip coverage. The owner `V5-platform` branch, `docs/v5/progress.json` and accepted evidence were not rewritten by the co-developer.

G09 implements the existing pure `src/tournament.js` game/tournament rule machine over durable PostgreSQL tables (rooms, roster, contributions, fixtures, records), including host-leave CANCELLED, pause/resume, lobby transfer, 200-Elo public cohort, existing Coins/Crowns fees, independent normal Elo, room-level locked settlement/refund, idempotent payouts, and recovery under concurrent workers. None of these product/economy rules were changed during hardening.

## Bug 1: active timer or fixture lease theft via larger requested TTL

**Fault:** `claimTimerLease` compared `timer_lease_until < new_until` while `claimFixture` compared `lease_until < new_until`. A second worker asking for a **longer** duration could acquire a currently live claim. Original tests used the same lease length for both workers, so this path was not exercised. The existing expiry check therefore did not actually protect ownership when lease lengths differed.

**Fix:** Both use the injected current clock `tx.clock()`, passed as a separate SQL bind, to compare `lease_until <= now` atomically inside the guarded `UPDATE`. An active lease is never stolen merely because its successor requested more time. A different owner takes over only after the incumbent's stored deadline expires. The actual owner can still renew its own lease. The atomically returned fence carries PostgreSQL room revision, never a caller-invented epoch. Supplied timer `epoch` is now a consistency assertion; omitting it remains backwards compatible and returns the current revision.

**Test:** The real owned PG16 `tests/v5-p09-fencing.test.js` suite adds a live incumbent lease of 20 seconds, tries another worker with an 80-second request both immediately and before expiry (must refuse), advances the injected clock exactly to expiry, and asserts takeover succeeds only then. Runs against both room timer and fixture leases.

## Bug 2: expired fixture completion and terminal fixture replay

**Fault:** `completeFixture` checked owner and room revision but **not the persisted lease deadline**. A worker that exceeded its TTL could still complete before a successor had re-claimed it. Also `claimFixture` admitted an unleased fixture regardless of status, including a previously `DONE` row, risking new background work and repeated revision advancement.

**Fix:** `completeFixture` now requires `lease_until > tx.clock()`, still checks the live room revision and owner in the same SQL update, and acts only for READY/PLAYING fixtures in RUNNING/PAUSED rooms. `claimFixture` only grants READY/PLAYING fixtures of RUNNING/PAUSED rooms. Neither a terminal room nor a DONE/BLOCKED fixture can be freshly claimed.

**Test:** Additional real PG regressions assert that (a) expired original owner returns `false` and does not mutate the fixture, (b) successor may claim and finish after expiry, (c) completed fixtures cannot be reopened or incremented twice, (d) terminal room rejects fresh timer/fixture claims.

## Bug 3: unchecked caller timer fence

**Fault:** Room timer claims wrote `timer_lease_epoch = input.epoch` without comparing it to `rooms.revision`. A worker could request a future epoch or renew a claim taken against an obsolete room revision and be handed that fabricated fence.

**Fix:** Timer `UPDATE` now stamps `timer_lease_epoch = revision` atomically and, when the caller supplies an epoch, requires it to equal the current revision. Missing epochs derive from durable current revision. An outdated worker attempting a stale-epoch renewal receives null without modifying ownership.

**Test:** A real PostgreSQL regression covers a forged future epoch, a valid omitted-epoch claim, a valid renewal and rejection after the durable room revision advances.

## Integration caveats and next checks

- The claim and completion methods are **trusted Core/worker internals**, not authenticated Internet RPC surfaces. Real P10 workers must supply unique per-worker/process owner IDs and carry the returned `{owner,epoch,until}` claim state through every mutation, with the current room revision and actual database eligibility rechecked. **The existing timer release API only checks owner**, so if a worker ID is recycled before an old release finishes, owner-only release could still be unsafe. P10 should use unique instance IDs and add a claim-specific release fence before exposing cross-process work.
- `createRoom` / `saveRoom` are privileged repository maintenance endpoints that accept complete room documents. Do not expose them as client operations or use them to overwrite live rooms without authoritative revision validation. Normal `run` and `settle` already have their own serialized transaction semantics; direct saved documents are not a user command.
- Tournament settlement must remain PostgreSQL-authoritative, under room -> sorted actor wallets/occupancy -> dependent ledgers/records/outbox lock order. P10 integration should rerun overlapping worker progression, expiry/settlement, cross-room wallet contention and system-burn conservation against actual concurrent PG transactions. No claim is made that a finished P09 source check alone proves the deployed worker and provider integration.
- The P08 co-dev `authenticateHttp(req)` real P05 session verifier and long-lived WebSocket revocation checks remain separate required host integrations; no URL actor or Redis presence is an authorization token.
- **Evidence scope:** Original owner G09 evidence is specific to source SHA `f2863ab1b60f`. New co-dev tests and SQL changes require their **own actual GitHub Actions PG16 run at a pinned co-dev SHA**, including zero skips/failures. A green current branch does not mark P10 or later formal gates accepted.

**Operational result:** Only source code, tests, CI and handoff documents changed; no production writes, no in-game fee/rank rule changes, and no speculative infrastructure deployment.
