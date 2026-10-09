# P09 post-gate tournament fencing and co-dev integration review

**Status:** post-G09 source hardening on `co-dev/v5-integration`; **original owner G09 remains accepted** at `f2863ab1b60fdc9fabce0193d486bc118acb2514` (21/21 original real PostgreSQL16 tests). **Main agent:** G10 accepted and P11 active. **Production:** V4 remains sole live authority; no host, database, Redis, DNS, billing or player data touched.

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

## Bug 4: in-command terminal settlement committed no outbox delivery

**Fault:** The normal, player-driven terminal path `run(... resign/move/cancel)` executes `settleRoom`, then writes wallets/ledgers/receipt and finishes. Only the separate `settle(roomId)` service path called `emitSettlement`. When the normal path settled first, later workers correctly saw `settled:true` and returned without writing any event. **Result:** financially correct payouts/refunds could be invisible to the durable P10 outbox consumer.

**Fix:** Only if `settleRoom` actually performed a payout or refund, `run` now queues the exact same deterministic `tournament.settle:<roomId>` ID and minimal routing payload before the encompassing transaction commits. The unique outbox ID and `ON CONFLICT DO NOTHING` prevent duplicate events; any event insertion error rolls back the room and financial changes together. Completed/replayed settlements do not enqueue additional events. The event carries no wallet amounts, balance snapshot or receipt body.

**Real-PG regression:** `tests/v5-p09-recovery.test.js` now checks payout and cancellation/refund through ordinary game commands, verifies the committed outbox event exists with the correct `refunded` flag, and proves an entire worker restart, command replay and standalone `settle()` replay never rewrite the event.

## Bug 5: public table join could overwrite a finalized room snapshot

**Fault:** `publicJoin` read all active rooms while holding only the **room-set advisory lock**. Standalone `settle` does not take that advisory lock, and can commit terminal status while the join is running. The join previously obtained the candidate from the old snapshot, took wallet locks, then overwrote the room by saving that old document. It skipped the row lock acquired before wallet changes by other room commands and by settlement.

**Fix:** When an existing public room is selected, take its **room-row `FOR UPDATE` lock before actor wallet locks**, then reload the room under that lock. A room that became terminal, changed table or filled up while waiting is **not overwritten**; normal public matchmaking creates a fresh lobby instead. No participation, entry-fee or cohort rule changed.

**Real-PG regression:** `tests/v5-p09-lifecycle.test.js` now holds the selected room row in an independently-owned admin transaction while another real Core pool attempts a join; the admin transaction closes the room, and the join must create a different lobby without resurrecting the terminal status, changing the original roster or holding phantom escrow.

## Bug 6: pre-lock publicJoin balance was treated as authoritative

**Fault:** `publicJoin` needed a read-only economy snapshot to choose a cohort and reject obviously unfunded joins, **before** locking actor wallets. The aggregate cache was then reused for `state.write` and any debit, even if a different transaction had changed a player's wallet while the join was blocked. The intended wallet lock only protects reads and writes **after** acquiring it, not the earlier selection snapshot.

**Fix:** Added the explicit, internal `tx.repositories.state.refresh()` operation in `packages/db/pg/repositories.js`, which clears the **current transaction's** unmodified cached aggregate and rehydrates from PostgreSQL. `publicJoin` calls it **after** room/actor locks; it then rechecks live verified eligibility, active occupancy and affordability before any financial write. All other commands retain their existing scoped read; previously mutated documents are never refreshed/discarded. The refresh is not an HTTP endpoint, never contacts production, and preserves all original balance/pricing rules.

**Real-PG regression:** A player begins a funded join from the selected room; a separate transaction holds the room lock and reduces that player's test-wallet balance to zero before releasing it. The waiting join must refuse `INSUFFICIENT_COINS`, leaving the locked wallet balance, room roster, reservation and operation ledger unchanged.

**Verification boundary:** The original G09 gate is still accepted by the owner for its original source. These newer co-dev changes are **NOT** automatically gate-accepted. Run the existing `v5-postgresql.yml` P09 suite (five source files, strict nonzero passes / zero skipped), full cross-phase P08/P10 worker tests, and the exact-head 11 Actions workflows. Neither production financial writes nor the primary G09/G10 evidence were changed here.

## Integration caveats and next checks

- The claim and completion methods are **trusted Core/worker internals**, not authenticated Internet RPC surfaces. Real P10 workers must supply unique per-worker/process owner IDs and carry the returned `{owner,epoch,until}` claim state through every mutation, with the current room revision and actual database eligibility rechecked. **The existing timer release API only checks owner**, so if a worker ID is recycled before an old release finishes, owner-only release could still be unsafe. P10 should use unique instance IDs and add a claim-specific release fence before exposing cross-process work.
- `createRoom` / `saveRoom` are privileged repository maintenance endpoints that accept complete room documents. Do not expose them as client operations or use them to overwrite live rooms without authoritative revision validation. Normal `run` and `settle` already have their own serialized transaction semantics; direct saved documents are not a user command.
- Tournament settlement must remain PostgreSQL-authoritative, under room -> sorted actor wallets/occupancy -> dependent ledgers/records/outbox lock order. P10 integration should rerun overlapping worker progression, expiry/settlement, cross-room wallet contention and system-burn conservation against actual concurrent PG transactions. No claim is made that a finished P09 source check alone proves the deployed worker and provider integration.
- The P08 co-dev `authenticateHttp(req)` real P05 session verifier and long-lived WebSocket revocation checks remain separate required host integrations; no URL actor or Redis presence is an authorization token.
- **Executed post-gate source proof:** Original owner G09 accepted **21/21** tests at source `f2863ab1b60f`. The merged co-dev source `3c9c90c855e76e4e6d1773fdadb7971f20e6c7db` passed [PostgreSQL integration run 37944786000](https://github.com/oculusrex14/Mega-XO/actions/runs/37944786000): **25/25 actual owned PG16 P09 tests, zero skipped, zero failed** (the original 21 plus all 4 new cases), full zero-skip database coverage register and synthetic database cleanup. **All 11/11 GitHub Actions workflows** passed on the same pinned code SHA, including real Redis, Core A/B failover and native Android/iOS simulator checks. This does not mark P10 or later formal production/provider gates accepted; documentation-only commits after this source SHA need independent exact-head CI status.

**Operational result:** Only source code, tests, CI and handoff documents changed; no production writes, no in-game fee/rank rule changes, and no speculative infrastructure deployment.
