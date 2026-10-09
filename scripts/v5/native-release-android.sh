#!/usr/bin/env bash
set -euo pipefail
# P20-08: run ONLY on an owner-controlled signed-release host/environment.
# No app identity, keystore, passwords or provider secrets are stored in Git.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${MEGA_ANDROID_APPLICATION_ID:?Registered Android package ID required}"
: "${MEGA_ANDROID_VERSION_CODE:?Monotonic positive Play version code required}"
: "${MEGA_ANDROID_VERSION_NAME:?Approved release version name required}"
: "${MEGA_ANDROID_RELEASE_KEYSTORE_PATH:?Owner-held keystore path required}"
: "${MEGA_ANDROID_RELEASE_STORE_PASSWORD:?Owner-held keystore password required}"
: "${MEGA_ANDROID_RELEASE_KEY_ALIAS:?Owner-held upload-key alias required}"
: "${MEGA_ANDROID_RELEASE_KEY_PASSWORD:?Owner-held upload-key password required}"
if [[ "$MEGA_ANDROID_APPLICATION_ID" == online.megaxo.prototype ||
      ! "$MEGA_ANDROID_APPLICATION_ID" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$ ]]; then
  echo "Refusing prototype/invalid Play package ID" >&2; exit 2
fi
if [[ ! "$MEGA_ANDROID_VERSION_CODE" =~ ^[1-9][0-9]*$ ||
      "$MEGA_ANDROID_VERSION_NAME" == 0.1.0-native-dev ]]; then
  echo "Refusing default/invalid release version" >&2; exit 2
fi
test -f "$MEGA_ANDROID_RELEASE_KEYSTORE_PATH" || {
  echo "Owner-held Android upload keystore does not exist" >&2; exit 2;
}
command -v gradle >/dev/null || { echo "Gradle 8.13 must be installed" >&2; exit 2; }
command -v jarsigner >/dev/null || { echo "JDK jarsigner required" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "SHA-256 tool required" >&2; exit 2; }
cd "$repo_root"
gradle -p native/android \
  -PmegaApplicationId="$MEGA_ANDROID_APPLICATION_ID" \
  -PmegaVersionCode="$MEGA_ANDROID_VERSION_CODE" \
  -PmegaVersionName="$MEGA_ANDROID_VERSION_NAME" \
  :app:bundleRelease --no-daemon --stacktrace
artifact="$repo_root/native/android/app/build/outputs/bundle/release/app-release.aab"
test -s "$artifact" || { echo "Signed Android App Bundle missing" >&2; exit 3; }
verification="$(jarsigner -verify "$artifact")"
grep -Fq 'jar verified.' <<<"$verification" || {
  echo "App Bundle signature verification did not pass" >&2; exit 3;
}
printf 'P20 signed Android AAB (NOT store submission):\n'
sha256sum "$artifact"
