#!/usr/bin/env bash
set -euo pipefail
# P20-08: owner-controlled macOS signing environment only.
# The script never invents a team, entitlements, store ID or signing approval.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${MEGA_IOS_BUNDLE_ID:?Registered Apple native bundle ID required}"
: "${MEGA_IOS_TEAM_ID:?Apple Developer Team ID required}"
: "${MEGA_IOS_VERSION_NAME:?Approved release version required}"
: "${MEGA_IOS_BUILD_NUMBER:?Monotonic TestFlight build number required}"
: "${MEGA_IOS_SIGNING_IDENTITY:?Installed Apple distribution certificate identity required}"
: "${MEGA_IOS_PROFILE_SPECIFIER:?Installed App Store provisioning profile specifier required}"
: "${MEGA_IOS_OUTPUT_DIR:?Absolute secure archive output directory required}"
if [[ "$MEGA_IOS_BUNDLE_ID" == online.megaxo.prototype ||
      ! "$MEGA_IOS_BUNDLE_ID" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$ ]]; then
  echo "Refusing prototype/invalid Apple bundle ID" >&2; exit 2
fi
if [[ ! "$MEGA_IOS_BUILD_NUMBER" =~ ^[1-9][0-9]*$ ||
      ! "$MEGA_IOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ||
      "$MEGA_IOS_VERSION_NAME" == 0.1.0 ]]; then
  echo "Refusing invalid Apple team or build version" >&2; exit 2
fi
if [[ "$MEGA_IOS_OUTPUT_DIR" != /* ]]; then
  echo "Secure archive directory must be absolute" >&2; exit 2
fi
command -v xcodebuild >/dev/null || { echo "macOS Xcode required" >&2; exit 2; }
command -v shasum >/dev/null || { echo "SHA-256 tool required" >&2; exit 2; }
mkdir -p "$MEGA_IOS_OUTPUT_DIR"
archive="$MEGA_IOS_OUTPUT_DIR/MegaXO.xcarchive"
xcodebuild \
  -project "$repo_root/native/ios/MegaXO.xcodeproj" -scheme MegaXO \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$MEGA_IOS_TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$MEGA_IOS_BUNDLE_ID" \
  MARKETING_VERSION="$MEGA_IOS_VERSION_NAME" \
  CURRENT_PROJECT_VERSION="$MEGA_IOS_BUILD_NUMBER" \
  CODE_SIGN_IDENTITY="$MEGA_IOS_SIGNING_IDENTITY" \
  PROVISIONING_PROFILE_SPECIFIER="$MEGA_IOS_PROFILE_SPECIFIER" \
  archive
test -d "$archive/Products/Applications/MegaXO.app" || {
  echo "Signed iOS app archive missing" >&2; exit 3;
}
printf 'P20 signed iOS archive (NOT TestFlight submission):\n'
/usr/bin/find "$archive/Products/Applications/MegaXO.app" -maxdepth 2 -type f -name 'MegaXO' -exec shasum -a 256 {} \;
if [[ -n "${MEGA_IOS_EXPORT_OPTIONS_PLIST:-}" ]]; then
  test -f "$MEGA_IOS_EXPORT_OPTIONS_PLIST" || {
    echo "Owner-supplied exportOptions.plist missing" >&2; exit 2;
  }
  xcodebuild -exportArchive -archivePath "$archive" \
    -exportOptionsPlist "$MEGA_IOS_EXPORT_OPTIONS_PLIST" \
    -exportPath "$MEGA_IOS_OUTPUT_DIR/export"
  find "$MEGA_IOS_OUTPUT_DIR/export" -name '*.ipa' -type f -exec shasum -a 256 {} \;
fi
