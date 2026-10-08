#!/usr/bin/env bash
set -euo pipefail
: "${APK_PATH:?APK_PATH is required}"
: "${SCREENSHOT_DIR:?SCREENSHOT_DIR is required}"
test -s "$APK_PATH"
mkdir -p "$SCREENSHOT_DIR"
adb install -r "$APK_PATH"
adb shell am start -W -n online.megaxo.prototype/.MegaXOActivity
sleep 8
# Emulator only. This proves install, process survival and a nonempty screen,
# not account/realtime, provider flows or actual physical-device performance.
pid="$(adb shell pidof online.megaxo.prototype | tr -d '\r')"
test -n "$pid"
adb exec-out screencap -p > "$SCREENSHOT_DIR/android-first-launch.png"
test -s "$SCREENSHOT_DIR/android-first-launch.png"
echo "P20 emulator first-launch smoke: success (app process remains running)"
