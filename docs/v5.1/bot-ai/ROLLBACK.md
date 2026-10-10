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
Expert and preserves the unverified-local-ai result class. That fallback is a
component contract; the full product UI is still unfinished. Until integrated
and tested, do not advertise playable Impossible or a working fallback screen.
Terminate inference on cancel/unload, fence late results and reinitialize only
from verified pinned bytes. A cached file alone does not establish game readiness.

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
