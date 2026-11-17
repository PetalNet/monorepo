#!/usr/bin/env bash
# Builds janet-dictate and wraps it in a minimal .app so macOS attributes the
# microphone, speech and accessibility prompts to it. Usage: bundle.sh [output-dir]
set -euo pipefail
# A relative output directory is relative to where the caller ran this, not to the package.
mkdir -p "${1:-$HOME/Applications}"
OUT="$(cd "${1:-$HOME/Applications}" && pwd)"
cd "$(dirname "$0")"
APP="$OUT/janet-dictate.app"

swift build -c release
mkdir -p "$APP/Contents/MacOS"
# Copy beside the target and move into place, so a running agent never sees a half-written binary.
cp .build/release/janet-dictate "$APP/Contents/MacOS/.janet-dictate.new"
mv -f "$APP/Contents/MacOS/.janet-dictate.new" "$APP/Contents/MacOS/janet-dictate"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>janet-dictate</string>
	<key>CFBundleIdentifier</key><string>dev.petalnet.janet-dictate</string>
	<key>CFBundleName</key><string>janet-dictate</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>0.1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>26.0</string>
	<key>LSUIElement</key><true/>
	<key>NSMicrophoneUsageDescription</key><string>janet-dictate records your voice while you hold the dictation key.</string>
	<key>NSSpeechRecognitionUsageDescription</key><string>janet-dictate turns your speech into text on this Mac.</string>
</dict>
</plist>
PLIST
codesign --force --sign - --identifier dev.petalnet.janet-dictate "$APP"
echo "built $APP"
echo "Ad-hoc signing gives a new identity on every build: allow Accessibility for the app again after a rebuild."
