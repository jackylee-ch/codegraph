/**
 * The cross-project connection cache is BOUNDED (count + idle age).
 *
 * `ToolHandler` opens a `CodeGraph` per distinct `projectPath` an agent passes
 * and caches it. Every cached entry is a live SQLite connection that
 * `configureConnection` hands a 64 MB page cache and a 256 MB mmap window, so an
 * unbounded cache turns a session that touches eight repos into eight
 * permanently-held connections — the daemon's resident set only ever grows, and
 * before this change nothing but `closeAll()` released any of it. A daemon meant
 * to survive weeks cannot carry that.
 *
 * Two independent bounds, exercised separately here because they fail
 * differently: a COUNT bound (memory ceiling under fan-out) and an IDLE-AGE
 * bound (a daemon sitting on two repos overnight should not still hold both).
 *
 * The DEFAULT project is owned by the server, is never stored in this cache, and
 * must never be evicted — asserted below, because evicting it would close the
 * connection the server itself keeps using.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import {
  ToolHandler,
  resolveProjectCacheLimits,
  PROJECT_CACHE_LIMITS,
  __setLoadCodeGraphForTests,
} from '../src/mcp/tools';

const SIZE_ENV = 'CODEGRAPH_PROJECT_CACHE_SIZE';
const TTL_ENV = 'CODEGRAPH_PROJECT_CACHE_TTL_MS';

/** Reach the private resolver — the unit under test is its caching, not a tool schema. */
const resolve = (h: ToolHandler, root: string): unknown =>
  (h as unknown as { getCodeGraph(p?: string): unknown }).getCodeGraph(root);

let tmpRoot: string;
const projects: string[] = [];

beforeAll(async () => {
  // The lazy `require('../index')` inside tools.ts can't be serviced by vitest's
  // module transform, so inject the already-imported class (same seam the
  // cross-project tests for #1474 use).
  __setLoadCodeGraphForTests(CodeGraph);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-projcache-'));
  // Five tiny indexed projects: enough to overflow the default bound of 3.
  for (let i = 0; i < 5; i++) {
    const dir = path.join(tmpRoot, `p${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), `export function f${i}(): number { return ${i}; }\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    cg.close();
    projects.push(fs.realpathSync(dir));
  }
}, 120_000);

afterAll(() => {
  __setLoadCodeGraphForTests(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env[SIZE_ENV];
  delete process.env[TTL_ENV];
});

describe('resolveProjectCacheLimits', () => {
  it('defaults to the documented bounds', () => {
    expect(resolveProjectCacheLimits({})).toEqual({
      maxProjects: PROJECT_CACHE_LIMITS.MAX_PROJECTS,
      idleTtlMs: PROJECT_CACHE_LIMITS.IDLE_TTL_MS,
    });
  });

  it('honors both env overrides, including 0 (disable)', () => {
    expect(resolveProjectCacheLimits({ [SIZE_ENV]: '1', [TTL_ENV]: '0' })).toEqual({
      maxProjects: 1,
      idleTtlMs: 0,
    });
  });

  it('ignores malformed values rather than throwing or capping to zero', () => {
    for (const bad of ['', '  ', 'abc', '-1', '2.5', 'NaN']) {
      expect(resolveProjectCacheLimits({ [SIZE_ENV]: bad }).maxProjects).toBe(
        PROJECT_CACHE_LIMITS.MAX_PROJECTS
      );
    }
  });
});

describe('ToolHandler cross-project cache bounds', () => {
  it('evicts the least-recently-used project past the count bound', () => {
    process.env[SIZE_ENV] = '2';
    const h = new ToolHandler(null);
    try {
      resolve(h, projects[0]!);
      resolve(h, projects[1]!);
      expect(h.cachedProjectRoots()).toEqual([projects[0]!, projects[1]!]);

      // Third insert overflows: p0 is the LRU and goes.
      resolve(h, projects[2]!);
      expect(h.cachedProjectRoots()).toEqual([projects[1]!, projects[2]!]);
    } finally {
      h.closeAll();
    }
  });

  it('a cache HIT refreshes recency, so the untouched entry is evicted instead', () => {
    process.env[SIZE_ENV] = '2';
    const h = new ToolHandler(null);
    try {
      resolve(h, projects[0]!);
      resolve(h, projects[1]!);
      // Touch p0 again — now p1 is the LRU.
      resolve(h, projects[0]!);
      expect(h.cachedProjectRoots()).toEqual([projects[1]!, projects[0]!]);

      resolve(h, projects[2]!);
      expect(h.cachedProjectRoots()).toEqual([projects[0]!, projects[2]!]);
    } finally {
      h.closeAll();
    }
  });

  it('never grows past the bound no matter how many projects a session fans out over', () => {
    process.env[SIZE_ENV] = '3';
    const h = new ToolHandler(null);
    try {
      for (let round = 0; round < 3; round++) {
        for (const p of projects) {
          resolve(h, p);
          expect(h.cachedProjectRoots().length).toBeLessThanOrEqual(3);
        }
      }
      expect(h.cachedProjectRoots().length).toBe(3);
    } finally {
      h.closeAll();
    }
  });

  it('releases a project untouched past the idle TTL', async () => {
    process.env[SIZE_ENV] = '10'; // count bound must not be what evicts here
    process.env[TTL_ENV] = '30';
    const h = new ToolHandler(null);
    try {
      resolve(h, projects[0]!);
      expect(h.cachedProjectRoots()).toEqual([projects[0]!]);

      await new Promise((r) => setTimeout(r, 60));

      // The sweep runs on a MISS — the moment another connection is about to be
      // added — so resolving a different project is what collects the stale one.
      resolve(h, projects[1]!);
      expect(h.cachedProjectRoots()).toEqual([projects[1]!]);
    } finally {
      h.closeAll();
    }
  });

  it('TTL=0 disables the idle sweep', async () => {
    process.env[SIZE_ENV] = '10';
    process.env[TTL_ENV] = '0';
    const h = new ToolHandler(null);
    try {
      resolve(h, projects[0]!);
      await new Promise((r) => setTimeout(r, 40));
      resolve(h, projects[1]!);
      expect(h.cachedProjectRoots()).toEqual([projects[0]!, projects[1]!]);
    } finally {
      h.closeAll();
    }
  });

  it('an evicted project is reopened on the next call and still answers', () => {
    process.env[SIZE_ENV] = '1';
    const h = new ToolHandler(null);
    try {
      const first = resolve(h, projects[0]!);
      resolve(h, projects[1]!); // evicts + closes p0
      expect(h.cachedProjectRoots()).toEqual([projects[1]!]);

      const reopened = resolve(h, projects[0]!);
      expect(reopened).not.toBe(first); // a genuinely new connection
      expect((reopened as CodeGraph).getProjectRoot()).toBe(projects[0]!);
      expect((reopened as CodeGraph).searchNodes('f0').length).toBeGreaterThan(0);
    } finally {
      h.closeAll();
    }
  });

  it('never caches or evicts the DEFAULT project', async () => {
    process.env[SIZE_ENV] = '1';
    const def = await CodeGraph.open(projects[4]!);
    const h = new ToolHandler(def);
    try {
      // Resolving the default project's own root reuses the server's instance.
      expect(resolve(h, projects[4]!)).toBe(def);
      expect(h.cachedProjectRoots()).toEqual([]);

      // Overflowing the cache with other projects must not touch it.
      resolve(h, projects[0]!);
      resolve(h, projects[1]!);
      expect(h.cachedProjectRoots()).toEqual([projects[1]!]);
      expect(def.searchNodes('f4').length).toBeGreaterThan(0);
    } finally {
      h.closeAll();
      def.close();
    }
  });
});
