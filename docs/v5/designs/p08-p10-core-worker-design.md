# V5 P08-P10 Core/worker design (structured scout payload)

```json
{
  "summary": "Read-only design scout for V5 P08 (revision-based durable realtime Game Core), P09 (durable tournaments) and P10 (durable jobs/outbox/provider retries). Produced an implementable design that fits the already-landed P02 PostgreSQL schema (packages/migrations/migrations/0001-0024), the frozen realtime/v1 envelope (packages/contracts/realtime.js), and the P05/P06 designs (identity.realtime_tickets + SECURITY DEFINER redemption; Redis ephemera primitives due.claim/route/bus). Covers: ticket-redeeming WSS handshake with session-bound connection identity, ping/resume, bounded per-connection command queues and true HTTP fallback onto the identical Core command transaction; a complete command-kind → table mapping with lookup-before-stale-revision replay semantics preserved from DurableStore.run/Authority.move/RoomStore.run; durable clocks with PostgreSQL as the only clock of record and the exact replacement for V4 startup void/refund (free rooms PAUSE, paid VOID only pre-import/under operator command); (worker_id, epoch, monotonic fence) claims with stale-fence rejection SQL, clock-skew bounds and dual-Core P16 safety; a unified ops.jobs table + producers enumerated from live call sites, at-least-once/idempotent consumers, quarantine/DLQ and a per-interval removal map for community-server startWorkers and production main fast/slow; provider RTDN/Apple/SIV boundaries preserving finalize-before-grant ordering with dedupe tables. Also reports three concrete P02 schema gaps (no room escrow/settlement/fixture-revision/fence columns; store_notifications/reward notification dedupe has no state machine; worker_runtime holds no DELETE on store_finalize so the 1-hour abandonment DELETE cannot be ported), one frozen-contract gap (realtime/v1 cannot carry room commands), and the honest [P] list (managed Redis/Valkey and Neon/Vercel provisioning). No files were modified; nothing was built or executed.",
  "architecture": "Target topology unchanged from docs/v5/ARCHITECTURE.md: Vercel API (control plane, ticket issuer, read-only projections) → Oracle Game Core A/B (sole competitive/economic mutation authority, direct WSS + HTTP fallback into ONE command transaction) → Neon PostgreSQL (sole durable truth) ← Oracle worker (durable claims, external I/O, then Core commands) → providers; managed Redis/Valkey is only an accelerator (bus/route/due/rate) whose total loss is survivable because the claim of record is always a PostgreSQL row. Concurrency is expressed as: aggregate row lock first (match.matches / tournament.rooms FOR UPDATE), then core.actor_occupancy + economy.wallets in sorted actor order, then dependent ledger/outcome/outbox rows; identity is (actor_id, key, fingerprint) in the per-family outcome tables that P02 already created (economy.command_outcomes, match.move_outcomes, tournament.command_outcomes, social.command_outcomes, monetization.command_outcomes); scheduling is absolute timestamptz deadlines compared against PostgreSQL's clock, claimed with FOR UPDATE SKIP LOCKED plus a monotonic lease_token fence; jobs are ops.jobs rows with a business-derived identity (never a fresh UUID per retry) whose consumer effect is either an idempotent Core command or a fenced worker-local state transition.",
  "files": [
    {
      "path": "/Users/oculus/Downloads/Test XO/AGENTS.md",
      "description": "Invariants governing this design: single Core authority, committed moves/deadlines survive process death and cross-Core reconnect, no V4 startup void, no SQLite dual writer, integer currency, four themes/policy frozen."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/ARCHITECTURE.md",
      "description": "Ownership register + persistence/concurrency decisions 1-8 (unit of work, lock order, operation identity before stale rejection, external I/O outside monetary transactions, fencing, runtime roles, no restart-void recovery)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/ROUTE-AND-DATA-INVENTORY.md",
      "description": "Writer families §4 items 1-12 (DurableStore.run, Authority, CommunityStore.tx, EmailAuth, RoomStore.run/tick/recover, MonetizationStore, provider notifications, StoreBindings, matchmaker/queue Maps, jobs.maintenance, relational housekeeping, perimeter/MailOutbox/operator) plus constructor/startup hazards and the hidden-write list."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/designs/p02-schema-design.md",
      "description": "Authoritative table/column/constraint names this design must fit (§2 mapping, §3 hot-path indexes and sorted-lock access, §5 identity/fingerprint rules, §7 role grants, §8 risks R1-R12)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/designs/p06-ephemera-design.md",
      "description": "Redis primitives this design consumes instead of duplicating: bus/route/due/hint/budget contracts, due.claim lease semantics, key/TTL matrix, wipe-survival invariants I1-I9, dual-Core §5.3, removal plan R1-R13."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/designs/p05-session-design.md",
      "description": "identity.realtime_tickets columns, B5.2-B5.5 issuance/redmission/admission/lifecycle, C1 service assertion, C2 SECURITY DEFINER redeem function, C4 outbox-notices rule, Part F TTL/bound table (ticket 10 s, 3 outstanding, 4 connections, envelope caps)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0012_match.sql",
      "description": "Landed match aggregate: match.matches (revision BIGINT, state_json, deadline, expires_at, escrow, settled, receipt_*), match.participants, match.escrow_contributions, match.move_outcomes(match_id,key,fingerprint,result) + the OFFERED/PLAYING sweep partial indexes."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0013_tournament.sql",
      "description": "Landed room aggregate: tournament.rooms (revision, escrow, settled, deadline, paused_at, quote/groups/finalRefs/seed JSONB, ranking[], extra), room_players, fixtures (opens/expires/ready_deadline/turn_at/banks/history) and command_outcomes(actor,key). Shows the gaps this design must fill."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0011_core_occupancy.sql",
      "description": "core.actor_occupancy PK(actor_id) as the durable one-active-aggregate-per-actor constraint and the documented sorted-actor FOR UPDATE lock order."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0018_runtime_ops.sql",
      "description": "ops.outbox (state machine, next_at, lease_until, attempts, lease_owner, lease_token, sealed-payload CHECK), ops.rate_buckets, runtime.controls/state - the base this design extends with ops.jobs."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0015_monetization_store.sql",
      "description": "monetization.receipts / store_bindings / store_revocations / store_finalize (state,next_at,attempts,lease_owner,lease_token) / store_notifications(store,notification_id,received_at) - the provider dedupe and finalization tables the P10 design extends."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0021_grants_core.sql",
      "description": "core_runtime least-privilege surface used to check which writes Core may perform directly vs. which must be worker-owned."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0022_grants_worker.sql",
      "description": "worker_runtime grants: full DML on ops.outbox, SELECT/INSERT/UPDATE on store_finalize (NO DELETE - constrains the V4 abandonment DELETE port), notifications INSERT, privacy.requests transitions, support.events DELETE."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0009_economy_commands.sql",
      "description": "economy.command_outcomes(actor_id,key,fingerprint,response TEXT verbatim) + wallet_operations/daily_progress - the global durable-store command ledger including trusted 'clock'/'maintenance' principals (actor_id has no FK)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0016_cosmetics_season.sql",
      "description": "season.day_snapshots / weekly_payouts(payout_id PK, UNIQUE(week,actor_id)) / league_week singleton - the stable period identities the V5-10-04 catch-up jobs key on."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/migrations/migrations/0017_privacy_support_audit.sql",
      "description": "privacy.requests state machine + deletion_receipts + support.events retention + audit.operator_audit immutability triggers - used by the deletion/retention job and DLQ-audit design."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/contracts/realtime.js",
      "description": "Frozen realtime/v1 OPERATIONS/SHAPES/ENVELOPE_FIELDS/PUBLIC_CODES and byte caps; validateCommand restricts command to {type} (+{move:{b,c}}) and there is no room/fixture field - the hard constraint behind the room-command contract gap."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/domain/commands.js",
      "description": "Exact command-kind set and role table of the durable dispatcher (preferences…weekly/refund) - the enumeration mapped onto schema tables in §3.1."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/economy-store.js",
      "description": "DurableStore.run: fingerprint sha256(JSON.stringify({principal,cmd})), outcome lookup before command execution, single-transaction commitDomain + outcomes.save - the semantics V5-08-02 must reproduce."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/src/authority.js",
      "description": "Exact match semantics this design preserves: offer expires (15 s queue / offerMinutes direct), accept reserve+escrow+activeMatch+deadline, move (fingerprint hash({actor,revision,move}), per-match commands map, revision CAS, TIMER_EXPIRED, deadline renewal), expire/timeout/voidByOperator/_settle and the deterministic journal entry ids."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/rooms.js",
      "description": "RoomStore.run/tick/recover: party_commands id=JSON([actor,key]) fp=sha256(clone(cmd)), reserve/settle financial writers with '<room>:reserve|payout|refund:<actor>' journal ids, ROOM_LIMIT 3, operator cancel, tick settlement and the recover() paid-VOID/free-PAUSE+turnAt rewrite that V5-08-05 removes."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/src/tournament.js",
      "description": "Room/fixture state machine and every clock constant the durable clocks must reproduce (lobby expiry 300 s/1800 s, event deadline 2 h/6 h/24 h, roundDelay 15 s/5 s, ready window 120 s, readyDeadline 45 s, fixture revision = state.moves.length, pause/resume credit arithmetic)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/jobs.js",
      "description": "The 15 s in-process maintenance scan that issues snapshot:/weekly:/expire:/timeout: commands - the scheduler V5-10-01/04/05 replaces with durable jobs."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/queue-session.js",
      "description": "Queue Maps (seen/terminal/terminalAt/pendingTickets), 45 s disconnect, 300 s terminal retention, and the hidden write-on-read expire command inside _clean."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/matchmaking.js",
      "description": "sweep() pairing loop that commits store.run(matchmakerPrincipal(),'pair:queue:<uuid>',{type:'queue'…}) - the fresh-UUID-per-retry identity that spec 03 §1 requires replacing with a claim-derived identity."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/production/main.js",
      "description": "recover() (unverified-session purge, challenge consumption, VOID/refund every OFFERED/PLAYING match, rooms.recover) and the fast(1000 ms)/slow(15000 ms) intervals with their exact statements - the removal target of V5-10-05 and V5-08-05."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/community-server.js",
      "description": "startWorkers 1000 ms interval (matchmaker.tick, rooms.tick, community.cleanup, processPurchaseFinalizations) and the CLI boot path rooms.recover() then startWorkers()."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/production/mail-outbox.js",
      "description": "Sealed-payload AES-GCM envelope, HKDF key, mail-budget daily 80/monthly 2400 spend, 200-row queue cap, claim/update/lease 15 s, attempts<3, 15 s×(attempts+1) backoff, payload NULL on sent/expired - the outbox semantics ops.jobs must match or improve."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/google-play-notifications.js",
      "description": "RTDN handle(): auth.verify, notification_id dedupe SELECT-then-INSERT, base64 decode + size bound, packageName check, currentByToken state lookup, revoke → store_revocations + monetization.refund - reordered in §6."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/apple-store-notifications.js",
      "description": "Apple handle(): verifyJws, environment/bundleId/appAppleId validation, notificationUUID dedupe, signedTransactionInfo inspect, appAccountToken binding vs receipt actor, revoke path - and the dedupe-after-processing ordering defect."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/google-play-billing.js",
      "description": "verify() writing the pending consume/acknowledge row before grant, finalizeRow/finalize backoff min(3600000,15000·2^min(8,attempts)) and processDue()'s hasReceipt gate + 1-hour no-receipt DELETE that worker grants forbid."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/monetization-store.js",
      "description": "MonetizationStore.transaction command kinds (claim/redeem/equip/purchase/restore/ticket/ssv/automatic-permit), refund() as a separate transaction, purchase finalization wiring - producers for the P10 job kinds."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/production/email-auth.js",
      "description": "Mail producers: OTP enqueue (id = challenge id, kind 'otp'), password-changed notice ('changed-'+id, kind 'changed'), email-changed security notices ×2 - the transactional-enqueue list for §5.2."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/community-store.js",
      "description": "securityNotify hook wiring for provider_linked/unlinked/other_sessions_revoked/session_revoked, deleteAccount's single-transaction pseudonymization + privacy.requests/deletion_receipts writes, cleanup() retention DELETEs."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/http.js",
      "description": "Retained HTTP command surface (/api/v1/move|resign|offer|accept|decline|cancel|convert|quest|friend|cosmetic|preferences|purchase) and the read-time timeout/expire writes on GET /match/:id that V5 must make genuinely read-only."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/server/party-http.js",
      "description": "Room HTTP command path (/api/party/command + revision-conditional GET returning {unchanged,serverNow}) and the per-address 2400/60 s Map - the HTTP-fallback equivalence target for room commands."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/db/pg/pool.js",
      "description": "Default statement_timeout 5000 ms / lock_timeout 2000 ms / idle_in_transaction 15000 ms, pool max 4 queueLimit 32, shared per-target connection budget - the sizing basis for every lease/fence bound in §4."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/db/pg/guards.js",
      "description": "application_name '<role>/<service>/<revision>' contract, pinned-GUC drift check and ROLE_MISMATCH fail-closed behaviour that the Core/worker/matcher process identities reuse."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/packages/db/scopes.js",
      "description": "Per-family outcome SQL scopes (COMMANDS, PARTY_COMMANDS, SOCIAL_OPERATIONS, V35_COMMANDS) - the exact key layouts the replay semantics preserve."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/Mega-XO-V5-Implementation-Pack/phases/08-durable-realtime-core.md",
      "description": "V5-08-01..05 actions, verifications and the G08 exit gate this design is written against."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/Mega-XO-V5-Implementation-Pack/phases/09-durable-tournaments.md",
      "description": "V5-09-01..05 actions/verifications and the G09 exit gate (no double-pay/double-refund/lost escrow; approved lobby behaviour preserved)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/Mega-XO-V5-Implementation-Pack/phases/10-durable-workers.md",
      "description": "V5-10-01..05 actions/verifications and the G10 exit gate (jobs survive restarts, at-least-once + idempotent authorized effects, visible recoverable failures)."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/Mega-XO-V5-Implementation-Pack/specs/03-DISTRIBUTED-CORE-AND-WORKERS.md",
      "description": "Normative rules applied throughout: §1 operation identity, §2 Redis contract, §4 clocks/no startup void, §5 room semantics + SKIP LOCKED claims + indivisible settlement, §6 worker/outbox and period identities, §7 multi-instance kill points."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/Mega-XO-V5-Implementation-Pack/ACCEPTANCE.md",
      "description": "A-case wording for A11, A13-A22, A29, A31 which §7 hooks into each task."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/docs/v5/OPEN-ITEMS.md",
      "description": "Actual unresolved provider state (V5-O006 Neon Free-plan capability, V5-O009 Vercel/Marketplace unauthenticated) used to keep the [P] list honest and claim no provisioned Redis/Vercel/Neon."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/deploy/compose.yaml",
      "description": "Existing container/hardening baseline (app, edge, backup profile; non-root, read-only, cap_drop, immutable digest, loopback metrics) that the proposed V5 staging compose extends rather than replaces."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/tests/v5-pg-guards.test.js",
      "description": "Established container-test convention (one disposable postgres:16 on a loopback-random port, self-skip without Docker, role/GUC/TLS assertions) that the P08-P10 staging test plan mirrors."
    },
    {
      "path": "/Users/oculus/Downloads/Test XO/package.json",
      "description": "Confirms the only runtime dependency is pg (no ws), Node >=24, and the existing node --test script layout the new suites must join."
    }
  ]
}
```
