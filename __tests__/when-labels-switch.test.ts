/**
 * `CODEGRAPH_NO_WHEN_LABELS=1` turns off the only request-time source parsing
 * there is, trading the `WHEN` condition labels for the memory that parsing
 * permanently costs a long-lived server.
 *
 * The measurement behind it, on a 460k-node index (flink), six explores through a
 * real daemon with the page cache at 8 MB and mmap off — resident growth over the
 * daemon's own baseline:
 *
 *   WHEN on    162, 162, 170, 170, 171, 142 MB   (governor reclaims every call)
 *   WHEN off   never crossed the 100 MB mark      (governor never fired at all)
 *
 * and the answers stayed the same size to within the labels themselves (24958 →
 * 24928 bytes on two of six queries, byte-identical on the other four).
 *
 * Why parsing is the whole difference, and why it cannot be reclaimed instead:
 * WebAssembly memory is monotonic — `memory.grow` has no inverse. One explore
 * brings the tree-sitter runtime up, loads eight grammars and parses source, and
 * rss goes 220 → 320 MB; the second explore adds 1 MB, so it is a high-water, not
 * a leak. `resetParser`, `clearParserCache` and a full GC each measured 87 MB
 * before and after, and recycling the query worker thread does not help either
 * (168–177 MB steady whether the worker retires every call, every second call, or
 * never) because a terminated thread's pages stay with the process.
 *
 * Losing the labels is a supported state, not a broken one: a language with no
 * walk rules already yields no label rather than a wrong one.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const ENV = 'CODEGRAPH_NO_WHEN_LABELS';

/**
 * The flag is read ONCE at module load (an operator does not change it
 * mid-process, and the check sits on the per-edge path), so each case has to
 * re-import the module with the env already set. `vi.resetModules()` drops the
 * cached copy so the next import re-evaluates the top-level read.
 */
async function loadGuards(disabled: boolean) {
  if (disabled) process.env[ENV] = '1';
  else delete process.env[ENV];
  vi.resetModules();
  return import('../src/graph/branch-guards');
}

const original = process.env[ENV];

beforeEach(() => { delete process.env[ENV]; });
afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe('request-time parsing switch', () => {
  it('is ON by default, so WHEN labels keep working', async () => {
    const g = await loadGuards(false);
    expect(g.requestTimeParsingEnabled()).toBe(true);
    // TypeScript has walk rules, so it is supported when parsing is allowed.
    expect(g.supportsBranchGuards('typescript')).toBe(true);
  });

  it('reports no supported language at all when disabled', async () => {
    const g = await loadGuards(true);
    expect(g.requestTimeParsingEnabled()).toBe(false);
    for (const lang of ['typescript', 'javascript', 'java', 'python', 'go', 'swift']) {
      expect(g.supportsBranchGuards(lang)).toBe(false);
    }
  });

  it('a language without walk rules is unsupported either way', async () => {
    // The pre-existing contract: no rules yields nothing, never a wrong label.
    const on = await loadGuards(false);
    expect(on.supportsBranchGuards('rust')).toBe(false);
    const off = await loadGuards(true);
    expect(off.supportsBranchGuards('rust')).toBe(false);
  });

  it('warming grammars is a no-op when disabled — nothing is loaded to parse with', async () => {
    const g = await loadGuards(true);
    await expect(g.warmBranchGuardGrammars()).resolves.toBeUndefined();
  });

  it('guardsForFileSync yields nothing when disabled, without touching the file', async () => {
    const g = await loadGuards(true);
    const out = g.guardsForFileSync(
      '/definitely/not/a/real/path.ts',
      'typescript',
      [{ line: 1, column: 0 }] as never
    );
    expect(out.size).toBe(0);
  });

  it('an empty or other value leaves parsing enabled — only "1" disables', async () => {
    for (const v of ['', '0', 'true', 'yes']) {
      process.env[ENV] = v;
      vi.resetModules();
      const mod = await import('../src/graph/branch-guards');
      expect(mod.requestTimeParsingEnabled()).toBe(true);
    }
  });
});
