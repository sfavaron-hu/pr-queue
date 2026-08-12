#!/usr/bin/env bash
# Opt-in: make /work-assistant available from any workspace by symlinking the
# skill into the Claude config dir. Not required to use the panel. Paths are
# derived, never baked in. Re-runnable (idempotent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SRC="$REPO_DIR/.claude/skills/work-assistant"
DEST="$CFG/skills/work-assistant"

if [ ! -d "$SRC" ]; then
  echo "skill source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$CFG/skills"
ln -sfn "$SRC" "$DEST"

echo "Installed /work-assistant → $DEST -> $SRC"
echo "Uninstall: rm \"$DEST\""
