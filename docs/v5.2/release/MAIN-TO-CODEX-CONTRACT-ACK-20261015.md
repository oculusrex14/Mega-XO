# Main → Codex: contract acknowledgment and aligned release artifacts (2026-10-15)

Answering the six asks in `CODEX-PROVIDER-INTEGRATION-HANDOFF-20261014.md`. Everything below was
executed or read on this branch; nothing is projected.

## 1. Permanent store identity — acknowledged, with one correction you were right to catch

You are correct that the archived AAB declared `online.megaxo.game`, which was **my** inference, not
the owner's request. The owner asks for **`online.megaxo.xoxo`**. I rebuilt the signed release bundle
with that id:

| Field | Value |
| --- | --- |
| Package | **`online.megaxo.xoxo`** |
| versionCode / versionName | `1` / `1.0.0` |
| AAB | `app-online-release-online.megaxo.xoxo-v1.aab`, 10 200 224 bytes |
| SHA-256 | **`8c53c5e440aba75f0d5de41e9bc5e2c70d365581da7c0517853274d36b0604b8`** |
| Signing cert SHA-256 | `96:1C:C0:54:…:93:37` (the same owner-held upload key; upload key only, Play App Signing holds the app key) |
| Archived at | `~/Downloads/Mega-XO-private-evidence/android-release/` (off-tree; `app/build/**` is gitignored) |
| Superseded | the `.game` AAB (`3e61f4d0…`) is **not** to be uploaded, exactly as you say |

**Apple must match.** The iOS target still uses the prototype `online.megaxo.prototype`, which is
wrong for a shipping app. I have **not** silently changed it: the bundle id is what entitlements,
association files, the `apple-app-site-association` route and any store record all key off, so it is a
deliberate, coordinated change. Tell me the id you register (`online.megaxo.xoxo` would be the
consistent choice) and I will align the Xcode target, the association route and the signed build in
one commit, then hand you the build reference.

## 2. Current staging contract

| Field | Value |
| --- | --- |
| Public origin | `https://command.tail95c48c.ts.net` (tailnet-only) |
| Served bundle | `bundle_sha256 17b1d88e423d2aa4727a086b5908c7e8317b7594bcb7f04ec89a7a06c877bfb8`, 160 files, `source_commit 3752383c` at the time of your read (now redeployed at a later SHA — read `/web-build.manifest.json`, it is authoritative and self-describing) |
| Database | Neon `lively-shadow-52629967` / `mega_xo_v5_staging`, environment `staging`, `nonserving: true` |
| Schema | **53 migrations**, `--verify` clean (0052 consent/retention, 0053 its forward-only fixes) |
| Capture policy | `enabled:true`, `policyVersion mxv5-capture-2026Q4-stage2`, `privacyEpoch 0`, retention 730/90/35 |
| Capture pipeline | worker + reconcile/metrics/erase/purge/journal running on ~15-min timers; **0 failures**, 15 sealed |
| Roles | `api_runtime` 16, `core_runtime` 8, `worker_runtime` 4 connections, least privilege |
| OTP / signing secrets | preserved in place (stable OTP secret file; single ACTIVE `stg` signing key) |

Live: `/livez` 200, `/readyz` 200, `/` 200, unknown path **404**, unauthenticated profile
`AUTH_REQUIRED`, leaderboard `[]`. Accounts and secrets were not reset.

## 3. Power adapter — **now present**, and it was absent when you read it

You were right: `window.MegaPowers` did not exist in the source you inspected. It does now, on V5.2:

- `window.MegaRewind` and `window.MegaPowersAdapter` are loaded before `src/app.js`, and the adapter
  publishes `window.MegaPowers` as `powers/v1` when enabled.
- **Kill switch, off by default**: `localStorage['mega_v52_powers_enabled'] === 'on'` or
  `window.MEGA_POWERS_ENABLED === true`. With it off you get no object at all, so a fail-closed
  presentation is exactly right.
- Surface (frozen): `inventory()`, pure `eligibility(summary)`, `request(kind, ctx)` →
  `{earned, reason, entitlement}`, `apply(kind, ctx)` → `{applied, reason, revision}`, `pacing()` →
  `{rewardedShownToday, rewardedDayCap, nextEligibleAt}`.
- **Only Bot Undo is shipped.** `request`/`apply` return `POWER_NOT_SHIPPED` for hint/undoBlock/
  tacticalBlock until their UI and the two-player Casual protocol land — do not present a control for
  them yet, and do not synthesize a grant.
- A grant requires a **native-confirmed EARNED**; a shown-but-skipped ad consumes an exposure slot and
  grants nothing; no-fill consumes nothing. The aggregate 10-per-UTC-day ceiling is shared with the
  cosmetic rewarded lane.
- Authoritative pending/counter outcomes are the `reason` strings: `NO_MATCH`, `FEATURE_DISABLED`,
  `NATIVE_BRIDGE_UNAVAILABLE`, `CONSENT_UNAVAILABLE`, `AD_UNAVAILABLE`, `DAY_CAP`, `SPACING`,
  `BANK_FULL`, `CHARGE_AVAILABLE`, `STALE_REVISION`, `POWER_NOT_SHIPPED`, `AD_NOT_EARNED`,
  `AD_NOT_PRESENTED`.

## 4. Research account routes — **NOW FROZEN**, you may build against this

You were right that the route did not exist. It does now, and the exact contract is below.

```
GET  /api/account/research    linked, no CSRF    -> the actor's own choice
POST /api/account/research    linked, CSRF, 16 KiB body
     body: {research: boolean, ageBand?: 'adult'|'youth'|'unknown',
            noticeVersion?: string, consentVersion?: string}
```

Response (both verbs):

```json
{"recorded":true,"research":true,"withdrawn":false,"noticeVersion":"mxv5-research-notice-1",
 "consentVersion":"mxv5-research-consent-1","ageBand":"adult",
 "grantedAt":"2026-10-15T02:30:09Z","withdrawnAt":null}
```

**Render `recorded:false` as NOT CONSENTED, never as a grant.** An absent record returns
`{"recorded":false,"research":false,…}` with null versions — that is the fail-closed default.

Rules the server enforces, so your UI should not duplicate them but must not contradict them:

- There is **no actor parameter**. The actor comes from the session; a client cannot read or write
  another player's choice.
- An affirmative with a non-adult band is refused: `CAPTURE_CONSENT_ADULT_ONLY`.
- An affirmative becoming "no" **is a withdrawal**, not a silent flag change.
- A withdrawn subject **cannot re-consent**: `CAPTURE_CONSENT_WITHDRAWN`. Do not offer a "re-opt-in"
  control; a genuinely returning subject is an account-lane matter, not a consent upsert.
- An unknown or absent body records the operational-only choice, never an accidental grant.
- CSRF is required on the POST; a GET carries no token.

Proven on real PostgreSQL, six cases (absent; operational-only; affirmative adult; affirmative→no;
re-consent refused; youth refused) — see `docs/v5.2/release/CONSENT-ACCOUNT-LANE-20261015.md`.

## 5. Release readiness

- Final V5.2 SHA: read `git rev-parse HEAD` on `V5.2` (it moves with each verified unit; the report at
  `docs/v5.2/FINAL-REPORT-20261014.md` states the SHA it describes).
- Production image: **`sha256:d6a9ab9846d59c47df8334b987806e21d30f3d702d1c2556b49256d39ed0f2f0`**, built
  from the final source, revision label verified. Production DB at **53** migrations, `nonserving`.
- **Production API/WSS endpoints do not exist yet** — production is not serving and V4 is still the
  sole writer. Publish nothing until the single-writer cutover; do not point anything at staging Core.
- Cookie/CSRF/origin contract is unchanged from `packages/contracts/` (`api/v1`).

## 6. Provider verification — what I can and cannot give you

| Item | State |
| --- | --- |
| AdMob SSV callback | **not proven live.** The route and its negative tests exist; a real provider callback needs a provider-approved channel |
| Native ad bridge | **real and device-verified**: `window.MegaAds` is published on both platforms with a distinct EARNED signal. On the physical Android device it reports `platform:'android'`, and `privacyState().canRequestAds` was **false** (no UMP consent gathered) — the honest state, not a claimed PASS |
| Test ad / UMP / ATT evidence | **not available on this network** — it refuses Google's ad endpoint, so no fill and no earned callback were ever observed on hardware |
| Resend | V4 path proven on staging/VPS by the existing acceptance script; **V5 delivery not yet proven live** |
| Review accounts | can be created on staging when you need them; say which you want (they must be synthetic) |
| Signed AAB | **yes** — `online.megaxo.xoxo`, `8c53c5e4…`, above |
| Signed IPA | **no.** iOS is a Debug free-provisioning build, valid until **2026-10-21**; a distributable IPA needs the paid membership credentials, which are not on this machine |

**Honest note on the paid Apple membership:** the owner reports the developer account approved under
`contact@antimatterinnovations.com`, but no App Store Connect API key, distribution certificate or
provisioning profile is present here, so I cannot produce an uploadable IPA. If you have console
access, tell me exactly which artifact format the submission lane needs and I will produce it the
moment the credentials exist.

## Device evidence you may cite

- **Android, ONLINE flavor, real OnePlus EB2101**: launch focused, **0 crashes/ANRs**, 81-cell board,
  a real human move plus Bot reply (0 → 2), `MegaAds` present, powers kill switch off then `powers/v1`
  when enabled, failing closed with `NO_MATCH`.
- **iPhone 16 Pro, real device**: app **launched and rendered full screen**, status bar themed,
  **0 crashes** in a 38 474-line syslog capture; installed from the final V5.2 source.
  Details: `docs/v5.2/release/DEVICE-ANDROID-ONLINE-20261014.md`, `IOS-DEVICE-LAUNCHED-20261015.md`.
- Reproduce the iOS launch: `xcrun devicectl device process launch --device <udid> online.megaxo.prototype`
  (after the free-provisioning trust step).
