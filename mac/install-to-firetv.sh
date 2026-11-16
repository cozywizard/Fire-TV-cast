#!/usr/bin/env bash
# Installs Fire TV Cast onto your Fire TV over Wi-Fi using adb.
#
# Usage:  ./mac/install-to-firetv.sh <fire-tv-ip> [path/to/FireTVCast.apk]
#
# Before running: on the Fire TV, turn on
#   Settings → My Fire TV → Developer options → ADB debugging
# (If you don't see Developer options: Settings → My Fire TV → About,
#  then click your device name 7 times.)
set -euo pipefail

TV_IP="${1:-}"
APK="${2:-FireTVCast.apk}"
REPO="cozywizard/Fire-TV-cast"

if [[ -z "$TV_IP" ]]; then
  echo "Usage: $0 <fire-tv-ip> [FireTVCast.apk]"
  echo "Find the IP on the TV: Settings → My Fire TV → About → Network."
  exit 1
fi

if ! command -v adb >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing adb (android-platform-tools) with Homebrew…"
    brew install --cask android-platform-tools
  else
    echo "adb is not installed. Either install Homebrew (https://brew.sh) and re-run this script,"
    echo "or download Google's platform-tools for Mac and put 'adb' on your PATH."
    exit 1
  fi
fi

if [[ ! -f "$APK" ]]; then
  echo "Downloading the latest FireTVCast.apk…"
  curl -fL -o "$APK" "https://github.com/$REPO/releases/download/latest/FireTVCast.apk"
fi

echo "Connecting to $TV_IP… (accept the 'Allow USB debugging?' prompt on your TV if it appears)"
adb connect "$TV_IP:5555"
# Give the user time to accept the prompt on the TV.
for _ in $(seq 1 30); do
  if adb -s "$TV_IP:5555" get-state 2>/dev/null | grep -q device; then break; fi
  sleep 1
done

echo "Installing…"
if ! adb -s "$TV_IP:5555" install -r "$APK"; then
  echo "Install failed – this usually means an older build signed with a different key is installed."
  echo "Removing the old copy and trying again…"
  adb -s "$TV_IP:5555" uninstall com.firetvcast.receiver || true
  adb -s "$TV_IP:5555" install "$APK"
fi

echo "Launching Fire TV Cast on the TV…"
adb -s "$TV_IP:5555" shell monkey -p com.firetvcast.receiver -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1 \
  || adb -s "$TV_IP:5555" shell am start -n com.firetvcast.receiver/.MainActivity

echo
echo "Done! On your Mac, open Google Chrome and go to:  https://$TV_IP:8443"
