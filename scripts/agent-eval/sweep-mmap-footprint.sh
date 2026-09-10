#!/usr/bin/env bash
# Find the largest mmap window whose PHYSICAL FOOTPRINT still fits the 200 MB cap.
#
# Footprint is the metric to trade against, not rss: rss counts clean file-backed
# pages the kernel drops for free (measured: rss 1085 MB vs footprint 255 MB with a
# 2 GB mapping), and governed-rss-growth therefore over-charges a large mapping.
# But footprint is NOT zero for one either -- page tables and the dirty fraction are
# real -- so the window has to be sized, not waved through.
#
# The restart is disabled during measurement (CEILING raised) so a run is not cut in
# half by the very budget being characterised; mmap is pinned explicitly because the
# ceiling also feeds clampConnectionMemory.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="${1:-$HOME/Code/stczwd/flink}"
OUT=/tmp/cg-mmap-sweep
mkdir -p "$OUT"

for arm in "off:0" "off:32" "off:128" "off:256" "off:512" "on:256"; do
  when="${arm%%:*}"; mmap="${arm##*:}"
  label="when-$when-mmap$mmap"
  pkill -f "codegraph.js serve --mcp" 2>/dev/null || true
  sleep 1
  extra=()
  [ "$when" = "off" ] && extra+=(CODEGRAPH_NO_WHEN_LABELS=1)
  env CODEGRAPH_ALLOW_UNSAFE_NODE=1 CODEGRAPH_MEMORY_CEILING_MB=8192 \
      CODEGRAPH_SQLITE_MMAP_MB="$mmap" "${extra[@]}" \
      node scripts/agent-eval/measure-serving.mjs --root "$ROOT" --rounds 5 \
      > "$OUT/$label.json" 2> "$OUT/$label.err" || { echo "$label FAILED"; continue; }
  python3 -c "
import json
d=json.load(open('$OUT/$label.json'))
print('%-22s median=%4sms p90=%4sms footprint=%6sMB bytes=%s'%('$label',d['medianMs'],d['p90Ms'],d['peakFootprintMb'],d['responseBytes']))
"
done
