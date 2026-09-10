/**
 * Query workers are RECYCLED after a call budget, so the WASM heap they grow does
 * not become the server's permanent floor.
 *
 * Why this exists at all: WebAssembly memory is monotonic — `memory.grow` has no
 * inverse. `codegraph_explore` parses source at request time (the WHEN labels), and
 * measured on a 460k-node index one explore brings the tree-sitter runtime up,
 * loads eight grammars and takes rss from 220 MB to 320 MB; the second explore adds
 * 1 MB, so it is a high-water, not a leak. Nothing in-process gives it back —
 * `resetParser`, `clearParserCache` and a full GC all measured 87 MB before and
 * after. Terminating the thread DOES, because the isolate goes with it.
 *
 * The indexer already solved the same problem the same way (parse workers recycle
 * every 250 parses). These tests pin the serving-side equivalent, with injected
 * fake workers so the scheduling is exercised without spawning threads.
 */
import { describe, it, expect } from 'vitest';
import { QueryPool, resolveWorkerMaxCalls, type PoolWorker } from '../src/mcp/query-pool';
import type { ToolResult } from '../src/mcp/tools';

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

/** Minimal worker that always answers, and records whether it was terminated. */
class CountingWorker implements PoolWorker {
  static spawned = 0;
  static terminated = 0;
  readonly id: number;
  calls = 0;
  alive = true;
  private msgCb?: (m: unknown) => void;
  private exitCb?: (code: number) => void;

  constructor() {
    this.id = ++CountingWorker.spawned;
    setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'ready', ok: true }); }, 0);
  }
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === 'message') this.msgCb = cb;
    else if (event === 'exit') this.exitCb = cb;
  }
  postMessage(msg: unknown): void {
    const m = msg as { type: string; id: number };
    if (!m || m.type !== 'call') return;
    this.calls += 1;
    setTimeout(() => { if (this.alive) this.msgCb?.({ type: 'result', id: m.id, result: ok(`w${this.id}`) }); }, 0);
  }
  terminate(): Promise<number> {
    if (this.alive) CountingWorker.terminated += 1;
    this.alive = false;
    // A real Worker emits 'exit' after terminate(); the pool must not treat a
    // planned retirement as a crash.
    setTimeout(() => this.exitCb?.(0), 0);
    return Promise.resolve(0);
  }
}

const reset = () => { CountingWorker.spawned = 0; CountingWorker.terminated = 0; };

describe('resolveWorkerMaxCalls', () => {
  it('defaults to 100', () => {
    expect(resolveWorkerMaxCalls(undefined)).toBe(100);
    expect(resolveWorkerMaxCalls('')).toBe(100);
  });

  it('honors an explicit budget', () => {
    expect(resolveWorkerMaxCalls('5')).toBe(5);
  });

  it('treats 0 as "never recycle"', () => {
    expect(resolveWorkerMaxCalls('0')).toBe(0);
  });

  it('ignores malformed values rather than disabling recycling by accident', () => {
    for (const bad of ['abc', '-1', '2.5', 'NaN']) {
      expect(resolveWorkerMaxCalls(bad)).toBe(100);
    }
  });
});

describe('QueryPool worker recycling', () => {
  it('retires a worker after its call budget and replaces it', async () => {
    reset();
    const pool = new QueryPool({
      root: '/x', size: 1, workerMaxCalls: 3,
      createWorker: () => new CountingWorker(),
    });
    for (let i = 0; i < 3; i++) {
      const r = await pool.run('codegraph_explore', { query: `q${i}` });
      expect(r.content[0].text).toBeTruthy();
    }
    // Third call hit the budget: that worker is gone and a replacement spawned.
    expect(CountingWorker.terminated).toBe(1);
    expect(CountingWorker.spawned).toBe(2);
    await pool.destroy();
  });

  it('keeps answering across several recycles', async () => {
    reset();
    const pool = new QueryPool({
      root: '/x', size: 1, workerMaxCalls: 2,
      createWorker: () => new CountingWorker(),
    });
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      seen.push((await pool.run('codegraph_explore', { query: `q${i}` })).content[0].text!);
    }
    expect(seen).toHaveLength(7);
    expect(seen.every((s) => /^w\d+$/.test(s))).toBe(true);
    // 7 calls at 2 per worker → 3 retirements, and the pool never ran dry.
    expect(CountingWorker.terminated).toBe(3);
    await pool.destroy();
  });

  it('a planned retirement is NOT charged to the crash budget', async () => {
    // Otherwise enough recycling would trip the circuit breaker and push every
    // call back in-process — the opposite of the intent.
    reset();
    const pool = new QueryPool({
      root: '/x', size: 1, workerMaxCalls: 1,
      createWorker: () => new CountingWorker(),
    });
    for (let i = 0; i < 20; i++) await pool.run('codegraph_explore', { query: `q${i}` });
    expect(pool.healthy).toBe(true);
    expect(CountingWorker.terminated).toBe(20);
    await pool.destroy();
  });

  it('workerMaxCalls=0 never retires', async () => {
    reset();
    const pool = new QueryPool({
      root: '/x', size: 1, workerMaxCalls: 0,
      createWorker: () => new CountingWorker(),
    });
    for (let i = 0; i < 12; i++) await pool.run('codegraph_explore', { query: `q${i}` });
    expect(CountingWorker.terminated).toBe(0);
    expect(CountingWorker.spawned).toBe(1);
    await pool.destroy();
  });

  it('settles the caller before tearing the thread down', async () => {
    // Retirement is bookkeeping; it must never delay the answer that triggered it.
    reset();
    const pool = new QueryPool({
      root: '/x', size: 1, workerMaxCalls: 1,
      createWorker: () => new CountingWorker(),
    });
    const res = await pool.run('codegraph_explore', { query: 'q' });
    expect(res.content[0].text).toBe('w1');
    await pool.destroy();
  });
});
