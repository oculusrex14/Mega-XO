# Approved app icon — native build acceptance

Source: `486466fc68e30adf1e925ab471076e86da52b902`. The original approved emblem is unchanged.
Both platforms previously lacked launcher wiring, despite having browser/PWA icons. The source
fix adds iOS AppIcon resources, Android adaptive foreground/background resources, and a separate
Play listing export. Provenance and geometry are pinned in `assets/p21/icons/native/PROVENANCE.json`.

Commands executed in the isolated Codex worktree:

```
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -sdk iphonesimulator -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath .artifacts/native-icons/xcode CODE_SIGNING_ALLOWED=NO build
/Users/oculus/.gradle/wrapper/dists/gradle-8.13-bin/e2local/gradle-8.13/bin/gradle -p native/android :app:assembleOfflineDebug :app:assembleOnlineDebug --no-daemon
node --test tests/v52-native-icons.test.js tests/v5-native-foundations.test.js tests/v5-native-online-target.test.js tests/v5-p21-brand.test.js
/Users/oculus/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/v5/export-native-icons.py --check
```

Both full native build commands succeeded. 60 tests passed with no skips or failures. The built
iOS plist selects AppIcon for iPhone and iPad; actual120px/152px icons and Assets.car are present.
The120px compiled iPhone icon was visually inspected. The compiled Android APK resolves the
adaptive launcher XML at all densities, with all five foreground images packaged. Independent
pixel decoding verifies all nonzero-alpha artwork/halo pixels fit the66dp safe circle.

`BUILD-RECEIPT.json` pins the actual output hashes and local environment. Raw build logs and
mask/compiled previews stay in ignored `.artifacts/native-icons/`; no signing credentials or
private account traces are included. Plain system Python first failed because Pillow was absent;
using the already bundled Pillow12.3.0 interpreter resolved it without an installation.

This is native source/resource and local build acceptance. Existing installed/store binaries
predate the fix. Fresh signed release artifacts and a store upload are still required to establish
the shipping icon; no physical-device or store pass is inferred from simulator/debug builds.
Rollback: revert the scoped native-icon commit and retain original approved artwork.
