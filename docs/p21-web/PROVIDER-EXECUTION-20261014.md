# Provider execution checkpoint — 14 October 2026

Scope: three actually spawned `gpt-6-luna` / `max` browser agents, orchestrated by Codex, against V5.1 `78b258224d799d8e29e6d7b6cae1bb25dcbe1758`. Existing local browser-QA work and Main's active checkout are preserved. Provider console actions are separate from source, device, approval and live acceptance.

## AdMob: four units created

The existing publisher's Android and iOS Mega XOXO records were verified before creation. Both unit lists were empty beforehand and showed exactly two units afterward. No duplicate publisher or app was created.

| Platform | Existing app ID | Newly created Rewarded unit | Newly created Interstitial unit |
| --- | --- | --- | --- |
| Android | `ca-app-pub-5255314563073178~4393199164` | `ca-app-pub-5255314563073178/9122606653` | `ca-app-pub-5255314563073178/5293761020` |
| iOS | `ca-app-pub-5255314563073178~3080117498` | `ca-app-pub-5255314563073178/3009633608` | `ca-app-pub-5255314563073178/5652853678` |

Both Rewarded units have amount `1`, item `cosmetic_reward`, matching the existing native/SSV contract. These are public provider identifiers, not credentials. Interstitial units have no reward. App records still show **Requires review**, no linked store listing, zero requests and zero impressions at inspection.

**Runtime serving remains disabled.** Real IDs are not substituted into test builds. Native Google test IDs and test-device acceptance remain required. SDK/client callbacks cannot grant rewards; only authoritative eligible, server-verified Cosmetic Credits are permitted. This checkpoint does not change Coins, Crowns, reward eligibility, game rules or native release settings.

SSV is unconfigured pending Main's verified public V5 handler. UMP had no existing messages. Publisher-data navigation reached an owner-only agreement/account gate; the agent stopped without accepting or creating a new publisher. The owner subsequently reported signing in, and the agent resumed inspection. Authorized `app-ads.txt` seller entries must come from the console; do not infer them solely from an App ID. Until that row is actually retrieved and deployed as text, the parked HTML response at the public path is a failure, not app-ads ownership verification.

## Resend: existing account and sender verified

Read-only console verified the existing `antimatterinnovations.com` domain, Tokyo region and `contact@antimatterinnovations.com` sender. The single production key is sending-only and restricted to that domain. No token was inspected, copied, rotated or revoked; no DNS or email-domain change occurred.

Free quota displayed 12/3,000 monthly messages, 0/100 daily, 1/3 domains and 10 requests/second; pay-as-you-go was disabled. Twelve recent historical messages showed provider **Delivered** events, including verification, reset and password-change subjects. This proves historical provider event status only, not V5 flow acceptance, inbox placement or authentication-header checks.

Current V5 staging still uses the private OTP sink, without an enabled Resend transport. Main owns A02 key custody and transport wiring. Owner-approved receiving mailboxes are retained privately. Real V5 signup/verification/reset/change delivery and negative OTP/rate/error cases remain **NOT_RUN** here.

## Store enrollment: externally pending

- Google Play Console: **Personal**, identity documents under review, phone-verification task gated on identity approval, app list empty and Create app disabled. No new account or app created.
- Apple Developer: **Pending**, with a purchase/completion prompt and a processing notice. This conflicts with the owner's reported paid enrollment; no second payment attempted. App Store Connect returns `INVALIDITCUSER`. Enrollment/payment reconciliation requires the existing receipt/provider outcome, not a replacement enrollment.
- `online.megaxo.xoxo` remains the owner-selected Android/iOS target; actual availability/registered identity and Apple Team ID are **unverified**. Native signing, association files, store testing and public release are not established by these observations.

## Monitoring: current records are not delivery acceptance

After owner sign-in, UptimeRobot showed the two preserved legacy records:

| Monitor | ID | Target | Observed status |
| --- | --- | --- | --- |
| `mega-xo-livez` | `804201831` | `https://play.antimatterinnovations.com/livez` | Down / connection timeout since 7 October |
| `mega-xo-opsz` | `804201842` | `https://play.antimatterinnovations.com/opsz` | Down / connection timeout since 7 October |

Both use five-minute checks. This is a real external observation and requires diagnosis even though prior host/CLI health probes were green. Do not erase the incident history or label monitoring verified. Receiver/plan inspection and safe test-message delivery are in progress; no controlled incident/recovery receipt exists at this checkpoint. The tailnet-only staging origin is not an appropriate external UptimeRobot target.

Vercel CLI confirmed the existing projects and Hobby scope, plus the configured default high-severity team-owner rule `ar_default`. Actual alert delivery remains unverified. Current DNS and production isolation requirements are in [the Main handoff](MAIN-PROVIDER-WEBSITE-HANDOFF-20261014.md).

## Next dependency and release evidence

Main must provide the email-enabled exact staging identities, public production WSS/HTTP contract, authenticated research-choice endpoint, explicit retention values, SSV handler and safe monitor hooks. Codex continues website/browser and provider work without changing Main's production writer or training files. General release approval is already recorded; objective unmet gates remain unmet.

No production domain/routing/indexing switch, paid upgrade, store publication, capture enablement or native ad activation occurred in this checkpoint. Provider-only and physical-device/novice-study tasks remain distinct.
