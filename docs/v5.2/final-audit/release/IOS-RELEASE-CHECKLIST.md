# iOS Release Checklist

| Item | Status | Notes |
|---|---|---|
| Final bundle id | READY | online.megaxo.xoxo (pbxproj, both configs); review-device build used prototype id by contract |
| Version / build | VERIFY | MARKETING_VERSION 0.1.0, CURRENT_PROJECT_VERSION 1 - bump at submission |
| Signing | READY (expiring) | identity C4A58D40... team D5TQJ76T44; profile expires 2026-10-21 - renew before any submission build |
| Entitlements | PARTIAL | Sign in with Apple present; associated-domains requires the capability + real AASA prefix (MXA-REL-002 owner env action) |
| StoreKit products | BLOCKED | MXA-ECO-014: no device purchase pass; products unverified in App Store Connect |
| Privacy manifest | NOT_RUN | owner action; disclosures must match SECURITY-AUDIT.md inventory |
| App Review credentials | NOT_RUN | owner action |
| Screenshots / metadata | NOT_RUN | owner action |
| TestFlight | RECOMMENDED | after profile renewal; exercises App Store signing + AASA |
| Archive validation | NOT_RUN | after profile renewal |
