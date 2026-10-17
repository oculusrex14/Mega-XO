# Retained Protections (not artificial blockers)

Every entry below was audited and deliberately KEPT. Removing any of them would weaken security, payment integrity, economy integrity, or honest-degradation guarantees.

1. **LAN bridge allowlist** (GR-001) - Android and iOS native LAN bridges only proxy `/api/party/*` to private-LAN http hosts. This is a security boundary, not a feature blocker.
2. **Rewarded powers switch** (GR-002) - ships default-ON with an explicit user off switch; the FEATURE_DISABLED path is honest messaging, not a hidden gate.
3. **Optional Impossible pack gate** (GR-003) - owner contract keeps the optional pack unverified/unpaid; the gate is the honest dependency, not an artificial block.
4. **AASA fail-close** (GR-004) - serving a wrong team prefix would associate nothing silently; the placeholder is the honest state. Requires APPLE_TEAM_ID in production env (owner action).
5. **Outbound provider refusal** (GR-006) - the production server refuses unconfigured outbound provider classes (e.g. email) rather than pretending to send. Account OTP delivery honestly reports EMAIL_DELIVERY_NOT_CONFIGURED until the owner enables a provider.
6. **Maintenance mode** (GR-007) - operational control; blocks online actions with honest copy during maintenance.
7. **Server-enforced ad caps** (GR-010) - rewardedGap/rewardedDayCap and interstitial caps are economy-integrity policy enforced in the commerce services (server/monetization-store.js, packages/services/commerce.js), with honest client messaging.
8. **iOS "Coming soon"** (GR-011) - honest absence of an unsubmitted App Store listing.

Note: GR-008 (mega_dev_session) was audited and is NOT retained as a guardrail - it is a P1 security finding in remediation.
