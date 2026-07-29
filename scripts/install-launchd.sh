#!/usr/bin/env bash
# Opt-in: keep the pr-queue sidecar running so localhost:7777 is always live.
# Not required — `node serve.js` is the baseline. Paths are derived, never baked in.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.prqueue.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PRQ_PORT:-7777}"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/serve.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRQ_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/prqueue-local.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/prqueue-local.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed $LABEL → http://localhost:$PORT"
echo "Logs:      $HOME/Library/Logs/prqueue-local.log"
echo "Uninstall: launchctl unload $PLIST && rm $PLIST"
