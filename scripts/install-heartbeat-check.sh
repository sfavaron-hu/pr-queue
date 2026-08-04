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
  "description": "Drains reversible local git actions (push, prune, draft PRs via --fill) on my own branches and queues the decisions that need me. Never answers its own questions.",
  "enabled": false,
  "interval_minutes": 20,
  "model": "claude-sonnet-5",
  "session_timeout_secs": 1800,
  "allowed_tools": ["Bash", "Read"],
  "implementation": "$REPO_DIR",
  "gate": "gate.sh runs assist/bin/run.js (the mechanical drain). Its exit IS the contract: 0 drained clean · 4 gh failed mid-pass so the PR half is untrustworthy and no worktree was touched · 3 the ledger could not be built. Escalation exists only to tell me a pass was incomplete — it NEVER answers a queued question; those wait for /work-assistant. Exit 10 is reserved for future model-needing residue the gate does not yet emit."
}
JSON

cat > "$CHECK_DIR/gate.sh" <<SH
#!/bin/bash
# Deterministic drain over my own branches/PRs. Exit is the heartbeat contract:
# 0 clean · 4 gh degraded · 3 ledger failed. No model — the executor runs every
# action through argv (spawnSync, no shell). Implementation lives in the repo.
exec "$NODE_BIN" "$REPO_DIR/assist/bin/run.js"
SH
chmod +x "$CHECK_DIR/gate.sh"

cp "$REPO_DIR/.claude/skills/work-assistant/heartbeat/escalate.md" "$CHECK_DIR/escalate.md"

echo "Installed heartbeat check 'work' → $CHECK_DIR (disabled by default)"
echo "Enable:    heartbeat enable work    (then: heartbeat run work)"
echo "Uninstall: rm -rf \"$CHECK_DIR\""
