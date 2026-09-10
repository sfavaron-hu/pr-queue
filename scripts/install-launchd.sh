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

# `unload` returns before the process dies. The old serve.js survives it as an
# orphan still holding the port, launchd's new job exits 1 on "Port already in
# use" and respawns forever, and `curl localhost:$PORT` answers 200 the whole
# time — from the orphan. The obvious check is the one that goes green.
# `set -o pipefail` is on and lsof exits 1 when nothing listens, so without the
# `|| true` the plain assignment `stale="$(port_pid)"` aborts the installer on
# the happy path — the one where the port is already free.
port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -z "$(port_pid)" ]; then break; fi
  sleep 0.5
done
stale="$(port_pid)"
if [ -n "$stale" ]; then
  echo "port $PORT still held by pid $stale after unload — killing it"
  kill "$stale" 2>/dev/null || true
  sleep 1
  if [ -n "$(port_pid)" ]; then kill -9 "$(port_pid)" 2>/dev/null || true; fi
  sleep 1
fi

launchctl load "$PLIST"

# A loaded job is not a running one. `launchctl list` prints "-" for the PID of
# a job in a respawn loop, so the PID has to be a number AND it has to be the
# process actually holding the port.
job_pid=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  job_pid="$(launchctl list | awk -v l="$LABEL" '$3 == l { print $1 }')"
  case "$job_pid" in ''|-|*[!0-9]*) job_pid=""; sleep 0.5; continue ;; esac
  if [ "$job_pid" = "$(port_pid)" ]; then break; fi
  job_pid=""
  sleep 0.5
done

if [ -z "$job_pid" ]; then
  echo "$LABEL did not come up on port $PORT. Last lines of the log:" >&2
  tail -20 "$HOME/Library/Logs/prqueue-local.log" >&2 2>/dev/null || true
  exit 1
fi

echo "Installed $LABEL → http://localhost:$PORT (pid $job_pid)"
echo "Logs:      $HOME/Library/Logs/prqueue-local.log"
echo "Uninstall: launchctl unload $PLIST && rm $PLIST"
