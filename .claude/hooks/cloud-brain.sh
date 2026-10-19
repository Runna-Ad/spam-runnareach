#!/usr/bin/env bash
# Cloud bridge for Pedro's second brain (UserPromptSubmit). Option 1, 2026-10-19.
#
# On Pedro's Macs the global hook ~/.claude/hooks/brain-recall.sh already runs
# (from Moisty-Mango/dotclaude) against the real vault ~/Brain/brain-starter, so
# this script exits at once there. A cloud session has neither: it only sees
# them when Moisty-Mango/second-brain and Moisty-Mango/dotclaude are attached
# and cloned. Then this script links the clones where the global hook expects
# them and runs that hook UNCHANGED, so recall behaves exactly as on the Macs.
#
# Never fails the prompt: every path that cannot work exits 0.

INPUT=$(cat)

# A real (non-symlink) vault means a Mac: the global hook handles recall.
if [ -d "$HOME/Brain/brain-starter/wiki" ] && [ ! -L "$HOME/Brain/brain-starter" ]; then
    exit 0
fi

PROJECT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
find_clone() {
    for d in "$PROJECT/../$1" "/home/user/$1" "$HOME/$1"; do
        [ -d "$d/.git" ] && { (cd "$d" && pwd); return 0; }
    done
    return 1
}
VAULT_SRC=$(find_clone second-brain)
DOT_SRC=$(find_clone dotclaude)

if [ -z "$VAULT_SRC" ] || [ -z "$DOT_SRC" ] || [ ! -f "$DOT_SRC/hooks/brain-recall.sh" ]; then
    # Say it once per session, never on every prompt.
    KEY=$(printf '%s' "$INPUT" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('session_id',''))
except Exception: print('')" 2>/dev/null | tr -cd 'A-Za-z0-9_-' | cut -c1-80)
    MARK="/tmp/cloud_brain_missing_${KEY:-$(date +%Y%m%d_%H)}"
    [ -f "$MARK" ] && exit 0
    touch "$MARK"
    echo "🧠 Second brain not attached to this cloud session (no recall, no global rules)."
    echo "   Conductor or a session Pedro talks to: ask him to attach Moisty-Mango/second-brain"
    echo "   and Moisty-Mango/dotclaude read-only. Worker sessions: your brief carries the"
    echo "   relevant brain lessons; do not ask."
    exit 0
fi

# Link the clones where the global hook looks. Never replace a real directory.
mkdir -p "$HOME/Brain" "$HOME/.claude/hooks" 2>/dev/null
[ -e "$HOME/Brain/brain-starter" ] || ln -s "$VAULT_SRC" "$HOME/Brain/brain-starter"
[ -e "$HOME/.claude/hooks/user-text.py" ] || ln -s "$DOT_SRC/hooks/user-text.py" "$HOME/.claude/hooks/user-text.py"

printf '%s' "$INPUT" | bash "$DOT_SRC/hooks/brain-recall.sh"
exit 0
