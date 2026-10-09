# P20 signed native release — controlled handoff

**Status:** procedures and release-signing configuration, not a signed release or store approval. P20/G20 remains open until P05+ shared backend, P19 staging, real device/provider acceptance and store evidence are complete.

These scripts must be run **only on an owner-controlled signing environment**. GitHub's P20 PR workflow intentionally compiles debug APKs and unsigned iOS Simulator apps. It never receives or writes distribution signing credentials. Do not enable store/ads/Google/Apple flows on the strength of a successful compilation.

## Android / Play internal track

Verify actual Play Console registration and upload signing certificate before setting:
- `MEGA_ANDROID_APPLICATION_ID`, `MEGA_ANDROID_VERSION_CODE`, `MEGA_ANDROID_VERSION_NAME`
- `MEGA_ANDROID_RELEASE_KEYSTORE_PATH`, `MEGA_ANDROID_RELEASE_STORE_PASSWORD`
- `MEGA_ANDROID_RELEASE_KEY_ALIAS`, `MEGA_ANDROID_RELEASE_KEY_PASSWORD`

Then on the trusted host execute `bash scripts/v5/native-release-android.sh`. The script builds a *signed* release AAB using the owner-provided keystore, verifies its JAR signature and prints its SHA-256, without printing secret environment values. It refuses `online.megaxo.prototype`, dummy version names, absent signing material and missing artifacts. The current manifest deliberately denies Internet permission pending the P05 authenticated transport: a signed AAB **is not yet the full networked game and must not be distributed as a finished V5 release**. Capture signed artefact hash, versionCode, exact package ID and the actual Play internal-track result later.

## iOS / TestFlight

Resolve the actual App Store Connect bundle ID, signing Team, certificates, provisioning profile, Sign in with Apple entitlement, privacy declarations and approved AppIcon. In the trusted macOS environment set:
- `MEGA_IOS_BUNDLE_ID`, `MEGA_IOS_TEAM_ID`, `MEGA_IOS_VERSION_NAME`, `MEGA_IOS_BUILD_NUMBER`
- `MEGA_IOS_SIGNING_IDENTITY`, `MEGA_IOS_PROFILE_SPECIFIER`, `MEGA_IOS_OUTPUT_DIR`
- Optional `MEGA_IOS_EXPORT_OPTIONS_PLIST` supplied by the owner to export an IPA

Execute `bash scripts/v5/native-release-ios.sh`. The script builds a signed `.xcarchive` through Xcode and optionally exports an IPA using the supplied export options. It prints artifact hashes; it does **not** upload to TestFlight or imply Apple approval. Xcode entitlements and provider scopes must be configured by the owner before using it. The Apple login bridge is disabled by default until registered audiences and backend exchange have been verified.

## Required release evidence

Keep a per-build private release record: source commit SHA, exact bundle manifest hash, backend protocol/schema version, Android package ID/versionCode/upload certificate ref/AAB SHA-256 or iOS bundle ID/team ref/build number/archive+IPA SHA-256, test devices/OS versions and store track/build IDs. Separately record *built*, *signed*, *uploaded*, *in review*, *approved* and *enabled*. No plaintext signing keys, private OAuth secrets, provider tokens, purchase receipts or personal player data belong in the evidence record.

Always preserve a prior internal release for rollback. The same permanent server actor, wallet, rank, Crowns purchases, Remove Ads state, and current UI must carry across Android, iOS and the retained browser client. P21 new website work remains deferred.
