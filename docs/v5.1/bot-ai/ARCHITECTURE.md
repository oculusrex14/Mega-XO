# V5.1 bot intelligence and guided practice

## Authority and deployment boundary

Base: `f8913fd36566f0c96d0b755b1e4e57be1795a266` on `V5.1`.
Only `feat/v5.1-bot-ai-tutorial` is writable for this work. No merge, tag,
deployment, database migration, V4 runtime change or V5 cutover is authorized.
The owner-approved 82 tasks are in IMPLEMENTATION.md; progress.json is the
machine-readable evidence ledger. Checkboxes mean completed validation, not
merely code written. A partial task retains its unchecked checkbox.

## Local-first topology

The live UI state is always a canonical `MegaGame` state. Search receives a
copy with match ID, revision, seed, difficulty and budget. It cannot mutate
UI state, persistence, money, rank, or networking. A returned move must match
both match ID and revision and pass `G.legal`, then `G.apply` on the live state.
Cancellation terminates isolated work; no stale completion may commit a move.
The current `G.choose` remains the rollback engine. New search is opt-in until
paired-league and device gates pass. No change to canonical rules is needed.

Guidance is a declarative controller over the real practice match, never a
parallel game. Exactly six half-moves are scripted. Explanation acknowledgments
precede scripted bot moves; clocks and automatic scheduling pause during
instruction. Saves carry a version and revision and are validated against
replayed canonical moves. Unknown/mismatched lessons stop guidance rather
than manufacturing moves. Skip leaves the state intact and practice unpaid.

Training runs separately on owner-operated DGX machines. A compact policy/value
network, legal mask and bounded search are the intended serving path. Training
checkpoints and raw games do not enter Git. Artifact hashes, data manifests,
licensing and measured promotion reports do. Teacher LLMs are optional research,
not a dependency of either runtime or the production network.

A future approved AI pack is optional immutable static data, downloaded with
consent, verified before caching and pinned per match. Inference uses a Worker:
WebGPU only after capability/health checks, WASM CPU as the baseline. Unsupported
or corrupt packs produce explicit unavailable/recovery states. An Expert
fallback is labeled Expert, never silently labeled Impossible. No per-move
cloud call, Vercel function, DGX availability or Oracle load is required.

## Economy and trust

Beginner=1, Easy=1, Medium=2, Hard=4, Expert=6 remain unchanged, as do daily caps,
eligibility and first-five-tier local policy. `D.complete` already excludes
practice and pass-and-play from records and rewards. Those are preserved.
Impossible results must be a separate unverified local class with no coins,
crowns, quest farming, Elo or official rankings. A future rewarded challenge
requires separately approved Core-owned state and bot turns. Merely validating
a client-reported result is not server authority.

## Ownership / smallest integration seams

| Path | Owner / permitted integration |
| --- | --- |
| src/game.js | Canonical oracle. Preserve; add independent adapters in src/bot. |
| src/app.js | Shared client/P21. Only tutorial lifecycle, save/resume, bot scheduling hooks. |
| src/domain.js | Shared economy. Preserve first five rewards/caps; isolate unverified results only. |
| src/styles.css | Existing four-theme tokens/layout unchanged. New scoped tutorial stylesheet. |
| index.html | Shared retained client. Add only required local scripts/styles. |
| native/client/bundle.config.json | Native owner. Extend explicit allowlists; no broad directory copy. |
| scripts/p21/build-web.js | P21 owner. Extend retained-game allowlist only for new local modules. |
| apps/web/*, assets/p21/*, docs/p21-web/* | P21 owner. Do not edit site routes, assets, branding or ledger. |
| src/account-client.js, src/network.js, server/* | Identity/authority owners. No changes required. |

The website currently delivers the retained client under `/game/`; relative
module URLs must work there and in native bundles, not only at repository root.
Worker dependencies must be allowlisted without executing worker entry scripts
on the main page. No service-worker or CDN policy change without P21 review.

## Evidence and release

C0 baseline -> C1 reproducibility -> C2 guided tutorial -> C3 ladder -> C4-C6
model/pack/mode -> C7 acceptance. Tutorial may be reviewed independently of
training. Browser automation is not physical WebView or user-comprehension
proof. Reference-device latency, thermal and memory gates remain blocked until
measured. No claim of stronger AI or invincibility is inferred from depth,
architecture, training loss or random opening variety.

## Rollback

Revert coherent feature commits on V5.1 only after owner review; never rewrite
V4 or main. Disable experimental search to select old `G.choose`. Guidance save
metadata is additive; old clients replay the same canonical move list as unpaid
practice. Unknown lesson versions preserve moves and offer unguided continuation.
Model cache invalidation must not erase saved human moves; recover or explicitly
select labeled Expert. This work requires no database schema migration.
