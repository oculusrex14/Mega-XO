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

SSV is unconfigured pending Main's verified public V5 handler. UMP had no existing messages. Publisher-data navigation reached an owner-only agreement/account gate; the agent stopped without accepting or creating a new publisher. The owner subsequently reported signing in, and the agent resumed inspection. The UMP embedded builder remained loading; no draft/message was saved or published. The public privacy URL is still parked, and the reviewed staging notice is tailnet-only.

The AdMob setup snippet explicitly supplied `google.com, pub-5255314563073178, DIRECT, f08c47fec0942fa0`. This row was **retrieved from the console**, not inferred from an App ID. Codex added `public/app-ads.txt` to the builder's explicit allowlist and an explicit Vercel text/plain header. The actual loopback HTTP test verifies exact bytes, checksum/provenance and MIME, and exclusion from the offline practice cache. **256/256 affected website tests passed**, zero skips/failures; the focused 22-test subset is included in that count. The public canonical path still returns parked HTML until deployment/domain cutover, so public ownership verification remains **NOT_RUN**.

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

Both use five-minute checks. This is a real external observation and requires diagnosis even though prior host/CLI health probes were green. Do not erase the incident history or label monitoring verified. The account uses Free 50 (50 monitors, 300-second checks), no payment method; neither an upgrade nor a charge occurred. The agent verified the existing email receiver matches an owner-approved mailbox, with Up+Down notifications enabled.

Created the missing `prelaunch-core-tcp443`, ID `804264653`, for `core.megaxo.online:443`, with five-minute checks and the existing receiver. Its initial external check was **Up**, about 149 ms, observed 2026-10-14 01:06:07 UTC. This measures TCP listener availability only, not TLS correctness or HTTP/API/game readiness. Treating an intentional HTTP 404 as healthy requires a paid status-code allowlist in the inspected console; no paid setting was enabled. Legacy monitors remain unchanged.

One provider test notification showed green **Test notification sent**, confirmation observed 2026-10-14 01:03:37 UTC. This is **not** a receiving-mailbox timestamp. The initial authenticated inbox was a different approved mailbox and contained no matching test message; that attempt is preserved separately. After owner handoff, Luna verified both `TEST: Monitor is DOWN: mega-xo-livez` and `TEST: Monitor is UP: mega-xo-livez` from sender domain `uptimerobot.com` in the approved receiving **Inbox**, not Spam. Gmail displayed 14 October 2026, 6:32 AM for both, without an explicit timezone, so no exact UTC delivery timestamp or delivery-latency claim is inferred. **Provider test-notification reception is verified**. Controlled service incident/recovery delivery remains **NOT_RUN**. Opening the previously unread test messages may have marked them read; no unrelated email was inspected. The tailnet-only staging origin is not an appropriate external UptimeRobot target.

Vercel CLI confirmed the existing projects and Hobby scope, plus the configured default high-severity team-owner rule `ar_default`. Actual alert delivery remains unverified. Current DNS and production isolation requirements are in [the Main handoff](MAIN-PROVIDER-WEBSITE-HANDOFF-20261014.md).

## Actual staging browser practice

Luna manually tested the deployed site in Brave at a 946×800 desktop viewport: all six tutorial moves and completed-board fallback, “Play from here” retaining the six-move position into Beginner, legal player/Bot replies, keyboard Tab/Arrow/Enter moves and visible focus, and all five browser appearances. Anonymous balances remained dashes with sign-in prompts; no account currency or Elo was granted. Rules and Settings navigation worked; no horizontal clipping was observed. The agent clicked **Save for offline practice** once: preparation completed and Settings showed ready. Networking was never disconnected, so disconnected-network acceptance is **NOT_RUN**. Theme was restored to Mega XOXO Neon; the local ten-move position and saved offline copy were retained, with no removal/reset of pre-existing browser data. Physical phones, moderated novice comprehension, full authenticated online gameplay and all-theme zoom/screen-reader matrices are **NOT_RUN by this manual slice**.

The independently fetched actual staging manifest was `5897497493617e1f389af1626451899831045840`, hash `31cdb4d302a12182b709c7430b389d79a42a706001360fab56afb3dd22028b7c`, 152 files / 3,547,734 bytes. The new 153-file app-ads bundle is a local verified artifact, not this currently served build. Codex did not restart Main's in-progress online acceptance to replace it.

The clean local artifact rebuilt after code commit `6532a1e0536c5f620b4d3c4929d2f1198d18beaa` has hash `4eb558b78ca46fdcaf062218d1eaa387d75c43dfde7d69c7afde5736ac1f589e`, 153 files / 3,547,793 bytes. This is the exact prepared frontend candidate for Main's next coordinated deployment. No public game launch is claimed.

## Next dependency and release evidence

Main must provide the email-enabled exact staging identities, public production WSS/HTTP contract, authenticated research-choice endpoint, explicit retention values, SSV handler and safe monitor hooks. Codex continues website/browser and provider work without changing Main's production writer or training files. General release approval is already recorded; objective unmet gates remain unmet.

No production domain/routing/indexing switch, paid upgrade, store publication, capture enablement or native ad activation occurred in this checkpoint. Provider-only and physical-device/novice-study tasks remain distinct.
