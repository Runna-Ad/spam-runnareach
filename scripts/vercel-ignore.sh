#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand): exit 0 skips the
# build, exit 1 builds. Any other exit code is reported as a FAILED deployment.
# Skip only a preview whose changes since the last built commit are notes
# (tasks/, .claude/, *.md). Anything we cannot check builds: the last built
# commit can fall outside Vercel's shallow clone, and git then exits 128.
[ "$VERCEL_ENV" = "production" ] && exit 1
# Worker branches (claude/*) skip their preview: each push made one, ~450 in
# two weeks. Integration branches (claude/*integration*) still build, so the
# pre-ship preview stays available.
case "$VERCEL_GIT_COMMIT_REF" in
  claude/*integration*) ;;
  claude/*) exit 0 ;;
esac
[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] || exit 1
git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null || exit 1
if git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . ':(exclude)tasks' ':(exclude).claude' ':(exclude)*.md'; then
  exit 0
fi
exit 1
