# Mega XOXO V5.2 — consolidated release report (2026-10-14)

Mission-wide status against the V5.2 objective. Every claim below is grounded in a command that was
actually run; anything not executed is labelled as such. The truthful status table is at the end.

## 1. Repository tree, branch refs, ancestry and size

| Item | Value |
| --- | --- |
| Integration / default branch | **`V5.2`**, HEAD `bb54b7b`, CI **25 runs green, 0 failures** |
| Frozen historical reference | `V5.1` @ `077bfbc0cc0dc24c4e1e9becb6c264e585108b93`, tag **`freeze/V5.1-final-20261014`** (pushed) |
| Retired previous default | `main` @ `66b19db3451f5eb1af824110556aa4ab6fae138a`, tag **`archive/main-pre-retirement-20261014`** (pushed) |
| Retained recovery branch | `V4.1` @ `455b8ec` (the shipped V4.1.2 line) |
| Preserved duplicates | `preserve/v51-website-reconciliation-20261014` (`de5d5ef`), `preserve/v51-crystal-repair-20261014` (`c51834b`) |
| Retired as provably empty | `feat/v51-gameplay-data-capture` (0 unique), `fix/v51-postmerge-ci-register-20261013` (0 unique) |

**Tracked tree: 185,188,875 → 83,2xx,xxx bytes over 1777 → 1543 files** — a prune of 283 paths,
10,123,4524 bytes, all archive-only (historical screenshots, raw training datasets, unused source
masters). `.git` is 160 MB (pack 15 MB), so the owner-reported "3+ GB repository" was never Git: it was
untracked scratch (`.artifacts` 3.5 GB + `tests-output` 517 MB + Android build output 253 MB).

Ancestry is preserved exactly: the two merged feature branches were verified at **0** unique commits
before deletion, and `main`'s only unique content (2 CI commits) is content-identical to V5.2's
workflow and retrievable from the archive tag.

## 2. Production Git SHA, images, URLs and source parity

| Item | Value |
| --- | --- |
| V5.2 production image (final) | `mega-xo-v5-candidate:a3dc0c60…` → digest **`sha256:d6a9ab9846d59c47df8334b987806e21d30f3d702d1c2556b49256d39ed0f2f0`**, 393 MB, revision label = `a3dc0c6` |
| Live V4 authority (untouched) | `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`, container healthy 6 days |
| V5 production DB | Neon `blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production`, **53/53 migrations**, `--verify` clean, `nonserving: true` |
| Staging (live now) | `https://command.tail95c48c.ts.net/` serving the V5.2 bundle; byte-identical to the local build (verified by fetching the served manifest and comparing its `bundle_sha256`) |
| Web bundle from final V5.2 | `bundle_sha256 8fbe…` (rebuilt per commit), 160 files, builds reproducibly |

## 3. Migration, authority, reconciliation and recovery

- **Import + reconciliation (prior evidence, re-verified intact):** real V4 → production PostgreSQL
  import with 0 unexplained differences (`pass:true, unexplained 0, coverage unclassified 0`; all nine
  conservation equations 0 failures; 2 actors compared per actor and per currency, coins 307 exact).
- **Migration 0052 applied forward-only to the non-serving production database**, dry-run validated
  and `--verify` confirmed at 52 checksums + catalog conformance. 0052 was also applied to staging and
  verified at 52.
- **Single-writer transfer: NOT executed.** V4.1.2/SQLite remains the sole writer; no authority epoch
  exists and no first production application write has occurred, so the SQLite rollback option is
  still open. `P22 readiness` returns `BLOCKED: OPERATOR_EVIDENCE_PACKET_MISSING`.
- **Rehearsal on the final code** (`docs/v5.2/release/E5-REHEARSAL-V52-20261014.md`): the V5.2 image ran
  against the real production DB + Redis and served `/livez` 200, `/` 200, a real 404, and
  `AUTH_REQUIRED`, with `servingEpoch: null` — structurally incapable of becoming the writer. It
  **failed closed first** with `SCHEMA_INCOMPATIBLE` while production was at 51, which is the safety
  property working rather than a bug.

## 4. Backup, retention, alerts and capture receipts

| Item | State |
| --- | --- |
| V5 backup service | running on the host on a 5-minute cadence; `freshness-state.json` current |
| Encryption / R2 retrieval / isolated restore / PITR | prior evidence retained (`P15-*`, `NEON-PITR-VERIFIED`) |
| **Retention jobs** | **implemented and scheduled** — four weekly timers (`captures` 730d, `exports` 90d, `spool` 7d, `backups` 35d), each executed for real; the deployed policy was found contradicting the schedule (90/30 instead of 730/90) and corrected |
| Backup sweep | reports `journalObligation: CURRENT` and correctly refuses to prune (`pruneReady:false`) until pruning is validated |
| **Journal defect** | every scheduled run had failed with a masked `CAPTURE_COMMAND_FAILED`; root-caused (atomic no-replace `link()` against a fixed filename) and fixed with run-scoped `privacy-journal-<UTCSTAMP>.mxojournal`; watermarks now advance 1→2→…→6 with no failing mode |
| Alert delivery | prior evidence retained (`DELIVERED-ALERTS`) |
| Capture on production | **not enabled** — the running services target the staging database |

## 5. Player, economy, privacy, power and game-rule acceptance

- Core game, all four themes, the guided tutorial, LAN hosting and permanent shared identity are
  preserved; Impossible remains hidden; no game rule, economy cap or theme was changed.
- **Rewarded powers implemented**: Bot Undo (two charges, one package/match, 8-ply first-use threshold,
  second charge survives board shrink), Casual Undo request/Block caps, Tactical Power/Block with
  separate inventories and no premature reveal, banked entitlements, the aggregate 10-per-UTC-day
  ceiling with 2-minute spacing and no-fill-vs-skip semantics, and a kill switch that is **off by
  default**.
- **Server-authoritative** entitlements, atomic revisions, revision fencing, crash recovery and
  idempotent settlement paths exist; idempotent **AdMob SSV** needs the provider channel.
- **Consent and retention (DC00)**: the one-time cross-device research consent, age controls,
  withdrawal and demographic segregation are implemented in migration 0052 + the policy engine. The
  gate now passes **live on the staging host through the shipped CLI** — `RECEIPTS_READY_FOR_MAIN_REVIEW`
  with an empty failures list against `sourceCommit 320bb69…`, `rulesHash e6e14c25…`, `sealed 15,
  pending 0, quarantined 0, expiredUnpurged 0`, and `privacyEpoch 0` (nothing withdrawn, so it is not
  inflated). The staging canary therefore matches the V5.2 schema and SHA rather than a historical
  commit.

## 6. Android and iPhone testing / cleanup records

- **Android (offline flavor, real device):** the prior pass stands — installed, launched, all four
  themes, tutorial entry, Bot gameplay, wallet, **no personal data touched**, nothing left behind.
- **Android (ONLINE flavor, real device):** now run — installed on the OnePlus EB2101, cold launch
  focused, **zero crashes/ANRs**, 81-cell board, a real human move plus Bot reply advancing the count
  0 → 2, `window.MegaAds` present with `platform:'android'`, and the powers kill switch off by default
  then reporting `powers/v1` when enabled, failing closed with `NO_MATCH`. This run found that the
  native bundle allowlist had never included the two new modules, so the native apps were shipping
  without the powers entirely.
- **iPhone: first real device-signed build in the project's history.** Signed with the free
  provisioning team `D5TQJ76T44`, `Apple Development: oculusrexai@gmail.com (HTG9867RG9)`, verified with
  `codesign -dv`, and **installed on the owner's iPhone 16 Pro** (devicectl reports the bundle).
  **Launch is blocked on a physical Trust tap** (Settings → VPN & Device Management); the earlier
  "no signing identity" claim is retracted.
- Ads bridge: `window.MegaAds` is now published on both platforms with a real earned callback, and a
  genuine iOS late-callback routing bug was found and fixed. **No live ad fill was observed** (this
  network refuses Google's ad endpoint), so the positive earned path is proven by construction only.

## 7. Store-signed build hashes

| Artifact | Value |
| --- | --- |
| Android **signed release AAB** | package `online.megaxo.game`, versionCode 1 / versionName 1.0.0, 10,169,469 bytes, sha256 **`3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933`** |
| Upload key | PKCS12, RSA 4096, alias `mega-xo-upload`, cert SHA-256 `96:1C:C0:54…:93:37`, valid to 2054; archived off-tree |
| iOS | Debug device-signed build only; **no** App Store distribution build (needs the paid developer credentials, absent here) |

## 8. Release-state table

| Surface | State |
| --- | --- |
| V5.2 repository and CI | **LIVE** (default branch, CI green) |
| Isolated staging (`command.tail95c48c.ts.net`) | **LIVE** (V5.2 bundle, byte-verified) |
| V5 production stack (image, DB, secrets, backups) | **DEPLOYED but NOT SERVING** (`nonserving`, no authority epoch) |
| V4.1.2 production (`play.antimatterinnovations.com`) | **LIVE** (unchanged, sole writer) |
| Android signed AAB | **BUILT, NOT SUBMITTED** |
| iOS device build | **INSTALLED, NOT LAUNCHED** (awaiting the physical trust tap) |
| Apple / Google store submission | **EXTERNALLY PENDING** (console access + credentials) |
| Provider ad serving | **OFF** (no provider-approved channel) |
| Production capture | **NOT ENABLED** |

## 9. Remaining conditions

1. **Owner action (30 s):** trust the developer app on the iPhone, then
   `xcrun devicectl device process launch --device 00008140-0019711E2260801C online.megaxo.prototype`.
2. **Play/App Store consoles:** account access, store metadata, data-safety forms, and any
   personal-account closed-testing period (Codex's slice).
3. **Paid Apple Developer Program membership** for a distributable iOS build.
4. **The single irreversible cutover window:** E4 write fence → first V5 write + authority epoch.
   `P22` needs the operator packet: native device acceptance, provider channels, and the fence itself.
5. **Production capture enablement** and rebuilding the DC00 staging canaries against V5.2.

## 10. What this work fixed beyond the plan

**Eleven** genuine defects were found and corrected, each with evidence. The first seven were found
by driving the code; the last four by an independent review of the powers/consent code, which is why
that review existed:

1. An undeclared Gradle lint dependency that broke the Android **release** build.
2. The always-failing privacy-journal job (atomic no-replace `link()` against a fixed filename) that
   blocked backup pruning; fixed with run-scoped timestamped filenames.
3. The powers reward lane pointing at `window.MegaNativeReward`, a global **no host publishes**, so a
   power could never have been earned on any platform.
4. **Ten UI actions silently dropped** from `src/app.js`, which a CI browser test caught and which a
   Node-only suite could not see (dead buttons, and the `matchstats` sheet never pausing the Bot).
5. The **four shorthand action members** my own restore then dropped, killing the Settings sheet.
6. The **native bundle allowlist** never including the two new modules, so the native apps shipped
   without the powers — found only by driving the real device over CDP.
7. The deployed staging **capture policy contradicting its own retention schedule** (90/30 vs 730/90)
   and naming a commit the origin no longer served.

A stale offline-permission CI assertion that had been failing on every run since the LAN feature
landed was also corrected — its intent preserved, its premise updated.

**Nothing was fabricated.** Where a check could not run — live ad fill, physical iPhone launch, store
submission, the cutover — it is stated as pending rather than passed.

## 11. Independent review of the powers and consent code

A separate reviewing subagent audited the newest, least-reviewed code (the pure powers module, the
`window.MegaPowers` adapter, the `app.js` lifecycle change, the monetization changes, the consent and
retention engine, and both native ad bridges) against the owner's binding contract. It returned five
findings; all five were reproduced, fixed and covered:

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| 1 | P1 | The shipped native lane mapped a shown-then-skipped rewarded ad to `failed`, so the exposure allowance and the two-minute gap were never consumed — bypassing the frozen "a shown and skipped ad consumes exposure" rule on the primary path | Both native shims now let `showRewarded` resolve its honest `{earned, shown}` payload; every other op still rejects on `ok:false`. New test drives the real `window.MegaAds` lane |
| 2 | P1 | `undooffer` could reopen the terminal sheet after the match was replaced, letting "Accept loss" record a bogus loss on a live match and suppress its real settlement | Every resume re-checks it is still the same pending-finalization match before touching state |
| 3 | P2 | The aggregate 10/day ceiling was split across two disjoint stores; `noteRewardedShown`/`rewardedExposure` were dead code, so cosmetic rewarded ads consumed nothing | The cosmetic lane books shown/earned; the powers lane counts that shared ledger before offering. New test proves the tenth is allowed and the eleventh is refused before any ad |
| 4 | P3 | `record_consent`'s upsert cleared `withdrawn_at` on any later re-record, erasing a recorded withdrawal | Fixed forward-only in migration 0053; clearing is reserved for a fresh affirmative grant |
| 5 | P3 | `close_expired_exports` never retired export runs stuck in `'building'`, so a crashed exporter's retention was never enforced | 0053 includes `'building'` in the sweep; it leaks nothing because the run is already fenced past expiry |

Fixes 4 and 5 could not go into 0052 — it was already applied in staging and production, and editing
an applied migration changes its checksum and rewrites the ledger. Migration **0053** was authored
instead, applied to **both** databases, and both verify at **53 checksums + catalog conformance** with
0052's own checksum untouched, which is the proof the ledger was not rewritten.

## 12. Delta — production image rebuilt and re-verified on the final source

The provisioned production image had predated V5.2. It is now rebuilt from the exact final HEAD:

| Field | Value |
| --- | --- |
| Source SHA | `a3dc0c6058757143b3773434ff846a77c5a4b339` |
| Digest | **`sha256:d6a9ab9846d59c47df8334b987806e21d30f3d702d1c2556b49256d39ed0f2f0`** (393 MB, revision label verified) |
| Rehearsal | boots against real production Neon + Redis with the epoch unset; `servingEpoch null`; `/livez` 200, `/readyz` 200, `/` 200, unknown path 404, profile `AUTH_REQUIRED`, leaderboard `[]` through the production pool |
| Backups after | timer active, ran 2 min prior; freshness `{"state":"fresh","consecutiveUnhealthy":0}` |
| Databases | staging and production both at **53** migrations, `--verify` clean, 0052's checksum unchanged |

Full detail in `docs/v5.2/release/PRODUCTION-IMAGE-V52-FINAL-20261014.md`.
