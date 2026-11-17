#!/usr/bin/env bash
# Builds janet-dictate and wraps it in a minimal .app so macOS attributes the
# microphone, speech and accessibility prompts to it. Usage: bundle.sh [output-dir]
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-$HOME/Applications}"
APP="$OUT/janet-dictate.app"

swift build -c release
mkdir -p "$APP/Contents/MacOS"
cp .build/release/janet-dictate "$APP/Contents/MacOS/janet-dictate"
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
