# Distributed Core, tournaments and durable jobs

Applies to Phases 4, 6-10, 12, 16 and 19. The approved domain policies stay unchanged; this replaces global serialization and process-local coordination with explicit durable ownership.

## 1. Unit-of-work and operation identity

Introduce a transaction context shared by repositories participating in one business operation. Repository methods do not open unrelated transactions underneath an already active command. Define safe retry classes, stable lock ordering and bounded lock/statement timeouts. A unique `(actor, operation-domain, operation-id)` key plus canonical payload fingerprint protects public commands. Preserve legacy key namespaces during compatibility; do not drop past responses while old clients can retry them.

A successful mutation records its outcome and outbox event in the same database transaction. Return the saved result on retry, including after a lost HTTP response. Do not include a rotating access token or volatile trace ID in the semantic fingerprint. Internal scheduled operations use stable identities derived from their business event, such as match/revision/deadline or season/publication version, not a fresh UUID each retry.

For financial operations, test complete rollback when any posting, result, rating or outbox write fails. A partially granted purchase with a missing operation outcome is unacceptable. External provider calls occur before or after a transaction according to the state machine, never inside a long wallet lock.

## 2. Managed Redis contract

Provision logically and credential-isolated staging/production services. Prefer a managed regional primary near the database/Core; local development may use a container. Record the provider, region, command support, memory/connection/request limits, persistence/eviction choices and costs. Upstash is a candidate, not an already provisioned component. Validate the actual Lua, sorted-set, TTL, atomic operation and pubsub behavior your adapter uses. Its REST capability does not mean a long-lived Core subscription should become a function-pinned loop [E08-E10].

Key format should contain environment and schema version, for example `mx:staging:v1:presence:<actor>`. Namespace alone is insufficient isolation for production credentials or eviction blast radius. Assign TTLs to presence, claims, reconnect hints and caches; bound cache and queue sizes. No public Redis port on the Oracle host, and no Redis credentials in clients.

Document degradation by operation. Public cache misses can query PostgreSQL. Presence can be temporarily unknown. Matchmaking may pause/rebuild. Security throttles need a bounded local fallback or conservative rejection, not unlimited credential attempts. Do not impose a new permanent player ban or change reward policy because Redis is down.

## 3. Matchmaking and actor occupancy

Keep existing skill windows, placements, recent-opponent/friend exclusions, cohort rules and anti-collusion behavior from `server/queue-session.js`, `server/matchmaking.js`, domain policy and their tests. Redis holds eligible candidate indices and heartbeat leases. PostgreSQL holds durable match assignment and any paid reservation.

Build join/cancel/heartbeat/expire/status as versioned idempotent operations. Multiple workers may claim candidates, but a Redis claim is not a monetary lock. At match creation, transactionally recheck both actors' account state, existing match/tournament occupancy, current rating/terms and balances; create the match and any applicable reservations; commit before returning a match ID. A database uniqueness/occupancy constraint prevents incompatible simultaneous work even when Redis is wiped or a stale worker wakes.

Define treatment of pending offers separately from an active match so you preserve current product behavior. Do not invent a global restriction banning all simultaneous invitations if the baseline permits them. Occupancy and claim semantics must reflect the existing queue/direct/tournament rules.

A crashed matcher can abandon ephemeral claims without losing assets. Reconstruct assignments from PostgreSQL and let unassigned clients rejoin with their prior operation identity. Test cancel-vs-claim, heartbeat expiry-vs-match commit, duplicate joins on two devices, direct challenge-vs-queue and tournament-vs-match races.

## 4. Live games, revision state and clocks

Persist match state, participants/symbols, accepted immutable terms, active status, revision, deadlines, operation outcomes and final settlement. In-memory state is only an optimization. A new process loads the committed state without invoking the V4 startup loop that voids valid games [R15].

Use the existing pure legal-move function. Lock or compare-and-swap the expected revision, verify membership/turn/deadline, persist the transition and outbox, then acknowledge. An event publication failure after commit must not undo a move or cause a second move on retry. Deliver revisions to both players through pubsub/socket routing; use bounded per-socket queues and disconnect slow clients cleanly, with snapshot recovery.

Timers use persisted absolute deadlines and a tested database/server clock convention. A move arriving on a deadline boundary races the timeout worker under the same transactional rule. Reconnect/restart does not grant a fresh turn duration. A duplicate expired-timer claim for an old revision does nothing. Clock skew and database latency must be measured without changing the approved turn rules.

Handle socket authentication timeout, maximum message size, heartbeat, rate budgets, subscription membership, token expiry, session replacement and graceful drain. Native foreground/background transitions may drop the transport but must not create a second match or actor. Keep the current HTTP snapshot/move fallback while clients migrate.

## 5. Tournaments and room semantics

Persist room ownership, code, roster, readiness, rules/version, fixture graph, clocks, match state, ranking, quote, contributions, escrow, payout/refund receipt, settled flag and revision. `RoomStore` currently updates room and economy together [R13]; preserve that atomicity when introducing repositories.

Private lobby host departure must still produce the approved `CANCELLED` behavior where applicable. Preserve formats, automatic public start, ten-player requirement, cohort spread, payout shares, burn, normal-Elo independence, review outcomes and accepted leave/pause controls. Do not make a Core restart act like a user leaving the room.

Claim due tournament work with transactional row locks, such as `FOR UPDATE SKIP LOCKED`, and durable lease/fence metadata when work spans transactions. A lease expiry never allows an old worker to commit after a newer owner has advanced the room. Settle/refund under one idempotent transaction and unique settlement identity. Race two payout workers and prove one financial effect. Test crash after match result, before fixture advancement, before payout and after commit but before response.

## 6. Worker/outbox semantics

`apps/worker` runs durable jobs for email/security notifications, purchase finalization, provider retry handling, privacy/deletion coordination, projections, cleanup and scheduled work. PostgreSQL records job identity, type, payload version, availability, attempt count, lease/fence, state, last sanitized error and completion. Sensitive job payloads are minimized and protected; existing encrypted OTP-email behavior must not regress.

Producers write outbox rows in their business transaction. Workers claim a bounded batch, perform outside-transaction I/O where possible, and complete only while holding a current fence. Use exponential backoff with jitter and bounded retries, a dead-letter state, private inspection/retry and an audit record for manual intervention.

There is no general exactly-once promise for network delivery. Use provider idempotency keys where supported; otherwise explicitly handle the 'sent but acknowledgment lost' case. Internal economic effects are idempotent Core commands, not direct worker wallet updates. Grant-state inspection is read-only. Google consume/ack retry starts only after the corresponding grant is committed; Apple device finishing also waits for delivery [R07,R14].

Daily/weekly/season jobs require stable period IDs and singleton business effects, not just a process-local cron. Preserve UTC calendar boundaries, qualification rules, snapshots and no-fabricated-snapshot behavior. Catch-up must distinguish missed work from already completed work and must not generate rewards that the approved rules never authorized.

## 7. Read models and multi-instance testing

Build authorized read models from committed records/outbox versions. Separate private strong-current responses (wallet/session/account state) from public TTL/event-invalidated projections. Return projection version/as-of metadata where useful. Do not use a stale cache to authorize spending, eligibility or moderation decisions. Cache invalidation races must not overwrite a newer projection with an older event.

Test Core A/B and multiple workers against the same database and Redis. Kill A before commit, after commit, after publish and during response; disconnect pubsub; restart workers; delete staging Redis; delay PostgreSQL; duplicate provider callbacks; drain while new users arrive. No test may run on production data or co-hosted unrelated services. Record process failover separately from host outage.

**Gate:** no lost durable command, no conflicting active assignments, no extra spend/grant/refund/settlement, latest-revision recovery works, and queues/cache/presence rebuild without permanent player damage.
