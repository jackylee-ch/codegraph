#!/usr/bin/env bash
# Is the retained ~110 MB the query-pool worker?
#
# The split says a zero-call daemon is 91 MB and four calls take it to ~200 MB, and
# neither soft_heap_limit nor temp_store moves that (six arms, all 192–202 MB). So the
# growth is not SQLite's own accounting. A pool worker is the other thing a first call
# creates: a whole worker_threads isolate, its own copy of the module graph, and its
# OWN SQLite connection paying cache and mmap independently.
#
# `CODEGRAPH_QUERY_POOL_SIZE=0` disables the pool and serves in-process, so this is a
# clean A/B on exactly that. Sizes 1/2 then show whether the cost is per-worker.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT=/tmp/cg-pool-sweep
mkdir -p "$OUT"

for size in 0 1 2 4; do
  pkill -f "codegraph.js serve --mcp" 2>/dev/null || true
  sleep 1
  env CODEGRAPH_ALLOW_UNSAFE_NODE=1 CODEGRAPH_MEMORY_CEILING_MB=8192 \
      CODEGRAPH_SQLITE_MMAP_MB=256 CODEGRAPH_NO_WHEN_LABELS=1 \
      CODEGRAPH_QUERY_POOL_SIZE="$size" \
      node scripts/agent-eval/measure-serving.mjs --root "$ROOT" --rounds 5 \
      > "$OUT/pool$size.json" 2> "$OUT/pool$size.err" || { echo "pool$size FAILED"; continue; }
  python3 -c "
import json
d=json.load(open('$OUT/pool$size.json'))
fps=d['perRoundFootprintMb']; tail=fps[1:]
steady=sorted(tail)[len(tail)//2] if tail else None
print('pool=%-2s median=%4sms idle=%5sMB steady=%5sMB peak=%5sMB bytes=%s'%(
  '$size',d['medianMs'],d['idleFootprintMb'],steady,d['peakFootprintMb'],d['responseBytes']))
"
done
