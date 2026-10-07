# Phase 20 - Build, sign and validate Android and iOS applications

**Milestone:** V5.7 | **Mode:** EXECUTE | **Prerequisites:** P19

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 5](../specs/05-ANDROID-AND-IOS-DELIVERY.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-20-01 - Freeze real native identity and build configuration

Inspect current local targets and provider consoles; preserve package/bundle IDs, signing identities and approved assets. Pin supported toolchain/SDK/dependencies.

**Verification:** No competing accidental app IDs; reproducible debug/staging/release build settings exist.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-02 - Build trusted bundled-client hosts

Implement Kotlin WebViewAssetLoader and Swift WKWebView hosts, exact asset allowlist, origin/main-frame bridge controls, offline-first and lifecycle behavior.

**Verification:** Clean offline install works; bundle excludes server-only authority, credentials and repository internals.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-03 - Implement secure session/network/realtime adapter

Host owns refresh/access lifecycle, Android Keystore-encrypted storage/iOS Keychain, allowlisted API transport, one-use tickets and revision reconnect. Include actor/session-bound notification registration, revocation and safe return-to-game foundations without adding unapproved prompts or campaigns.

**Verification:** Logout/reinstall/refresh/process-kill/network-switch tests preserve same actor and safe credentials.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-04 - Integrate real native Google/Apple identity

Reuse existing nonce/audience/link/reauth semantics with actual SDK UI and correct app/server configuration.

**Verification:** Physical-device login/cancel/link/revoke/recovery tests pass; no fake token success bridge.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-05 - Integrate four-product Play/StoreKit commerce

Use persisted account bindings, localized products, pending/cancel/interruption/replay/refund and delivery-before-finalization; restore Remove Ads only.

**Verification:** Real sandbox device evidence proves one grant and no consumable remint across devices/platforms.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-06 - Integrate ads/consent and approved privacy resources

Implement UMP-before-requests, verified SSV-only rewards, approved interstitial caps/placement, Remove Ads and reachable association/deletion resources.

**Verification:** Physical-device consent/SSV replay/late callback tests pass; no ad during live play or new gameplay blocker.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-07 - Complete actual device and cross-platform parity

Run full themes/screens/accessibility/network/build matrix; play on Android, read same wallet/rank/purchases on iOS and retained browser-style client.

**Verification:** Device identities/builds/screenshots recorded; no separate mobile data model or unapproved UI changes.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-20-08 - Build/sign/upload and report store state accurately

Produce debug APK, signed release AAB, Xcode archive/signed IPA, internal Play/TestFlight uploads and accurate submission metadata using existing approvals.

**Verification:** Hashes/build numbers/track IDs and submitted/approved/enabled states are separate; pending provider review is not claimed complete.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `real native/android target`
- `real native/ios target`
- `signed APK/AAB and archive/IPA references`
- `native provider/device acceptance`
- `internal distribution/store status`

## Exit gate

G20: actual applications, not adapters alone, build and run the unchanged product against V5; required native/device/provider evidence and distribution status are explicit.

## Abort / rollback boundary

Keep prior internal/native builds available and backend contracts backward compatible. Do not remove an approved UI feature to bypass a native integration defect.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
