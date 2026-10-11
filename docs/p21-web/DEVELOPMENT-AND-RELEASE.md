# P21 local development and release boundary

This is the isolated `V5.1` website build. It packages the cinematic website and game presentation, preserves the standalone browser client, and renders the full existing legal documents within the website. Source/build tests and a local preview do not establish a deployed V5 service, online acceptance, legal approval or permission to cut over production.

## Local build and preview

From the repository root, use Node.js 24 or newer:

```sh
node scripts/p21/build-web.js
node scripts/p21/serve-web.js --port 4173
```

Open `http://127.0.0.1:4173`. The server binds to loopback. `/game` and `/game/` render the cinematic website game. `/legacy-game` redirects to `/legacy-game/`, where the standalone client keeps its original relative scripts, styles and theme logos. `/store`, `/sponsors` and `/ads` use the website shell. Full documents are available at `/legal/privacy`, `/legal/terms`, `/legal/support`, `/legal/delete-account` and `/legal/privacy-choices`; their original wording, links and draft notices are preserved. Unknown page requests use the website's 404 presentation with HTTP 404; absent assets receive HTTP 404. Account and game API requests return an explicit unconfigured response, and mutations are refused.

The preview's optional leaderboard read seam is **disabled by default**. Only an explicit `P21_READ_API_ORIGIN=https://play.antimatterinnovations.com` enables `GET /api/v1/leaderboard`. The destination is fixed; browser cookies, authorization and actor headers are never forwarded. No sessions are created. Only `metric=rating|wealth`, `scope=global|local|region`, `league=all` or the eleven approved lowercase tier IDs, and an optional uppercase two-letter `region` are accepted. The display alias `scope=region` maps to the deployed API's `scope=local`. Duplicate/unknown filters are refused. The request has a five-second timeout, a 256 KiB response bound and a 200-row limit. Successful responses retain only the existing public fields `id`, `name`, `region`, `tier`, `rating`, `games` and `wealth`; errors are sanitized and responses are never cached by this preview.

The owner's unauthenticated live probe returned HTTP 401 `AUTH_REQUIRED` on both rating and wealth. Enabling this read seam does not make that live endpoint public or supply a signed-in website session. A 401/403 upstream result becomes the website's explicit authentication-required response. Anonymous leaderboard access or authenticated same-origin API integration requires a separate verified ingress release. Browser/accessibility QA forces the seam off, and proxy tests use only synthetic loopback responses. The static Vercel artifact includes no proxy function or external rewrite.

The default output is ignored `.artifacts/p21-web`. The builder accepts another child of `.artifacts` or the dedicated `apps/web/dist` release directory. It refuses repository roots, unrelated directories, symlinks and existing directories without its manifest. It also refuses replacement if someone added an unrecognized file to a generated output. Invalid/missing source input leaves the previous build intact.

```sh
node --test tests/v5-p21-web-build.test.js
node scripts/p21/build-web.js --output apps/web/dist
```

The local Chromium acceptance runner uses an installed Playwright package (set `NODE_PATH` to the managed runtime's `node_modules` if it is not on the regular module path):

```sh
node scripts/p21/browser-qa.cjs
node scripts/p21/browser-qa.cjs --no-build
node scripts/p21/accessibility-qa.cjs
```

Accessibility QA also requires axe-core (the validation workflow pins 4.14.0). It scans each page and practice at desktop/mobile widths, checks the Paper Club turn HUD contrast and forced-colors treatment, and records incomplete checks for manual review. Automated success is not screen-reader or complete WCAG certification.

The second browser command checks an existing `.artifacts/p21-web` snapshot without rebuilding while another developer edits source. Both browser runners first freeze a checksum-verified payload snapshot. They record exact packaged SHA/hash, browser version, all route/viewport results, local link and asset failures, complete legal document text and website chrome, local-practice routing, theme selection and legacy-client smoke under ignored `tests-output/p21-web/<bundle-hash-prefix>/`. Screenshots include the reference-sized 1672×941 homepage, 768px tablet, 390px/320px mobile, each desktop page and the four practice themes. No live/authenticated player data is captured. These are browser checks on a static local package, not live account or provider acceptance. If the local shell injects a persistent HTTP-server timer through `NODE_OPTIONS`, run the managed Node executable directly with `env -u NODE_OPTIONS`; no host wrapper or approved game code is modified.

The build copies only explicit website modules (including the allowlisted `data.js` and `game-runtime.js` when present), approved retained client scripts/styles, eight optimized game-theme logos, optimized art/rank/currency WebPs, local fonts/licenses and public legal documents. Rank exports from `assets/p21/art/ranks/` or `assets/p21/ranks/` retain their subdirectories under `/assets/art/ranks/`; a duplicate destination is refused. Optimized `assets/p21/art/currency/` exports map to `/assets/art/currency/`. It excludes server authority, backend packages, databases, env files, provider configuration, native SDK/signing files, original screenshots and PNG art masters. The retained `/legacy-game/index.html` and client scripts/styles remain byte-for-byte unchanged. Raw legal `.html` aliases remain available, with only their stylesheet URL replaced by `/legal/legal.css`. Generated `/legal-documents.js` exports a frozen `legalDocuments` map of the five exact `<main>` inner-markup strings; no head/body/styles or executable markup is included, and the source documents are untouched.

`web-build.manifest.json` records each source path, exact input/output SHA-256, payload size, bundle hash and route map. A generated multi-source module records all contributing source paths, lengths and hashes in its `sources` array, alongside its generated output hash. `source_commit` identifies checkout HEAD; while the working tree has changes, the recorded input hashes identify the actual packaged bytes. Rebuild from the final reviewed commit for release evidence. The manifest has no timestamp so identical inputs and checkout SHA produce identical bytes.

## Vercel static project configuration

The checked-in `apps/web/vercel.json` is a static-site configuration; framework is Other, root directory is `apps/web`, output directory is `dist`, install command is `true`, and build command is `node ../../scripts/p21/build-web.js --output apps/web/dist`. In project build settings, enable inclusion of source files outside the root directory: the builder deliberately consumes the retained browser client and optimized assets from the monorepo. No backend dependencies are installed for this website.

Automatic Git deployments are explicitly disabled with `git.deploymentEnabled: false`. This checkpoint adds validation CI and local delivery files only. It does not create/update a Vercel project, deploy a preview, change the production branch, attach `megaxo.online`, alter DNS, switch the live browser origin or promote production. When separately authorized, identify the actual owner team/project, inspect its existing settings, use the reviewed `V5.1` commit and keep the domain dormant until release acceptance.

The configuration uses explicit website/legal/game rewrites so missing JavaScript, fonts and API paths retain HTTP 404. The builder emits a shared `404.html` document for the website's branded fallback using [Vercel's static custom-404 convention](https://vercel.com/kb/guide/custom-404-page). Static assets have revalidation-friendly caching because their names are stable. Headers include CSP, nosniff, no embedding and noindex while the release remains unapproved. The retained game still references its existing pinned Lucide CDN and Google Fonts; the CSP permits those sources. Network-independent native packaging remains the separate existing `scripts/v5/build-client.js` workflow.

Configuration references, verified 2026-10-11: [Vercel project configuration](https://vercel.com/docs/project-configuration), [monorepo projects](https://vercel.com/docs/monorepos) and [disable automatic Git deployments](https://vercel.com/docs/project-configuration/git-configuration#turning-off-all-automatic-deployments).

## Online and production prerequisites

The website bundle provides presentation and retained offline gameplay. Online play requires a separately verified V5 API/session/Core integration, not merely the existence of Vercel rewrites. Before enabling it:

- Verify canonical website/API/Core origins, owner-controlled domains, TLS, exact OAuth callback/association URLs and intended Vercel project identity.
- Preserve the same permanent actor/session model. Verify protected cookies, exact allowed origins, credentialed requests, CSRF and session-expiry behavior against the real V5 API. A static site cannot independently create an identity system.
- Connect the existing browser account/community/party paths to the authorized V5 services through a reviewed origin/compatibility contract; do not create a second SQLite writer. Verify realtime tickets, direct Core WebSocket reconnect and accepted HTTP fallback.
- Run real staging guest, linked account, Ranked, tournament, friends, reward/wallet and cross-platform tests. Approve legal/retention copy through its existing release gate. Keep store/ad rewards backend-verified.
- Rebuild from the reviewed commit; retain the manifest and checksums, browser/visual/accessibility evidence and staging service identities. Obtain the authorized release/cutover window before domain promotion or any production transition.

The live V4.1.2 SQLite authority at `play.antimatterinnovations.com` remains governed by the V5 cutover runbooks. Website readiness never authorizes its retirement or a PostgreSQL authority change.
