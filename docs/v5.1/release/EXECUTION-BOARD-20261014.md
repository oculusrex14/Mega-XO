# Mega XOXO V5.1 — shared execution board

**Owner directive:** 2026-10-14. Stages A–E including the final production cutover are
**authorized**; Google Play / App Store publication remains excluded until provider approval.
This page is the live coordination index for Main (VPS/integration/DB/native/release) and Codex
(provider consoles/browser/website). Exact SHAs and evidence links only; no claim without a real run.

- Integration branch: `V5.1` (sole). `main`, `V4.1`, tags and recovery artifacts preserved.
- Entry HEAD this session: `666be4e5df5ff6def00a91401b9b5c65e6ed2c20` → now `78b2582`.
- Production authority: **V4.1.2 / SQLite** on Oracle host `command`, digest
  `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`,
  revision `f1e5577d42809fc3da889ba76b87ca6c87e68575`; `play.*` livez/opsz 200.

## Domain layout (target)

| Host | Owner | State |
| --- | --- | --- |
| `megaxo.online` / `www.megaxo.online` | Codex (Vercel website) | website source on `V5.1`; not yet published |
| `api.megaxo.online` | Codex (Vercel stateless API) | project created; preview only |
| `core.megaxo.online` | Main (Oracle signed Core gateway) | edge deployed (staging Core, HMAC 11/11) |
| `play.antimatterinnovations.com` | Main | V4 facade, retained for client migration |
| Email | Main | reuse V4 Resend; `contact@antimatterinnovations.com`; no V5 mailbox |

## Lane ownership (exclusive shared files)

| Area | Owner | Notes |
| --- | --- | --- |
| `docs/v5.1/release/*`, `docs/v5.1/data/*` | Main | board, evidence, decisions |
| `docs/p21-web/*`, `public/*` | Codex | website/legal/checklist |
| `packages/*`, `scripts/v5/*`, `scripts/v51/*` | Main | integration, migration, Core, native, release |
| Provider consoles, Vercel projects, store listings | Codex | Main supplies exact requirements/evidence |
| Production host, DB authority, backups, native execution | Main | |
| `AGENTS.md`, root manifests | Main | avoid concurrent writes |

## Task board

| ID | Pri | Owner | State | Work | Evidence / next |
| --- | --- | --- | --- | --- | --- |
| B01 | P0 | Main | DONE | Reconcile HEAD; fix real CI failure (native bundler refused canonical `https://megaxo.online/` in P21 legal pages) | `78b2582`; `tests/v5-client-bundle.test.js` 16/16, `v5-native-foundations` 30/30 |
| B02 | P0 | Main | DONE | Stage latest P21 bundle + verify served bytes | bundle `31cdb4d3…`; 152/152 payload files hash-identical over public HTTPS; only `source_commit` field differs |
| B03 | P0 | Main | IN PROGRESS | Real two-account online acceptance over the deployed staging origin (WSS/session/settlement) | R05 public-origin run |
| B04 | P0 | Main | TODO | Board + owner-authorization ledger entry (DC00/R35 day-one capture) | this page |
| A01 | P0 | Main | CLOSED | P3 signed Core edge re-verification (fresh evidence) | `P3-EDGE-V4-REGRESSION-20261013.md`; re-run in B03 |
| A02 | P0 | Main | TODO | Resend: install V5 secrets via protected files; real signup-verify/reset/change/failure tests; no OTP capture | reuse V4 provider; isolated from live users |
| A03 | P0 | Main | TODO | #11/R08/G15: V4 Restic/R2 inventory + non-serving restore; V5 R2 bucket; real PG16 logical backup→encrypt→retrieve→restore; Neon PITR; measured RPO/RTO | Cloudflare CLI auth present |
| A04 | P0 | Main+Codex | TODO | #10/R09: real monitoring providers; instrument website/API/Core/realtime/Neon/Redis/backups/email/worker/gateway/latency/capture; prove incident+recovery alert delivery | needs provider console (Codex) |
| A05 | P0 | Main+Codex | TODO | DC00/R35 day-one capture: policy/disclosures, choice binding, capture roles, staging canaries, collector/reconciler/metrics/erasure/export-purge/journal ops, 15 release receipts | collector already merged + lab-verified |
| B05 | P0 | Codex | TODO | Vercel: publish `megaxo.online`/`www`/`api.` projects; wire real Oracle Core; receipts + rollback | Main supplies Core endpoint + HMAC key |
| B06 | P0 | Main+Codex | TODO | Native: real app IDs, signing identities, entitlements, association files, release configs | Play registered; Apple enrollment pending |
| C01 | P0 | Main | TODO | Device discovery (ADB/usb/xcrun); dev-build-only install; no personal-data destruction | 2 owned phones on USB |
| D01 | P0 | Main | TODO | Immutable launch candidate from final SHA; reconcile 40 acceptance cases/G00–G20/P21/R35–R38 | `scripts/v5/release-source-candidate.js` |
| E01–E05 | P0 | Main | TODO | Authorized cutover: freeze+backup → import+reconcile → sole authority → fence V4 → start V5 + verify | one owner GO recorded (directive) |

## Blocking prerequisites and external state

| Item | Exact state | Owner action |
| --- | --- | --- |
| Google Play Console | Personal registration + payment complete; verification documents submitted | none now |
| Apple Developer | Membership paid; **enrollment pending** | wait for approval |
| Vercel domain/website publish | Codex lane | needs Main's Core endpoint |
| Cloudflare R2 tooling | authenticated on Mac | Main to verify scope before changes |
| Neon production DB | project `blue-sun-85454968`, nonserving, PITR window **21600s (6h)** | note for RPO target |
| Staging Core | `core.megaxo.online` → **staging** Core; must not be used by production API | switch at cutover |

## Decisions log

- **D1 (2026-10-14):** canonical site links in bundled native assets are resolved through a validated
  exact-match allowlist (`canonical_link_rewrites`), not by weakening the non-local-dependency guard.
- **D2:** `megaxo.online` website source lives on `V5.1`; the bundle is built by
  `scripts/p21/build-web.js` and served from the isolated staging origin.
- **D3:** Production API must never point at the staging Core; Core credentials/DB/Redis namespace are
  provisioned independently at cutover.

---

## Session close — 2026-10-14 outcome

All A01–A40 cases were reconciled against executed evidence: **PASS 14 / RUNNING 15 / BLOCKED 11 /
NOT_RUN 0** (`ACCEPTANCE-CASE-RECONCILIATION-20261014.md`). Gates G00–G20 accepted; P21 owner-deferred.

### Completed and verified

| Area | Evidence |
| --- | --- |
| Production PostgreSQL: 51/51 migrations, 5 least-privilege roles, capture-table isolation | `PRODUCTION-PG-PROVISIONED-20261014.md` |
| Real V4→PG import + reconciliation (0 unexplained, C1–C9 pass) | `E2-PRODUCTION-IMPORT-RECONCILIATION-20261014.md` |
| V4 snapshot restored off-box, hash equals manifest | `E1-V4-SNAPSHOT-RESTORE-20261014.md` |
| V5-only R2 target + real encrypted backup + independent retrieve | `P15-V5-BACKUP-RETRIEVE-MEASURED-20261014.md` |
| Complete DR restore (counts equal production) | `P15-DR-RESTORE-PROVEN-20261014.md`, `P15-PRODUCTION-RESTORE-PROCEDURE-20261014.md` |
| Neon PITR recovery point | `NEON-PITR-VERIFIED-20261014.md` |
| Incident + recovery alerts delivered | `DELIVERED-ALERTS-20261014.md` |
| Automatic supervised backup service | `V5-BACKUP-SERVICE-20261014.md` |
| Day-one capture policy + 13/15 receipts | `DC00-R35-COLLECTION-EVIDENCE-20261014.md` |
| Production image/secrets/namespace + live rehearsal | `E3-PRODUCTION-STACK-PROVISIONED-20261014.md`, `E5-PRODUCTION-STACK-REHEARSAL-20261014.md` |
| Write-fence inventory + `V4_SERVING` manifest | `E4-V4-WRITE-FENCE-INVENTORY-20261014.md`, `v4-serving-manifest.json` |
| Android online/offline flavors + real device install | `native/android/**` (`3531e98`), `DEVICE-ANDROID-EB2101-20261014.md` |
| iOS build + cross-platform parity | `DEVICE-IOS-IPHONE16PRO-20261014.md` |
| Website acceptance 256/5/0; domain association prepared | `P3-*`, `VERCEL-DOMAIN-PREPARED-20261014.md` |
| Incident/rollback/forward-recovery runbook | `V5-INCIDENT-AND-FORWARD-RECOVERY-RUNBOOK-20261014.md` |
| Final report | `FINAL-PRODUCTION-DEPLOYMENT-REPORT-20261014.md` |

### Postponed (mandatory gates blocked)

E4 fence → E5 first write → retirement are **postponed** because the P22 operator packet and the DC00
day-one gate are both BLOCKED on external decisions. Exact unblocking actions are in
`E4-E5-CUTOVER-POSTPONED-20261014.md`.

### Open (in flight / owner-gated)

- Native session lifecycle client wiring + iOS parity (agents).
- Native session routes mount in `apps/api/routes/account.js` (agent).
- Real app IDs / signing identities / entitlements (owner).
- Store billing + live ads (provider approval).
- Vercel apex/API DNS records at Hostinger (owner).
