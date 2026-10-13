# Owner review applied — 14 October 2026

Source milestone **5897497493617e1f389af1626451899831045840**, pushed fast-forward to V5.1. Existing uncommitted `scripts/p21/staging-browser-qa.cjs` is preserved and excluded from this milestone. Main's advancing commits were fetched and fast-forwarded in Codex's isolated worktree; Main's active checkout and training work were not edited.

## Eight comments

| Comment | Result |
| --- | --- |
| 1 — Sponsors privacy button cramped | Separate action row; measured 26px gap after the disclosure list, on desktop and mobile. |
| 2/3 — Media-kit presentation and removal | Later explicit removal controls: removed `/press` view, route metadata, generated page, footer link, sitemap entry and Vercel rewrite. Assets retained. `/press` and `/pages/press.html` return 404. |
| 4–7 — Privacy/Terms draft notices | Completed full policy wording and removed draft notice/version bars. Clean and themed legal aliases share the same source bodies. Policies reflect sole-proprietor/hobby status, actual data handling, inactive commercial features and disabled gameplay capture. Email-only contact follows owner instruction. Formal compliance limitations are recorded in `docs/legal/WEBSITE-POLICY-UPDATE-20261014.md`. |
| 8 — Settings discretion | Retained: this is the existing user-facing place for saving/removing the offline copy and finding account/privacy controls. |

## Deployment identity and preservation

- Review origin: https://command.tail95c48c.ts.net
- Frontend source: `5897497493617e1f389af1626451899831045840`.
- Bundle: `31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c`; **152 files / 3,547,734 bytes**.
- Actual backend source remains **3e51ba0c95d1083fe89e7c6f909e7590cee1a600**; entry SHA256 `f73e8a0c8d49ccfe6666583d8a2b0f4aa055a151cf2d6f1d7df3d715b8740c69`.
- Staging PID **2441819**, boot **2026-10-13T20:09:16.880000Z** (14 October, 01:39:16 IST).
- Existing backend checkout `/opt/mega-xo-v51-staging/repo` unchanged. Only the frontend artifact was replaced, then the inspected staging process was gracefully restarted with the same executable, arguments and inherited environment to reload its manifest allowlist.
- Current artifact alias `/opt/mega-xo-v51-staging/p21-web` points to `/opt/mega-xo-v51-staging/codex-frontend-releases/5897497493617e1f389af1626451899831045840/web`.
- Previous artifact preserved at `/opt/mega-xo-v51-staging/p21-web-before-5897497493617e1f389af1626451899831045840`. Prior deployment receipt preserved in the versioned release. Root deployment receipt now distinguishes backend and frontend source identities.
- New process is a detached staging Node process, not a new production service. Future operators must inspect/stop its exact PID rather than assuming the former tmux session owns it. Staging `run.sh` remains unchanged and still resolves the stable frontend path.
- All existing secret-file hashes unchanged; no account/database/schema reset, policy-gate activation, provider configuration, production deployment, DNS or V4 change. No forced kill or force push.

## Acceptance

| Evidence | Environment | Result |
| --- | --- | --- |
| `node --test tests/v5-p21-*.test.js tests/v51-p21-bot.test.js` | Local Node 26.8.2, isolated checkout | **256/256 PASS**, 0 skip |
| `node --test tests/legal-pages.test.js` | Local disposable service/SQLite fixture only | **3/3 PASS** after replacing the stale draft-banner expectation; prior failure preserved |
| Layout/content/removal checks | Local loopback: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5; widths 1625/390/320 | **45/45 PASS**; 36 rendered-page axe audits, 0 detected violations |
| Public HTTPS browser checks | Actual staging Chromium; widths 1625/390; Sponsors, Privacy, Terms, Settings, removed Press/sitemap | **10/10 PASS**; 8 rendered-page axe audits, 0 detected violations; screenshots captured |
| Served bytes | Actual deployed staging loopback HTTP via SSH, distinct from public HTTPS | **152/152** files match hash/size, all noindex |
| Health / initial public HTTPS manifest | Actual staging | `/livez` 200 ready; frontend source/hash matches pinned receipt |

Browser command: `NODE_PATH=<existing Playwright modules> PLAYWRIGHT_BROWSERS_PATH=.artifacts/realtime-qa-browsers env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node .artifacts/p21-owner-review/visual-qa.cjs`; staging additionally sets `P21_REVIEW_ORIGIN=https://command.tail95c48c.ts.net` and a separate output directory. The driver stamps the pinned frontend identity verified separately by deployment/served-payload evidence. The complete local three-engine matrix is not mislabeled as a live three-engine/device pass.

Build command: `env -u NODE_OPTIONS /Users/oculus/.hermes/node/bin/node scripts/p21/build-web.js --output .artifacts/p21-owner-review/web`. The guarded frontend deploy driver hash is `b9f81f607f362949605e2013b56584ad43eea9d2fbcc377dc3569b83a270995b`; artifact upload SHA256 `d81eade1a83b7f8645e2aaca4bbf55fd1aaafa4312afe80deb25658e1dbc20a0`. It refuses changed process/target/build, checks every payload before swapping, retains the old artifact and can restore it on failed health.

Evidence and screenshots: `docs/p21-web/evidence/20261014-owner-review/`, with checksummed artifact index. Initial TLS/networkidle/large-manifest timeouts remain accurately recorded in `preserved-failures.json`; they are not substituted with a claimed public all-file transfer pass. Physical-device, commercial-provider, formal policy/retention and production-cutover gates remain separate.

## Recovery

Restore the preserved prior frontend only after checking the current staging process/artifact identity; keep the same current V5 PostgreSQL backend, secrets and accounts. Reload the inspected staging process against the restored manifest and verify health. Do not restart a SQLite production writer or reset data. The published source changes can also be reverted with an ordinary forward revert after reviewing subsequent V5.1 commits; never reset/force-push shared history.
