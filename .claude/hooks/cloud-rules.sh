#!/usr/bin/env bash
# Cloud bridge for Pedro's global rules (SessionStart). Option 1, 2026-10-19.
#
# On Pedro's Macs ~/.claude/CLAUDE.md (from Moisty-Mango/dotclaude) loads by
# itself, so this script exits at once there. A cloud session never loads it,
# which is how a whole cloud session skipped the wrap-up routine, the
# PEDRO_OVERRIDE rule and the writing check (tasks/lessons.md, 2026-10-19).
# When the dotclaude clone is attached, this prints those rules into the
# session's context once, at start.

cat >/dev/null  # SessionStart input is not needed

# Loaded natively (a Mac, or the cloud setup script, Moisty-Mango/dotclaude
# hooks/cloud-setup-script.sh). Its "could not load" notice does not count: then the
# rules still come from the clones below when they are attached.
if [ -f "$HOME/.claude/CLAUDE.md" ] && ! grep -q 'CLOUD-SETUP-STUB' "$HOME/.claude/CLAUDE.md"; then
    exit 0
fi

PROJECT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
for d in "$PROJECT/../dotclaude" "/home/user/dotclaude" "$HOME/dotclaude"; do
    if [ -f "$d/CLAUDE.md" ]; then
        echo "━━━ PEDRO'S GLOBAL RULES (from Moisty-Mango/dotclaude, loaded for this cloud session) ━━━"
        echo "On the Macs this file is ~/.claude/CLAUDE.md. Paths in it under ~/.claude and"
        echo "~/Brain/brain-starter map to the attached clones: $(cd "$d" && pwd) and the second-brain clone."
        echo ""
        cat "$d/CLAUDE.md"
        echo "━━━ END OF GLOBAL RULES ━━━"
        exit 0
    fi
done
exit 0
