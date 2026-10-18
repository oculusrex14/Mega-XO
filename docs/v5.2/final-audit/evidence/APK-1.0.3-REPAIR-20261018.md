# Direct Android APK 1.0.3 repair

18 October 2026. This record supersedes earlier claims that native email sign-in or all online
reads were verified on 1.0.1/1.0.2. It certifies only the evidence below, not the full launch audit.

## Artifact

- Package `online.megaxo.game`, version `1.0.3`, versionCode `4`, target SDK 35, minimum SDK 28.
- SHA-256 `50c3c01bf909f048fffe23f9c55d445c762d42f7165658c6368024dc4e43be53`;
  23,993,495 bytes. Native source at `2a20cb56f8e58c2b512e3822a7e997b4148a2da3`.
- Client bundle `a6c3227efc39191c1a1a16b5634a5c29cdaaf2a8295b310f89a219f4bfae0d75`.
- Release signing certificate SHA-256
  `961cc05474570e60584a14142bb0e3d645804bcb4c168862a6945e4175329337`;
  `apksigner verify` PASS, matching the existing installation lineage.
- API `https://megaxo.online`; registered Google server client configured; real registered Android
  AdMob app/rewarded/interstitial IDs compiled. `megaStoreDistribution=direct-apk` explicitly set.
- `downloads/android/megaxo-1.0.3.apk` replaces the tracked 1.0.2 artifact. Previous bytes remain
  recoverable through Git and production rollback archives. Consumer UI does not display hashes.

## Confirmed defects repaired

| ID | Defect | Fix |
| --- | --- | --- |
| APK-AUTH-01 | Email minted unsupported `amr:['email']`, causing immediate profile 401 | `pwd` for password; `otp` for verification/reset, `1e46105`, `f1c4834` |
| APK-NET-01 | Android parsed every JSON body as an object, rejecting invitations/challenges arrays | Shared object/list parser and actual bridge envelope JVM test, `c34fa95`, `04879bd` |
| APK-NET-02 | Android rejected every query string, preventing player search and rankings | Strict origin-free path policy permits only existing query consumers, `c34fa95` |
| APK-NET-03 | Retained client country labels conflicted with server ISO2 vocabulary | Network adapter translates existing labels and omits global region, `bd107a2` |
| APK-STORE-01 | Direct APK offered unusable device-store purchase actions | Explicit distribution marker, real fixed website-store links; Play remains default, `0157cc4` |
| APK-AUTH-02 | Native provider login fell back to cookie API after logout cleared cached capability state | Native host owns sign-in capability checking, `2a20cb5` |
| APK-UI-01 | Unsupported Apple sign-in/link actions remained disabled on Android | Filter native actions by compiled capabilities, `1b1b538` |
| APK-SEC-01 | Fresh anonymous sessions reset the password-attempt budget | Mandatory durable trusted-source admission before allocation plus normalized-address budget, `f1c4834`, `5c3787c` |
| APK-ADS-01 | Ad preparation opened privacy options unnecessarily; consent-denied users could not revisit privacy | Separate preparation and privacy review; keep loading gated, `34a962f` |
| APK-ADS-02 | Signed AdMob numeric unit ID did not match stored full unit | Map only verified callback IDs to exact configured units; validate release configuration, `34a962f` |
| APK-MAIL-01 | Enabling Resend would fail because production supplied no fetcher | Supply/validate the server fetch implementation, `34a962f` |
| APK-REL-01 | Deployment copied ignored builds/untracked diagnostics rather than only committed source | Clean-tracked-tree guard and `git archive` snapshot staging, `e887253` |

## Device evidence

Physical Android 5199676e, OnePlus Nord CE, production HTTPS backend. Used `adb install -r` for
candidate builds; exact final bytes above were installed. No new actor or economic reward was
created to substitute for sign-in. The original profile, friend list and server wallet were retained.

| Check | Result |
| --- | --- |
| Final APK email login after sign-out | PASS: existing profile restored, sheet dismissed, server wallet loaded |
| Final APK Google login from signed-out state | PASS: native Google account chooser, same existing profile restored |
| Google control enabled / unsupported Apple action absent | PASS on final APK |
| Force-stop/relaunch and Keystore refresh recovery | PASS during candidate acceptance; final post-deploy recheck recorded below |
| Friends/invitations/challenges list responses | PASS, no false connection warning |
| Global and India/local rankings | PASS after country adapter repair; empty qualifying board rendered as a successful empty state |
| Account wallet authority | PASS, account-wallet label and existing server balance |
| Product website-store action | PASS: actual tap opened Chrome at `megaxo.online/store`, without credentials in URL |
| Installed Mega XOXO packages | PASS: only `online.megaxo.game` |
| Fresh signup/reset mail delivery | BLOCKED_EXTERNAL: no Resend key and host email policy disabled |
| Live ad impression / SSV reward settlement | NOT_RUN: serving approval, consent/provider registration and SSV setup remain unverified |
| Paid checkout fulfillment on this APK | NOT_RUN: browser handoff proven, no payment attempted |
| Two-player matchmaking completion / iPhone matrix | NOT_RUN in this APK repair slice |

ADB XML/screenshots were used transiently; no credentials, OTPs, account list or raw authenticated
trace is committed. Native bundles keep WebView debugging disabled in release. The public IDs in
build configuration are provider identifiers, not credentials.

## Validation and review

GitHub Actions owns full Node, PostgreSQL, Android unit/emulator and iOS build validation. Targeted
local smokes only: native email 7/7, country adapter 1/1; agent smokes: store routing 3/3, native ads
configuration 3/3, mail wiring 11/11. The account-address-cap regression exercises distinct guest
sessions against the real PostgreSQL harness. Full CI results and deployment identity are appended
after the exact candidate passes.

Sol 6.1 xhigh independently reviewed `dce3d98..34a962f` and the additional country adapter at
`bd107a2`: CONDITIONAL GO for this narrow repair, no remaining P0/P1 found in reviewed source,
conditional on passing exact-artifact/device/GitHub evidence. No full-product launch certification.

## Remaining release work

- Configure Resend and verified sender/domain, enable the approved outbound mail policy, and prove
  signup/reset delivery on an isolated test account. Provider browser setup did not complete here.
- Finish AdMob serving/consent/SSV registration and use a registered test device for actual acceptance.
  Production server ad mode remains off; compiling real IDs does not prove ad delivery. Rewarded
  power items require a real Core settlement contract; current Core supports credits/boost only.
- Native billing/store submissions, full payment refund/fulfillment acceptance, iOS exact build,
  original audit reconciliation and SEO/AEO tasks remain in the launch-completion plan.
- Pre-existing refresh AMR provenance remains `pwd`; no current authorization decision uses it.
  Record as P2 until the original method can be durably preserved through rotation.
- Credential rotation: **to be done when owner prompts it**, explicitly deferred by owner.

## Deployment verification

Pending exact-candidate GitHub validation and matched production deployment. Do not interpret the
artifact's presence in the branch as proof the public download has been replaced.
