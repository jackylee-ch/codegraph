#!/usr/bin/env bash
# Close the last gap to a 150 MB steady state, with the pool off.
#
# Established so far on flink (WHEN labels off, pool off, mmap 256): idle 91.6 MB,
# plateau 155–175 MB over 20 rounds (146 -> 174 by round 4, flat to round 14, settles
# ~155), median 708 ms. Against a 1651 ms baseline that is 2.33x, so there is a lot of
# latency headroom -- anything under ~1100 ms still clears 1.5x. That headroom is what
# makes trading the mapping and the page cache for footprint affordable here.
#
# Long-ish runs (12 rounds) because the plateau only shows after round 4, and a 5-round
# verdict on this metric has already been wrong once.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT=/tmp/cg-final-sweep
mkdir -p "$OUT"

# label:CACHE_MB:MMAP_MB
for arm in "c16-m256:16:256" "c8-m128:8:128" "c4-m64:4:64" "c4-m0:4:0" "c8-m256:8:256"; do
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
