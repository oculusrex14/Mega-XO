#!/usr/bin/env bash
set -euo pipefail
: "${APK_PATH:?APK_PATH is required}"
: "${SCREENSHOT_DIR:?SCREENSHOT_DIR is required}"
test -s "$APK_PATH"
mkdir -p "$SCREENSHOT_DIR"
# The shipping application id can differ from the retained Kotlin namespace. Launch exactly the
# component declared by this APK; a stale prototype id is not evidence that the app failed to render.
aapt_bin="$(command -v aapt || true)"
if [ -z "$aapt_bin" ]; then
  sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  for candidate in "$sdk_root"/build-tools/*/aapt; do
    if [ -x "$candidate" ]; then aapt_bin="$candidate"; fi
  done
fi
if [ -z "$aapt_bin" ]; then echo 'Android SDK aapt is required to inspect the APK identity' >&2; exit 1; fi
badging="$("$aapt_bin" dump badging "$APK_PATH")"
target="$(printf '%s\n' "$badging" | node scripts/v5/native-smoke-target.cjs)"
read -r package_id launch_component <<< "$target"
adb install -r "$APK_PATH"
adb logcat -c
adb shell am start -W -n "$launch_component"
# Fail if the game's dynamic mode selectors and navigation fail to initialize.
# A static HTML header + nonempty screenshot is not an acceptance test.
ready=0
for step in $(seq 1 42); do
  adb logcat -d -s MegaXOStartup:I > "$SCREENSHOT_DIR/startup-log.txt"
  if grep -q 'MegaXOStartup.*READY game_initialized=true' "$SCREENSHOT_DIR/startup-log.txt"; then
    ready=1
    break
  fi
  if grep -q 'MegaXOStartup.*TIMEOUT' "$SCREENSHOT_DIR/startup-log.txt"; then
    break
  fi
  sleep 1
done
pid="$(adb shell pidof "$package_id" | tr -d '\r')"
adb exec-out screencap -p > "$SCREENSHOT_DIR/android-first-launch.png"
test -s "$SCREENSHOT_DIR/android-first-launch.png"
if [ "$ready" != 1 ] || [ -z "$pid" ]; then
  echo "P20 Android first-launch failed: signed game's dynamic UI is not initialized" >&2
  grep -E 'MegaXOStartup.*(SCRIPT_ERROR|TIMEOUT)' "$SCREENSHOT_DIR/startup-log.txt" || true
  exit 1
fi
echo "P20 emulator first-launch: signed offline game UI initialized (not device/provider acceptance)"

# Only the DEBUG WebView exposes DevTools. Exercise the existing approved
# game controllers as a guest; no production bridge or signed source changes.
adb forward tcp:9222 "localabstract:webview_devtools_remote_$pid"
trap 'adb forward --remove tcp:9222 >/dev/null 2>&1 || true' EXIT
node scripts/v5/native-smoke-gameplay.cjs
adb exec-out screencap -p > "$SCREENSHOT_DIR/android-bot-first-move.png"
test -s "$SCREENSHOT_DIR/android-bot-first-move.png"
echo "P20 Android functional smoke: real offline X move committed"
