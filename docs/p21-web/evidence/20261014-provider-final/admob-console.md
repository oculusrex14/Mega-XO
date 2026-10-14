# AdMob provider check — 2026-10-14

Scope: existing publisher account and app records, the four authorized ad units, UMP state, SSV readiness, and app-ads.txt. This is a browser/provider observation, not device acceptance or approval to serve real ads.

Evidence context: repository checkout at `78b258224d799d8e29e6d7b6cae1bb25dcbe1758` (detached `HEAD`); existing untracked `scripts/p21/staging-browser-qa.cjs` was left untouched. Browser tab ID `1438672291` was resumed after the owner confirmed the existing AdMob account was signed in. The app records, unit lists, app-ads.txt instructions, and Privacy & messaging pages were accessible; no account signup or terms acceptance was performed.

## Existing AdMob apps

| Platform | Console app name | App ID | Approval status | Store association |
| --- | --- | --- | --- | --- |
| Android | Mega XOXO Android | `ca-app-pub-5255314563073178~4393199164` | Requires review; limited ad serving | None shown (`—`) |
| iOS | Mega XOXO iOS | `ca-app-pub-5255314563073178~3080117498` | Requires review; limited ad serving | None shown (`—`) |

The records remain the existing publisher apps; neither was duplicated. The re-opened app list showed exactly two active ad units for each and no store/package association. The four units below were individually re-opened by platform and exact IDs; both reward settings pages showed amount `1` and item `cosmetic_reward`. No ad units were created or duplicated during this verification pass.

## Existing ad units (created during prior authorized setup; reverified 2026-10-14)

All four were created under those existing platform records. The rewarded creation forms used amount `1` and item `cosmetic_reward`, matching `native/COMMERCE-AND-ADS.md`, `MegaAndroidAds.kt`, `MegaIOSAds.swift`, and the production server's `rewardItem: 'cosmetic_reward'` contract. Partner bidding remained unchecked. No SSV callback URL was entered.

| Platform | Format | AdMob unit name | Public ad-unit ID | Reward metadata |
| --- | --- | --- | --- | --- |
| Android | Rewarded | Mega XOXO Rewarded | `ca-app-pub-5255314563073178/9122606653` | amount `1`, item `cosmetic_reward` |
| Android | Interstitial | Mega XOXO Interstitial | `ca-app-pub-5255314563073178/5293761020` | n/a |
| iOS | Rewarded | Mega XOXO Rewarded | `ca-app-pub-5255314563073178/3009633608` | amount `1`, item `cosmetic_reward` |
| iOS | Interstitial | Mega XOXO Interstitial | `ca-app-pub-5255314563073178/5652853678` | n/a |

Current unit lists showed exactly these two units per app. Each row showed `0 active` mediation groups and `0 enabled` campaigns, with no frequency caps. The app overviews showed zero ad requests and zero impressions; both app records remain **Requires review** with limited ad serving and no linked stores. No native ad SDK, test-device, or physical-device acceptance was performed. Runtime serving must remain off.

The AdMob UI's **How to set up app-ads.txt for your apps** panel displayed the exact authorized seller line below as its “following code snippet” (tab `1438672291`):

```text
google.com, pub-5255314563073178, DIRECT, f08c47fec0942fa0
```

This seller-row provenance is the explicit AdMob setup snippet, not an inference from the App ID prefix. Main owns adding it to the website source and checking the public origin after domain attachment.

## SSV readiness

The source contract exposes a GET callback path, `/api/monetization/admob-ssv`, in `server/monetization-http.js`; `server/admob-ssv.js` verifies AdMob signatures, and `server/monetization-store.js` binds ticket, actor, ad unit, reward item, timestamp, and unique transaction ID before settling. The native bridge supplies the ticket as `custom_data` and the actor as `user_id`. The production server keeps the ad mode off by default.

There is no verified production callback URL to configure:

- The current Vercel API handler in `apps/api/index.js` has no monetization or AdMob SSV route.
- A read-only request to `https://api.megaxo.online/readyz` on 2026-10-14 failed DNS resolution (`Could not resolve host`).
- The existing Vercel API deployment evidence is for a preview bound to staging; it is not a safe production rewards endpoint.

Therefore SSV was left unconfigured for both rewarded units. Main must integrate the verified signature/ticket/actor/transaction contract into the intended production API/Core composition and provide a stable, public HTTPS origin that is confirmed to route to that exact handler before the callback URL is entered. Do not point SSV to a staging preview.

## UMP and serving

The AdMob Privacy & messaging page still contained only “Create a new message” choices for European regulations, US state regulations, and the iOS IDFA explainer; no existing messages were listed in the account. The European regulations Settings page showed: automatically add ad sources as ad partners **off**; maximize message coverage **on**; legitimate-interest controls **on**, enabled by default; consent mode for advertising purposes **off**; RTB creative consent check **off**; special feature 2 **off**. These account settings were read only and left unchanged.

The European message education flow lists required steps: add a privacy-policy URL to the apps; choose consent options; review account settings; publish the message; implement the UMP SDK. The message builder itself remained at its loading progress indicator in the embedded panel; no configuration fields, draft-save option, or publish control became available. No draft was saved and no message was published. The current staged `/privacy` page is on the tailnet-only staging origin referenced in `docs/p21-web/OWNER-REVIEW-20261014.md`; the public canonical `https://megaxo.online/privacy` is not a safe notice destination while that domain is parked. The app records also have no linked store listing. Consequently there is no verified public privacy-policy URL to attach to these app records, and the console builder cannot be completed until it loads and a suitable public notice URL is available. No legal-purpose, ad-partner, or consent-choice attestation was submitted.

Native adapter code contains UMP consent and privacy-options methods, but the adapters are intentionally not instantiated by the app entry points. The provider inventory records missing iOS `NSUserTrackingUsageDescription` and `PrivacyInfo.xcprivacy`; physical-device consent and ATT acceptance remain open. Runtime real-ad mode is off and remains off.

The account's Publisher data (BETA) page was also inspected read-only. It displayed an existing `Mega XOXO Free | iOS` row with Analytics off, User insight surveys off, and publisher first-party IDs on; this row was not changed and is not treated as proof of a current iOS store listing.

Read-only public check: `https://megaxo.online/app-ads.txt` returned HTTP 200 with `text/html` from Hostinger; its title was “Parked Domain name on Hostinger DNS system.” It is not an app-ads.txt file. The authorized AdMob row above is ready for Main to add to the website source, then verify at the public origin after domain attachment. No website source was changed by this lane.

## Not performed

No existing publisher or app record was duplicated. No account terms were accepted, no UMP draft or message was saved/published, no callback URL was configured, no app-ads.txt file or website source was changed, and no ad was served. Browser tab `1438672291` is left open for continued AdMob work. This note is ignored under `.artifacts/` and was not committed.
