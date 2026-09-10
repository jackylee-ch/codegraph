/**
 * The MCP server enforces a per-process memory budget at tool-call boundaries.
 *
 * Measured shape of the problem this guards (flink, 16,633 files / 460,106 nodes
 * / 1.4 GB index, one serve process): 201 MB physical footprint at rest, of which
 * one forced full GC returned 139 MB — it sat at 62 MB afterwards and stayed
 * there. Nothing in the process was asking, so nothing collected: the live set is
 * far below any `--max-old-space-size`, which is also why capping the heap flag
 * did nothing (128/256/512 MB all measured identical).
 *
 * The second half is that a GC alone is not enough. Reachable caches survive it —
 * three consecutive explores on that index drifted 86 → 186 → 193 → 209 MB *with*
 * a GC after each one. So the governor evicts first and collects second, and both
 * halves are asserted here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  MemoryGovernor,
  readMemory,
  getGcHandle,
  resolveMemoryBudget,
  MEMORY_BUDGET_DEFAULTS,
  captureRssBaseline,
  resolveDaemonV8Flags,
  __resetGcHandleForTests,
  __setRssBaselineForTests,
  type MemoryBudget,
  type MemoryReading,
} from '../src/mcp/memory-governor';

const MB = 1024 * 1024;

const budget = (overrides: Partial<MemoryBudget> = {}): MemoryBudget => ({
  enabled: true,
  highWaterBytes: 100 * MB,
  ceilingBytes: 200 * MB,
  ...overrides,
});

afterEach(() => {
  delete process.env.CODEGRAPH_MEMORY_HIGH_MB;
  delete process.env.CODEGRAPH_MEMORY_CEILING_MB;
  delete process.env.CODEGRAPH_NO_MEMORY_GOVERNOR;
});

describe('resolveMemoryBudget', () => {
  it('defaults sit above this process floor so the defaults never restart-loop', () => {
    const b = resolveMemoryBudget({});
    expect(b.enabled).toBe(true);
    expect(b.highWaterBytes).toBe(MEMORY_BUDGET_DEFAULTS.HIGH_WATER_MB * MB);
    expect(b.ceilingBytes).toBe(MEMORY_BUDGET_DEFAULTS.CEILING_MB * MB);
    // Measured floor after evict + gc is 230–255MB of resident growth on indexes
    // from 215k to 460k nodes; a default ceiling at or under that would make every
    // fresh process breach immediately.
    expect(b.ceilingBytes).toBeGreaterThan(255 * MB);
  });

  it('honors both overrides', () => {
    const b = resolveMemoryBudget({
      CODEGRAPH_MEMORY_HIGH_MB: '60',
      CODEGRAPH_MEMORY_CEILING_MB: '90',
    });
    expect(b.highWaterBytes).toBe(60 * MB);
    expect(b.ceilingBytes).toBe(90 * MB);
  });

  it('never lets the ceiling sit at or below the high-water mark', () => {
    // Otherwise the first trip over the line would reclaim and immediately
    // self-destruct, which is a restart loop rather than a budget.
    const b = resolveMemoryBudget({
      CODEGRAPH_MEMORY_HIGH_MB: '150',
      CODEGRAPH_MEMORY_CEILING_MB: '100',
    });
    expect(b.ceilingBytes).toBeGreaterThan(b.highWaterBytes);
  });

  it('ignores malformed values instead of collapsing the budget to zero', () => {
    for (const bad of ['', ' ', 'abc', '0', '-5', 'NaN']) {
      expect(resolveMemoryBudget({ CODEGRAPH_MEMORY_HIGH_MB: bad }).highWaterBytes).toBe(
        MEMORY_BUDGET_DEFAULTS.HIGH_WATER_MB * MB
      );
    }
  });

  it('has a kill switch', () => {
    expect(resolveMemoryBudget({ CODEGRAPH_NO_MEMORY_GOVERNOR: '1' }).enabled).toBe(false);
  });
});

describe('readMemory', () => {
  it('reports committed, live and resident bytes', () => {
    const r = readMemory();
    expect(r.committedJsBytes).toBeGreaterThan(0);
    expect(r.liveBytes).toBeGreaterThan(0);
    expect(r.rssBytes).toBeGreaterThan(0);
    // Committed must cover live — the difference is what a GC could hand back.
    expect(r.committedJsBytes).toBeGreaterThanOrEqual(r.liveBytes);
  });

  it('governs on the WORSE of committed JS and resident growth', () => {
    // Neither term alone can be gamed: JS-only is blind to SQLite's page cache
    // and mmap, absolute rss is dominated by the runtime's clean mapped binary.
    const r = readMemory();
    expect(r.governedBytes).toBe(Math.max(r.committedJsBytes, r.rssGrowthBytes));
  });

  it('resident growth is a DELTA over baseline, never the absolute rss', () => {
    __setRssBaselineForTests(null);
    const base = captureRssBaseline();
    expect(base).toBeGreaterThan(0);
    const r = readMemory();
    expect(r.rssGrowthBytes).toBeLessThan(r.rssBytes);
    // An absolute-rss budget would be unsatisfiable: the runtime's own footprint
    // already exceeds any sane per-project number before codegraph does anything.
    expect(r.rssBytes).toBeGreaterThan(r.rssGrowthBytes);
  });

  it('a rise in rss above baseline shows up in the governed number', () => {
    __setRssBaselineForTests(1); // pretend the process started at ~nothing
    const r = readMemory();
    expect(r.rssGrowthBytes).toBeGreaterThan(r.committedJsBytes);
    expect(r.governedBytes).toBe(r.rssGrowthBytes);
    __setRssBaselineForTests(null);
  });
});

describe('getGcHandle', () => {
  it('obtains a working full-GC handle without --expose-gc on the command line', () => {
    __resetGcHandleForTests();
    const gc = getGcHandle();
    expect(gc).toBeTypeOf('function');
    expect(() => gc!()).not.toThrow();
  });

  it('does not leave global.gc reachable afterwards', () => {
    const hadGlobal = typeof (globalThis as { gc?: unknown }).gc === 'function';
    __resetGcHandleForTests();
    getGcHandle();
    if (!hadGlobal) {
      expect(typeof (globalThis as { gc?: unknown }).gc).not.toBe('function');
    }
  });

  it('memoizes, so a tool-call-path caller pays the derivation once', () => {
    __resetGcHandleForTests();
    expect(getGcHandle()).toBe(getGcHandle());
  });
});

describe('resolveDaemonV8Flags — the budget made structural', () => {
  it('caps the daemon old space at a third of the ceiling', () => {
    // A third, not the whole ceiling: the ceiling covers the whole process, and
    // measured on a 460k-node index the JS side only ever committed ~58MB, so the
    // rest of the budget belongs to native (sqlite page cache, malloc arenas,
    // code space, page tables).
    const flags = resolveDaemonV8Flags({ CODEGRAPH_MEMORY_CEILING_MB: '600' });
    expect(flags).toContain('--max-old-space-size=200');
    expect(flags).toContain('--max-semi-space-size=4');
  });

  it('floors the cap so V8 does not thrash on a large index', () => {
    // Both knobs, because resolveMemoryBudget floors the ceiling just above the
    // high-water mark — lowering only the ceiling leaves the default high water
    // dominating it.
    const flags = resolveDaemonV8Flags({
      CODEGRAPH_MEMORY_HIGH_MB: '50',
      CODEGRAPH_MEMORY_CEILING_MB: '60',
    });
    expect(flags).toContain('--max-old-space-size=48');
  });

  it('never hands V8 more than 1 GB just because the ceiling is huge', () => {
    const flags = resolveDaemonV8Flags({ CODEGRAPH_MEMORY_CEILING_MB: '99999' });
    expect(flags).toContain('--max-old-space-size=1024');
  });

  it('an explicit override wins over the derivation', () => {
    const flags = resolveDaemonV8Flags({
      CODEGRAPH_MEMORY_CEILING_MB: '600',
      CODEGRAPH_DAEMON_HEAP_MB: '96',
    });
    expect(flags).toContain('--max-old-space-size=96');
  });

  it('CODEGRAPH_DAEMON_HEAP_MB=0 disables the flags entirely', () => {
    expect(resolveDaemonV8Flags({ CODEGRAPH_DAEMON_HEAP_MB: '0' })).toEqual([]);
  });

  it('the governor kill switch also drops the flags', () => {
    expect(resolveDaemonV8Flags({ CODEGRAPH_NO_MEMORY_GOVERNOR: '1' })).toEqual([]);
  });

  it('defaults produce a cap derived from the default ceiling', () => {
    const flags = resolveDaemonV8Flags({});
    const expected = Math.round(MEMORY_BUDGET_DEFAULTS.CEILING_MB / 3);
    expect(flags).toContain(`--max-old-space-size=${expected}`);
  });
});

describe('MemoryGovernor.check', () => {

  it('does nothing under the high-water mark — no evict, no gc', () => {
    let evicted = 0;
    const g = new MemoryGovernor(
      { evict: () => { evicted++; }, onCeiling: () => {} },
      budget({ highWaterBytes: 1024 * 1024 * 1024 * 1024 })
    );
    const out = g.check();
    expect(out.action).toBe('ok');
    expect(evicted).toBe(0);
  });

  it('is inert when disabled, even far past the line', () => {
    let evicted = 0;
    const g = new MemoryGovernor(
      { evict: () => { evicted++; }, onCeiling: () => {} },
      budget({ enabled: false, highWaterBytes: 1 })
    );
    expect(g.enabled).toBe(false);
    expect(g.check().action).toBe('ok');
    expect(evicted).toBe(0);
  });

  it('evicts BEFORE collecting — the order that also reclaims reachable caches', () => {
    const order: string[] = [];
    // A GC observed through its effect on the live set can't be ordered reliably,
    // so the sequence is asserted via the hook that CAN be: evict must have run
    // by the time check() returns a reclaim verdict.
    const g = new MemoryGovernor(
      { evict: () => order.push('evict'), onCeiling: () => order.push('ceiling') },
      budget({ highWaterBytes: 1, ceilingBytes: Number.MAX_SAFE_INTEGER })
    );
    const out = g.check();
    expect(out.action).toBe('reclaimed');
    expect(order).toEqual(['evict']);
  });

  it('fires the ceiling hook when still over after evict + gc, and only once', () => {
    const seen: MemoryReading[] = [];
    const g = new MemoryGovernor(
      { evict: () => {}, onCeiling: (r) => seen.push(r) },
      budget({ highWaterBytes: 1, ceilingBytes: 1 })
    );
    expect(g.check().action).toBe('ceiling');
    expect(g.check().action).toBe('ceiling');
    expect(seen).toHaveLength(1); // second trip must not re-fire
    expect(seen[0]!.governedBytes).toBeGreaterThan(0);
  });

  it('stops asking for restarts once the budget is provably below the floor', () => {
    // A ceiling no fresh process can meet is a restart loop, not a budget. After
    // MAX_CONSECUTIVE_CEILINGS the governor says so and stops self-destructing —
    // it does NOT quietly widen the budget, which would be the tool overriding
    // the operator.
    const lines: string[] = [];
    let restarts = 0;
    const g = new MemoryGovernor(
      { evict: () => {}, onCeiling: () => { restarts++; }, log: (l) => lines.push(l) },
      budget({ highWaterBytes: 1, ceilingBytes: 1 })
    );
    for (let i = 0; i < MEMORY_BUDGET_DEFAULTS.MAX_CONSECUTIVE_CEILINGS + 3; i++) {
      expect(g.check().action).toBe('ceiling');
    }
    expect(restarts).toBe(1);
    expect(lines.filter((l) => l.startsWith('budget below floor'))).toHaveLength(1);
    // Reclaim keeps running — only the self-destruct stops.
    expect(lines.filter((l) => l.startsWith('reclaim:')).length).toBeGreaterThan(1);
  });

  it('a throwing evict hook never fails the caller', () => {
    const g = new MemoryGovernor(
      { evict: () => { throw new Error('boom'); }, onCeiling: () => {} },
      budget({ highWaterBytes: 1, ceilingBytes: Number.MAX_SAFE_INTEGER })
    );
    expect(() => g.check()).not.toThrow();
  });

  it('a throwing ceiling hook never fails the caller', () => {
    const g = new MemoryGovernor(
      { evict: () => {}, onCeiling: () => { throw new Error('boom'); } },
      budget({ highWaterBytes: 1, ceilingBytes: 1 })
    );
    expect(() => g.check()).not.toThrow();
  });

  it('actually returns memory: a large retained buffer is gone after release + check', () => {
    // The end-to-end claim, in miniature: hold a big allocation, make it
    // unreachable from the evict hook, and observe committed bytes fall.
    let hog: Buffer[] | null = [];
    for (let i = 0; i < 40; i++) hog.push(Buffer.alloc(4 * MB, 1));
    const before = readMemory();

    const g = new MemoryGovernor(
      { evict: () => { hog = null; }, onCeiling: () => {} },
      budget({ highWaterBytes: 1, ceilingBytes: Number.MAX_SAFE_INTEGER })
    );
    const out = g.check();

    expect(out.action).toBe('reclaimed');
    if (out.action === 'reclaimed') {
      expect(out.after.governedBytes).toBeLessThan(before.governedBytes);
    }
    expect(hog).toBeNull();
  });
});
