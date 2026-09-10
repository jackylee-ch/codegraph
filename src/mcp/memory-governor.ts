/**
 * Memory governor for the long-lived MCP server.
 *
 * The daemon is disk-backed by design — the graph lives in SQLite and queries
 * read rows out of it — but nothing in the process ever asked "how much am I
 * using?", so two things went unbounded in practice:
 *
 *  1. **Committed-but-free V8 pages.** Opening a large index allocates
 *     proportionally (measured: heapUsed 18 MB → 117 MB on a 460k-node index)
 *     and most of it is garbage the moment open finishes. With a live set far
 *     below any `--max-old-space-size`, V8 has no reason to collect and never
 *     returns the pages: a serve process sat at 201 MB physical footprint where
 *     one forced full GC took it to 62 MB, and it stayed there.
 *  2. **Reachable caches.** GC cannot touch those, so a GC alone leaves the
 *     per-query drift in place. They have to be EVICTED first — which is why
 *     `check()` evicts and only then collects. Doing it the other way round
 *     recovers the startup garbage and nothing else.
 *
 * Design notes worth keeping:
 *
 * - **Event-driven, never a timer.** A repeating interval would hold the event
 *   loop open and defeat the daemon's own idle-exit (and its 30-minute
 *   inactivity backstop). The server calls `check()` after a tool call
 *   completes — the moment memory has just moved and nobody is waiting on us.
 * - **Governed on what V8 has committed for us**, not on RSS. RSS counts the
 *   bundled runtime's ~395 MB of mapped, clean, shared mach-o text, which is not
 *   charged to the process and would blow any sane threshold on the first read.
 *   `total_heap_size` is the committed JS heap — precisely the part a compacting
 *   GC can hand back — plus external/ArrayBuffer bytes that a cache can pin.
 * - **`--expose-gc` is NOT on Node's NODE_OPTIONS allowlist**, so the flag cannot
 *   be passed in from the environment (a process started that way exits before
 *   running). The handle is obtained in-process instead, and the flag is turned
 *   back off immediately so nothing else can reach `global.gc`.
 */
import * as v8 from 'v8';
import { runInNewContext } from 'vm';

/** A reading of the memory this process has actually committed. */
export interface MemoryReading {
  /**
   * The number the budget is enforced against: the WORSE of the committed JS
   * heap and the resident-set growth over this process's own baseline.
   *
   * Two terms, because either one alone can be gamed:
   *  - Committed JS heap (`total_heap_size` + external + ArrayBuffer) catches
   *    V8 holding pages a GC could return, but is blind to everything native —
   *    most importantly SQLite's per-connection page cache and mmap window,
   *    which were measured at ~250 MB of the process while the JS heap read
   *    112 MB. Governing on JS alone would report success while the process cost
   *    three times the budget.
   *  - Resident growth over baseline catches exactly that native part. It is
   *    measured as a DELTA because absolute rss includes the bundled runtime's
   *    own mapped binary — clean, shared, `vmmap` dirty=0, not charged to the
   *    process — which is larger than any sane budget on its own and would make
   *    an absolute-rss budget unsatisfiable no matter what codegraph did.
   *
   * Taking the max means a budget can only be met by holding BOTH down.
   */
  governedBytes: number;
  /** Committed JS heap + external + ArrayBuffer bytes. */
  committedJsBytes: number;
  /** Resident growth over the baseline captured before any project was opened. */
  rssGrowthBytes: number;
  /** Live (reachable) JS bytes. `committed - live` is roughly what a GC can return. */
  liveBytes: number;
  /** Absolute resident set, for reporting only — it includes clean mapped binary. */
  rssBytes: number;
}

/** What `check()` decided to do. */
export type GovernorOutcome =
  | { action: 'ok'; before: MemoryReading }
  | { action: 'reclaimed'; before: MemoryReading; after: MemoryReading }
  | { action: 'ceiling'; before: MemoryReading; after: MemoryReading };

const MB = 1024 * 1024;

/**
 * Defaults.
 *
 * Set ABOVE this process's measured floor, deliberately. Measured on two indexes
 * of very different size (iceberg 215k nodes, flink 460k nodes), after evict + a
 * double GC, with SQLite's page cache at 8 MB and mmap off:
 *
 *   committed JS   106–114 MB
 *   rss growth     230–255 MB
 *
 * Both are nearly INDEPENDENT of index size, which is the signal that they are
 * the serving machinery — V8's committed heap and code space, node:sqlite,
 * the FTS5 query path — and not retained graph data. A budget below that floor
 * cannot be met by evicting or collecting, only by restarting, which is a restart
 * loop rather than a budget. So the defaults sit above it and catch genuine
 * growth; a tighter budget is available and honest, but the operator has to ask
 * for it knowing the floor (and `consecutiveCeilings` below stops the loop).
 */
export const MEMORY_BUDGET_DEFAULTS = {
  HIGH_WATER_MB: 384,
  CEILING_MB: 512,
  /**
   * Ceiling breaches in a row before the governor concludes the budget is below
   * the process floor and stops asking for restarts. Two is enough: one breach
   * can be a genuine spike, two in a row on a freshly restarted process means the
   * number is unreachable here.
   */
  MAX_CONSECUTIVE_CEILINGS: 2,
} as const;

export interface MemoryBudget {
  enabled: boolean;
  highWaterBytes: number;
  ceilingBytes: number;
}

/** Parse a positive-number env override; `undefined` for unset/malformed. */
function envPositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the budget from the environment.
 *
 * A ceiling at or below the high water mark would mean "reclaim, then
 * immediately self-destruct" on the very first trip, so the ceiling is floored
 * just above the high water mark rather than trusted blindly.
 */
export function resolveMemoryBudget(env: NodeJS.ProcessEnv = process.env): MemoryBudget {
  const highMb = envPositiveNumber(env.CODEGRAPH_MEMORY_HIGH_MB) ?? MEMORY_BUDGET_DEFAULTS.HIGH_WATER_MB;
  const rawCeilingMb = envPositiveNumber(env.CODEGRAPH_MEMORY_CEILING_MB) ?? MEMORY_BUDGET_DEFAULTS.CEILING_MB;
  return {
    enabled: env.CODEGRAPH_NO_MEMORY_GOVERNOR !== '1',
    highWaterBytes: highMb * MB,
    ceilingBytes: Math.max(rawCeilingMb, highMb * 1.1) * MB,
  };
}

/**
 * Resident-set baseline: what this process cost before it opened anything.
 *
 * Captured on first read rather than at import so it reflects a process that has
 * finished loading its modules. Everything above it is growth codegraph is
 * responsible for and can therefore be asked to give back.
 */
let rssBaselineBytes: number | null = null;

/** Capture (or re-capture) the resident baseline. Call before opening a project. */
export function captureRssBaseline(): number {
  rssBaselineBytes = process.memoryUsage().rss;
  return rssBaselineBytes;
}

/** Test seam: forget the baseline so a test can control it. */
export function __setRssBaselineForTests(bytes: number | null): void {
  rssBaselineBytes = bytes;
}

/** Read the current committed/live/resident numbers. */
export function readMemory(): MemoryReading {
  const h = v8.getHeapStatistics();
  const m = process.memoryUsage();
  if (rssBaselineBytes === null) rssBaselineBytes = m.rss;
  const committedJsBytes = h.total_heap_size + (h.external_memory ?? 0) + m.arrayBuffers;
  const rssGrowthBytes = Math.max(0, m.rss - rssBaselineBytes);
  return {
    governedBytes: Math.max(committedJsBytes, rssGrowthBytes),
    committedJsBytes,
    rssGrowthBytes,
    liveBytes: h.used_heap_size,
    rssBytes: m.rss,
  };
}

let gcHandle: (() => void) | null | undefined;

/**
 * A full-GC handle, or `null` when this runtime won't give one up.
 *
 * `global.gc` is used when the host already exposed it; otherwise the flag is
 * flipped on just long enough to capture the function and flipped straight back
 * off, so `global.gc` does not stay reachable for the rest of the process.
 * Memoized including the failure case — a runtime that refused once will refuse
 * again, and retrying on every tool call would be pure overhead.
 */
export function getGcHandle(): (() => void) | null {
  if (gcHandle !== undefined) return gcHandle;
  const existing = (globalThis as { gc?: () => void }).gc;
  if (typeof existing === 'function') {
    gcHandle = existing;
    return gcHandle;
  }
  try {
    v8.setFlagsFromString('--expose_gc');
    const fn = runInNewContext('gc') as unknown;
    gcHandle = typeof fn === 'function' ? (fn as () => void) : null;
  } catch {
    gcHandle = null;
  } finally {
    try {
      v8.setFlagsFromString('--no-expose_gc');
    } catch {
      // Best effort — leaving it exposed is harmless next to failing a tool call.
    }
  }
  return gcHandle;
}

/** Test seam: forget the memoized handle so a test can re-derive it. */
export function __resetGcHandleForTests(): void {
  gcHandle = undefined;
}

/** What the governor is allowed to do when memory is over the line. */
export interface MemoryGovernorHooks {
  /**
   * Drop what can be dropped: bounded caches down to their low-water marks and
   * cross-project connections nothing is using. Must be synchronous and must not
   * throw — it runs off the back of a completed tool call.
   */
  evict: () => void;
  /**
   * Last resort, called when memory is still past the ceiling after evict + GC.
   * The server's handler exits gracefully so the next request gets a fresh
   * process; a restart costs one cold start and is strictly better than drifting
   * past a budget the user set.
   */
  onCeiling: (reading: MemoryReading) => void;
  /** Optional structured log sink; defaults to stderr under CODEGRAPH_MCP_DEBUG. */
  log?: (line: string) => void;
}

const fmtMb = (bytes: number): string => `${Math.round(bytes / MB)}MB`;

/**
 * Enforces the per-process memory budget at tool-call boundaries.
 *
 * Deliberately holds no timer, no history and no state beyond the budget and the
 * hooks: a governor that accumulated its own bookkeeping would be one more thing
 * growing inside the process it is meant to bound.
 */
export class MemoryGovernor {
  private readonly budget: MemoryBudget;
  private ceilingFired = false;
  private consecutiveCeilings = 0;
  private budgetBelowFloor = false;
  private floorReported = false;

  constructor(
    private readonly hooks: MemoryGovernorHooks,
    budget: MemoryBudget = resolveMemoryBudget(),
    /**
     * True when a restart for THIS budget already happened recently on this
     * project. A per-process counter cannot see a cross-process restart loop —
     * each fresh daemon breaches once, restarts, and its counter resets — so the
     * daemon persists the fact and hands it back in. Starting in this state means
     * the governor still reclaims on every call but never asks to restart again.
     */
    alreadyRestartedForMemory = false
  ) {
    this.budget = budget;
    this.budgetBelowFloor = alreadyRestartedForMemory;
    if (alreadyRestartedForMemory) {
      this.consecutiveCeilings = MEMORY_BUDGET_DEFAULTS.MAX_CONSECUTIVE_CEILINGS + 1;
    }
  }

  get enabled(): boolean {
    return this.budget.enabled;
  }

  /** True when this governor has given up on restarting (budget below floor). */
  get restartsDisabled(): boolean {
    return this.budgetBelowFloor;
  }

  /**
   * Called after a tool call completes. Under the high-water mark this is two
   * cheap reads and nothing else, which is why it can sit on the hot path.
   *
   * Order is load-bearing: EVICT first so the cached objects become unreachable,
   * THEN collect so V8 actually hands the pages back. A GC before eviction can
   * only reclaim the startup garbage and leaves per-query drift untouched.
   */
  check(): GovernorOutcome {
    const before = readMemory();
    if (!this.budget.enabled || before.governedBytes < this.budget.highWaterBytes) {
      return { action: 'ok', before };
    }

    try {
      this.hooks.evict();
    } catch (err) {
      this.log(`evict hook threw (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }

    const gc = getGcHandle();
    if (gc) {
      try {
        // Twice: the first pass frees, the second lets V8 compact and release
        // the pages the first pass emptied.
        gc();
        gc();
      } catch {
        // A refused GC is not a reason to fail the request that triggered us.
      }
    }

    const after = readMemory();
    this.log(
      `reclaim: governed ${fmtMb(before.governedBytes)} -> ${fmtMb(after.governedBytes)} ` +
      `(js ${fmtMb(before.committedJsBytes)} -> ${fmtMb(after.committedJsBytes)}, ` +
      `rss+ ${fmtMb(before.rssGrowthBytes)} -> ${fmtMb(after.rssGrowthBytes)}, ` +
      `live ${fmtMb(before.liveBytes)} -> ${fmtMb(after.liveBytes)}, rss ${fmtMb(after.rssBytes)}), ` +
      `high ${fmtMb(this.budget.highWaterBytes)} ceiling ${fmtMb(this.budget.ceilingBytes)}` +
      (gc ? '' : ' [no gc handle]')
    );

    if (after.governedBytes >= this.budget.ceilingBytes) {
      this.consecutiveCeilings += 1;
      // A budget below this process's floor cannot be met by restarting — every
      // fresh process lands right back over the line. Say so once, plainly, and
      // stop asking: a restart loop serves nobody, and silently widening the
      // budget instead would be the tool deciding it knows better than the
      // operator. Reclaim still runs on every call, so memory is still held as
      // low as it can go; what stops is the self-destruct.
      if (this.consecutiveCeilings > MEMORY_BUDGET_DEFAULTS.MAX_CONSECUTIVE_CEILINGS) {
        if (!this.floorReported) {
          this.floorReported = true;
          this.log(
            `budget below floor: ${fmtMb(after.governedBytes)} is the least this process reaches ` +
            `after evict + gc, but the ceiling is ${fmtMb(this.budget.ceilingBytes)}. ` +
            'Restarting cannot fix that, so further ceiling breaches will not request one. ' +
            'Raise CODEGRAPH_MEMORY_CEILING_MB, or reduce the work per call ' +
            '(a smaller index root, or fewer files per explore).'
          );
        }
        return { action: 'ceiling', before, after };
      }
      // Fire once per process: a second call while it is already winding down
      // would just log noise, and the handler is expected to be idempotent.
      if (!this.ceilingFired) {
        this.ceilingFired = true;
        this.log(
          `ceiling: ${fmtMb(after.governedBytes)} still past ${fmtMb(this.budget.ceilingBytes)} ` +
          'after evict + gc — handing off for a graceful restart'
        );
        try {
          this.hooks.onCeiling(after);
        } catch (err) {
          this.log(`ceiling hook threw (ignored): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { action: 'ceiling', before, after };
    }

    this.consecutiveCeilings = 0;
    return { action: 'reclaimed', before, after };
  }

  private log(line: string): void {
    if (this.hooks.log) {
      this.hooks.log(line);
      return;
    }
    if (process.env.CODEGRAPH_MCP_DEBUG) {
      process.stderr.write(`[CodeGraph memory] ${line}\n`);
    }
  }
}
