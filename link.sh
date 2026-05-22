#!/usr/bin/env bash
# link.sh — Register skills with agent harnesses.
#
# pi (~/.agents/skills/):
#   Symlinks this entire repo as a subdirectory. Pi recursively discovers all
#   skill directories within it, so new skills are picked up automatically.
#
# opencode (~/.config/opencode/skills/):
#   Symlinks each <skill-name>/ directory individually (opencode uses a flat
#   skills/<name>/SKILL.md layout). Re-run this script when new skills are added.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── pi ────────────────────────────────────────────────────────────────────────
PI_SKILLS_DIR="$HOME/.agents/skills"
mkdir -p "$PI_SKILLS_DIR"

PI_LINK="$PI_SKILLS_DIR/personal-skills"
if [ -L "$PI_LINK" ]; then
  echo "pi      : link exists      $PI_LINK"
elif [ -e "$PI_LINK" ]; then
  echo "pi      : WARNING — $PI_LINK exists but is not a symlink, skipping"
else
  ln -s "$REPO_DIR" "$PI_LINK"
  echo "pi      : created           $PI_LINK -> $REPO_DIR"
fi

# ── opencode ──────────────────────────────────────────────────────────────────
OC_SKILLS_DIR="$HOME/.config/opencode/skills"
mkdir -p "$OC_SKILLS_DIR"

oc_count=0
oc_new=0

for skill_dir in "$REPO_DIR"/*/; do
  [ -f "${skill_dir}SKILL.md" ] || continue
  skill_name="$(basename "$skill_dir")"
  link="$OC_SKILLS_DIR/$skill_name"
  oc_count=$((oc_count + 1))

  if [ -L "$link" ]; then
    echo "opencode: link exists      $link"
  elif [ -e "$link" ]; then
    echo "opencode: WARNING — $link exists but is not a symlink, skipping"
  else
    ln -s "$skill_dir" "$link"
    echo "opencode: created           $link -> $skill_dir"
    oc_new=$((oc_new + 1))
  fi
done

echo ""
echo "Done — $oc_count skill(s) total, $oc_new new opencode link(s) created."
