# Google Play Console review and package-free listing draft — 2026-10-14

**State at observation:** Console account reviewed; create-app form is an unsaved draft. No app record, package registration, AAB upload, track, test invitation, production-access application, or review submission was created. No declaration checkbox was selected.

**Observation time:** 2026-10-14 16:47 UTC (Play Console UI; local activity-log timezone was not displayed). **Source checkout:** `36c982fab6ca59e5ed0744d585175605050f9a9d`.

## Account and console observations

- Existing account only; no duplicate enrollment or payment attempted. The visible account is **Personal**, account ID `4755692624714861405`. Activity log showed account creation and account-details update dated 2026-10-14; the UI did not show its timezone. Fee-paid/approved state is owner-reported; this review did not inspect a payment receipt.
- The account home showed no apps / “Create your first app.” Policy status displayed **“No issues found with your developer account.”** The Users and permissions page showed the owner account as Active with all permissions and no additional users. Developer contact verification indicators were shown complete; no names, phone/address values, OTPs, or other personal details are copied here.
- Android developer verification was not affirmatively confirmed. At the time of review, the Home page had no visible “Verify that you have access to an Android mobile device” task, and the developer-verification pages exposed no positive completion receipt. No Play Console mobile-app verification was attempted. Record this as **NOT CONFIRMED**, not as incomplete or complete.
- No packages appeared in Android developer verification. `online.megaxo.xoxo` returned **“Package name available”** in the create-app form; this was only an availability check and did not register it.

## Package mismatch and release artifact

The signed release record at `docs/v5.2/release/ANDROID-RELEASE-SIGNING-20261014.md` identifies AAB SHA-256 `3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933`, version `1.0.0` / code `1`, and manifest package **`online.megaxo.game`**. The owner-preferred candidate is **`online.megaxo.xoxo`**. This is a blocking mismatch until Main acknowledges an aligned final artifact/package. The AAB was not uploaded and neither package was registered.

## Unsaved create-app form and required owner declarations

The live handoff page is Brave tab `1438672356`, URL `https://play.google.com/console/u/0/developers/4755692624714861405/create-new-app`.

Form values visible in that tab:

- App name: `Mega XOXO`
- Package name: `online.megaxo.xoxo` (availability only; not registered)
- Default language: `English (United States) – en-US`
- App or game: `Game`
- Free or paid: `Free` (download price; this does not set in-app product prices or assert that paid features are active)
- Google automatic protection: on by default; the console says an installer check will be added to the app code. This was not changed.
- **Create app was not clicked.**

All three declarations remain unchecked. Their visible text is:

1. **“Confirm app meets the Developer Program Policies”** — states the application meets the policies.
2. **“Accept the Play App Signing Terms of Service”** — acceptance of those terms.
3. **“Accept US export laws”** — acknowledges possible US export-law coverage, agrees compliance including encryption requirements, and certifies export authorization.

These are specific policy/legal/compliance declarations. Route them to the account holder after Main confirms the package/build alignment; do not treat the owner’s general app-setup authorization as answers to these declarations.

## Source-grounded listing copy — DRAFT, not entered or submitted

**Short description (draft):**

> Nine boards. One bigger game. Play solo or pass the device.

**Full description (draft):**

> Mega XOXO puts a strategic twist on Tic-tac-toe. Nine small boards make one bigger game.
>
> Claim three small boards in a row to win. Each move sends the next player to a matching board, so every turn shapes both your path to victory and your opponent’s choices. If the destination board is already won or drawn, any unfinished board is open.
>
> Practice against the Bot at five skill levels, from Beginner to Expert, or pass one device between two players. Learn the rules with the guided tutorial. Choose who starts, set an optional turn timer, and play with four included themes: Vector Light, Midnight Club, Paper Club and After Hours.
>
> Local games do not require an account.

These claims are grounded in `src/game.js`, `src/app.js`, the tutorial sources, `src/monetization-ui.js`, and the four-theme native allowlist. The draft deliberately does not promise online matchmaking, private matches, tournaments, ranking, ads, purchases, powers, Neon/native Neon, or Impossible. A final description must match the exact reviewed Android build and its live feature flags.

**Suggested category:** Game → Board (candidate for later listing configuration; not selected in the form).

**URLs:** `https://megaxo.online/support` and `https://megaxo.online/privacy` correspond to repository routes, but were not browser-verified as publicly deployed during this Console-only pass. Do not enter them until the public deployment and policy text are verified.

**Images:** Official theme logo art exists, but `docs/p21-web/ASSET-REGISTRY.md` still marks platform adaptive app icons, splash images, and metadata screenshots open. There are no verified native gameplay screenshots or final Play feature graphic in the reviewed asset inventory. Listing assets are not ready.

## Age, privacy, data safety, SDK and access disclosures — unresolved

- Owner decision in `docs/v5.1/release/OWNER-DECISIONS-AND-EXECUTION-20261014.md`: intended teen/general play around 12–14+, with age-rating, account eligibility and research/advertising permission treated separately.
- Current `public/privacy.html` and `public/terms.html` say accounts are adult-only, no child accounts or parental verification are offered, and the gameplay-training collection described in the owner decision is not enabled under the published policy. This conflicts with the intended target audience and must be reconciled before selecting Play target-age groups or completing content/data-safety answers. No age-target or content-rating answers are guessed here.
- Android source includes Google Identity `1.2.1`, Play Billing `9.1.0`, UMP `4.0.0`, and Mobile Ads SDK `1.4.0` in `native/android/app/build.gradle.kts`. The base manifest declares Internet, network-state, nearby-Wi-Fi (with `neverForLocation`) and notification permissions, and removes `AD_ID`; the online manifest enables Internet and network-state. Presence of an SDK/dependency is not proof that a feature is active or that it collects a particular field. The exact merged manifest, SDK behavior, consent behavior and data flows for the final signed AAB still need a build-specific review.
- The Gradle property `megaAdMobAppId` defaults to Google's test app ID unless explicitly overridden. The release-signing record does not provide an AdMob override receipt; do not claim production ad configuration or serving from it.
- The signing record uses the online flavor. `megaApiOrigin` defaults empty unless explicitly supplied; the signing record excerpt lists application-ID/version properties but gives no origin value. Treat the online endpoint and online access/reviewer flow as **unverified for this AAB** until Main provides the exact build configuration and device acceptance. Do not invent reviewer credentials.
- The Play app-access, target-audience, content-rating, Data safety, ads, purchases, privacy-policy and reviewer-access forms remain uncompleted. No product prices were proposed.

## Closed-test and device requirements

The account is Personal and its activity log shows creation on 2026-10-14, so the current Google Play rule for personal developer accounts created after 2023-11-13 applies: a closed test needs **at least 12 testers continuously opted in for the preceding 14 days** before applying for production access. Internal testing has no equivalent tester-duration gate, but does not grant production access. Production access still requires an application answering about the app, testing and readiness. There is no track or tester list in this account, and no tester activity was fabricated.

Google’s device-verification help instructs the account owner to complete verification through the Play Console mobile app on a real Android device; the web view alone did not prove completion. No mobile verification was performed in this pass.

Official Google sources checked 2026-10-14:

- [App testing requirements for new personal developer accounts](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en) — 12 continuous opt-ins over the preceding 14 days, production-access application and track availability.
- [Device verification requirements for new developer accounts](https://support.google.com/googleplay/android-developer/answer/14316361?hl=en) — account owner and real Android device / Play Console mobile app procedure.

## Result at handoff

**DRAFT / NOT REGISTERED / NOT UPLOADED / NOT SUBMITTED / NOT LIVE.** The only permitted current state is the unsaved form in tab `1438672356` and this source-grounded listing draft. Next dependencies: Main’s explicit package-alignment acknowledgment and exact build receipt; reconciliation of target-age/privacy policy and final data/SDK answers; account-holder review of the three exact declarations; real device verification status; final native listing assets; and genuine willing testers after an eligible test build exists.
