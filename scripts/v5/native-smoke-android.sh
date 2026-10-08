#!/usr/bin/env bash
set -euo pipefail
: "${APK_PATH:?APK_PATH is required}"
: "${SCREENSHOT_DIR:?SCREENSHOT_DIR is required}"
test -s "$APK_PATH"
mkdir -p "$SCREENSHOT_DIR"
adb install -r "$APK_PATH"
adb logcat -c
adb shell am start -W -n online.megaxo.prototype/.MegaXOActivity
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
pid="$(adb shell pidof online.megaxo.prototype | tr -d '\r')"
adb exec-out screencap -p > "$SCREENSHOT_DIR/android-first-launch.png"
test -s "$SCREENSHOT_DIR/android-first-launch.png"
if [ "$ready" != 1 ] || [ -z "$pid" ]; then
  echo "P20 Android first-launch failed: signed game's dynamic UI is not initialized" >&2
  grep -E 'MegaXOStartup.*(SCRIPT_ERROR|TIMEOUT)' "$SCREENSHOT_DIR/startup-log.txt" || true
  exit 1
fi
echo "P20 emulator first-launch: signed offline game UI initialized (not device/provider acceptance)"
