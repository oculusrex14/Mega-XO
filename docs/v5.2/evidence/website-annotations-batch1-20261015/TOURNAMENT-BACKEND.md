# Tournament integration for annotation 9

Date: 2026-10-15. Source base: `8648d9e995ebf992efc432d074aed24671fc3d46` plus this batch's uncommitted backend changes; the integration owner records the final commit. Target: disposable loopback PostgreSQL 16.15 at port 63967, synthetic accounts and lab-created databases only. No staging/production deployment or real-player acceptance is claimed.

## Implemented contract

- `GET /api/party/capabilities` reads signed Core capabilities. A configured PostgreSQL tournament service advertises the four exact `src/tournament.js` table quotes. An unconfigured preview advertises `online:false`, `publicEnabled:false`, and no tables.
- `GET /api/party/rooms/:id` requires the existing verified linked session; Core returns `T.view` only to a room member.
- `POST /api/party/command` requires the same authentication, browser Origin/CSRF protection, and a durable client idempotency key. Public commands are limited to `publicJoin`, `ready`, `leave`, `matchReady`, `move`, and `resign`, with strict per-command fields and canonical `{b,c}` moves. Client actor, scope, name, room administration and arbitrary result/economy fields are refused.
- Dedicated `/ingress/tournaments/{capabilities,view,command}` routes verify the existing timestamp/path/actor/op-key/raw-body HMAC. Core invokes the existing PostgreSQL service with the signed actor and `scope:'player'`. The API has no Core pool or tournament-table grant. Stored account usernames supply public roster names.
- A bounded rotating Core timer sweeps at most sixteen rooms per pass. Each due transition takes a room-row lock and respects an existing live timer lease, invokes canonical `T.tick`, and commits any terminal public payout/refund, ledger, occupancy release, room update and outbox event in one transaction. It changes no clock, entry, prize, matchmaking window, game rule or Elo policy. Production/staging entry points compose this service and stop the single-flight timer before closing its pool.
- Ambiguous Core transport failures return retryable `503 SERVICE_UNAVAILABLE`; the browser can retain the original operation key instead of creating a duplicate command.

## Local verification

All commands ran with the host's injected `NODE_OPTIONS` removed and the existing dependency directory supplied through `NODE_PATH`.

`env -u NODE_OPTIONS NODE_PATH='/Users/oculus/Downloads/Test XO/node_modules' V5_PG_URL=postgres://postgres@127.0.0.1:63967/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 node --test --test-reporter=tap tests/v52-tournament-http.test.js`

Result: **13 passed, 0 failed, 0 skipped**. Evidence: `/tmp/mega-batch1-tournament-http.tap` during execution. Includes real cookie/Origin HTTP authentication, signed ingress tampering, unauthenticated and outsider isolation, ten-player public joining/readiness/reservation, canonical legal moves/opponent reads, same-key replay/conflict, API-role write denial, timer lease refusal, concurrent tick/refund, deliberately failed-outbox rollback, timeout/no-show/lobby expiry, bounded sweep rotation, and a completed public event's exact ten-place payout without Elo changes.

`env -u NODE_OPTIONS NODE_PATH='/Users/oculus/Downloads/Test XO/node_modules' V5_PG_URL=postgres://postgres@127.0.0.1:63967/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 node --test --test-concurrency=1 --test-reporter=tap tests/v5-p09-lifecycle.test.js tests/v5-p09-fencing.test.js tests/v5-p09-settlement.test.js tests/v5-p09-persistence.test.js tests/v5-p09-recovery.test.js tests/v5-p11-core-gateway.test.js tests/v51-v5-production-server.test.js`

Result: **49 passed, 0 failed, 0 skipped**. Evidence: `/tmp/mega-batch1-tournament-regressions.tap` during execution. An earlier parallel attempt exhausted local disk space while creating disposable databases (35 passed, 14 failed). The harness removed its own databases; the sequential rerun above passed. No unrelated files or databases were removed.

After the final retryable-transport-error adjustment, the gateway and composition subset was repeated with `--test-concurrency=1` against the same owned cluster: **21 passed, 0 failed, 0 skipped** (`tests/v5-p11-core-gateway.test.js tests/v51-v5-production-server.test.js`; `/tmp/mega-batch1-tournament-final-gateway.tap`). These 21 overlap the 49 above and are not additional unique coverage.

JavaScript syntax checks for the API route, gateway, tournament service and both composition entry points passed. `git diff --check` passed.

## Remaining acceptance and rollback

This is real local HTTP/PostgreSQL service verification, not two physical devices or a deployed browser tournament. Main must deploy the reviewed commit and perform the integrated browser acceptance before claiming those levels. Tournament updates use authoritative HTTP room polling in this website implementation; it does not claim a tournament WebSocket protocol. Advertisements/provider operations were not exercised.

Rollback before deployment: omit/revert this batch's backend commit. After deployment, first drain ongoing tournaments and preserve PostgreSQL authority, accounts, keys and rows; disable public admission rather than interrupting an active event's writer or restarting a SQLite service. No migration or grant change is required by this implementation.
