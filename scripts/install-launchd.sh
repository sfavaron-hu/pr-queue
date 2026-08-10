#!/usr/bin/env bash
# Opt-in: keep the pr-queue sidecar running so localhost:7777 is always live.
# Not required — `node serve.js` is the baseline. Paths are derived, never baked in.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude || true)"
LABEL="com.prqueue.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PRQ_PORT:-7777}"
WORKSPACE="${PRQ_WORKSPACE:-}"
CLAUDE_CONFIG_DIR_VAL="${CLAUDE_CONFIG_DIR:-}"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

if [ -z "$CLAUDE_BIN" ]; then
  echo "warning: 'claude' not found on PATH — the agent will run without it, so session rows will not appear in the panel." >&2
fi

mkdir -p "$HOME/Library/LaunchAgents"

AGENT_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
if [ -n "$CLAUDE_BIN" ]; then
  AGENT_PATH="$(dirname "$CLAUDE_BIN"):$AGENT_PATH"
fi

EXTRA_ENV=""
if [ -n "$WORKSPACE" ]; then
  EXTRA_ENV="$EXTRA_ENV
    <key>PRQ_WORKSPACE</key><string>$WORKSPACE</string>"
fi
if [ -n "$CLAUDE_CONFIG_DIR_VAL" ]; then
  EXTRA_ENV="$EXTRA_ENV
    <key>CLAUDE_CONFIG_DIR</key><string>$CLAUDE_CONFIG_DIR_VAL</string>"
fi

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
    <key>PATH</key><string>$AGENT_PATH</string>$EXTRA_ENV
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
