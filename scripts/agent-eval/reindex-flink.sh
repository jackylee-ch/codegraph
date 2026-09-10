#!/usr/bin/env bash
# Rebuild dist and re-index flink, so mmap/footprint sensitivity can be measured
# on the largest available repo (16,633 files / 460,106 nodes / 1.37M edges).
#
# Node 26 is hard-blocked by codegraph (issue #81, a V8 WASM Zone-allocator bug on
# 25.x+). No Node 22 is installed here, so the override is required; indexing has
# completed on it repeatedly in this environment.
#
# Both subcommands take the path POSITIONALLY -- there is no --path flag on either.
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run build
export CODEGRAPH_ALLOW_UNSAFE_NODE=1
rm -rf "$HOME/Code/stczwd/flink/.codegraph"
node dist/bin/codegraph.js init -y "$HOME/Code/stczwd/flink"   # init indexes by default
node dist/bin/codegraph.js status "$HOME/Code/stczwd/flink"
