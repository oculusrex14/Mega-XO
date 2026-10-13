# Codex P21 recovery and Main handoff — 2026-10-12

Codex owns website source, browser acceptance and provider preparation. Main owns V5.1 integration, the PostgreSQL HTTP account backend, staging services and native configuration. This handoff does not approve publication, a paid resource, provider enrollment, a production cutover or a change to V4.1/main.

## Recovered work and local preservation

The existing managed detached worktree is `/Users/oculus/.codex/worktrees/v51-website-readiness/Test XO`, based on `f0a3144466e3e738c1ba9e4833691c21eeeb24af`. Before any resumed edit, Codex preserved all 19 unfinished owned paths, the tracked patch and the ten saved unpublished commits in `.artifacts/recovery-20261012T163635Z/`:

- `inventory.json` records each path's bytes and SHA-256.
- `uncommitted-owned-files.tar` preserves the unfinished files.
- `working-tree.patch` preserves the tracked delta.
- `saved-milestones.bundle` preserves base-to-`4d76d75` commits; `git bundle verify` passed.

The archive is local ignored recovery material, not an exported secret or production backup. Owner untracked work in Main's checkout (`.agents/`, the independent main-agent plan, logo pack and skills lock) was left intact. Main's tracked checkout remains free of Codex app edits. A sanitized staging note accidentally created in Main's untracked evidence folder was left untouched and copied into the isolated worktree. The empty old JPG was preserved but excluded from commits and image-evidence claims.

Three unfinished 3D draft files remain deliberately uncommitted: `assets/p21/three/factories.mjs`, `scripts/p21/export-three.mjs`, and `scripts/p21/three-qa.cjs`. They contain incomplete geometry/export/turntable changes. Syntax checks alone do not qualify them; no new GLB/still export or runtime activation was performed. Do not discard these drafts or confuse them with the committed source asset pack.

## Saved source milestones

All SHA values below are original isolated-worktree commits. They are unpublished relative to V5.1; do not assume they already serve on staging.

| Commit | Change | Boundary |
|---|---|---|
| `222e6ded787ddc47367108d7573c6709c3dc01a8` | Narrow viewport and safe-area reflow | Local desktop-engine evidence; synthetic safe-area geometry |
| `4d30e37bf0dcab349046d377707cb93e42533d2b` | Anonymous novice study procedure/scorer | No actual novice sessions |
| `576eb54da5700918941cd318b219faaf253d8748` | Independent cinematic scene source layers | Not activated in the website |
| `95789cfcb3f7f0be6e13eb00c674fa6857a55af2` | Frozen sRGB scene export profile | Deterministic local export |
| `0663ae50ce979528e505ca42b15e7b014ffe33f7` | Separate Firefox/WebKit evidence | No Safari/device equivalence claim |
| `5fc3f957eb6268395b5aa9a2883d46a56b13b85c` | Real download-handler redirect QA | Real store URLs still null |
| `a44bc39bb1793f5a3c5ded4c30ac8338d460c42d` | Browser icon exports from approved emblem | SVG/mask/vector requirements remain open |
| `9df5e8e5cbc92a3832551c160cfef9d15763db45` | Original optional audio source/exports | No autoplay/runtime activation or human listening acceptance |
| `991e8b8970de3810dfcb2a1f4a3f7be2a75d71ab` | Editable 3D source, GLBs and transparent stills | Draft asset pack; no runtime/owner quality approval |
| `4d76d755d5a760d514d5f35f3768ac90fba2bc79` | Explicit opt-in verified guest offline practice | Default browsing does not register a worker |
| `af1e3d57be28a09ebf6d421a1e92c268e8048eaf` | Preserve verified offline fallback through hydration/history | Private/unknown/query fallback remains guest-only |
| `12acd9967928b00f79e7348593d61310dba2c2ea` | Distinguish first install, waiting update and failed install | Does not claim/reload open clients automatically |
| `681f06bfad5e929cdda929cdf6d4486f5fff89ec` | Recover completed motion job and silent exports/provenance | Hero unchanged; seam/license/device review open |
| `2a3fec72463cf00187a1c78cec94b6d349161184` | Provider/hosting inventory and preparation | Read-only evidence; no target project, purchase or app record created |
| `2953c7e2432f28282ce1309e11e87f506e0b2e50` | Corrected staging frontend and reported account timeout | Browser authentication remains unaccepted |
| `2934129bc4b5a32c4e48ea4734a9a314070e47d8` | Original acceptance overlay, current route map and persistent QA archive | All 160 pinned IDs retained; no device/provider gate silently closed |
| `82358d42d4d6c1c06120273d11591b6a83ce83e9` | Offline QA transport attribution, teardown and preserved failures | Clean exit0 in targeted teardown run; older helper/engine results remain separately pinned |

The first ten were recovered saved commits. The next two repair real local offline defects. The motion milestone preserves the already-completed authorized provider job; no new generation was commissioned. Later documentation/test checkpoints should be integrated with the same small-commit discipline.

## Reconciliation with Main

Main and origin were `46da760c8c3da1fcec0733ba1b92f8f296762ba4` at reconciliation. Main subsequently advanced to `539c9ba8523429496ff706fd501045d6c0db4993`; that additional commit changes only research evidence documentation. WebUI's R01/R02 register/audit work was not edited by Codex.

A second managed **detached** worktree, `/Users/oculus/.codex/worktrees/v51-website-reconciliation/Test XO`, was created at Main's `46da760`. The 13 source milestones through `681f06b` cherry-picked cleanly, ending at `4f3e48339312576549ea0c6bf381588c21f57f5c`. Main's `resolveStatic()` correction/export and our `.webmanifest`/`.ico` MIME additions both remain present in `scripts/p21/serve-web.js`. Do not replace that file wholesale with the older website version.

Verification on reconciliation HEAD:

```sh
env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node --test tests/v5-p21-*.test.js tests/v51-p21-bot.test.js
env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node scripts/p21/build-web.js
```

Result: **143/143 PASS**, no skips; build **151 files / 3,474,873 bytes**, bundle **`9cfa78636df78528c6ae1fb95ee5afc845b787f796f17d91be5258d4b283aeef`**. This is byte-identical to the isolated candidate built at `681f06b`; its manifest records the separate reconciliation source SHA. The original local candidate's affected website/bot run was 138/138 PASS. The five additional reconciliation cases are Main's new static-resolver tests.

An additional attempted foundations-service test could not load `pg` in this fresh worktree. Its preserved log records 143 passing website/bot cases plus that environment dependency failure; the real-PG foundations file was **NOT_RUN**, not accepted. No database grants, service source or test assertions were changed to bypass it.

Main should fetch/inspect fresh V5.1, inspect all local changes, integrate the desired original commits in order, preserve its own backend/static-server corrections, and run current checks before a fast-forward-only push. The detached reconciliation checkout is a validation candidate, not a shared-trunk update. No remote branch, V4.1/main merge, deployment or force-push occurred.

## Local browser and checklist boundary

On candidate `681f06b` / bundle `9cfa78636df7`, Chromium 151, Firefox 146.0.1 and Playwright WebKit 26 each passed **915/915** local presentation checks, with no missing resources or JavaScript errors. Chromium axe 4.14 passed 137 checks with zero violations; 116 incomplete/manual views remain open. Chromium offline passed **33/33**. The first Firefox/WebKit offline runs passed 14 setup/theme checks then stopped at a 15-second bot-move wait; those incomplete reports remain preserved and are under diagnosis. These results are fresh unauthenticated local software contexts, not physical phones, Safari product acceptance, actual assistive-technology acceptance, real providers or authenticated staging acceptance.

The later controlled comparison passed **33/33** in Firefox/WebKit and Chromium 145 when the local origin connections were dropped while `navigator.onLine` remained true. This is Worker/cache transport simulation, not physical offline acceptance. Firefox/WebKit browser-offline emulation remains incomplete with explicit bot recovery; Chromium145 emulation passed 30/33 and its route-attribution caveat is retained. The runner's prior exit130 after a completed report is preserved; a teardown-only revision closes its owned HTTP resources and the targeted Chromium145 origin-drop rerun passed33/33 with clean exit0. The [acceptance plan](OFFLINE-ACCEPTANCE-PLAN-20261012.md) and [archive index](evidence/20261012-recovery-validation/archive-index.json) pin each engine, helper SHA, transport, manifest and failure.

The six-move tutorial, canonical bot Worker and original four themes were validated and retained. Browser Neon remains the fifth browser-only default; no paid native Neon was activated. Study materials, source assets and local tests do not close manual/device/provider gates. The isolated checklist has **71 checked / 159 open**; Main's original trunk snapshot is **70 / 160** until integration. The single extra closure is K120, canonical rank policy without invented subdivisions. Do not present either count as a production-readiness percentage.

After saving this recovery checkpoint, Codex started a separate profile-editor slice in the same isolated worktree. Its four web files and focused tests are in progress and must not be included merely by staging the whole working tree. Main should integrate reviewed commits, not unfinished drafts. The generated/served local artifact remains the pinned9cfa candidate until that next source milestone is tested and explicitly rebuilt.

## Current staging and the exact next dependencies

Verified public frontend: `http://100.107.65.122:8081/`, source `f4851a568524846d981b351c659af4a9ee7479be`, bundle `8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`; **140/140 files** match. CUA loaded home and the anonymous account form. This supersedes the earlier blank localhost shell. It verifies the frontend bytes, not the running backend/process revision.

The owner then reported an email-continuation timeout. Cookie-free probes measured `/api/account/session` 200 in **4,181 ms**, close to the client's **4,500 ms** bootstrap budget; `/livez` took **3,991 ms**. This is a latency hypothesis and bounded staging observation, not a reproduced signup cause. See [the precise defect and cookie finding](evidence/20261012-staging-review/ACCOUNT-TIMEOUT-20261012.md).

Main's subsequent owner-shared summary reports warm Neon RTT 2,530–2,732 ms and a single cross-region accept taking 17.4 seconds against the unchanged 15-second offer window, alongside passing co-located queue and HTTP auth suites. Preserve this distinction: explaining cross-region latency and passing co-located tests does not establish a passing current remote browser journey. Do not lengthen the offer TTL to close an environment gate.

| Needed from Main / human | Enables |
|---|---|
| Running API/Core/server boot commit or image receipt, start time and build identity; frontend manifest alone is insufficient | Exact-build attribution of account/online defects |
| Controlled session/email phase timings and correction of the reported timeout within the V5 PostgreSQL contract | Repeatable browser continuation |
| Human privately completes the new credential/OTP step through Main's approved staging channel, or an actually supported private credential handoff | Real signup/login, profile, session refresh and logout checks |
| Private HTTPS origin, exact cookie/CSRF/Origin contract and a guard on the development cookie fallback | Secure staging/browser acceptance and eligible separate hosted preview |
| Two approved isolated test actors with qualification/balance setup receipts, permitted scenarios and cleanup/recovery ownership | Wallet, offers, concurrent accepts, challenges and matchmaking acceptance |
| Exact realtime endpoint/auth/reconnect contract and co-located timing proof within the unchanged 15-second offer TTL | Realtime/reconnect/settlement acceptance |
| Signed iOS/Android candidate identities and physical-device access | Cross-platform permanent-actor continuity |

The current HTTP form can support a controlled account investigation while HTTPS is pending; HTTPS, secondary actors and physical builds are later acceptance gates, not excuses to defer all independent website work. Outbound email/store/ad providers remain disabled. Google/Apple OAuth start is not mounted and its UI is disabled. Production/V4.1 is never a substitute.

## Hosting/provider preparation

Read-only Vercel CLI/connector inspection confirms the intended team is Hobby, with three projects and no Mega XOXO target/deployment. Official Hobby policy limits it to personal non-commercial use; no duplicate project, plan upgrade, trial or deploy was created. The owner’s 2026-10-13 correction confirms non-commercial hobby use and selects Vercel Hobby; a paid upgrade is not a current blocker. An approved reachable API/session/WSS contract remains required for a connected separate non-production preview. See [hosting evidence](HOSTING-DISCOVERY-20261012.md).

Apple's owner-selected Individual route matches its sole-proprietor guidance. Google Organization eligibility requires provider classification and a matching D-U-N-S/business verification; Udyam does not replace D-U-N-S or make the proprietor incorporated. The final `online.megaxo.xoxo` identifiers remain owner-selected targets, not verified/registered identities; Main retains native signing/OAuth/billing configuration ownership. Latest provider-page attempts were gated by 2SV, reauthentication, DOB or Apple sign-in, and subsequent new-tab attempts were unavailable. No approval, record, SKU, price, purchase or store release is claimed. See [provider preparation](PROVIDER-SETUP-20261012.md).

Computer Use explicitly blocked access to the Terminal app for safety. Codex did not bypass the denial, inspect Terminal, interrupt Main or send its intended prompt. This document is the reviewable Main handoff. Credentials supplied by the owner were not copied to agents, evidence, files or Git.

A focused read-only Tailscale enablement inspection also could not open a supported browser: the visible in-app attempt returned `Browser is not available: iab`. Tailnet/account/node matching and enablement/MFA state remain unverified. The app's separate browser-panel request returned `queued`; that is not proof the page opened or HTTPS was enabled. Main/human retains the private HTTPS enablement and server wiring step.

## Recovery / rollback

The prior bundle and all failed test reports remain preserved. Roll back only owned isolated website commits through ordinary revert/reconciliation; never reset shared V5.1 or user files. Main owns staging actor/session cleanup and compatible server recovery. No production writer was started, stopped or migrated. Offline removal is explicit in Settings and removes only product-owned root worker/cache, preserving unrelated storage and practice/preferences.

## Final resumed checkpoint — 2026-10-13

The profile slice is completed source 4d9aa915; Friends source 586fe5e plus stable social-key fix f71856a and two measured WebKit focus fixes b313daa/e9eab575 are committed. Final original source e9eab5753fe9ee8552f3b7f9d1be6ad5e7e3deec / bundleefe8fdc628606103b7171e0c0230a260614fb6c082e86a0cb5e26fb5f6d20e92 (152 files/3,523,497 bytes). Current reconciled source isde5d5ef4fca22118bb223601bc833511eb5d2f53 over Main 2e8e501a6c9770a15383fd392c3323c652daf977; no conflicts and byte-identical payload. Main backend/packages/training/research files have zero Codex delta against that base.167 original/172 reconciled website+bot tests pass, no failure/skip.

Friends 40/40 and Profile 18/18 pass in Chrome 151, Firefox 146 and WebKit 26. Chrome broad915/915 and axe 137 pass;116 incomplete manual views stay open. Offline33/33 each: Chrome browser-offline, Firefox/WebKit origin-drop with navigator.onLine=true. Persistent indexes: evidence/20261013-profile-validation/archive-index.json and evidence/20261013-final-browser-validation/archive-index.json. Both measured WebKit failures, helper setup failures, older Chromium145 reports and the interrupted partial b313 broad run remain preserved. Source/fixture passes do not close native/device/provider/authenticated acceptance.

This supersedes the earlier in-progress profile/9cfa-candidate paragraph, pending private HTTPS observation and commercial-plan interpretation above. Staging HTTPS now serves https://command.tail95c48c.ts.net, independently verified frontendf4851a5/8167 with 140 files; receipt service source 8328b71, fresh process boot identity still requested. Owner reports credential submission/code step, but staging mail is disabled and private OTP entry/linkage remains pending. Current Brave cannot attribute the owner's code phase. The concrete Main handoff is CODEX-TO-MAIN-20261013.md; no acknowledgment is inferred from the on-disk note.

Main's source composition omits Core's ephemera publisher, and equal-revision resume/hint suppression can miss terminal status. The detailed source-only defects and safe browser-reader plan are in REALTIME-CONTRACT-AND-INTEGRATION-GAPS-20261013.md. Actual HTTP-to-peer socket push, complete two-account game/reconnect/settlement, wallet/friends/tournament/native continuity remain open. Current frontend HTTP polling is retained; a WSS endpoint/service smoke is not an implemented browser client. No training, backend, data-authority, fee, DNS, production, store or indexing changes occurred. Owner has selected Hobby for current non-commercial use; no paid upgrade blocker remains.
