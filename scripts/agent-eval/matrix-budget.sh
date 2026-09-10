#!/usr/bin/env bash
# Sweep the two knobs that decide whether the 150/200 MB budget is reachable at
# all, measuring latency and memory from the same run each time.
#
#   CODEGRAPH_NO_WHEN_LABELS  -- moves request-time tree-sitter parsing off the
#                                serving path (measured worth ~77 MB, and its WASM
#                                heap cannot be given back: memory.grow has no
#                                inverse, so what it takes is permanent)
#   CODEGRAPH_SQLITE_MMAP_MB  -- the mapping; charged by the budget now, so this is
#                                a real trade rather than a free win
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT="${2:-/tmp/cg-matrix}"
mkdir -p "$OUT"
export CODEGRAPH_ALLOW_UNSAFE_NODE=1

run() { # <label> ...env assignments
  local label="$1"; shift
  echo "=== $label ==="
  # Stop any daemon so the next run starts from a clean baseline.
  pkill -f "codegraph.js serve --mcp" 2>/dev/null || true
  sleep 1
  env "$@" node scripts/agent-eval/measure-serving.mjs --root "$ROOT" --rounds 5 \
    > "$OUT/$label.json" 2> "$OUT/$label.err" || echo "  FAILED (see $OUT/$label.err)"
  python3 -c "
import json,sys
d=json.load(open('$OUT/$label.json'))
g=[l for l in d['governorSample'] if 'governed' in l or 'ceiling:' in l]
print('  median=%sms p90=%sms min=%sms bytes=%s governorLines=%s'%(d['medianMs'],d['p90Ms'],d['minMs'],d['responseBytes'],d['governorLines']))
for l in g[-2:]: print('   ',l.split('] ')[-1])
" 2>/dev/null || true
}

run when-on-mmap32    CODEGRAPH_SQLITE_MMAP_MB=32
run when-off-mmap32   CODEGRAPH_SQLITE_MMAP_MB=32  CODEGRAPH_NO_WHEN_LABELS=1
run when-off-mmap0    CODEGRAPH_SQLITE_MMAP_MB=0   CODEGRAPH_NO_WHEN_LABELS=1
run when-off-mmap50   CODEGRAPH_SQLITE_MMAP_MB=50  CODEGRAPH_NO_WHEN_LABELS=1
