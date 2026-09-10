/**
 * Cross-restart memory of "this project already restarted for the memory budget".
 *
 * A per-process breach counter cannot see a restart LOOP: each fresh daemon
 * breaches once, asks for a restart, exits, and the replacement starts with a
 * clean counter. Measured on flink with a 200 MB ceiling, that is exactly what
 * happened — every process restarted on its first tool call.
 *
 * So the fact is persisted next to the index. A daemon that finds a recent record
 * for the SAME ceiling starts with restarts already disabled: it still reclaims on
 * every call, but it stops asking to be replaced and says once that the budget is
 * below this process's floor. The alternative — quietly widening the budget —
 * would be the tool overriding a number the operator set.
 *
 * Keyed by ceiling so raising the budget is immediately effective rather than
 * being suppressed by an older record.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';

/** How long a restart record suppresses further restarts. */
export const MEMORY_RESTART_SUPPRESSION_MS = 10 * 60 * 1000;

const FILE = 'memory-restart.json';

interface RestartRecord {
  at: number;
  ceilingBytes: number;
  governedBytes: number;
}

function recordPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), FILE);
}

/**
 * Note that this project just restarted for the memory budget. Best-effort: a
 * failed write only costs the loop guard, and must never stop the shutdown it is
 * being called from.
 */
export function recordMemoryRestart(
  projectRoot: string,
  ceilingBytes: number,
  governedBytes: number
): void {
  try {
    const rec: RestartRecord = { at: Date.now(), ceilingBytes, governedBytes };
    fs.writeFileSync(recordPath(projectRoot), JSON.stringify(rec), { encoding: 'utf-8' });
  } catch {
    // Nothing to do — worst case the next process retries the restart once more.
  }
}

/**
 * Whether a restart for this ceiling happened recently enough to suppress another.
 * A record for a DIFFERENT ceiling is ignored (the operator changed the budget),
 * and an unreadable or malformed record is treated as absent.
 */
export function memoryRestartSuppressed(
  projectRoot: string,
  ceilingBytes: number,
  now: number = Date.now()
): boolean {
  try {
    const raw = fs.readFileSync(recordPath(projectRoot), 'utf-8');
    const rec = JSON.parse(raw) as Partial<RestartRecord>;
    if (typeof rec.at !== 'number' || typeof rec.ceilingBytes !== 'number') return false;
    if (rec.ceilingBytes !== ceilingBytes) return false;
    return now - rec.at < MEMORY_RESTART_SUPPRESSION_MS;
  } catch {
    return false;
  }
}

/** Forget the record — used when a budget change should get a fresh chance. */
export function clearMemoryRestartRecord(projectRoot: string): void {
  try {
    fs.unlinkSync(recordPath(projectRoot));
  } catch {
    // Absent is the desired state.
  }
}
