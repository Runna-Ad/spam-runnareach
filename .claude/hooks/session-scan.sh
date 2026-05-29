#!/usr/bin/env bash
# S.P.A.M. Project Scan — runs ONCE per session (first prompt only).
# Outputs a concise state block so Claude never assumes env/code state.
# Token-conscious: max ~30 lines of output, no file dumps.

STAMP_FILE="/tmp/spam-session-scan-$(date +%Y%m%d)"

# Only fire once per calendar day / session
if [ -f "$STAMP_FILE" ]; then
  exit 0
fi
touch "$STAMP_FILE"

cd /Users/work/Projects/S.P.A.M 2>/dev/null || exit 0

echo "━━━ S.P.A.M. PROJECT SCAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Vercel env vars — NAMES ONLY (no values). Prevents "not configured" false diagnoses.
echo "▸ VERCEL ENV VARS SET:"
vercel env ls 2>/dev/null \
  | awk '/Encrypted/{print "  ✓ " $1}' \
  | sort \
  || echo "  (vercel env ls failed — run manually if needed)"

# 2. TypeScript baseline — quick check without full compile
TS_ERRORS=$(npx tsc --noEmit 2>&1 | grep -c "error TS"; true)
echo "▸ TS ERRORS: ${TS_ERRORS}"

# 3. Git state — last commit + any uncommitted changes
LAST_COMMIT=$(git log --oneline -1 2>/dev/null || echo "no git")
DIRTY=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
echo "▸ GIT: ${LAST_COMMIT} | dirty files: ${DIRTY}"

# 4. Key source files — modification timestamps (catch stale context)
echo "▸ RECENTLY MODIFIED (24h):"
find lib components app -name "*.ts" -o -name "*.tsx" 2>/dev/null \
  | xargs ls -lt 2>/dev/null \
  | awk -v cutoff="$(date -v-24H +%s 2>/dev/null || date -d '24 hours ago' +%s 2>/dev/null)" \
    'NR>0 { print "  " $NF }' \
  | head -8 \
  || find lib components app -newer tasks/todo.md -name "*.ts" -o -newer tasks/todo.md -name "*.tsx" 2>/dev/null | head -8 | sed 's/^/  /'

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
