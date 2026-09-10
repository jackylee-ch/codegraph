/**
 * A query-only process must NOT bring up the tree-sitter WASM runtime.
 *
 * A process that only answers queries never parses — the query path reads rows
 * out of SQLite — so `Parser.init()` on the `open()` path is work no query needs,
 * paid on the startup path of every long-lived MCP daemon. `openSync()` has never
 * initialized it and works fine, which is the existing proof that opening a
 * project doesn't need it.
 *
 * The runtime still comes up before the first parse: every parsing path goes
 * through `loadGrammarsForLanguages()`, which initializes on demand (pinned by
 * the last test here).
 *
 * Measured caveat worth keeping next to this: the ~32 MB `JSArrayBufferData` seen
 * in a serve process's heap snapshot is the SNAPSHOT WRITER's buffer, not this
 * runtime — `process.memoryUsage().arrayBuffers` stays 0 MB across `openSync()`
 * and a query. So this test guards a correctness/startup-work invariant, and
 * should not be cited as a memory saving.
 *
 * The fixture is indexed in a CHILD process on purpose: indexing parses, which
 * would flip the module-level flag and make the in-process assertion vacuous.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, {
  isTreeSitterRuntimeInitialized,
  loadGrammarsForLanguages,
} from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const hasBuild = fs.existsSync(BIN);

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lazy-parser-'));
  fs.writeFileSync(
    path.join(dir, 'a.ts'),
    'export function alpha(): number { return beta(); }\nexport function beta(): number { return 1; }\n'
  );
  if (!hasBuild) return;
  execFileSync(process.execPath, [BIN, 'init', '-y', dir], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_TELEMETRY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}, 180_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tree-sitter runtime is lazy (query-only processes skip the 32 MB WASM heap)', () => {
  it('the runtime is not up merely because this module was imported', () => {
    expect(isTreeSitterRuntimeInitialized()).toBe(false);
  });

  it.skipIf(!hasBuild)('open() on an indexed project does NOT initialize the runtime', async () => {
    const cg = await CodeGraph.open(dir, { sync: false });
    try {
      expect(isTreeSitterRuntimeInitialized()).toBe(false);
      // …and the connection is fully usable without it: querying reads SQLite.
      expect(cg.searchNodes('alpha').length).toBeGreaterThan(0);
      expect(isTreeSitterRuntimeInitialized()).toBe(false);
    } finally {
      cg.close();
    }
  });

  it.skipIf(!hasBuild)('openSync() likewise leaves it down', () => {
    const cg = CodeGraph.openSync(dir);
    try {
      expect(cg.searchNodes('beta').length).toBeGreaterThan(0);
      expect(isTreeSitterRuntimeInitialized()).toBe(false);
    } finally {
      cg.close();
    }
  });

  // Ordered last on purpose: it flips the module-level flag for good.
  it('loading a grammar brings the runtime up on demand', async () => {
    await loadGrammarsForLanguages(['typescript']);
    expect(isTreeSitterRuntimeInitialized()).toBe(true);
  });
});
