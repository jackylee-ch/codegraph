#!/usr/bin/env bash
# Which of the tests failing on this branch also fail on clean upstream main?
#
# A red suite on a working branch is two populations mixed together: regressions
# this branch caused, and failures that were already there. Only the first kind is
# yours to fix, and the difference is not guessable — AGENTS.md records known
# pre-existing failures for Windows, but the list for a given upstream tip is
# whatever it is that day. So run the same files against an untouched checkout.
#
# Uses a throwaway worktree rather than switching branches, so the working tree
# under review is never disturbed, and installs there from scratch because
# esbuild/rollup ship platform-specific binaries that must not be shared.
#
# Usage: check-upstream-failures.sh [test-file ...]
#   REF=origin/main check-upstream-failures.sh      # no `upstream` remote configured
#
# WHEN labels are turned on because vitest.config.mts turns them on for the suite
# (several hundred tests assert what request-time parsing produces); the shipped
# default is off. ALLOW_UNSAFE_NODE is here because Node 25+ is hard-blocked
# (issue #81) and that is what is installed on this machine.
set -euo pipefail
cd "$(dirname "$0")/../.."

REF="${REF:-upstream/main}"
WT=/tmp/worktrees/codegraph/upstream-check

TESTS=("$@")
if [ ${#TESTS[@]} -eq 0 ]; then
  TESTS=(
    __tests__/installer-targets.test.ts
    __tests__/mcp-callers-truncation.test.ts
    __tests__/nextjs.test.ts
    __tests__/react-native-bridge.test.ts
    __tests__/ui-steps-api-servers.test.ts
    __tests__/ui-steps-api.test.ts
    __tests__/ui-steps-cross-tier.test.ts
    __tests__/object-literal-methods.test.ts
  )
fi

git rev-parse --verify "$REF" >/dev/null 2>&1 || { echo "no such ref: $REF" >&2; exit 1; }
if [ -d "$WT" ]; then
  git worktree remove "$WT" --force 2>/dev/null || true
fi
git worktree add "$WT" "$REF"

cd "$WT"
npm ci --silent
npm run build
CODEGRAPH_ALLOW_UNSAFE_NODE=1 CODEGRAPH_WHEN_LABELS=1 \
  npx vitest run "${TESTS[@]}" 2>&1 | grep -E "FAIL|Test Files|Tests " || true
