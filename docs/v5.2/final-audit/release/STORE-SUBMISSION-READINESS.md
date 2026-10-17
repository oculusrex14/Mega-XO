# Store Submission Readiness

**Verdict: NOT READY for either store.** Everything preparable without store consoles is done or listed below; nothing has been submitted.

## Android (Google Play)
- Blockers: MXA-ECO-004/005/014 (billing mount, RTDN route, device purchase pass), account-deletion management decision (SAGAN-004), Data Safety form, listing assets, content rating.
- Prepared: signed release APK (d01d35ee...), application-id association (both ids served), privacy policy, min/target SDK recorded.
- Owner actions: Play Console access, App Signing enrollment (then add the Google cert fingerprint to assetlinks), Data Safety + rating questionnaires, listing assets, internal-track upload.

## iOS (App Store)
- Blockers: profile expiry 2026-10-21 (renew first), StoreKit product verification + device purchase pass, privacy manifest, App Review materials.
- Prepared: bundle id + team known, AASA contract correct server-side (needs APPLE_TEAM_ID env live), entitlements reviewed.
- Owner actions: Apple membership renewal, App Store Connect records, privacy manifest answers, review notes, TestFlight.

## Required human approvals (owner)
1. Financial/pricing approval for Polar sandbox-to-live price ids (handoff section 8).
2. Data Safety / privacy-manifest attestations (owner declarations only).
3. Exact-build release approval per AGENTS.md (no agent may submit).
4. Decision on deletion-cancellation semantics (in-app OTP revival vs support-mediated) before claiming any cancellation capability in store metadata.
