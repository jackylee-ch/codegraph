/**
 * The memory budget must not be wideable by configuration.
 *
 * This pins the fix for a real defect. An earlier revision subtracted the
 * *configured* SQLite `mmap_size` from the governed resident reading, reasoning
 * that a clean file-backed mapping is dirty=0 and excluded from the OS's physical
 * footprint. Both facts are true; the conclusion was not. With the default
 * `mmap_size` at 2 GB, `rssGrowthBytes` was zero for any growth short of 2 GB, so
 * the resident arm of the budget could not fire, `governedBytes` collapsed to the
 * committed JS heap — the term already measured to be innocent, since the growth
 * is native tree-sitter parsing that V8's counters cannot see — and the governor
 * reported "0 ceiling events" while watching the wrong arm. Raising `mmap_size`
 * raised the blind spot with it.
 *
 * Nothing threw and no test failed, because the failure mode of a budget that
 * cannot fire is silence. So the properties below are asserted directly:
 *
 *  1. the governed reading does not move when SQLite's knobs are turned up,
 *  2. cache+mmap are clamped into a share of the ceiling, so a mapping the budget
 *     could not pay for cannot be configured in the first place,
 *  3. the shipped defaults ARE the required numbers (150 MB steady / 200 MB
 *     ceiling) rather than looser numbers that measurements override on the
 *     command line.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  MEMORY_BUDGET_DEFAULTS,
  resolveMemoryBudget,
  readMemory,
  __setRssBaselineForTests,
} from '../src/mcp/memory-governor';
import { clampConnectionMemory, resolveConnectionMemory, CONNECTION_MEMORY_DEFAULTS } from '../src/db';

afterEach(() => {
  __setRssBaselineForTests(null);
});

describe('the budget is not wideable by configuration', () => {
  it('governed resident growth is rss minus baseline, with nothing subtracted', () => {
    __setRssBaselineForTests(0);
    const r = readMemory();
    // With a zero baseline, growth IS the resident set. Any allowance term would
    // show up here as a shortfall.
    expect(r.rssGrowthBytes).toBe(r.rssBytes);
  });

  it('turning SQLite mmap up does not shrink the governed reading', () => {
    __setRssBaselineForTests(0);
    const before = readMemory().rssGrowthBytes;
    process.env.CODEGRAPH_SQLITE_MMAP_MB = '4096';
    try {
      const after = readMemory().rssGrowthBytes;
      // rss can drift a little between two reads; an allowance would drop this by
      // gigabytes, so a tight tolerance separates the two cases unambiguously.
      expect(Math.abs(after - before)).toBeLessThan(16 * 1024 * 1024);
      expect(after).toBeGreaterThan(0);
    } finally {
      delete process.env.CODEGRAPH_SQLITE_MMAP_MB;
    }
  });

  it('governedBytes is the worse of the two arms, so neither alone can satisfy it', () => {
    __setRssBaselineForTests(0);
    const r = readMemory();
    expect(r.governedBytes).toBe(Math.max(r.committedJsBytes, r.rssGrowthBytes));
    // On a real process with a zero baseline the resident arm is the larger one;
    // if this ever inverts, the JS arm is no longer the slack one and the comment
    // in readMemory() needs rewriting.
    expect(r.governedBytes).toBe(r.rssGrowthBytes);
  });
});

describe('SQLite memory is clamped into the ceiling', () => {
  it('clamps a mapping no configuration should be able to ask for', () => {
    // The window is capped by a CONSTANT, not by a share of the ceiling: it is not
    // charged linearly (mmap=0 measured WORSE for footprint than mmap=64), so
    // modelling it as a linear cost would be modelling a cost that does not exist.
    // What the cap is for is the governed reading, which counts mapped pages the OS
    // does not charge — so the discrepancy has to be bounded by something no
    // configuration can raise.
    const got = clampConnectionMemory({ cacheMb: 4, mmapMb: 4096 }, 200);
    expect(got.clamped).toBe(true);
    expect(got.mmapMb).toBe(128);
    expect(got.cacheMb).toBe(4);
  });

  it('clamps the page cache to a share of the ceiling, because that one IS linear', () => {
    // Real dirty memory in malloc arenas: measured `MALLOC_SMALL` 104.9 MB dirty at
    // a 64 MB cache.
    const got = clampConnectionMemory({ cacheMb: 999, mmapMb: 0 }, 200);
    expect(got.cacheMb).toBe(50);
    expect(got.mmapMb).toBe(0);
  });

  it('scales the cache with the ceiling rather than a fixed number', () => {
    expect(clampConnectionMemory({ cacheMb: 999, mmapMb: 0 }, 400).cacheMb).toBe(100);
    expect(clampConnectionMemory({ cacheMb: 999, mmapMb: 0 }, 100).cacheMb).toBe(25);
  });

  it('does not let a bigger ceiling raise the mmap cap', () => {
    // Otherwise the bound on the governed reading's blind spot would be negotiable
    // again, just one level up.
    expect(clampConnectionMemory({ cacheMb: 0, mmapMb: 4096 }, 8192).mmapMb).toBe(128);
  });

  it('leaves a request that already fits completely alone', () => {
    const req = { cacheMb: 4, mmapMb: 64 };
    expect(clampConnectionMemory(req, 200)).toEqual({ ...req, clamped: false });
  });

  it('treats 0 as a legal setting for either knob', () => {
    expect(clampConnectionMemory({ cacheMb: 0, mmapMb: 0 }, 200))
      .toEqual({ cacheMb: 0, mmapMb: 0, clamped: false });
  });

  it('does not clamp its own defaults — a default that gets reduced is a default that lies', () => {
    const resolved = resolveConnectionMemory({});
    expect(resolved.cacheMb).toBe(CONNECTION_MEMORY_DEFAULTS.CACHE_MB);
    expect(resolved.mmapMb).toBe(CONNECTION_MEMORY_DEFAULTS.MMAP_MB);
  });

  it('assumes the same ceiling the governor defaults to', () => {
    // db/ must not import mcp/, so the ceiling is duplicated as a constant there.
    // This is the pin that keeps the two from drifting apart.
    const implicit = resolveConnectionMemory({ CODEGRAPH_SQLITE_MMAP_MB: '4096' });
    const explicit = resolveConnectionMemory({
      CODEGRAPH_SQLITE_MMAP_MB: '4096',
      CODEGRAPH_MEMORY_CEILING_MB: String(MEMORY_BUDGET_DEFAULTS.CEILING_MB),
    });
    expect(implicit).toEqual(explicit);
  });
});

describe('the shipped defaults are the required numbers', () => {
  it('defaults to 150 MB steady and a 200 MB ceiling', () => {
    expect(MEMORY_BUDGET_DEFAULTS.HIGH_WATER_MB).toBe(150);
    expect(MEMORY_BUDGET_DEFAULTS.CEILING_MB).toBe(200);
  });

  it('resolves those defaults with no environment help at all', () => {
    // The earlier revision shipped 384/512 and only reached 100/200 by passing
    // overrides on the measurement command line, so the enforced budget and the
    // reported budget were different numbers.
    const b = resolveMemoryBudget({});
    expect(b.enabled).toBe(true);
    expect(b.highWaterBytes).toBe(150 * 1024 * 1024);
    expect(b.ceilingBytes).toBe(200 * 1024 * 1024);
  });
});
