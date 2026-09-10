#!/usr/bin/env bash
# Build the pre-change baseline in a worktree and measure it with the SAME harness.
#
# Every latency multiple this branch has claimed so far compared a number from one
# ad-hoc probe against a number from another. That is not a measurement. cd4e65b is
# the last commit before the memory work started, so it is the honest "before".
#
# The baseline serves the SAME index (the DB is in the flink checkout, not in the
# worktree), so only the serving code differs between the two arms.
set -euo pipefail
REPO="$HOME/Code/stczwd/codegraph"
WT=/tmp/worktrees/codegraph/baseline
cd "$REPO"
if [ ! -d "$WT" ]; then
  git worktree add "$WT" cd4e65b
fi
cd "$WT"
npm ci --silent
npm run build
