# Owner-authorized safe V5.1 integration — 2026-10-13

The owner explicitly requested a safe GitHub push of the recovered P21 work. This supersedes the pending/no-push state in earlier recovery and Main handoff notes; those historical records remain intact. This receipt records the reviewed candidate before a normal fast-forward push, not deployment or production acceptance.

Integrated source: `4c5c82d46e0c4619b8b28577287c03c0df6fb409`. Main's latest fetched GitHub parent: `2a374ef7552661fb078ae8dfaf8d9b17e398796a`. Original completed P21 history: `3775a2f07e043c96856dea207276200f09aa4fad`, base `f0a3144466e3e738c1ba9e4833691c21eeeb24af`. The 26 original milestone IDs are retained once; the parallel cherry-picked reconciliation history is excluded. Main's completed history is retained, with no delta in training, bot source, backend/packages or V5.1 research/release paths relative to the fetched Main parent. Both automatic merges had zero conflicts. The only normalization removed one trailing blank line in the owned offline test.

Validation: Node 26.8.2, `env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node --test tests/v5-p21-*.test.js tests/v51-p21-bot.test.js tests/bot/search-labels.test.cjs` =>175/175 at `2411dc0e9d8a026dae1c57486eee9ad2a1eab3d1`; after Main's training-only update, the 172 affected website/tutorial tests pass again at the integrated source above. Zero failure/skip. The browser payload is byte-identical between these two checks.

Build: `node scripts/p21/build-web.js` => bundle `28c1ad39883b4431e7b446d8e5d54c422b9daa5ce3be89cd7770f61c3a8badc9`,152 files/3,523,500 bytes. Relative to the preceding `efe8` browser archive, only Main's committed `legacy-game/src/bot/search.js` and its generated offline worker digest changed. File checksums were verified. A Luna Max agent ran the existing tutorial/Worker/five-theme harness at the exact source2411 above:15/15, Chromium151.0.7922.34; independent loopback transport6/6 includes three sitewide noindex headers, missing-asset404 and disabled auth/leaderboard API503. This is local synthetic acceptance; live account, WSS, complete games/settlement and physical devices remain unverified.

Upload review:310 owned P21 files/~42.94 MB changed-file bytes, no oversize file, no high-confidence live-secret pattern and no outside-P21 delta relative to Main's reviewed base. All51 prior profile/final-browser archive hashes remain valid. No deleted file, force-push, new remote branch, main/V4.1 update, provider/DNS/store action or staging/production deployment is part of this operation. Vercel automatic deployment is disabled and sitewide HTTP noindex/nofollow remains held. Public-page static metadata prepares eventual discovery; it does not override the current HTTP release hold.

Preservation: Root `/Users/oculus/Downloads/Test XO` remains Main's active checkout. Codex did not switch/reset/stash/clean it or edit its training work. Three unfinished 3D drafts and the invalid zero-byte JPG remain preserved in the original readiness worktree and recovery bundles, excluded from this publication. An existing Root untracked `CODEX-TO-MAIN-20261013.md` or staging-review file may collide with the newly tracked destination during a later local pull; preserve such local files outside their destinations before integration. Do not reset or overwrite them. Codex leaves that reconciliation to Main's active-work checkpoint.

Evidence: `evidence/20261013-safe-integration/archive-index.json`; exact commands and results are preserved there. A new verified Git bundle is created locally before the push. GitHub's branch/commit receipt establishes whether the subsequent normal push completed. If the remote advances first, fetch/merge and revalidate rather than force it. Rollback uses ordinary reverts of owned P21 history (e.g. the P21 merge2411 with first-parent mainline1), preserving later Main/backend/training history. Never reset shared history or change data authority.

## Original saved milestone IDs

- `222e6ded787ddc47367108d7573c6709c3dc01a8` fix(web): reflow narrow viewports and respect display safe areas
- `4d30e37bf0dcab349046d377707cb93e42533d2b` feat(web): prepare anonymous novice comprehension study
- `576eb54da5700918941cd318b219faaf253d8748` feat(assets): add independent cinematic scene source layers
- `95789cfcb3f7f0be6e13eb00c674fa6857a55af2` fix(assets): retain the color profile for repeatable scene exports
- `0663ae50ce979528e505ca42b15e7b014ffe33f7` test(web): isolate Firefox and WebKit presentation evidence
- `5fc3f957eb6268395b5aa9a2883d46a56b13b85c` test(web): exercise real download redirects across browser engines
- `a44bc39bb1793f5a3c5ded4c30ac8338d460c42d` feat(assets): export browser icons from the approved emblem
- `9df5e8e5cbc92a3832551c160cfef9d15763db45` feat(assets): preserve original optional UI audio cues
- `991e8b8970de3810dfcb2a1f4a3f7be2a75d71ab` feat(assets): preserve editable 3D glyph currency and rank families
- `4d76d755d5a760d514d5f35f3768ac90fba2bc79` feat(web): offer verified opt-in offline practice
- `af1e3d57be28a09ebf6d421a1e92c268e8048eaf` fix(web): retain verified offline fallback through page hydration
- `12acd9967928b00f79e7348593d61310dba2c2ea` fix(web): distinguish offline install progress from failed and waiting updates
- `681f06bfad5e929cdda929cdf6d4486f5fff89ec` feat(assets): preserve generated motion source and verified silent exports
- `2a3fec72463cf00187a1c78cec94b6d349161184` docs(web): preserve verified provider scope and staging prerequisites
- `2953c7e2432f28282ce1309e11e87f506e0b2e50` docs(web): record corrected staging frontend and account timeout evidence
- `2934129bc4b5a32c4e48ea4734a9a314070e47d8` docs(web): reconcile original acceptance ledger with recovered exact-build evidence
- `82358d42d4d6c1c06120273d11591b6a83ce83e9` test(web): qualify offline transport modes and close owned QA resources
- `e374b7ea751a3a6c98df49c4d70df0d71ae3ceea` docs(web): hand off recovered milestones and exact staging dependencies
- `4d9aa91503ed34cc72cb73a63a0e8207133e6d01` feat(web): edit profile details and privacy with fenced session refresh
- `586fe5efdc1282112c25d8c030ea174c3332363d` feat(web): manage protected friends and requests within the Neon website
- `f71856a18e320ee267c2d28723855d658f5e33e3` fix(web): bind friend retries to the social endpoint operation key
- `b313daac32c89ba36fd7f8ec2ce7ade6d0683154` fix(web): focus protected form feedback across browser button behavior
- `e9eab5753fe9ee8552f3b7f9d1be6ad5e7e3deec` fix(web): return profile recovery actions to the edited field
- `e36e359b09e02579378c8c8df72c2039d0f6469d` test(web): verify protected profile and friend flows in isolated browsers
- `90d6e05a7c311cc28133542e5aed851a3e2cb242` docs(web): preserve browser acceptance and precise staging integration handoff
- `3775a2f07e043c96856dea207276200f09aa4fad` docs(web): clarify account phase evidence and verified recovery receipt
