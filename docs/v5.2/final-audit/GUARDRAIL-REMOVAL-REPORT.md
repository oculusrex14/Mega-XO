# Guardrail Removal Report

## Removed

### GR-005 - assetlinks release application id (removed in a385774)
- **Was:** /.well-known/assetlinks.json served only `online.megaxo.xoxo`; the store-bound release build distributed from the website is `online.megaxo.game`.
- **Impact:** App Links silently failed to associate for the distributed release build.
- **Fix:** DEFAULT_ASSET_LINKS now serves both statements with the same owner-held upload-key fingerprint; frozen-contract test (tests/v5-p11-website-foundations.test.js) strengthened to require the release id.
- **Validation:** DEFAULT_ASSET_LINKS contents verified locally (both ids present); full validation via GitHub Actions on the audit head.

## Pending removal (assigned)

### GR-008 - mega_dev_session unconditional cookie (MXA-SEC-001, P1)
- **Status:** assigned to the security workstream for a verified fix across the 5 sessionCookieHeaders call sites; protocol-aware gating so the non-Secure staging cookie is never set on secure origins.

## Explicitly NOT removed (see RETAINED-PROTECTIONS.md)

Authentication, payment verification (fail-closed STORE_UNAVAILABLE), server-side economy validation, ad-farming caps, rate limits, LAN host allowlists, AASA fail-close, maintenance mode, honest-degradation messaging.
