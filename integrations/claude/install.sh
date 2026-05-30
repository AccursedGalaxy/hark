#!/usr/bin/env bash
# Idempotent, opt-in installer for hark's `/head` slash-command.
#
# It symlinks integrations/claude/head.md into your Claude Code commands dir
# (~/.claude/commands/) so the command auto-updates whenever you `git pull`
# this repo. Safe to re-run: an existing correct link is left alone, and any
# other file already at the destination is backed up rather than clobbered.
#
# It does NOT touch ~/.claude/settings.json. The pure-PM tree-guard hooks are
# opt-in and listed in this directory's README.md for you to add by hand
# (Decision B, 2026-05-29: head command only, no settings.json automation).
set -euo pipefail

# Directory this script lives in (integrations/claude), resolved through symlinks.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SRC="$SCRIPT_DIR/head.md"
DEST_DIR="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
DEST="$DEST_DIR/head.md"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

# Already linked to us? Nothing to do.
if [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SRC")" ]; then
  echo "head.md already linked → $DEST (no changes)"
  exit 0
fi

# Something else is there — back it up rather than clobber.
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  backup="$DEST.bak-$(date +%Y%m%d%H%M%S)"
  mv "$DEST" "$backup"
  echo "moved existing $DEST → $backup"
fi

ln -s "$SRC" "$DEST"
echo "linked head.md → $DEST"
echo "  source: $SRC"
echo
echo "The /head command is now installed. To enable the pure-PM tree-guard,"
echo "follow integrations/claude/README.md (manual settings.json edit)."
