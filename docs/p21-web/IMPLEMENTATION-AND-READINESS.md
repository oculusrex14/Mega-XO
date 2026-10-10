# V5.1 website implementation and readiness

The homepage and 26 supporting routes are implemented in editable DOM/CSS, with the approved Mega XOXO logo and a shared cinematic design. Local practice is playable using the existing game rules. This is a verified frontend checkpoint, **not a production-ready integrated platform or a deployed website**.

Code: `99e65bdc8655162cf2dcc4af26dc0b73ec203cdc`, branch `V5.1`, entry `1638f088f641651654005c832fc813353d004101`. The original V5 pack, retained `index.html`/`src/`, native source, schemas, identity and economic authority are unchanged by this checkpoint. Current website authorization is a later owner request; it does not retroactively accept the historical P21 deferral or G22/G23/G24.

## Checklist feasibility and reference fidelity

The existing plan can achieve the uploaded still composition. Editable page elements, a clean unlettered scene, trophy/device/crystal cutouts and procedural board/glyph/icon art cover the visible homepage. A realtime 3D mesh, hero video and audio are not necessary to render this still target. The broader asset-pack entries remain open and have not been silently ticked as delivered.

The implemented reference regions are the 70px navigation header, left headline/actions/platform strip, center nine-board preview and instruction strip, right mode/rank rail, and three lower feature cards. The 1672×941 capture preserves the reference headline wrapping, cyan-to-purple emphasis, panel proportions and feature-row position (approximately y=708, height=205). The scene remains a separate optimized image: controls, live text and board logic are editable elements.

The actual result is visually close but **not an exact pixel match or owner-approved golden**. The generated mountains, trophy, crystal facets and device screens differ from the reference. Header artwork uses the approved logo. There are deliberate truthful content changes: guest balances show dashes; the rank rail requests sign-in; no Diamond II, illustrative 1620/1580 rating, expired 2024 Season 3 or pretend countdown. The board is a valid replayed local fixture, clearly labeled interactive practice. Device artwork contains abstract X/O art, not actual native application screenshots. Aesthetic sign-off and any further art refinements remain open.

- [Actual desktop homepage](evidence/99e65bd/home-desktop.png)
- [Mobile homepage](evidence/99e65bd/home-mobile390.png)
- [Ranked page](evidence/99e65bd/page-ranked.png)
- [Themes page](evidence/99e65bd/page-themes.png)
- [Paper Club practice](evidence/99e65bd/practice-paperclub.png)

These are captured website renders. The original visual authority remains [the uploaded screenshot](../../assets/p21/reference/homepage-generated-image-1.png).

## Implemented behavior and evidence levels

| Scope / task IDs | Implemented | Evidence level / remaining scope |
|---|---|---|
| P21.01,.03,.04,.06 | Cinematic chrome, official logo, local licensed fonts, shared panels/buttons/icons, generated unlettered scene/trophy/crystal/devices and procedural theme art | Local browser render and provenance. Vector/layered/3D/video/audio/full rank pack and owner visual acceptance OPEN |
| P21.02,.07 | `/`, `/play`, `/casual`, `/ranked`, `/tournaments`, `/season`, `/friends`, `/challenge`, `/leaderboard`, `/rewards`, `/themes`, `/profile`, `/settings`, `/account`, `/how-to-play`, `/support`, `/help`, `/about`, `/privacy`, `/terms`, `/delete-account`, `/privacy-choices`, `/status`, `/news`, `/offline`, `/404`, `/accessibility` | Designed and locally rendered; account/online actions use retained-game gateways. Live data/detail/transaction/auth flows OPEN |
| P21.05 | 81 accessible cells, required-board routing, five bot levels, local two-player, reset and four existing theme palettes; theme change preserves the current game | Pure-rule tests and Chromium input checks. No account grants; online game/realtime acceptance OPEN |
| P21.08,.10 | 27-route viewport matrix at 1672/768/390/320, landmarks/headings/links/assets, mobile menu/Escape/focus, theme selection, reduced motion/forced colors and axe | Local Chromium evidence only. Physical browsers, manual screen readers/gradient contrast and real CWV OPEN |
| P21.09 | Safe deterministic positive-allowlist build, unchanged retained client, clean static/legal/game routes, MIME/CSP, explicit unconfigured API and rejected writes, Vercel static config with automatic deployments disabled, validation CI | Local build and CI. Actual Vercel project, API/session/Core connection and deployment OPEN |

The [route/flow map](ROUTES-AND-FLOWS.md), [asset registry](ASSET-REGISTRY.md), [exact provenance](../../assets/p21/art/PROVENANCE.json) and [development/release guide](DEVELOPMENT-AND-RELEASE.md) describe how to maintain the delivered files. No new secrets, database, identity system or online economic writer exists in the website.

## Exact checkpoint verification

All checks below exercised source `99e65bdc8655162cf2dcc4af26dc0b73ec203cdc`. [verification.json](evidence/99e65bd/verification.json) records task/case IDs, exact commands, target/environment, results and file hashes.

| Check | Command / target | Result / evidence |
|---|---|---|
| Affected paths | `env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node --test tests/v5-p21-*.test.js`, local macOS Node 24 | **27/27 PASS**, zero skips; [log](evidence/99e65bd/affected-tests.log) |
| Static packaging | `node scripts/p21/build-web.js`, local `.artifacts/p21-web` | 62 allowlisted files, 1,935,785 bytes; [manifest](evidence/99e65bd/web-build.manifest.json) |
| Browser matrix | `node scripts/p21/browser-qa.cjs --no-build`, managed Playwright 1.62.1 / Chromium 151.0.7922.34, unauthenticated loopback | **489/489 PASS**, 38 screenshots, zero missing local resources/JS errors; [report](evidence/99e65bd/browser-qa.json) |
| Automatic accessibility | `node scripts/p21/accessibility-qa.cjs`, axe-core 4.14.0 / Chromium, desktop/mobile pages and practice | **58/58 PASS**, zero automatic violations; 56 views have incomplete checks requiring manual review; Paper Club HUD contrast 11.20:1; [report](evidence/99e65bd/accessibility-qa.json) |
| Retained source and pack | `git diff --exit-code 1638f088f641651654005c832fc813353d004101 HEAD -- index.html src native Mega-XO-V5-Implementation-Pack` at code checkpoint | PASS, zero changes. Retained game copies are also hash/byte-checked by build tests |
| Asset inventory | Python SHA-256 verification of all 26 provenance inventory files | PASS; source PNGs, optimized exports, font/license bytes match [provenance](../../assets/p21/art/PROVENANCE.json) |
| Website CI | [Actions 38082099277](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099277), exact code SHA | **PASS**, static + Chromium/a11y jobs; [summary](evidence/99e65bd/ci-website.json). Downloaded build manifest exactly equals local manifest |
| Existing browser validation | [Actions 38082099203](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099203), exact code SHA | **PASS**; [summary](evidence/99e65bd/ci-retained.json). Publish/image jobs excluded by their release gates |

Native preservation CI also passed at the same code SHA: [Actions 38082099216](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099216), all four build/emulator/simulator/byte-parity jobs. [Summary](evidence/99e65bd/ci-native.json) and [artifact IDs/digests](evidence/99e65bd/ci-native-artifacts.json) are archived; Android is debug signed and iOS is an unsigned simulator build. This is not a physical-device/store/production acceptance.

Bundle SHA-256: `8df1661fceb72b300e55d81be9fc758a91238a9a90370e3d7a4d7cb3f14d8857`. All 38 local captures remain under ignored `tests-output/p21-web/8df1661fceb7/`; selected review captures are committed above. CI retains its complete presentation artifact for 14 days. There is no new production web URL, runtime image digest or database identity to report for this static local checkpoint.

Earlier genuine defects and fixes are retained in [corrected-findings.json](evidence/99e65bd/corrected-findings.json): Ranked exceeded the phone viewport until its grid minimum was corrected; the horizontal league table required keyboard focus before mobile axe passed. Earlier dirty-tree bundles identify exact bytes through manifest hashes rather than claiming their old HEAD alone identifies new code. `/offline` gained its missing page heading; Paper Club HUD contrast and forced-colors heading treatment were also corrected before final committed-source verification.

## Remaining production gates

1. **Visual acceptance:** owner review of actual homepage and page designs; approve or refine the generated scene/art differences. Complete remaining required brand/asset exports without claiming missing masters exist.
2. **Live V5 staging integration:** real protected cookie/session/CSRF/CORS contract, permanent actor, rank/wallet/friends/tournament data, real queue/detail/action states, Core tickets/WebSocket/resume/fallback and cross-platform agreement. Current guest-only presentation and `/game/` gateways are incomplete online delivery.
3. **Provider/legal readiness:** formal legal/disclosure approval, commercial hosting eligibility, owner-controlled website/API/Core origins, TLS/DNS/associations/OAuth callbacks and actual intended Vercel project. Read-only Vercel inventory on 2026-10-11 authenticated `oculusrex14` and returned `godfin`, `bidthrone`, `website` in `oculusrex14s-projects`; no dedicated Mega XOXO website or `mega-xo-api` appeared in that scoped inventory. No object was created or modified.
4. **Device/quality:** physical Safari/iOS/Android Chrome/Firefox, manual VoiceOver/TalkBack and gradient/image contrast, zoom/touch, actual network/hardware CWV, security/session expiry and signed-in failure/retry evidence. Automatic axe is not a full WCAG certification.
5. **Release:** reviewed immutable source/build, staging smoke, explicit domain/deployment authorization and separate operator go/no-go for V5 production. Live V4.1.2/SQLite remains authoritative. No API/Core deployment, DB writes/import/cutover, signing/store approval or device acceptance was performed by this website checkpoint.
