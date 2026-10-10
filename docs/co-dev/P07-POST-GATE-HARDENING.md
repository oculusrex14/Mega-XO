# P07 post-gate co-developer review — matcher claim fencing and hint authorization

**Branch:** `co-dev/v5-integration` | **PR:** [unified #9](https://github.com/oculusrex14/Mega-XO/pull/9)  
**Upstream checkpoint:** G07 was accepted at `045d5f94a13485486d5e5ab6a3dd5f8616604008`, which is merged into this branch; its owner ledger and evidence were not changed.  
**Scope:** post-gate hardening only. No matching windows, placement pools, user economy, queue pricing, Crown utility, UI, V4 production or P08 Core code changed.  
**Acceptance:** original G07 remains owner-recorded; these new changes need exact integrated CI/real disposable PG16+Redis execution before merge.

## Findings and fixes

### 1. An expired matcher could remove a successor's claim or active FIFO candidate

**Root cause:** `RELEASE_LUA` deleted the Redis claim key without comparing ownership and could remove the queue ticket/index with `requeue:false` even if the original claim's TTL had expired and a NEW matcher had already acquired the same actor. The release function also ignored the opaque `claimId` returned by `claimCandidates`.

**Fix:** Lua now compares `ARGV[4]` (the exact token) with `GET KEYS[3]` before ANY deletion or mutation. A missing/stale token is a complete no-op and returns `false`. `releaseClaim` requires `claimId` with `INVALID_CLAIM_ID` on absent/invalid tokens. Every call from `matchTick`, including mismatched occupancy, unpaired FIFO release and successful pairs, now supplies the token of the originating claim. This prevents ABA claim-handoff interference without new Redis state or a durable/economic policy change.

**Integration contract change:** Any real caller previously invoking `queue.releaseClaim({ mode, actor, requeue })` must pass **`claimId` returned by its own `queue.claimCandidates()`**, never re-read the current claim ID from Redis to "make the release work." That would recreate the stale-owner vulnerability. P07 suite direct calls were updated.

**Real Redis regression** in `tests/v5-p07-queue.test.js`: claim A with 250ms TTL, wait for expiry, claim B, ask A to `requeue:false` and `requeue:true`; both must return false, preserve B's lock and the original FIFO joinedAt; an absent token must refuse; B's correct token releases normally.

### 2. An untrusted Redis hint could disclose a different actor's match

**Root cause:** `status(actor)` resolved `queue:match:<actor>` hints with a targeted `match.matches WHERE match_id=$1` query, without checking that `actor` was a participant. A stale or corrupted Redis hint could cause `status` to surface an unrelated match's ID, terms hash and expiry despite durable PostgreSQL being the intended authority.

**Fix:** `readMatchById(matchId, actor)` now requires `JOIN match.participants p ... WHERE m.match_id=$1 AND p.actor_id=$2`. Invalid hints are evicted; `status` falls back to a normal durable match lookup and then queue status. The existing participant path is preserved.

**Integration regression:** `tests/v5-p07-queue.test.js` opens a REAL Core queue offer for Alice and Bob and injects an unrelated actor's hint into the OWN test Redis namespace. Carol must see `idle` and her poisoned hint is deleted; the actual two participants still see their offer.

### 3. A failed PostgreSQL hydration could strand live queue claims

**Root cause:** after `claimCandidates`, `matchTick` fetched account/relationship/history data from PostgreSQL without cleanup on a failed read. A transient database failure left claims locked until their TTL instead of immediately returning them with FIFO state intact.

**Fix:** if hydration throws *before a Core assignment command is sent*, release only currently owned claims using `Promise.allSettled`, then rethrow the original PG error. A genuinely stale claim is not touched because fix #1 fences its token. The matcher never pairs without PG truth. A real-Redis test injects a throwing PG read after real queue admission and confirms the healthy matcher can reclaim both users immediately with the same FIFO timestamps.

## Verification and follow-up

**Integrated, zero-skip suite (exact checked-out PR head; provider-owned disposable only):**

```sh
node --test --test-reporter=tap tests/v5-p07-policy.test.js tests/v5-p07-queue.test.js tests/v5-p07-match.test.js tests/v5-p07-recovery.test.js
```

The three new tests extend `tests/v5-p07-queue.test.js`, and the prior direct `releaseClaim` assertions in queue/match/recovery suites pass explicit claimId. The suite requires the repository's **owned** PG16 and Redis loopback test guards; use the existing `.github/workflows/v5-postgresql.yml` service setup. Without providers, integration tests skip by design; skips are **not** accepted as a pass.

**Executed code-side review, not G07 replay:** all four updated P07 JavaScript files parsed successfully in V8. The actual updated `queue.js` was loaded against stubbed PG/Redis interfaces: a non-participant hint was rejected/evicted; a real participant hint resolved; stale claim release returned false, current token returned true, absent token raised `INVALID_CLAIM_ID`. This is **not** an execution of Lua on real Redis or of the full PG integration tests.

**CI blocker:** GitHub Actions on PR #9 has repeatedly returned failed jobs with no assigned runner and zero executed steps. The primary agent must investigate repository Actions runner/minutes/billing/service state, rerun exact-head tests and record new proof before merging. Never infer that the old G07 evidence automatically covers the changed queue SHA.

**Remaining risk to evaluate later:** timeouts of non-cancellable Redis commands may have an indeterminate result even when the caller reports unavailable. The service must continue to treat PG as match/economy authority, reconcile joins after temporary outage and avoid pretending a timed-out Redis write was definitely rolled back. A broad queue-protocol redesign is explicitly **not** part of this post-gate fix and should be evaluated with real fault injection, not speculatively patched during P08.

**Safe merge boundary:** This branch modifies `packages/services/queue.js` and three P07 integration test files (plus additive documentation). The primary agent should review its current P08 dependency/import surfaces before integrating, ensure source hashes/evidence are repinned and rerun P07 zero-skip plus P08-to-date suites. Do not modify `docs/v5/progress.json` or overwrite P08 runtime work to force a merge.
