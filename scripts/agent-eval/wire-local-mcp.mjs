#!/usr/bin/env node
/**
 * Wire the LOCAL codegraph build into Claude Code as a user-scoped MCP server.
 *
 * Why not `codegraph install`: the installer writes `command: "codegraph"`, i.e.
 * whatever is on PATH — which is the published version, not the build sitting in
 * this checkout's `dist/`. This writes the same entry shape but points it at
 * `dist/` directly, so a branch can be exercised through a real agent.
 *
 * Why the published package's bundled Node: codegraph hard-blocks Node 25+
 * (issue #81 — a V8 turboshaft WASM Zone-allocator bug that OOMs while compiling
 * tree-sitter grammars), and a machine whose system Node is newer than that cannot
 * run the local build at all. The published package ships its own supported Node
 * runtime, so borrowing it means the block never fires and no
 * CODEGRAPH_ALLOW_UNSAFE_NODE override is needed. `--liftoff-only` is the same flag
 * the shipped launcher passes, for the same reason (#293/#298).
 *
 * Why user scope rather than a per-project `.mcp.json`: the projects this is aimed
 * at are upstream checkouts that get PRs sent from them, and an untracked
 * `.mcp.json` in one is a file that can be committed by accident. A user-scoped
 * entry leaves nothing in any repo, and it is still effectively opt-in per project,
 * because codegraph only answers where a `.codegraph/` index exists — at an
 * un-indexed root it returns guidance rather than an error, and indexing stays a
 * deliberate act.
 *
 * Idempotent, and it rewrites the JSON with the same 2-space form the file already
 * uses. A backup is taken first regardless. `--dry-run` prints the entry and
 * touches nothing.
 *
 * Usage: node scripts/agent-eval/wire-local-mcp.mjs [--dry-run]
 *   CLAUDE_JSON=/path/to/.claude.json   override the config location
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG = process.env.CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The published package's platform sidecar carries the Node binary. Resolved from
 * this machine's platform/arch and npm's own global root rather than a literal
 * path, so the script survives a move to another machine or architecture.
 */
function findBundledNode() {
  const pkg = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
  const bin = process.platform === 'win32' ? 'node.exe' : 'node';
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    // npm not on PATH — fall through to the conventional locations
  }
  roots.push(
    path.join(os.homedir(), '.npm-global/lib/node_modules'),
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  );
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, '@colbymchenry/codegraph/node_modules', pkg, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const bundledNode = findBundledNode();
const localBuild = path.join(REPO, 'dist/bin/codegraph.js');
if (!bundledNode) {
  console.error(
    `no bundled Node found for ${process.platform}-${process.arch}.\n` +
      'Install the published package first: npm i -g @colbymchenry/codegraph',
  );
  process.exit(1);
}
if (!fs.existsSync(localBuild)) {
  console.error(`missing local build: ${localBuild}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const entry = {
  type: 'stdio',
  command: bundledNode,
  args: ['--liftoff-only', localBuild, 'serve', '--mcp'],
  alwaysLoad: true,
};

if (DRY_RUN) {
  console.log(`would write mcpServers.codegraph in ${CONFIG}`);
  console.log(JSON.stringify(entry, null, 2));
  process.exit(0);
}

fs.copyFileSync(CONFIG, `${CONFIG}.bak-mcp-wire`);
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const before = JSON.stringify(cfg.mcpServers?.codegraph);
cfg.mcpServers ??= {};
cfg.mcpServers.codegraph = entry;
if (before === JSON.stringify(entry)) {
  console.log('unchanged — already pointing at the local build');
} else {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(before ? 'updated' : 'created', `mcpServers.codegraph in ${CONFIG}`);
}
console.log(JSON.stringify(entry, null, 2));
