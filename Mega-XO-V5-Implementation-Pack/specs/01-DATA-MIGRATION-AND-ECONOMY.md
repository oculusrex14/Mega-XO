# Data migration and economic correctness specification

Applies to Phases 1-4, 7-10, 15, 18 and 22. This is a required design and acceptance specification; the importer and SQL described here must be implemented and tested. They do not already exist in this pack.

## 1. Establish the complete source model

At the verified baseline, `server/economy-store.js` persists a single `state(id=1,json)` aggregate and a relational `commands` table [R10]. `Authority.export()` defines serialized structures [R11]. Community, rooms, monetization, production migrations and provider stores add relational data [R12-R15,R22]. Therefore a table-only migration is incomplete.

On a consistent restored copy, inventory every table/index/trigger and each schema version. Search all constructors and migrations for DDL, plus every path that updates `state` or room JSON. Enumerate all root and nested keys actually present, including older-record variants. Produce a source-to-target inventory with: source locator, data owner, meaning, destination, conversion, idempotency key, retention decision, verification query, and coverage fixture. Every source field/table gets a destination or an explicit reason for non-migration. Unknown keys fail coverage review rather than being silently dropped.

Known mapping seeds, not a complete inventory:

| V4 source | V5 destination / treatment |
|---|---|
| `state.json.accounts` entry pairs | actors, wallets, eligibility flags, ratings, season state, daily progress, preferences and inventory |
| `state.json.matches` and nested command pairs | matches, participants, immutable terms/quotes, current state, deadlines, command outcomes, results |
| `state.json.receipts` | purchases, grants, non-consumable entitlements and reversal state |
| `state.json.snapshots`, `weeklyPaid`, `leagueWeek` | season/weekly publication and payout records; deduplication preserved |
| `state.json.journal`, `burned` | immutable historical ledger representation, system burn balances, explicit migration accounting baseline |
| Account social arrays / history / seasonHistory | canonical friendships/requests/blocks, authorized match history, rank/season records |
| `profiles`, `identities`, `email_credentials` | permanent actors/profile IDs, provider subject bindings, exact password hash/salt/verification state |
| `account_sessions`, sign-in/OTP state | deliberate compatibility migration or documented expiry policy, never silently upgraded authentication |
| `profile_saves` | revisioned practice archive, still non-authoritative for competitive assets |
| `party_rooms.json`, `party_commands` | rooms/tournaments/fixtures, reservations, payouts, room revisions and replay outcomes |
| `v35_commands`, `v35_tickets`, `v35_casual`, `v35_events`, `v41_ad_ticket_context` | monetization idempotency, grants, reward eligibility history and provider-ticket bindings |
| `v41_store_bindings` | exact persisted Google obfuscated account ID and Apple app-account UUID |
| Provider verification/finalization/notification/revocation tables | full purchase state machine, retry state and refund/revocation tombstones |
| Reports/privacy/deletion/audit/support tables | policy-bound records, tombstones, audit continuity and restricted diagnostic index |
| Existing email outbox and maintenance metadata | durable jobs/outbox or explicit drained/expired state, never duplicate sensitive email or weekly rewards |
| Presence/temporary guest sessions/rate buckets | migrate only if required for transition; otherwise explicitly expire/rebuild without asset or identity loss |

Actor IDs are validated text, not necessarily UUID. Do not cast them to UUID, regenerate tags, merge identities by email, or normalize usernames differently without proving collision behavior. Preserve case-insensitive email uniqueness equivalence in PostgreSQL and report any existing collisions.

## 2. Source capture and deterministic extraction

Use the existing tested backup/restore procedures or a proper SQLite backup API. Do not copy only the live `.sqlite` file while omitting WAL state. A final import requires a full writer freeze: application commands, cron/timers, admin mutations, purchase/SSV callbacks and background tasks. Merely hiding the UI or changing DNS is not a write freeze.

Record capture time UTC, source release/version, schema versions, immutable backup identity, checksum and relevant row/object counts. Keep actual data in encrypted, access-controlled temporary storage outside Git and public CI artifacts. Synthetic/sanitized fixtures are used for normal PRs. A production-derived staging copy needs explicit data isolation and outbound-email/provider suppression.

Parse raw `state.json` and room JSON. Do not construct `Authority` with a live clock: its restore path can initialize defaults and roll seasons [R11]. Never invoke `addAccount()` during import because it can generate identifiers or opening balances. Record any required explicit legacy transform, including time reference, source-version condition and test case. Random IDs for new normalized historical rows must be replaced by deterministic source-derived IDs or stable recorded mappings.

Make the importer target-aware: require an explicit environment ID, source fingerprint, empty migration namespace/expected migration-run ID and an advisory migration lock on a direct connection. Refuse an unknown target, an active production writer or a reused run with a different source hash. No automatic truncate/drop of an arbitrary database.

## 3. Schema and transaction requirements

Use checked-in ordered SQL migrations with checksums, a migration history table and a single migrator. Runtime constructors do not create/alter schema. Support clean creation, upgrade from each supported V5 schema, and expand/backfill/switch/contract compatibility.

Use integer units for Coins, Crowns, Cosmetic Credits and reservations. PostgreSQL BIGINT is suitable internally, but JavaScript boundaries must use safe-integer validation or explicit lossless strings/BigInt conversion. Do not silently turn unsafe integers into rounded JSON numbers. Retain the approved maximum/safe-integer policy. Elo requires exact hundredths: NUMERIC with appropriate precision or scaled hundredths, not truncation to integer Elo or binary floating recomputation during import.

Board state can remain a bounded JSONB snapshot per match with revision and checksum. Do not retain the entire economy as a single hot JSONB row. Normalize accounts/wallets/escrows/command keys and settlements sufficiently for independent transactions and constraints. Keep immutable terms/quotes so later policy deployments cannot change an already accepted match's payout.

Multi-record mutations use one unit of work. Define a lock order such as match/tournament identity, sorted actor occupancy records, sorted wallet IDs, then dependent rows; use it consistently and test deadlock retries. The exact order can differ, but it must be documented and globally consistent. No HTTP/provider call occurs while holding an economy transaction open.

## 4. Ledger and conservation semantics

The legacy journal includes liquid-balance movement for reservation, while reserved balances and room/match escrow are recorded elsewhere. Do not pretend it is already a full double-entry ledger or sum available, reserved and escrow as three independent holdings. Reserved holdings and escrow are two representations of the same encumbrance.

For each actor and currency compare exact pre/post **available** and **reserved** amounts. Separately reconcile each escrow and its contributions to the reserved total. Compare cosmetic credit balances, permanent ownership, equipped state, boosts and reward history. Preserve burn totals and historical receipts. Conversion uses the existing 10:1 game rule; compare individual currencies and conversion records, not only aggregate Coin-equivalent wealth.

Define the V5 ledger representation before importing. Import historical entries with immutable source references; do not replay them against balances that were already loaded. If historical records cannot reconstruct a complete double-entry history, retain them unmodified and create a clearly labeled migration opening/accounting baseline derived from the source snapshot. That baseline is a record of existing holdings, not a gameplay grant or unexplained adjustment. It must have per-actor source evidence and cannot conceal a mismatch. All subsequent V5 changes use fully auditable postings.

Conservation tests distinguish configured mint/burn/conversion operations from transfers/reservations. A normal transfer conserves holdings; an entry reservation moves available to reserved; settlement releases reserved, pays the approved payout and records the approved burn; verified purchases and existing reward rules are explicit issuances. Duplicate settlement, callback, import or retry adds no extra posting or entitlement.

## 5. Reconciliation output and import recovery

Produce both restricted row-level differences and a sanitized summary. The summary records counts, hashes and difference counts, not player PII. Required categories:

- Actors, tags, usernames, provider-to-actor bindings, password hash/salt and verification fidelity.
- Each actor's available/reserved Coins/Crowns, cosmetic credits, inventory, entitlement, rating, games, season and daily/weekly progress.
- Escrow contributions and settlement/refund state per match/tournament; active occupancy consistency.
- Match IDs, terms, state/revision/deadline, participants, results, history and operation outcomes.
- Purchase identities, account bindings, product/environment, grant/refund/finalization and provider notification dedupe.
- Friend graph, requests, blocks, profile visibility and cloud-save revision/content hash.
- Privacy/deletion/tombstone state, reports, audit verification boundary, job/outbox/retry state.

Counts and global currency totals are necessary but insufficient: swapping balances between actors must fail. Canonicalize ordering when hashing sets/maps, while preserving meaningful history order. Migration twice must produce equivalent canonical state and the same source mapping. Interrupt and resume at each batch boundary; no repeated batch can mint funds or duplicate identity/purchase records.

Stage imported data in a nonserving target and validate before activation. For large imports, use deterministic batches with recorded checkpoints and final cross-table validation rather than an unbounded transaction. Retry only known transient database errors. Unexpected source data produces an actionable discrepancy, not a generic 'best effort' skip.

## 6. Migration tests and release gate

Use fixtures for non-UUID actors, mixed-case email, linked Google/Apple identities, reserved balances, offers, live games, completed/refunded purchases, unprocessed notifications, interrupted jobs, deleted actors, quarterly rollover, legacy field variants and repeated operation keys. Include the exact approved bought-Crown challenge/tournament flows.

Differentially replay identical seeded commands against the legacy authority and PostgreSQL implementation with the same clock and randomness. Compare public responses, end-state balances/ranks/terms/results and documented exceptions. Do not use the legacy implementation's time-mutating restore as a source extractor.

**Gate:** zero unexplained differences, source coverage complete, duplicate/concurrent spend and settlement tests pass, restore-and-reimport verified, no production path reads SQLite after V5 activation. Preserve a signed/checksummed migration manifest with both source identity and target identity. See [cutover](07-CUTOVER-AND-LEGACY-COMPATIBILITY.md) for the first-write boundary.
