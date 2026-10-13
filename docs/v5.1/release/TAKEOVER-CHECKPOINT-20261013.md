# V5.1 takeover checkpoint — 2026-10-13

Continuing Codex's unfinished deployment/integration/release work as sole integration owner on
`V5.1`. Entry HEAD was `4e7d3858`; latest pushed HEAD is `1284c5b` (see below). Every claimed result
has an evidence doc under `docs/v5.1/release/` and a commit.

## Milestone status

| Priority | State | Evidence |
| --- | --- | --- |
| P1 staging website | **DEPLOYED + verified** — live `9628ed7`, 153-file bundle, old 140-file `f4851a5` retired, HTTPS/WSS/session/CSRF/404 verified | `STAGING-DEPLOY-20261013.md` |
| P2 online acceptance | **31/31 PASS** on the deployed origin — two real accounts, matchmaking, concurrent accepts, realtime move + fan-out, full legal game to line-win + settlement, economy/history, reconnect, fencing, live resignation, logout | `P2-ONLINE-ACCEPTANCE-20261013.md` |
| P3 Vercel | **projects created + preview live** — `mega-xo-web` + `mega-xo-api`; API reaches real staging Neon (session 200); routes/CSP/caching/boundary verified; DNS prepared (not attached) | `VERCEL-DEPLOYMENT-20261013.md`, `DNS-DOMAIN-ASSOCIATION-20261013.md` |
| P4 native | **Android APK + iOS simulator app BUILT**; identical client bundle hash across platforms | `NATIVE-BUILDS-20261013.md` |
| P5 provider/store | **readiness inventory** (code-present vs provider-approved); store links honestly null | `PROVIDER-READINESS-INVENTORY-20261013.md` |
| P6 backend | **suites executed** on disposable PG16/Redis; **CI trigger gap fixed** (10 workflows only targeted the retired branch); P08 stall defect + P15 seal race fixed | `P6-BACKEND-VERIFICATION-20261013.md` |
| P7 collector | **PR #12 reviewed (READY_WITH_FIXES) and INTEGRATED**; 58 non-PG + 11 PG capture tests pass; capture CI green | `GAMEPLAY-CAPTURE-PR-REVIEW-20261013.md` |
| P8 production | **read-only recon** — single SQLite writer `71d33a1a`; no cutover | `PRODUCTION-AUTHORITY-RECON-20261013.md` |
| P21 a11y | **automated audit** 54 PASS/0 FAIL, 161 contrast pairs, 8 contrast defects fixed | `P21-A11Y-AUDIT-20261013.md` |

## Real defects found and fixed this session

1. Matchmaker tick missing on the isolated staging origin → real two-browser queue joins never paired (`890ec4a`).
2. Core wallet provisioning not wired into the staging account service → first economic command failed `ACCOUNT_REQUIRED` (`11e6f50`).
3. Vercel API default handler built an incomplete pool + 40-char SHA revision → every route 409 (`0902d73`).
4. Account-deletion acknowledgement dropped the durable `tombstone`/`actorHash` (`1a80ebc`, WebUI peer).
5. Ten CI workflows triggered only on the retired `V5-platform` branch → DB/failover/chaos gates silently never ran for V5.1 (`6e914f0`, `4f907d2`, `ae288ff`).
6. P08 slow-client bound closed the socket with `destroy()` after writing the 1008 frame → the frame was discarded and never delivered (`3adf278`, P08 peer).
7. P15 `sealStream` could leave the `.partial` ciphertext behind (destroy-then-unlink race) (`ac452fa`).
8. P21 contrast: 8 real theme/component contrast failures fixed; audit harness added.

## Running/deployed identities

- Staging origin: `https://command.tail95c48c.ts.net` → `127.0.0.1:8085`, source `9628ed7`, bundle
  `sha256 2887b0cd…`, 153 files.
- Vercel: `mega-xo-web` (static, 38 routes 200), `mega-xo-api` (preview, staging-Neon sessions).
- Production (untouched): `mega-xo-production-app-1` image `71d33a1a…`, one caddy ingress on 80/443.

## Outstanding owner actions

- **Vercel → Core**: needs a public signed Core edge (DNS/domain decision) — the API is not the
  economic authority and must not proxy into the private tailnet endpoint.
- **DNS**: `megaxo.online` is Hostinger-parked; attach to Vercel at launch (`DNS-DOMAIN-ASSOCIATION-20261013.md`).
- **Stores/devices**: Play/App Store membership (MFA/attestations/fees), signing identities, physical
  device acceptance.
- **Provider**: monitor IDs / `read:packages`; real email provider (`RESEND_API_KEY`); real commerce/SKU.
- **Launch**: one go/no-go for the irreversible production cutover (P8).

## Remaining critical path to the go/no-go

1. Final source/image freeze + V4 backup/restore validation + export snapshot.
2. Per-actor import + economic reconciliation with zero unexplained differences.
3. PostgreSQL sole-authority config + single-writer fence + first-write boundary.
4. Worker/callback readiness + monitoring/alerts.
5. Owner go/no-go → tested cutover runbook → verify production → retire V4 authority.

Training programme and Impossible remain **DEFERRED BY OWNER**.
