#!/usr/bin/env bash
# Opt-in: register the work-assistant as a gated heartbeat check, exactly as the
# `prs` check registers pr-babysit. The gate is the mechanical drain (run.js):
# it costs no model session on a clean pass, and only escalates when gh degraded
# mid-pass. Paths are derived, never baked in. Re-runnable (idempotent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HB="${HB_HOME:-$CFG/heartbeat}"
CHECK_DIR="$HB/checks/work"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
if [ ! -d "$HB/checks" ]; then
  echo "heartbeat is not installed at $HB (expected $HB/checks). Install the heartbeat platform first." >&2
  exit 1
fi

mkdir -p "$CHECK_DIR"

cat > "$CHECK_DIR/check.json" <<JSON
{
  "description": "Drains reversible local git actions (push, prune, remove merged worktrees) on my own branches and queues the decisions that need me. Does NOT open draft PRs — those wait for /work-assistant, where a model writes a proper body. Never answers its own questions; pings me on Slack when a new one is waiting so I run /work-assistant.",
  "enabled": false,
  "interval_minutes": 20,
  "model": "claude-sonnet-5",
  "session_timeout_secs": 1800,
  "allowed_tools": ["Bash", "Read", "mcp__claude_ai_Slack__slack_send_message"],
  "implementation": "$REPO_DIR",
  "gate": "gate.sh runs assist/bin/run.js (the mechanical drain). Its exit IS the contract: 0 drained clean, nothing new · 10 a NEW unanswered question appeared, so escalate to send me a generic Slack heads-up (throttled by notified.json — it never re-pings a question already sent, so questions sitting unanswered cost no session) · 4 gh failed mid-pass so the PR half is untrustworthy and no worktree was touched · 3 the ledger could not be built. The escalation ONLY notifies — it NEVER answers a queued question; those wait for /work-assistant."
}
JSON

cat > "$CHECK_DIR/gate.sh" <<SH
#!/bin/bash
# Deterministic drain over my own branches/PRs. Exit is the heartbeat contract:
# 0 clean · 10 a new question is waiting (escalate → Slack heads-up) · 4 gh
# degraded · 3 ledger failed. No model in the drain itself — the executor runs
# every action through argv (spawnSync, no shell). Implementation is in the repo.
exec "$NODE_BIN" "$REPO_DIR/assist/bin/run.js"
SH
chmod +x "$CHECK_DIR/gate.sh"

cp "$REPO_DIR/.claude/skills/work-assistant/heartbeat/escalate.md" "$CHECK_DIR/escalate.md"

echo "Installed heartbeat check 'work' → $CHECK_DIR (disabled by default)"
echo "Enable:    heartbeat enable work    (then: heartbeat run work)"
echo "Uninstall: rm -rf \"$CHECK_DIR\""
