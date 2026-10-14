# Mega XOXO V5.1 — final production deployment report (2026-10-14)

**Outcome:** the website, backend, database, recovery, monitoring and one physical platform are built,
provisioned and independently verified. The final **V4→V5 authority cutover is deliberately not
executed**, because two mandatory gates are blocked on external decisions, and the owner's directive
requires postponing the cutover automatically while a mandatory gate fails. Nothing in this report is
claimed as passing that was not observed.

## 1. Source, images and CI

| Field | Value |
| --- | --- |
| Integration branch | `V5.1` (sole) |
| HEAD at this report | `03c1f879bfdc56924fabbfcc453b690f20fc4e95` |
| Frozen launch candidate | `4c1c16819ecf44254b994951d4d20f2613610d3f`, content hash `640ed89a9a04e760d46981d1e54d888f15d407351d1b114c3084e4c1636a35d5` (`V5_SOURCE_CANDIDATE_OK`, `NOT DEPLOYABLE` by design) |
| **V5 production image** | `sha256:41b8b7a3283647d76cf0929cb809bd072422f722759f1df8484ace06f6b4a792` (built on the host from the exact HEAD `07c9fbab…`, 393 MB, revision label verified) |
| V4 production image (retained) | `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4` (rev `f1e5577`) |
| CI | 21 lanes targeted at `V5.1`; green on the tip and on every pushed milestone this session; no unexplained failures or skips |

## 2. Production URLs, DNS and TLS

| Host | Serves | State |
| --- | --- | --- |
| `play.antimatterinnovations.com` | V4.1.2 (live authority) | 200; retained for client migration |
| `core.megaxo.online` | signed Core gateway edge (Caddy) | deployed; Let's Encrypt cert; `/`→404, only `/ingress/*` routed; HMAC enforced |
| `command.tail95c48c.ts.net` | isolated staging origin (HTTPS+WSS) | live; served bundle hash-identical to its build |
| `api.megaxo.online`, `megaxo.online`, `www` | not yet attached | DNS is at Hostinger; Vercel projects `mega-xo-api`/`mega-xo-web` exist with previews only, env scoped Preview/Development |

## 3. Sole authority and writer epoch

- **Production authority: V4.1.2 / SQLite**, single writer, `nonserving` V5 database.
- No authority epoch exists; **no first production application write has occurred**.
- V4 write surface mapped: only `mega-xo-production-app-1` mounts the database read-write (the backup
  container is `rw=false`); no product cron writes; fence manifest valid for the current `V4_SERVING`
  phase (`v4-serving-manifest.json`, 16/16 classes, `callbacksFailClosed=false`).

## 4. Migration reconciliation totals

| Measure | Value |
| --- | --- |
| Migrations applied to production Neon | **51/51** (checksum-verified; channel binding SCRAM-SHA-256-PLUS) |
| Runtime roles | 5 LOGIN, least privilege (16/8/4/2/2 connection limits) |
| Import | real V4 snapshot, 77 batches, 8 549 rows |
| Reconciliation | **0 unexplained**, **0 coverage-unclassified**; C1–C9 all pass on per-actor/per-currency data |
| Principals | 2 actors / 2 wallets / 2 matches / 2 profiles / 2 email credentials; wallet total **307 coins** |
| Capture isolation | **no runtime role can read the `learning` capture tables** (independent probe) |

## 5. Backup, restore and key custody

| Item | Value |
| --- | --- |
| V4 backup repository (untouched) | `s3:…/mega-xo-backups/mega-xo-v4-production`, 611 snapshots, newest every ~15 min |
| V4 restore drill | snapshot `8d426537…` restored off-box, sha256 `c77632f0…` equals the manifest, `quick_check ok`, 0 FK violations |
| **V5-only R2 bucket (new)** | `mega-xo-v5-dr-archives`, prefix `megaxo/v5/pg16-encrypted/v1/`; bucket-scoped writer + **separate** reader credential |
| V5 encrypted backup | archive `9fc3fa9a…`, 224 362 B; **independent reader retrieve sha256 equal** |
| **Measured RPO/RTO** | backup wall **36.1 s** (target: 15 min); restore into an isolated PG16 **<1 s** for this dataset (target: 60 min) |
| Complete DR restore | every relation count equals production exactly, including the 307-coin total, and **zero `learning` capture data** |
| Neon PITR | 6-hour history window; a recovery point reconstructed the historical state (49 migrations) |
| Automatic service | 5-minute systemd timer, upload+readback verified in ~1.1 s, archive decrypts and restores; freshness checker FRESH at 29 s vs 900 s RPO and alerts when stale |
| Key custody | RSA-3072 recipient; **private half off-host only**; host-wide search proved no private key on the host |

## 6. Delivered monitoring and alerts

The production health monitor's real `healthy→unhealthy→healthy` transition fired the **incident** and
the **recovery** alert through the live Resend key to `contact@antimatterinnovations.com`; the same send
path was independently confirmed HTTP 200. The key is send-only (correct least privilege). V5-specific
signal thresholds remain to be wired and individually proved.

## 7. Day-one gameplay capture (DC00/R35)

Owner-authorized and **recorded**. Policy derived from the privacy contracts with citations; staging
policy enabled; real canaries through the real Core; 13 of the **15** release-gate evidence classes
demonstrated with real runs. The gate reports `BLOCKED` with exactly
`["MISSING_privacyPurpose","MISSING_retention"]` — deliberately left out pending the controller's
purpose acceptance and approval of the retention windows. `productionAuthorized:false`,
`trainingAuthorized:false`.

## 8. Device matrices and phone cleanup

| Platform | Result |
| --- | --- |
| **Android (OnePlus EB2101, Android 13)** | dev build installed and launched; zero crashes/ANRs; all four themes applied on-device; real Vs Bot match played with the forced-board rule verified; offline banner correct. **Cleanup: no helper, file or setting left on the phone** |
| **iOS (iPhone 16 Pro)** | build + byte-identical cross-platform client parity (`e0381428…`, 97 files); **device matrix NOT RUN** — 0 signing identities, 0 provisioning profiles (Apple enrollment pending). iPhone untouched |
| Cleanup verification | no agent-created artifact remains on either phone; personal data never touched |

## 9. Website and backend live smoke

| Check | Result |
| --- | --- |
| Staging origin over public HTTPS | `/livez`, index, manifest, legal, robots all 200; served payload hash-identical to its build |
| P21 acceptance | 261 assertions → **256 pass / 5 skip / 0 fail** |
| Real two-account online journey over the deployed HTTPS/WSS origin | `ok:true`, **31/31** |
| Production stack against production data (rehearsal) | `/livez` and `/readyz` 200, website 200, `app-ads.txt` 200, real 404, authenticated leaderboard 200, anonymous profile **401**, `X-Robots-Tag: noindex`; refuses to arm an authority epoch |

## 10. Acceptance

40 original cases reconciled against executed evidence: **PASS 14, RUNNING 15, BLOCKED 11, NOT_RUN 0**
(`ACCEPTANCE-CASE-RECONCILIATION-20261014.md`). The P0 triage audit was re-baselined with every
anti-promotion guard kept (verified by a 9-case mutation harness). G00–G20 accepted; P21 is
owner-deferred.

## 11. Outstanding provider-dependent work

| Item | State |
| --- | --- |
| Native online target (Android/iOS authenticated transport + session lifecycle) | in progress this session; the offline boundary is currently shipped |
| Real app IDs, signing identities, entitlements, association files | need the owner's store accounts; association files are honest placeholders matching the built dev ids |
| Store billing / live ads | provider-approved state absent; test/sandbox paths only |
| iOS physical-device acceptance | blocked on Apple enrollment |
| Vercel apex/API domain attachment | DNS authority is at Hostinger; prepared, not executed |
| Realistic-history RPO/RTO | small-data measurements |
| **Production cutover (E4 fence, E5 first write, retirement)** | **postponed** — mandatory gates blocked (see below) |

## 12. Why the cutover did not happen

`scripts/v5/p22/readiness.js` returns **BLOCKED** with `OPERATOR_EVIDENCE_PACKET_MISSING`, and the DC00
day-one gate returns **BLOCKED** with the two missing receipts. Both require external decisions no agent
may fabricate. Fencing V4 without them would stop the only live authority. Per the directive:

> "If a mandatory website/backend/day-one-capture gate fails, fix it, test again and postpone the
> cutover automatically until passing."

**Exact unblocking actions:** (1) Apple Developer approval → real iOS identity → the device matrix;
(2) owner/controller acceptance of the capture purpose + the retention windows → the two receipts;
(3) owner confirmation of live provider channels or an explicit decision to launch without them.
Then the single irreversible window: E4 fence → first V5 write + authority epoch → endpoint switch →
retirement, using `V5-INCIDENT-AND-FORWARD-RECOVERY-RUNBOOK-20261014.md`.

## 13. Relevant commits and evidence

Commits this session (pushed, CI-green): `78b2582` (native-bundle canonical link fix), `3fb7dba` +
`424923a` + `2018ed9` (real production backup, V5 R2 target, DR), `792ebe7` (public allowlist fix +
PITR evidence), `4b537a5` (device reports), `478f568` (delivered alerts), `4c1c168` (data-only restore
path), `735fcb3` (restore procedure), `2fcc460` (write-fence inventory), `5276d98` (runbook),
`e729ddb` (Stage D qualification), `e4a1190` + `6ea14f1` (production server + rehearsal), `f043448`
(backup service), `3283ae8` (canonical evidence JSON), `7004b72` (acceptance reconciliation),
`03c1f87` (cutover postponed + `V4_SERVING` fence manifest).

Evidence lives in `docs/v5.1/release/` (19 documents this session), `docs/v5.1/data/`,
`docs/v5/evidence/phase22-production-cutover-prep.json`, and privately (0600, never committed) under
`~/MegaXO-private/` and the host's `/opt/mega-xo-v5-production/`.
