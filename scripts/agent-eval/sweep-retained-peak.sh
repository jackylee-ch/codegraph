#!/usr/bin/env bash
# Attack the ~112 MB of per-call growth that is never returned.
#
# Measured split on flink: a daemon that has served ZERO calls sits at 91.2 MB of
# physical footprint; four explores take it to ~203 MB and it never comes back
# (183–207 MB thereafter, never near 91). So steady state is NOT startup cost — it
# is the retained peak of SQLite's transient allocation (FTS5 ranking, sorters,
# statement scratch) passing through the system allocator, which grows its arenas to
# the peak and does not return the pages.
#
# Two knobs bear directly on that peak, and neither has been measured on FOOTPRINT
# before (the earlier pass looked at rss, where a large mapping drowns the signal):
#   soft_heap_limit -- makes SQLite recycle its own cache instead of growing
#   temp_store=FILE -- spills sorters/temp b-trees to disk instead of RAM
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT=/tmp/cg-peak-sweep
mkdir -p "$OUT"

# label:SOFT_HEAP_MB:TEMP_STORE
for arm in "base:0:MEMORY" "soft64:64:MEMORY" "soft32:32:MEMORY" "tempfile:0:FILE" \
           "soft32-tempfile:32:FILE" "soft16-tempfile:16:FILE"; do
  IFS=: read -r label soft temp <<< "$arm"
  pkill -f "codegraph.js serve --mcp" 2>/dev/null || true
  sleep 1
  env CODEGRAPH_ALLOW_UNSAFE_NODE=1 CODEGRAPH_MEMORY_CEILING_MB=8192 \
      CODEGRAPH_SQLITE_MMAP_MB=256 CODEGRAPH_NO_WHEN_LABELS=1 \
      CODEGRAPH_SQLITE_SOFT_HEAP_MB="$soft" CODEGRAPH_SQLITE_TEMP_STORE="$temp" \
      node scripts/agent-eval/measure-serving.mjs --root "$ROOT" --rounds 5 \
      > "$OUT/$label.json" 2> "$OUT/$label.err" || { echo "$label FAILED"; continue; }
  python3 -c "
import json
d=json.load(open('$OUT/$label.json'))
fps=d['perRoundFootprintMb']
steady=sorted(fps[1:])[len(fps[1:])//2] if len(fps)>1 else None
print('%-18s median=%4sms idle=%5sMB steady=%5sMB peak=%5sMB bytes=%s'%(
  '$label',d['medianMs'],d['idleFootprintMb'],steady,d['peakFootprintMb'],d['responseBytes']))
"
done
