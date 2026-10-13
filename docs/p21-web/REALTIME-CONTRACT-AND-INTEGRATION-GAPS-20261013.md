# P21 realtime contract and integration gaps — 2026-10-13

Source audit against Main 2e8e501a6c9770a15383fd392c3323c652daf977 and website e9eab5753fe9ee8552f3b7f9d1be6ad5e7e3deec. These are source findings; actual authenticated browser WSS/two-account settlement remain NOT_RUN. No backend, training, ticket policy, TTL, permissions or production state was changed.

## R15-HTTP-WSS-PUBLISH-01 — source-observed staging composition gap

`scripts/v51/p21-staging-server.cjs:180` creates Core with `createCoreService(corePool)`. Ephemera is created afterward and is passed to queue/realtime, but not Core. Core's post-commit publisher depends on that adapter (`packages/services/core.js:386`, `:490`). Realtime subscribes to `core-match` (`packages/services/realtime-transport.js:857`). Direct WS commands broadcast locally, so the existing socket-command smoke can pass while an HTTP move from the current browser produces no matching socket hint. Main must wire the owned adapter through Core composition and prove an HTTP move reaches a second authenticated browser subscriber after commit. No database grant change is needed or authorized by this finding.

Reproduction to run after approved actor handoff: two linked staging actors join/accept the same match; one subscribes via scoped ticket and `/realtime/v1`; the other issues the existing `/api/v1/move` HTTP operation. Require the subscribed peer to receive a fresh authoritative snapshot without making its own polling request. Preserve operation keys/actor membership and the unchanged 15-second offer TTL. A direct WS move is a separate case and does not close this one. Runtime result: NOT_RUN.

## R15-TERMINAL-SNAPSHOT-02 — equal move revision can conceal settlement

Resign/timeout can settle a game without adding a move or changing its move revision (the resign contract is tested in `tests/v5-p08-commands.test.js:659`). Resume at the current revision returns ack only (`packages/services/realtime-transport.js:995`), and the hint handler suppresses an already-broadcast revision (`:848`). Therefore an equal revision does not establish that status/deadline/receipt is unchanged. Main must test and correct terminal delivery; the browser must request a fresh full snapshot on reconnect/equal-revision recovery, rather than deriving a board or settlement from ack. Preserve canonical move revisions and Core-owned settlement.

Required runtime case: subscriber has applied revision N; peer resigns through HTTP; subscriber must discover FINISHED and the Core receipt at revision N. Also test timeout/void and reconnect at N. Runtime result: NOT_RUN.

## Exact current wire contract

- Same-origin API base: `https://command.tail95c48c.ts.net`; WSS ingress path: `/realtime/v1`.
- `POST /api/v1/ticket` accepts only `{matchScope: matchId}` through the shared account client; response `{ok:true,ticket,expiresAt}`. Issuer TTL is 10 seconds; no socket URL is returned. Never log/cache tickets.
- Redeem: `{protocol:'realtime/v1',operation:'ticket.redeem',ticket}`; ack binds the ticket scope or auth, revision 0.
- Subscribe: `subscribe,match_id`; receive snapshot envelope containing the existing Authority.view DTO.
- Resume: `resume,match_id,ack_revision` of the last actually applied snapshot; can produce ack or up to 10 missed moves as delta followed by snapshot. Do not count ack/delta as an applied board.
- Snapshot: `snapshot,match_id,expected_revision,snapshot` and optional server_now. Preserve id/players/status/symbols/revision/state/terms/quote and applicable deadline/settled/receipt. Do not synthesize names, clock, payouts or revisions.
- Recovery HTTP `/realtime/v1/snapshot?match_id=...` returns the envelope, while `/api/v1/match/:id` returns the bare DTO. Recovery is independently authenticated/no-store; actor is only a mismatch assertion.

Sources: `apps/api/routes/competitive.js:341`, `packages/services/tickets.js:45`, `packages/services/realtime-transport.js:18`, `scripts/v51/p21-staging-smoke.cjs:1130`, `packages/services/core.js:648`, `src/authority.js:104`.

## Safe frontend slice and remaining acceptance

No reusable browser realtime client exists: src/network.js provides HTTP and apps/web/app.js polls every 2.5 seconds. The optional game-runtime.js file is absent, not a generated implementation. Add an isolated reader with actor/match/route/socket/lifecycle fencing, fresh scoped tickets, subscribe/resume/full-snapshot recovery and explicit teardown. Keep existing HTTP mutation/poll recovery until real opponent push and terminal delivery pass under the deployed CSP in all supported browsers. On authoritative terminal state, retire inputs/transport and refresh actual profile/wallet/rank.

Do not automatically retry an uncertain socket mutation over the current HTTP path. Transport adds key inside its Core move command; HTTP does not. Core fingerprints exact principal/command JSON (`packages/services/core.js:159`), so same operation key across these different payloads can cause IDEMPOTENCY_CONFLICT. Main must verify canonical cross-channel replay before any such fallback is implemented. Socket ack has neither operation ID nor a board.

Main owns publisher/ticket/service composition and settlement correctness. Codex owns the browser reader/presentation and actual browser acceptance. Required evidence is exact deployed source/bundle/process identity, two approved actors/private sign-in handoff, HTTP-to-peer socket push, equal-revision terminal delivery, reconnect/full game settlement and native continuity. Source audit and local synthetic UI passes do not close R15. Rollback: no operational change; revert only future owned frontend commits through ordinary reconciliation if needed.
