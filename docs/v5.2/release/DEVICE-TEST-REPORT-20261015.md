# Device test report: new build, guest + signed-in passes (2026-10-15)

**Build under test:** Android `online.megaxo.xoxo` v0.1.0-native-dev, `assembleOnlineDebug` from V5.2
`1fc36a6` with `-PmegaApiOrigin=https://megaxo.online` (device `OnePlus Nord CE`, adb `5199676e`).
iOS: `MegaXO` Debug built and launched on a booted iPhone 17 Pro simulator from the same tree.

> The owner asked whether the build shows the rewarded superpowers. **Yes** — verified on the physical
> device, see §2.

## 1. Defect found and fixed during this pass

**Native guest saw a false outage.** With no session, the native transport answered
`ONLINE_UNAVAILABLE` for every account/API call, which classified as `degraded` and rendered
"Connection interrupted / Online services are temporarily unavailable" on plain browsing. A native host
has no cookie jar, so it needs the host bearer for those calls — but a signed-out user should get the
honest auth state, not an outage. `src/account-client.js` now establishes the session state first, so a
guest receives `LINK_ACCOUNT_REQUIRED` and the correct "Sign in to play online" affordance.

Evidence: before the fix the device reported `{state:'degraded', code:'ONLINE_UNAVAILABLE'}` with the
banner visible; after the fix the same screen reports `{state:'online'}` and the banner is hidden, with
no other change to the app.

## 2. Rewarded superpowers (owner question — answered)

The app is the right build. On the **Vs Bot** board the POWER BAR renders all four:

| Power | Observed state |
| --- | --- |
| Undo | count `0`, "Unlocks at 8 moves · 0/8" |
| Undo Block | "Unavailable" |
| Tactical Hint | count `0`, "Optional rewarded ad" |
| Hint Block | "Unavailable" |

They are **gated to Vs Bot by design** (`src/app.js:227`:
`on && powers && match && match.mode==='bot' && !match.practice && !match.online`), so they do not
appear on home, Pass & Play, or online — that is correct behaviour, not a missing feature.

## 3. Guest pass (measured on device)

Cold start `am start -W`: **1301 ms** first launch, **979 ms** on relaunch. Device→`megaxo.online/livez`
from the phone's own shell: **200 in 1.42 s**.

| Feature | Result | Timing |
| --- | --- | --- |
| Home renders (all nav, wallet, modes) | PASS | — |
| Bottom nav Play/Friends/Rank/Stats/Quests | PASS, 5/5 | 22–46 ms apply |
| Vs Bot mode → setup (5 difficulties) | PASS | 12 ms |
| Vs Bot Start Match → board (81 cells) | PASS | ~1.2 s render |
| Bot gameplay: move + bot reply + forced-route update | PASS (screenshot) | — |
| Pass & Play mode → board | PASS | ~1.2 s |
| Play Online tap (guest) | PASS — gates, no crash | 5 ms |
| Tournaments tap (guest) | PASS — gates | 13 ms |
| Private Match tap (guest) | PASS — gates | 14 ms |
| Wallet sheet ("Your wallet · Saved on this device 150 Coins 0 Crowns") | PASS | ~1.0 s |
| Settings sheet | PASS | ~1.0 s |
| How-to-play / tutorial (6 moves) | PASS | ~1.0 s |
| Rank: How ranks work / Coins & Crowns help | PASS | ~1.0 s |
| Quests: Weekly rank rewards help | PASS | ~1.0 s |
| Sign-in sheet opens (email / Google / Apple / guest) | PASS | ~1.4 s |
| Google + Apple buttons | **greyed / no-op** — no provider configured (see §5) | — |

## 4. Signed-in pass

The Android app **cannot itself be signed in yet** — see §5. The signed-in surface was therefore
driven against the live authority with the owner's test profile
(`mothervader693@gmail.com`), which is the same backend the app and web client call:

Sign-in `POST /api/account/email {"action":"continue"}` → **200 in 1.21 s**, actor
`u_e17f44f4-8229-4230-b767-987c3a1cf807`, profile `Oculus-Rex` / `MEGA-A889B432`, rating 600, tier wood.

| Endpoint | Status | Latency |
| --- | --- | --- |
| `/api/account/session` (linked:true) | 200 | 0.82 s |
| `/api/account/profile` | 200 | 0.84 s |
| `/api/v1/profile` | 200 | 0.97 s |
| `/api/v1/leaderboard?metric=rating` | 200 (`[]` — honest: 0 rated players) | 0.89 s |
| `/api/community/friends` | 200 (1 friend) | 0.86 s |
| `/api/community/search?q=ocu` | 200 | 0.80 s |
| `/api/party/capabilities` (Core-backed) | 200, 4 real tables | 0.79 s |
| `/api/v1/invitations` | 200 (`[]`) | 0.76 s |
| `/api/v1/queue` (join) | 200 `{state:'searching'}` | 0.77 s |
| `/api/v1/cancel-queue` | 200 `{state:'cancelled'}` | 0.79 s |
| `/api/account/save` | 200 (cloud save revision 288) | 0.80 s |
| `/api/monetization/status` | **404** — no such route in V5 | 0.69 s |

## 5. Blockers for a fully working signed-in app (honest)

1. **Google/Apple sign-in not configured.** Live `providers:{}`; the native finish returns
   `PROVIDER_NOT_CONFIGURED`. The exact client/origin/redirect values to enter are in
   [GOOGLE-OAUTH-REQUIRED-CONFIG-20261015.md](GOOGLE-OAUTH-REQUIRED-CONFIG-20261015.md).
2. **No web OAuth start/consume on V5** (`POST /api/account/start` → `NOT_FOUND`), so the web Google
   flow also cannot complete; only the legacy V4 server implements it.
3. **Email sign-in cannot work in the native app.** `POST /api/account/email` issues a **cookie**
   session; a native host has no cookie jar and the transport only permits the four
   `/api/account/native/*` routes without a bearer. Adding an email branch to that token family is an
   auth-surface change and was deliberately **not** made here.
4. **iOS device install needed an identity workaround, and one worked.** The registered bundle id
   cannot be signed to this development team: *"The app identifier online.megaxo.xoxo cannot be
   registered to your development team because it is not available"* / *"No profiles for
   online.megaxo.xoxo were found"* — the identifier belongs to the App Store record (`6822833387`),
   and only an Apple Development identity (`HTG9867RG9`) is in the local keychain. A **device-test
   build under the distinct bundle id `online.megaxo.xoxo.devtest`** built, installed and launched on
   the physical iPhone 16 Pro (`00008140-0019711E2260801C`) successfully:
   `devicectl device install app` → `App installed: bundleID: online.megaxo.xoxo.devtest`, then
   `devicectl device process launch` → *"Launched application"*, with the process observable in
   `devicectl device info processes`. Store/TestFlight binaries must still use the registered identity
   and the owner's distribution profile; the `.devtest` id is a testing-only workaround.
   The iOS app was also verified running on a booted simulator from the same tree.

## 6. Not claimed

A device-test build IS installed and launched on the physical iPhone (distinct `.devtest` bundle id, testing only). No provider sign-in is claimed working. No store
submission. The empty leaderboard is genuine (the production database has 2 actors, 0 rated games;
`metric=rating` requires `games >= 10`), not a defect.
