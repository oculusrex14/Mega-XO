# Mega XOXO V5.2 — consolidated release report (2026-10-14)

Mission-wide status against the V5.2 objective. Every claim below is grounded in a command that was
actually run; anything not executed is labelled as such. The truthful status table is at the end.

## 1. Repository tree, branch refs, ancestry and size

| Item | Value |
| --- | --- |
| Integration / default branch | **`V5.2`**, HEAD `941998c4125f72ceb68ba81895ccb3c36ef5e58c`, CI **11 workflows green, 0 failures** |
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
| V5.2 image built on the host | `mega-xo-v5-candidate:8ebeb0c6…` → digest **`sha256:8e53d6679119f355bf3951ad53880b87f5f0f8ae0a3ae2db77aae1e9a788832e`**, 393 MB, revision label = the source SHA |
| Live V4 authority (untouched) | `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`, container healthy 6 days |
| V5 production DB | Neon `blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production`, **52/52 migrations**, `--verify` clean, `nonserving: true` |
| Staging (live now) | `https://command.tail95c48c.ts.net/` serving bundle `d9e281c0…` / commit `ad847de` / 160 files — byte-identical to the local build |
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
| **Retention jobs** | **implemented and scheduled** — four weekly timers (`captures` 730d, `exports` 90d, `spool` 7d, `backups` 35d), each executed for real |
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
  withdrawal and demographic segregation are implemented in migration 0052 + the policy engine, and
  the DC00 gate now returns **`RECEIPTS_READY_FOR_MAIN_REVIEW`** — independently re-verified by Main at
  the reported SHA, with `MISSING_privacyPurpose` and `MISSING_retention` gone and the validator's
  binding still refusing a mismatched receipt.

## 6. Android and iPhone testing / cleanup records

- **Android (offline flavor, real device):** the prior pass stands — installed, launched, all four
  themes, tutorial entry, Bot gameplay, wallet, **no personal data touched**, nothing left behind on
  the device. The **online flavor** device pass has **not** run (no phone attached during this work).
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

Four genuine defects were found and corrected, each with evidence: an undeclared Gradle lint
dependency that broke the Android release build; the always-failing privacy-journal job that blocked
backup pruning; the powers reward lane pointing at a global no host publishes (so a power could never
be earned); and **ten UI actions silently dropped from `src/app.js`**, which a CI browser test caught
and which a Node-only suite could not see. A stale offline-permission assertion that had been failing
on every run since the LAN feature landed was also corrected — its intent preserved, its premise
updated.

**Nothing was fabricated.** Where a check could not run — live ad fill, physical iPhone launch, store
submission, the cutover — it is stated as pending rather than passed.
