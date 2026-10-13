# Local Brave GUI review — 2026-10-12

## Target and provenance

- Browser: Brave Browser extension tab controlled through CUA; unauthenticated, local loopback only.
- Preview URL: `http://127.0.0.1:4173/`.
- Baseline page bundle: `8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`, source commit `f0a3144466e3e738c1ba9e4833691c21eeeb24af`. The parent rebuilt the preview during this audit with the CSS correction, producing bundle `db286d8f83560024d264895e26d7990e363f5f1e4c7a6ac41eac4b409b731f89`; the GUI recheck initially used the rebuilt working-tree payload whose CSS bytes were later committed. The final automation manifest confirmed the identical bundle against source commit `222e6ded787ddc47367108d7573c6709c3dc01a8`. This review does not establish production provenance.
- The viewport capability accepted 1672×941, 768×1024, 390×844, and 320×800 overrides. At 320×800, Brave's captured page content was about 305 px wide because its desktop scrollbar reserves a gutter; the CUA target did not expose `documentElement.clientWidth` or an image-file export method.
- CUA screenshots were visible in the audit tool output. No manual screenshot was written to this evidence directory. The baseline headless Chromium screenshots/report from the existing browser QA are in `tests-output/p21-web/8167f349fb16/`; those files are not Brave GUI captures.

## Steps and observations

1. Inspected the homepage at 1672×941, 768×1024, 390×844, and 320×800. The hero, practice preview, online-mode panel, and feature cards remained readable; the 768px header used the mobile menu. The 320px baseline bundle showed a horizontal scrollbar at the bottom of both `/` and `/game` in this desktop scrollbar environment.
2. Parent rebuilt the local preview after removing the root `min-width:320px` constraint. Repeated `/` and `/game` at 320×800: the visible horizontal scrollbar was gone, the game controls and board remained within the captured left/right page bounds, and the board still showed its prior eight local moves. This is a local visual recheck, not a physical mobile-browser result.
3. Opened the 320px mobile navigation. All 11 links were exposed; Escape closed the menu and focus returned to its trigger.
4. Started the six-step guided practice in local browser mode, advanced through all six guided moves, and selected “Play from here.” The saved guided state survived route navigation at step 2/6. No account was signed in and no wallet/reward balance was changed.
5. Switched through Mega XOXO Neon, Vector Light, Midnight Club, Paper Club, and After Hours. Each selected theme rendered and the existing practice board state remained visible.
6. Swept the documented public, game, account, support, legal, store, and error routes by direct local navigation. No route rendering failure was observed. With the local read API disabled, leaderboard showed its explicit unavailable error and store showed an unavailable price; these are expected preview conditions.
7. Focused a legal game cell and used ArrowRight. Focus moved one cell; the local practice turn advanced. This checks keyboard operation through CUA input only, not screenreader behavior.

## Actionable review items

- **320px reserved-scrollbar regression (observed on baseline; visually and automatically fixed in the committed preview).** Baseline `/` and `/game` at 320×800 showed a horizontal scrollbar while the document declared `html { min-width: 320px; }` in `apps/web/styles.css`. Parent removed the minimum width. The committed `P21-BROWSER-320-SCROLLBAR-GUTTER-REFLOW` checks passed on `/`, `/game`, `/legal/privacy`, and `/account` with `scrollbar-gutter:stable`. Checklist: P21-G006 and P21.10 narrow-width review.
- **Cross-platform progress copy needs R15 verification.** The homepage feature card says stats, rank, and rewards sync with a linked account (`apps/web/site.js`, cross-platform feature entry). Local preview had no authenticated/shared-account service, so the claim was not validated; keep it gated or verify the real same-origin account/session path before release. Checklist/register: R15.
- **Route documentation needs reconciliation.** `docs/p21-web/ROUTES-AND-FLOWS.md` still has an older route/theme summary alongside a later annotation for the current `/game`, retained `/legacy-game/`, and five themes. Update one canonical map so it cannot be read as the active route contract. Checklist/register: P21.02 and R16.

## Limits

This review is local Brave GUI evidence only. It does not establish physical iOS Safari/Android/Firefox behavior, real `env(safe-area-inset-*)` behavior, an actual screenreader, forced-colors acceptance, CWV/performance, online/authenticated shared-account acceptance, production behavior, or fresh-user tutorial comprehension. The CSS-variable safe-area regression fixture added to `scripts/p21/browser-qa.cjs` is explicitly synthetic. R17 physical/manual acceptance and R21 moderated comprehension study remain open.

## Automated local checks on the committed payload

- Source commit: `222e6ded787ddc47367108d7573c6709c3dc01a8`; website bundle: `db286d8f83560024d264895e26d7990e363f5f1e4c7a6ac41eac4b409b731f89`.
- `scripts/p21/browser-qa.cjs --no-build`: PASS, 915 checks, 0 failures. Report: `tests-output/p21-web/db286d8f8356/browser-qa.json`.
- `scripts/p21/accessibility-qa.cjs`: PASS, 137 checks, 0 violations, 116 incomplete/manual-review views. Report: `tests-output/p21-web/db286d8f8356/accessibility-qa.json`.
- The browser QA report includes synthetic scrollbar-gutter and safe-area fixture geometry; screenshots are under the same `db286d8f8356/` output directory. These Chromium results supplement, and do not replace, the limited Brave GUI review or physical acceptance.
