# Android Release Checklist

| Item | Status | Notes |
|---|---|---|
| Final application id | READY | online.megaxo.game (release contract); default online.megaxo.xoxo also associated (MXA-REL-001 fixed) |
| Version code / name | READY | 1 / 1.0.0 pinned in release contract |
| Release signing | READY | owner upload key (96:1C:C0:54...); Play App Signing cert must be ADDED to assetlinks after first AAB upload |
| AAB generation | NOT_RUN | AAB not yet produced this audit; APK d01d35ee... verified (23,982,197 bytes, API origin baked in) |
| Play Billing integration | BLOCKED | MXA-ECO-004: billing classes not mounted as window.MegaBilling; MXA-ECO-005: no RTDN route; device purchase pass NOT_RUN (MXA-ECO-014) |
| Target SDK compliance | VERIFY | minSdk 28; targetSdk to confirm against current Play policy at submission |
| Permissions | REVIEW | manifest audit inside SECURITY-AUDIT.md; LAN permissions justified by GR-001 |
| Privacy policy | READY | /privacy live; data-safety disclosures NOT drafted (owner action) |
| Data Safety form | NOT_RUN | owner action - must match actual collection (see SECURITY-AUDIT.md inventory) |
| Content rating questionnaire | NOT_RUN | owner action |
| App access instructions | NOT_RUN | guest play needs no credentials; note reviewer account for ranked/store checks |
| Store listing assets | NOT_RUN | owner action |
| Testing track | RECOMMENDED | internal testing track first; exercises Play App Signing certificate for the assetlinks update |
| Account deletion | PARTIAL | intake + 30-day schedule exist; in-app cancellation does not (SAGAN-004) - Play policy expects account-deletion management; route decision needed |
