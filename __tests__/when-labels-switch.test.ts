/**
 * Request-time source parsing is **OFF by default**, and `CODEGRAPH_WHEN_LABELS=1`
 * buys it back.
 *
 * It is the only request-time parsing there is, and it pays for the `WHEN` condition
 * labels, call-argument shapes, and the Steps/Screens derivations that read call
 * sites. Measured on flink (16,633 files / 460,106 nodes), same queries and same
 * index, physical footprint:
 *
 *   parsing on    276.4 MB
 *   parsing off   200.3 MB
 *
 * 76 MB — the difference between holding a 150 MB steady budget and missing it by a
 * third. Why it cannot be reclaimed instead: WebAssembly memory is monotonic
 * (`memory.grow` has no inverse). One explore brings the tree-sitter runtime up,
 * loads eight grammars and parses source, and rss goes 220 -> 320 MB; the second
 * explore adds 1 MB, so it is a high-water, not a leak. `resetParser`,
 * `clearParserCache` and a full GC each measured 87 MB before and after, and
 * recycling the query worker thread does not help either (168–177 MB steady whether
 * the worker retires every call, every second call, or never) because a terminated
 * thread's pages stay with the process.
 *
 * Losing the labels is a supported state, not a broken one: a language with no walk
 * rules already yields no label rather than a wrong one, so the output shape does not
 * change — one optional annotation is absent.
 *
 * NOTE: `vitest.config.mts` sets `CODEGRAPH_WHEN_LABELS=1` for the whole suite, because
 * the several hundred tests that assert what the feature PRODUCES need it on. This file
 * is the one that clears it, so the shipped DEFAULT cannot hide behind that line.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const ON = 'CODEGRAPH_WHEN_LABELS';
const OFF = 'CODEGRAPH_NO_WHEN_LABELS';

/**
 * Both flags are read ONCE at module load (an operator does not change them
 * mid-process, and the check sits on the per-edge path), so each case has to
 * re-import the module with the env already set. `vi.resetModules()` drops the
 * cached copy so the next import re-evaluates the top-level read.
 */
async function loadGuards(env: Record<string, string | undefined>) {
  for (const k of [ON, OFF]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  vi.resetModules();
  return import('../src/graph/branch-guards');
}

const originals = { [ON]: process.env[ON], [OFF]: process.env[OFF] };

beforeEach(() => { delete process.env[ON]; delete process.env[OFF]; });
afterEach(() => {
  for (const [k, v] of Object.entries(originals)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('request-time parsing switch', () => {
  it('is OFF by default — the budget comes first', async () => {
    const g = await loadGuards({});
    expect(g.requestTimeParsingEnabled()).toBe(false);
    // Not "unsupported language": nothing is supported, because nothing parses.
    for (const lang of ['typescript', 'javascript', 'java', 'python', 'go', 'swift']) {
      expect(g.supportsBranchGuards(lang)).toBe(false);
    }
  });

  it('CODEGRAPH_WHEN_LABELS=1 buys the labels back', async () => {
    const g = await loadGuards({ [ON]: '1' });
    expect(g.requestTimeParsingEnabled()).toBe(true);
    // TypeScript has walk rules, so it is supported once parsing is allowed.
    expect(g.supportsBranchGuards('typescript')).toBe(true);
  });

  it('the old opt-out still wins, so anything that set it keeps working', async () => {
    const g = await loadGuards({ [ON]: '1', [OFF]: '1' });
    expect(g.requestTimeParsingEnabled()).toBe(false);
  });

  it('only "1" enables — a stray value does not silently cost 76 MB', async () => {
    for (const v of ['', '0', 'true', 'yes']) {
      const g = await loadGuards({ [ON]: v });
      expect(g.requestTimeParsingEnabled()).toBe(false);
    }
  });

  it('a language without walk rules is unsupported either way', async () => {
    // The pre-existing contract: no rules yields nothing, never a wrong label.
    const on = await loadGuards({ [ON]: '1' });
    expect(on.supportsBranchGuards('rust')).toBe(false);
    const off = await loadGuards({});
    expect(off.supportsBranchGuards('rust')).toBe(false);
  });

  it('warming grammars is a no-op when off — nothing is loaded to parse with', async () => {
    const g = await loadGuards({});
    await expect(g.warmBranchGuardGrammars()).resolves.toBeUndefined();
  });

  it('guardsForFileSync yields nothing when off, without touching the file', async () => {
    const g = await loadGuards({});
    const out = g.guardsForFileSync(
      '/definitely/not/a/real/path.ts',
      'typescript',
      [{ line: 1, column: 0 }] as never
    );
    expect(out.size).toBe(0);
  });
});
