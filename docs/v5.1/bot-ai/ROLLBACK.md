# Local bot/tutorial rollback and release hold

This is a rollback plan, not authorization to merge or deploy. V4 production,
main, account authority, currency amounts/caps and backend schemas are outside
this change. There is no database migration to reverse.

## Search selector

Leave/remove the experimental flag or set `mega_v51_search` to `legacy` before
starting a NEW non-practice match. This selects the original G.choose engine.
Already-started matches pin their engine/seed; changing the flag is deliberately
not a midgame engine swap. Pause/leave the match to cancel its Worker. For an
urgent product rollback, revert the coherent Worker integration on the feature
branch and review the resulting native/P21 allowlists together; do not patch
only the UI script tag. Never force-push or overwrite independent P21 work.

The canonical move history is compatible with the original rules. Preserve it
before any local save conversion. Replaying through G.apply must succeed before
accepting a restore; reject corrupted histories rather than fabricating moves.

## Tutorial

Skip Guidance keeps the exact current board and unpaid practice classification.
Replay Explanation never undoes moves. Restart is explicit and practice-only.
Unknown lesson versions stop guidance but retain successfully replayed moves.
A coherent tutorial rollback removes its lifecycle hooks, scripts and scoped CSS
and corresponding native/P21 allowlist entries, not the player's entire save.
Normal accounts, wallets, rewards and statistics must remain untouched.

## Pack and inference

Keep APPROVED_CATALOG empty until release gates pass. There is no shipped model
or inference vendor library in this checkpoint. Removing a cached optional pack
must wait for in-flight writes and delete only that model URL, never saved human
moves or general localStorage. Do not purge unrelated P21/auth caches.

For future approved models, remove the affected catalog version from NEW match
selection, retain the saved match's pinned hash, and expose pack-unavailable or
corrupt recovery. Re-download must verify exact size/hash/version. Do not silently
swap weights in an active match. Model failure must not invent a win/loss.

The local-AI helper requires explicit confirmation to continue with labeled
Expert and preserves the unverified-local-ai result class. The fallback and
recovery screen IS integrated in the retained client and covered by the pack,
impossible-session and local-ai suites; what remains unproven is a playable
Impossible match on a physical device with an approved model, not the fallback UI.
Terminate inference on cancel/unload, fence late results and reinitialize only
from verified pinned bytes. A cached file alone does not establish game readiness.

## Public API routes (V5.1 integration)

The website/API integration added or changed these server behaviors; each is
reverted by reverting its own commit, never by restoring an old whole file:

- Public matchmaking queue (`apps/api/routes/competitive.js`,
  `packages/services/core-gateway.js`): admission/cancellation/status now traverse
  the signed Core ingress that owns the Core-side queue service, so the API holds
  no Core credentials. Reverting must restore BOTH the route and the ingress
  dispatch together; a half-revert leaves admission returning 503.
- Public leaderboard (`packages/services/core-gateway.js`, `apps/api/index.js`,
  `apps/api/routes/compat.js`): served actor-free over the same signed ingress
  because `api_runtime` has no `economy` SELECT. Reverting returns the previous
  silent empty 200; do not "fix" it by granting `api_runtime` economy reads.
- Offer/accept/decline/cancel routes (`apps/api/routes/competitive.js`): the four
  routes the route manifest declares. Reverting removes them; Core still supports
  the commands, so no schema or Core change is involved.
- Realtime ticket binding and logout fencing (`packages/services/tickets.js`,
  `core.js`, `realtime-transport.js`, `packages/domain/session-id.js`): client
  actor/session/generation/audience/env overrides are refused and the actor-auth
  mutex fences commands after logout. Reverting weakens a real security fix; do not
  do it to make a smoke pass. No migration is involved.

None of these change V4, the production database, provider configuration or the
release hold.

## Economy / delivery / verification

Maintain the first five BOT_PAY values and all caps. Guided practice and
unverified-local-ai results remain excluded from ordinary reward and quest
processing, including explicitly labeled Expert recovery. No client report is
promoted to an authoritative verified online result.

Before owner integration, re-run the feature tests, full Node CI, real HTTP
root/P21 Worker/tutorial/pack checks and native bundle validation. Repeat the
reference-device and user-study gates when hardware/participants are available.
Compare P21 shared-file changes to the latest V5.1 head; never restore the whole
old base. No CDN, Oracle service, native permission or live production change is
required to leave these experiments disabled.

### Already executed at the C9-integration checkpoint

- Full Node suite: 1402 tests, 1123 passed, 278 skipped, and the only failure is
  the owner-named pre-existing `opsz` backup-freshness test on an untouched file.
- Real loopback PostgreSQL/Redis: P05 30/30, P06/P11/P13 34/34, P07 16/16,
  P08 commands/transport/timers/restart/snapshot green, core-gateway 11/11, P21 106/106.
- Real Chromium: `/game` six-move guided + reload + handoff + five themes; root and
  `legacy-game` Worker cancel/resume; pack manager; real ONNX neural Worker PUCT on
  WebGPU with cancellation; device harness capture with Expert corpus p95 329.86 ms.
- CI: all four workflows pass on the pushed head.
- Isolated V5 staging: flows 1-11 pass against real Neon + Upstash; flow 12 is
  environment-gated by cross-region latency (V5-O017), with the accept route proven
  locally against real PG16 in ~1s.
