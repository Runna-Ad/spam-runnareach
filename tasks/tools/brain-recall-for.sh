#!/usr/bin/env bash
# Print the second-brain lessons that match a topic, for pasting into a worker
# brief ("Brain lessons" section). Worker sessions get only this repo, so the
# conductor carries the brain to them. Uses the same recall hook as every prompt.
#   tasks/tools/brain-recall-for.sh "send queue claim release gmail retry"
# Prints nothing when the brain is not attached or nothing matches.
TOPIC="$*"
[ ${#TOPIC} -lt 20 ] && TOPIC="$TOPIC (topic for a worker brief)"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
KEY="brief_$(date +%s)_$$"
python3 -c 'import json,sys; print(json.dumps({"session_id": sys.argv[1], "prompt": sys.argv[2]}))' "$KEY" "$TOPIC" \
  | CLAUDE_PROJECT_DIR="$ROOT" bash "$ROOT/.claude/hooks/cloud-brain.sh" \
  | sed -n '/BRAIN RECALL/,$p'
rm -f "/tmp/brain_recall_catalog_sid_$KEY" "/tmp/brain_recall_surfaced_sid_$KEY"
