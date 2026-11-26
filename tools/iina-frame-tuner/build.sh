#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

app="build/音画逐帧校准.app"
mkdir -p "$app/Contents/MacOS"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.musicmarblesstudio.frame-tuner</string>
<key>CFBundleName</key><string>音画逐帧校准</string>
<key>CFBundleExecutable</key><string>FrameTuner</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
export MACOSX_DEPLOYMENT_TARGET=13.0
xcrun swiftc -swift-version 5 -O FrameTuner.swift -o "$app/Contents/MacOS/FrameTuner"
codesign --force --sign - "$app"
codesign --verify --strict "$app"
echo "已构建 $PWD/$app"
