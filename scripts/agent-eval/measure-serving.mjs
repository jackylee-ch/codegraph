#!/usr/bin/env node
/**
 * Measure a serving daemon's latency AND its real memory cost on one index.
 *
 * Both halves matter together: every latency number this project has regretted
 * came from tuning one while only assuming the other. So this reports median/p90
 * wall-clock, the physical footprint the OS actually charges (via `vmmap`, which
 * excludes clean file-backed pages), the governed reading the budget enforces on,
 * and the governor events in `daemon.log` — from ONE run, so they cannot drift.
 *
 * Usage:
 *   node scripts/agent-eval/measure-serving.mjs --root ~/Code/stczwd/flink --rounds 5
 * Env passthrough (CODEGRAPH_*) is inherited, so a config matrix is just a loop
 * in the caller with different env.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const root = path.resolve(argOf('--root', process.cwd()).replace(/^~/, process.env.HOME));
const rounds = Number(argOf('--rounds', '5'));

/** Four flow questions spanning different query shapes against the same index. */
const QUERIES = [
  'StreamExecutionEnvironment execute JobGraph',
  'CheckpointCoordinator triggerCheckpoint PendingCheckpoint',
  'SourceOperator emitNext SourceReader pollNext',
  'JobMaster startScheduling SchedulerNG',
];

const cli = path.resolve(argOf('--cli', path.resolve(import.meta.dirname, '../../dist/bin/codegraph.js')));
const child = spawn(process.execPath, [cli, 'serve', '--mcp', '--path', root], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
});

let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});
child.stderr.on('data', () => {}); // the proxy chatters; daemon.log is the record

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 180_000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

/** Physical footprint in MB — what macOS actually charges the process. */
function footprintMb(pid) {
  try {
    const out = execFileSync('vmmap', ['-summary', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/Physical footprint:\s+([\d.]+)([KMG])/);
    if (!m) return null;
    const scale = { K: 1 / 1024, M: 1, G: 1024 }[m[2]];
    return Number(m[1]) * scale;
  } catch { return null; }
}

function daemonPid() {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8')).pid; }
  catch { return null; }
}

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

(async () => {
  await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'measure-serving', version: '0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const logPath = path.join(root, '.codegraph', 'daemon.log');
  const logBefore = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  // Footprint BEFORE any tool call, so startup cost and per-call growth can be told
  // apart. A steady-state number that is mostly startup is not fixable in the
  // serving path, and vice versa — assuming either way has cost this branch time.
  let idleFootprint = null;
  for (let i = 0; i < 20 && idleFootprint === null; i++) {
    const pid = daemonPid();
    if (pid) idleFootprint = footprintMb(pid);
    if (idleFootprint === null) await new Promise((r) => setTimeout(r, 250));
  }
  process.stderr.write(`idle (0 calls): footprint ${idleFootprint ? idleFootprint.toFixed(1) : '?'}MB\n`);

  const times = [];
  const roundFootprints = [];
  let bytes = 0, peakFootprint = 0;
  for (let r = 0; r < rounds; r++) {
    for (const q of QUERIES) {
      const t0 = performance.now();
      const res = await rpc('tools/call', { name: 'codegraph_explore', arguments: { query: q } });
      const ms = performance.now() - t0;
      // Round 0 is warm-up: it pays grammar load and first-touch page faults.
      if (r > 0) { times.push(ms); bytes += JSON.stringify(res.result ?? {}).length; }
    }
    const pid = daemonPid();
    const fp = pid ? footprintMb(pid) : null;
    if (fp) peakFootprint = Math.max(peakFootprint, fp);
    if (fp) roundFootprints.push(Number(fp.toFixed(1)));
    process.stderr.write(`round ${r}${r === 0 ? ' (warmup)' : ''}: footprint ${fp ? fp.toFixed(1) : '?'}MB\n`);
  }

  const tail = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').slice(logBefore).split('\n').filter((l) => l.includes('memory'))
    : [];
  console.log(JSON.stringify({
    root, rounds, calls: times.length,
    medianMs: Math.round(pct(times, 0.5)), p90Ms: Math.round(pct(times, 0.9)),
    minMs: Math.round(Math.min(...times)), maxMs: Math.round(Math.max(...times)),
    peakFootprintMb: Number(peakFootprint.toFixed(1)),
    idleFootprintMb: idleFootprint === null ? null : Number(idleFootprint.toFixed(1)),
    perRoundFootprintMb: roundFootprints,
    responseBytes: bytes,
    governorLines: tail.length,
    governorSample: tail.slice(-4),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CODEGRAPH_'))),
  }, null, 2));
  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); child.kill(); process.exit(1); });
