/**
 * A memory-ceiling restart must not become a restart LOOP.
 *
 * A per-process breach counter cannot see one: each fresh daemon breaches once,
 * asks to be replaced, exits, and the replacement starts with a clean counter.
 * Measured on a 460k-node index with a 200 MB ceiling, that is exactly what
 * happened — every process restarted on its first tool call, because the least
 * that process reaches after evict + a double GC is ~257 MB.
 *
 * So the fact is persisted beside the index and handed back to the next
 * governor, which then reclaims on every call but never asks to restart again and
 * says once that the budget is below the floor. Quietly widening the budget
 * instead would be the tool overriding a number the operator set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordMemoryRestart,
  memoryRestartSuppressed,
  clearMemoryRestartRecord,
  MEMORY_RESTART_SUPPRESSION_MS,
} from '../src/mcp/memory-restart-record';
import { MemoryGovernor, MEMORY_BUDGET_DEFAULTS } from '../src/mcp/memory-governor';

const MB = 1024 * 1024;
const CEILING = 200 * MB;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-memrestart-'));
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory restart record', () => {
  it('reports not-suppressed when no restart has happened', () => {
    expect(memoryRestartSuppressed(root, CEILING)).toBe(false);
  });

  it('suppresses a second restart for the same ceiling', () => {
    recordMemoryRestart(root, CEILING, 257 * MB);
    expect(memoryRestartSuppressed(root, CEILING)).toBe(true);
  });

  it('does NOT suppress when the operator changed the ceiling', () => {
    // Raising the budget must take effect immediately rather than being
    // suppressed by a record written under the old, unreachable number.
    recordMemoryRestart(root, CEILING, 257 * MB);
    expect(memoryRestartSuppressed(root, 512 * MB)).toBe(false);
  });

  it('expires, so a genuine one-off spike can restart again later', () => {
    recordMemoryRestart(root, CEILING, 257 * MB);
    const later = Date.now() + MEMORY_RESTART_SUPPRESSION_MS + 1000;
    expect(memoryRestartSuppressed(root, CEILING, later)).toBe(false);
  });

  it('treats a malformed or absent record as absent rather than throwing', () => {
    fs.writeFileSync(path.join(root, '.codegraph', 'memory-restart.json'), 'not json');
    expect(() => memoryRestartSuppressed(root, CEILING)).not.toThrow();
    expect(memoryRestartSuppressed(root, CEILING)).toBe(false);
    clearMemoryRestartRecord(root);
    expect(memoryRestartSuppressed(root, CEILING)).toBe(false);
  });

  it('clearing gives the budget a fresh chance', () => {
    recordMemoryRestart(root, CEILING, 257 * MB);
    clearMemoryRestartRecord(root);
    expect(memoryRestartSuppressed(root, CEILING)).toBe(false);
  });
});

describe('a governor constructed after a suppressed restart', () => {
  it('never asks to restart, but still reclaims', () => {
    const lines: string[] = [];
    let restarts = 0;
    const g = new MemoryGovernor(
      { evict: () => {}, onCeiling: () => { restarts++; }, log: (l) => lines.push(l) },
      { enabled: true, highWaterBytes: 1, ceilingBytes: 1 },
      true // a restart for this ceiling already happened
    );
    expect(g.restartsDisabled).toBe(true);
    for (let i = 0; i < 3; i++) expect(g.check().action).toBe('ceiling');
    expect(restarts).toBe(0);
    expect(lines.filter((l) => l.startsWith('reclaim:')).length).toBe(3);
    expect(lines.filter((l) => l.startsWith('budget below floor')).length).toBe(1);
  });

  it('a first-run governor DOES ask once', () => {
    let restarts = 0;
    const g = new MemoryGovernor(
      { evict: () => {}, onCeiling: () => { restarts++; } },
      { enabled: true, highWaterBytes: 1, ceilingBytes: 1 },
      false
    );
    expect(g.restartsDisabled).toBe(false);
    g.check();
    expect(restarts).toBe(1);
    // …and the per-process counter still guards against repeat asks in-process.
    for (let i = 0; i < MEMORY_BUDGET_DEFAULTS.MAX_CONSECUTIVE_CEILINGS + 2; i++) g.check();
    expect(restarts).toBe(1);
  });
});
