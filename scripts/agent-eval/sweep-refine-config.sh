#!/usr/bin/env bash
# Refine around the arm that landed on the target: cache 4 MB / mmap 64 MB gave a
# 150.9 MB plateau (159.2 MB max) at 778 ms on flink with the pool off.
#
# Note the shape of the result, because it is counter-intuitive and worth keeping: mmap=0
# was WORSE for footprint than mmap=64 (159.8 vs 150.9 MB). Mapped reads do not buffer
# pages through the allocator's arenas, so a small window costs less retained memory than
# no window at all. "Turn the mapping off to save memory" is the wrong instinct.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT=/tmp/cg-refine-sweep
mkdir -p "$OUT"

for arm in "c4-m32:4:32" "c2-m64:2:64" "c4-m96:4:96" "c2-m128:2:128"; do
  IFS=: read -r label cache mmap <<< "$arm"
  pkill -f "codegraph.js serve --mcp" 2>/dev/null || true
  sleep 1
  env CODEGRAPH_ALLOW_UNSAFE_NODE=1 CODEGRAPH_MEMORY_CEILING_MB=8192 \
      CODEGRAPH_NO_WHEN_LABELS=1 CODEGRAPH_QUERY_POOL_SIZE=0 \
      CODEGRAPH_SQLITE_CACHE_MB="$cache" CODEGRAPH_SQLITE_MMAP_MB="$mmap" \
      node scripts/agent-eval/measure-serving.mjs --root "$ROOT" --rounds 12 \
      > "$OUT/$label.json" 2> "$OUT/$label.err" || { echo "$label FAILED"; continue; }
  python3 -c "
import json,statistics
d=json.load(open('$OUT/$label.json'))
fps=d['perRoundFootprintMb']; plateau=fps[4:] or fps
print('%-10s median=%4sms p90=%4sms idle=%5sMB plateau=%5.1fMB max=%5sMB'%(
  '$label',d['medianMs'],d['p90Ms'],d['idleFootprintMb'],
  statistics.median(plateau),max(fps)))
"
done
