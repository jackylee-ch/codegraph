/**
 * Query pool — runs CPU-heavy read-tool calls on a pool of worker threads so
 * the shared daemon's main event loop stays free for the MCP transport.
 *
 * Why this exists: see {@link ./query-worker}. One daemon, one event loop, one
 * synchronous SQLite connection serializes every concurrent `codegraph_explore`
 * AND starves the transport (a 10-way wave delivered 0 transport heartbeats in
 * 25s — responses can't flush until the whole batch drains, so clients time
 * out). Spreading the dispatch across worker threads (each its own WAL read
 * connection) restores true multi-core parallelism and an idle main loop.
 *
 * Properties:
 *   - lazy growth: one warm worker on construct, grows to `size` on demand, so a
 *     single-agent session pays for one connection and a 10-subagent burst grows
 *     to the core budget.
 *   - crash recovery: a dead worker is respawned and its in-flight call retried
 *     once; a poison call that keeps crashing fails gracefully (never wedges the
 *     pool). A crash budget trips a circuit breaker (`healthy` → false) so the
 *     caller falls back to in-process dispatch instead of thrashing respawns.
 *   - graceful backstop: a call that can't be served within `softTimeoutMs`
 *     resolves with SUCCESS-shaped "busy, retry" guidance — never `isError`, so
 *     a momentary overload can't teach the agent to abandon codegraph — instead
 *     of hanging past the client's hard timeout.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import type { ToolResult } from './tools';

/** Compiled sibling — `query-worker.js` lives next to this file in `dist/mcp/`. */
const WORKER_FILE = path.join(__dirname, 'query-worker.js');

/**
 * Minimal worker surface the pool drives — satisfied by a real `worker_threads`
 * Worker. Abstracted so tests can inject a fake worker and exercise the pool's
 * queue / growth / crash-recovery / backstop logic without spawning threads or
 * needing a built `dist/`.
 */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', cb: (m: unknown) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
}

/** Default linger before a queued call is answered with busy-guidance. */
const DEFAULT_BUSY_TIMEOUT_MS = 45_000; // < the ~60s MCP client request timeout

/** Hard ceiling on pool size regardless of core count / env. */
const MAX_POOL_SIZE = 16;

/**
 * Total worker deaths before the pool declares itself unhealthy and the caller
 * reverts to in-process dispatch. High enough to ride out a few transient
 * crashes, low enough that a systematically-broken worker (e.g. a platform that
 * can't spawn threads) degrades quickly instead of respawning forever.
 */
const CRASH_BUDGET = 12;

/**
 * Calls a worker serves before it is retired and replaced.
 *
 * This is the serving-side counterpart to the indexer's parse-worker recycle
 * (extraction/index.ts recycles every 250 parses). Both exist for the same
 * reason: **WebAssembly memory is monotonic.** `memory.grow` has no inverse, so a
 * thread that has parsed source carries that high-water for as long as it lives —
 * measured on a 460k-node index, one explore brings the tree-sitter runtime up,
 * loads eight grammars and parses source for the WHEN labels, and rss goes
 * 220 MB → 320 MB. The second explore adds 1 MB: it is a high-water, not a leak.
 * Nothing in-process returns it — `resetParser`, `clearParserCache` and a full GC
 * were all measured at 87 MB before and after.
 *
 * Terminating the thread DOES return it, because the whole isolate goes away. So
 * the only way a long-lived server keeps a bounded footprint while still parsing
 * at request time is to do that parsing in a thread it is willing to replace.
 *
 * 100 rather than the indexer's 250: a query worker's calls are far heavier than
 * a single file parse (each explore parses several files), and a serving process
 * is judged on steady footprint where the indexer is judged on throughput. Set
 * `CODEGRAPH_QUERY_WORKER_MAX_CALLS=0` to disable recycling.
 */
const DEFAULT_WORKER_MAX_CALLS = 100;

/** Resolve the per-worker call budget; 0 (or a malformed value) disables recycling. */
export function resolveWorkerMaxCalls(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WORKER_MAX_CALLS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_WORKER_MAX_CALLS;
  return n;
}

/**
 * Max workers cold-starting at once. A worker's cold start is heavy — full
 * module load (tree-sitter etc.) + opening a large WAL DB — and starting the
 * whole pool simultaneously thrashes CPU/I-O so badly it can stall the daemon's
 * main loop for tens of seconds. Warming a couple at a time keeps each start
 * fast; as one reports ready the next begins, so the pool still reaches full
 * size within a few calls of a burst, just without the thundering herd.
 */
const MAX_CONCURRENT_SPAWN = 2;

/** Shape of a message a worker posts back (ready handshake or a tool result). */
interface WorkerMessage {
  type?: string;
  ok?: boolean;
  id?: number;
  result?: ToolResult;
}

interface Job {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  resolve: (r: ToolResult) => void;
  retries: number;
  settled: boolean;
  enqueuedAt: number;
  softTimer?: NodeJS.Timeout;
}

export interface QueryPoolOptions {
  /** Default project root each worker opens at spawn. */
  root: string;
  /** Max worker threads. Defaults to `clamp(cores-1, 1, 16)`. */
  size?: number;
  /** Linger before a queued call gets busy-guidance. Default 45s. */
  softTimeoutMs?: number;
  /** Retries for an in-flight call whose worker crashed. Default 1. */
  maxRetries?: number;
  /**
   * Calls a worker serves before it is retired and replaced. Default 100
   * (`CODEGRAPH_QUERY_WORKER_MAX_CALLS`); 0 disables recycling.
   * See DEFAULT_WORKER_MAX_CALLS for why this exists.
   */
  workerMaxCalls?: number;
  /** Worker factory (tests inject a fake). Defaults to a real `worker_threads` Worker. */
  createWorker?: () => PoolWorker;
}

/**
 * Resolve the pool size from the `CODEGRAPH_QUERY_POOL_SIZE` override and the
 * machine's core count. `0` (or a negative) explicitly disables the pool (the
 * caller serves in-process — today's behavior). Unset → `clamp(cores-1, 1, 16)`:
 * leave a core for the main loop + OS, but never zero, since even one worker
 * frees the transport and lets responses flush incrementally.
 */
export function resolvePoolSize(envVal: string | undefined, cpuCount: number): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), MAX_POOL_SIZE);
    // non-numeric / negative → fall through to the default
  }
  return Math.max(1, Math.min(cpuCount - 1, MAX_POOL_SIZE));
}

function resolveBusyTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_QUERY_BUSY_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_BUSY_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.floor(n);
}

/** Success-shaped overload guidance (NEVER isError — see the abandonment rule). */
function busyGuidance(waitedMs: number): ToolResult {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  return {
    content: [{
      type: 'text',
      text:
        `CodeGraph is busy serving other concurrent requests right now (this call waited ${secs}s in the queue). ` +
        `This is NOT an error and the index is fine — wait a few seconds and retry this exact call; it will return normally. ` +
        `If you can't wait, use your built-in tools for just this one step.`,
    }],
  };
}

export class QueryPool {
  private idle: PoolWorker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<PoolWorker, Job>();
  private workers = new Set<PoolWorker>();
  // Workers spawned but not yet 'ready'. Growth must count these so a single
  // first call (with the eager worker still starting) doesn't spawn the WHOLE
  // pool at once — N simultaneous cold worker starts (each a full module load +
  // a large DB open) saturate the box and starve the main loop. Grow only when
  // the queue outstrips idle + pending.
  private pendingWorkers = new Set<PoolWorker>();
  private nextId = 1;
  private totalCrashes = 0;
  private destroyed = false;
  /** Calls each live worker has served, for the recycle budget. */
  private callsServed = new Map<PoolWorker, number>();
  private readonly workerMaxCalls: number;
  private readonly root: string;
  private readonly maxSize: number;
  private readonly softTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly createWorker: () => PoolWorker;

  constructor(opts: QueryPoolOptions) {
    this.root = opts.root;
    this.maxSize = Math.max(1, Math.min(opts.size ?? Math.max(1, os.cpus().length - 1), MAX_POOL_SIZE));
    this.softTimeoutMs = opts.softTimeoutMs ?? resolveBusyTimeoutMs();
    this.maxRetries = opts.maxRetries ?? 1;
    this.workerMaxCalls = opts.workerMaxCalls ?? resolveWorkerMaxCalls(process.env.CODEGRAPH_QUERY_WORKER_MAX_CALLS);
    this.createWorker = opts.createWorker ?? (() => new Worker(WORKER_FILE, { workerData: { root: this.root } }));
    this.spawnOne(); // one eager warm worker, ready for the first call
  }

  /** Pool size cap (for logging/status). */
  get size(): number { return this.maxSize; }

  /** Live worker count (for tests/status). */
  get liveWorkers(): number { return this.workers.size; }

  /**
   * False once the crash budget is exhausted (or after destroy). The ToolHandler
   * checks this and falls back to in-process dispatch — a broken worker platform
   * degrades to today's behavior instead of failing tool calls.
   */
  get healthy(): boolean {
    return !this.destroyed && this.totalCrashes < CRASH_BUDGET;
  }

  /**
   * True once at least one worker has completed its cold start (posted the
   * 'ready' handshake). Until then the ToolHandler serves calls IN-PROCESS:
   * a worker cold start is a full module load + DB open — seconds normally,
   * tens of seconds on a loaded machine — and a call queued behind it gets
   * nothing until the 45s busy backstop. The daemon's very first tool call
   * hitting that window was the recurring #662 test flake (and a real
   * first-call stall for agents). The pool exists for CONCURRENT load, which
   * by definition arrives after warm-up; the pre-pool in-process path is
   * strictly better while nothing is warm. Stays true for the pool's
   * lifetime — later crash-respawn gaps are covered by retry + backstop.
   */
  get ready(): boolean {
    return this.everReady && !this.destroyed;
  }
  private everReady = false;

  private spawnOne(): void {
    if (this.destroyed || this.workers.size >= this.maxSize) return;
    let w: PoolWorker;
    try {
      w = this.createWorker();
    } catch {
      this.totalCrashes++; // counts toward the circuit breaker
      return;
    }
    this.workers.add(w);
    this.pendingWorkers.add(w);
    w.on('message', (m) => this.onMessage(w, (m ?? {}) as WorkerMessage));
    w.on('error', () => this.onWorkerGone(w));
    w.on('exit', (code) => { if (code !== 0) this.onWorkerGone(w); });
  }

  private onMessage(w: PoolWorker, m: WorkerMessage): void {
    if (!m) return;
    if (m.type === 'ready') {
      this.pendingWorkers.delete(w);
      if (m.ok === false) this.totalCrashes++; // hard open failure
      else this.everReady = true;
      this.idle.push(w);
      this.drain();
      return;
    }
    if (m.type === 'result') {
      const job = this.inflight.get(w);
      this.inflight.delete(w);
      const retiring = this.shouldRetire(w);
      if (!retiring) this.idle.push(w);
      if (job) this.settle(job, m.result ?? busyGuidance(0));
      // Settle the caller BEFORE tearing the thread down: retirement is
      // bookkeeping and must never delay the answer that triggered it.
      if (retiring) this.retire(w);
      this.drain();
    }
  }

  /**
   * Has this worker served its call budget?
   *
   * Counted here rather than at dispatch so a worker is only ever retired between
   * calls, never mid-flight.
   */
  private shouldRetire(w: PoolWorker): boolean {
    if (this.destroyed || this.workerMaxCalls === 0) return false;
    const served = (this.callsServed.get(w) ?? 0) + 1;
    this.callsServed.set(w, served);
    return served >= this.workerMaxCalls;
  }

  /**
   * Replace a worker that has served its budget, to give back the WASM heap it
   * grew (see DEFAULT_WORKER_MAX_CALLS).
   *
   * Order matters: spawn the replacement first so a burst still has somewhere to
   * go, and do NOT count this as a crash — it is planned, and charging the crash
   * budget would eventually trip the circuit breaker and push every call back
   * in-process, which is the opposite of the intent. `onWorkerGone` is skipped
   * by removing the worker from `workers` before terminating it: its `exit`
   * handler then sees an unknown worker and returns.
   */
  private retire(w: PoolWorker): void {
    if (!this.workers.has(w)) return;
    this.workers.delete(w);
    this.pendingWorkers.delete(w);
    this.callsServed.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    if (!this.destroyed && this.workers.size + this.pendingWorkers.size < this.maxSize) {
      this.spawnOne();
    }
    try { void w.terminate(); } catch { /* already gone */ }
  }

  // A worker died (crash hook, OOM, segfault, exit≠0). Respawn a replacement and
  // retry its in-flight job once; a job that keeps crashing workers fails
  // gracefully so it can't loop the pool forever.
  private onWorkerGone(w: PoolWorker): void {
    if (!this.workers.has(w)) return; // already handled (error+exit both fire)
    this.workers.delete(w);
    this.pendingWorkers.delete(w);
    this.idle = this.idle.filter((x) => x !== w);
    this.totalCrashes++;
    const job = this.inflight.get(w);
    this.inflight.delete(w);
    try { void w.terminate(); } catch { /* already gone */ }
    if (this.healthy) this.spawnOne(); // keep capacity
    if (job) {
      if (job.retries < this.maxRetries && this.healthy) {
        job.retries++;
        this.queue.unshift(job); // head of line — retry promptly
      } else {
        this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph worker crashed; please retry the call.' }] });
      }
    }
    this.drain();
  }

  private drain(): void {
    // Grow toward maxSize while queued work outstrips workers that are idle OR
    // already on their way up (pending) — so we never spawn the whole pool for a
    // single call whose eager worker just hasn't reported ready yet.
    while (
      this.queue.length > this.idle.length + this.pendingWorkers.size &&
      this.workers.size < this.maxSize &&
      this.pendingWorkers.size < MAX_CONCURRENT_SPAWN &&
      this.healthy
    ) {
      this.spawnOne();
    }
    while (this.idle.length && this.queue.length) {
      // Skip jobs the backstop already answered.
      let job: Job | undefined;
      while (this.queue.length && (job = this.queue.shift()) && job.settled) job = undefined;
      if (!job || job.settled) break;
      const w = this.idle.pop()!;
      this.inflight.set(w, job);
      w.postMessage({ type: 'call', id: job.id, toolName: job.toolName, args: job.args });
    }
  }

  private settle(job: Job, result: ToolResult): void {
    if (job.settled) return; // already answered (by backstop or worker)
    job.settled = true;
    if (job.softTimer) clearTimeout(job.softTimer);
    job.resolve(result);
  }

  /** Run a read tool on the pool. Always resolves (never rejects). */
  run(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const job: Job = {
        id: this.nextId++, toolName, args, resolve,
        retries: 0, settled: false, enqueuedAt: Date.now(),
      };
      // Don't let the caller wait past softTimeoutMs. The worker may still be
      // busy (we can't cancel synchronous CPU), but the CLIENT gets a prompt,
      // success-shaped "retry" instead of a hard timeout.
      job.softTimer = setTimeout(() => {
        if (!job.settled) this.settle(job, busyGuidance(Date.now() - job.enqueuedAt));
      }, this.softTimeoutMs);
      job.softTimer.unref?.();
      this.queue.push(job);
      this.drain();
    });
  }

  /** Terminate all workers and answer any outstanding calls gracefully. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const ws = [...this.workers];
    this.workers.clear();
    this.pendingWorkers.clear();
    this.idle = [];
    for (const job of [...this.inflight.values(), ...this.queue]) {
      this.settle(job, { isError: true, content: [{ type: 'text', text: 'codegraph is shutting down; retry shortly.' }] });
    }
    this.inflight.clear();
    this.queue = [];
    await Promise.all(ws.map((w) => Promise.resolve(w.terminate()).catch(() => { /* already gone */ })));
  }
}
