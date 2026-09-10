/**
 * Counting callers must not mean materializing them.
 *
 * Explore's centrality tiering wanted one number per candidate — how many
 * distinct things call this — and got it from `getCallers(id).length`, which
 * builds a full `Node` for every caller and then reads the array's length. On a
 * hub symbol that is hundreds of objects allocated and dropped per candidate, and
 * a query naming an overloaded symbol pays it once per namesake. That is native
 * allocation the process memory budget then has to account for.
 *
 * `countDistinctCallers` is one `COUNT(DISTINCT source)` aggregate over every
 * candidate at once. The invariant that makes the swap safe is that it returns the
 * SAME number, which is what this file pins — including the edge kinds, because a
 * count computed over a different kind set than the listing would make two
 * surfaces disagree about the same symbol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { CALLER_EDGE_KINDS } from '../src/types';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callercount-'));
  // A hub (`target`) called from several files, one file calling it twice, plus a
  // class that is instantiated (an `instantiates` caller) and a symbol nothing
  // calls at all.
  fs.writeFileSync(path.join(dir, 'hub.ts'), 'export function target(): number { return 1; }\nexport class Widget { build(): number { return 2; } }\nexport function lonely(): number { return 3; }\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), "import { target } from './hub';\nexport function callsOnce(): number { return target(); }\n");
  fs.writeFileSync(path.join(dir, 'b.ts'), "import { target } from './hub';\nexport function callsTwice(): number { return target() + target(); }\n");
  fs.writeFileSync(path.join(dir, 'c.ts'), "import { Widget } from './hub';\nexport function makes(): number { return new Widget().build(); }\n");
  cg = await CodeGraph.init(dir, { index: true });
  const s = cg.getStats();
  // Guard the fixture itself: if extraction produced nothing, every assertion
  // below would fail for a reason that has nothing to do with caller counting.
  if (s.nodeCount === 0) {
    throw new Error(`fixture did not index: ${JSON.stringify({ files: s.fileCount, nodes: s.nodeCount, edges: s.edgeCount })}`);
  }
}, 180_000);

afterAll(() => {
  cg?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const idOf = (name: string): string => {
  // searchNodes returns SearchResult (node + score), not Node.
  const hits = cg.searchNodes(name).map((r) => r.node).filter((n) => n.name === name);
  expect(hits.length).toBeGreaterThan(0);
  return hits[0]!.id;
};

describe('getCallerCounts matches getCallers().length', () => {
  it('agrees on a symbol with several callers, one of them calling twice', () => {
    const id = idOf('target');
    const listed = cg.getCallers(id).length;
    expect(cg.getCallerCounts([id]).get(id)).toBe(listed);
  });

  it('agrees on an instantiated class', () => {
    const id = idOf('Widget');
    const listed = cg.getCallers(id).length;
    expect(cg.getCallerCounts([id]).get(id)).toBe(listed);
  });

  it('omits a symbol nothing calls, rather than reporting 0', () => {
    // Same contract as countIncomingEdges: absent means "no matching edges", so a
    // caller can tell it apart from "not asked about".
    const id = idOf('lonely');
    expect(cg.getCallers(id).length).toBe(0);
    expect(cg.getCallerCounts([id]).has(id)).toBe(false);
  });

  it('answers many ids in one call, each matching its own listing', () => {
    const ids = ['target', 'Widget', 'lonely'].map(idOf);
    const counts = cg.getCallerCounts(ids);
    for (const id of ids) {
      expect(counts.get(id) ?? 0).toBe(cg.getCallers(id).length);
    }
  });

  it('is empty for an empty id list and for unknown ids', () => {
    expect(cg.getCallerCounts([]).size).toBe(0);
    expect(cg.getCallerCounts(['no-such-node']).size).toBe(0);
  });

  it('dedupes ids so a repeated id is not double counted', () => {
    const id = idOf('target');
    const counts = cg.getCallerCounts([id, id, id]);
    expect(counts.get(id)).toBe(cg.getCallers(id).length);
  });
});

describe('CALLER_EDGE_KINDS is the single source of truth', () => {
  it('names the kinds both the listing and the count use', () => {
    // Shared const rather than two literals: `instantiates` was added to the
    // listing for #774, and a count that missed it would under-report every class.
    expect([...CALLER_EDGE_KINDS]).toEqual([
      'calls',
      'references',
      'imports',
      'instantiates',
      'navigates',
    ]);
  });
});
