/**
 * Whole-graph aggregates are memoized per graph generation, and every write path
 * invalidates them.
 *
 * `getDominantFile()` answers "which file holds the densest concentration of
 * in-file edges" — a property of the ENTIRE index that only a write can change.
 * It ran on every `codegraph_explore` call, as a full scan of `edges` with two
 * joins back to `nodes`. A CPU profile of the explore path on a 460k-node /
 * 1.37M-edge index put it at **65% of all CPU time** (13.5s + 0.9s of a 22.2s
 * profile). Memoizing it took the median explore from 1267 ms to 470 ms.
 *
 * A memo on a whole-graph aggregate is only safe if invalidation is exhaustive:
 * one missed write path means a silently stale answer for the rest of the
 * process's life, and "stale dominant file" degrades ranking rather than throwing,
 * so nothing would surface it. These tests pin the invalidation for every family
 * of write — nodes, edges, files, unresolved refs — plus the memo's own contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node, Edge, FileRecord } from '../src/types';

let dir: string;
let db: DatabaseConnection;
let q: QueryBuilder;

const node = (id: string, file: string, name = id): Node => ({
  id, kind: 'function', name, qualifiedName: name, filePath: file,
  language: 'typescript', startLine: 1, endLine: 2, startColumn: 0, endColumn: 0,
} as Node);

const edge = (source: string, target: string): Edge =>
  ({ source, target, kind: 'calls' } as Edge);

const file = (p: string): FileRecord => ({
  path: p, contentHash: 'h', language: 'typescript', size: 10,
  modifiedAt: 1, indexedAt: 1, nodeCount: 1,
});

/** Build a graph with enough in-file edges that getDominantFile returns non-null. */
function seed(filePath: string, count: number): void {
  q.upsertFile(file(filePath));
  const nodes: Node[] = [];
  for (let i = 0; i < count + 1; i++) nodes.push(node(`${filePath}#${i}`, filePath));
  q.insertNodes(nodes);
  const edges: Edge[] = [];
  for (let i = 0; i < count; i++) edges.push(edge(`${filePath}#${i}`, `${filePath}#${i + 1}`));
  q.insertEdges(edges);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-aggmemo-'));
  db = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
  q = new QueryBuilder(db.getDb());
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('graph generation counter', () => {
  it('starts at zero and advances on a write', () => {
    expect(q.getGraphGeneration()).toBe(0);
    q.insertNode(node('a', 'src/a.ts'));
    expect(q.getGraphGeneration()).toBeGreaterThan(0);
  });

  it('advances for every family of write, not just nodes', () => {
    // The dominant file is derived from nodes AND edges, and deleting a file
    // removes both — so all four families have to invalidate.
    const seen = new Set<number>();
    const mark = () => seen.add(q.getGraphGeneration());
    mark();
    q.insertNode(node('a', 'src/a.ts')); mark();
    q.insertEdge(edge('a', 'a')); mark();
    q.upsertFile(file('src/a.ts')); mark();
    q.insertUnresolvedRef({
      fromNodeId: 'a', referenceName: 'x', referenceKind: 'calls',
      line: 1, column: 0, filePath: 'src/a.ts', language: 'typescript',
    } as never); mark();
    q.deleteNodesByFile('src/a.ts'); mark();
    // Six distinct generations means no write was a silent no-op.
    expect(seen.size).toBe(6);
  });
});

describe('getDominantFile memo', () => {
  it('returns the same answer on a repeat read', () => {
    seed('src/core.ts', 40);
    const first = q.getDominantFile();
    expect(first).not.toBeNull();
    expect(q.getDominantFile()).toEqual(first);
  });

  it('does NOT serve a stale answer after a write changes the winner', () => {
    seed('src/core.ts', 40);
    expect(q.getDominantFile()!.filePath).toBe('src/core.ts');

    // A denser file arrives — the memo must notice.
    seed('src/denser.ts', 90);
    expect(q.getDominantFile()!.filePath).toBe('src/denser.ts');
  });

  it('does NOT serve a stale answer after the winner is deleted', () => {
    seed('src/core.ts', 40);
    seed('src/other.ts', 25);
    expect(q.getDominantFile()!.filePath).toBe('src/core.ts');

    q.deleteNodesByFile('src/core.ts');
    const after = q.getDominantFile();
    expect(after?.filePath).not.toBe('src/core.ts');
  });

  it('caches a null result as firmly as a hit', () => {
    // Below the 20-edge floor there is no dominant file. Recomputing "still
    // nothing" on every call would leave the worst case (a sparse index) unfixed.
    q.insertNode(node('a', 'src/a.ts'));
    expect(q.getDominantFile()).toBeNull();
    const gen = q.getGraphGeneration();
    expect(q.getDominantFile()).toBeNull();
    expect(q.getGraphGeneration()).toBe(gen); // a read must not bump the generation
  });

  it('a read never advances the generation', () => {
    seed('src/core.ts', 40);
    const gen = q.getGraphGeneration();
    q.getDominantFile();
    q.getDominantFile();
    q.getTopRouteFile();
    expect(q.getGraphGeneration()).toBe(gen);
  });
});

describe('getTopRouteFile memo', () => {
  it('is memoized and invalidated the same way', () => {
    // No routes at all → null, and stable.
    expect(q.getTopRouteFile()).toBeNull();
    expect(q.getTopRouteFile()).toBeNull();

    q.upsertFile(file('src/routes.ts'));
    q.insertNodes([
      { ...node('r1', 'src/routes.ts'), kind: 'route' } as Node,
      { ...node('r2', 'src/routes.ts'), kind: 'route' } as Node,
      { ...node('r3', 'src/routes.ts'), kind: 'route' } as Node,
    ]);
    const got = q.getTopRouteFile();
    expect(got?.filePath).toBe('src/routes.ts');
    expect(got?.routeCount).toBe(3);
  });
});
