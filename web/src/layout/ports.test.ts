import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignPorts } from './ports';
import type { Placement } from './elk';

const at = (x: number, y: number, width = 200, height = 60): Placement => ({ x, y, width, height });
const edge = (source: string, target: string) => ({ id: `${source}>${target}`, source, target });
function ports(boxes: Record<string, Placement & { parentId?: string }>, edges: { id: string; source: string; target: string }[]) {
  const nodes = Object.entries(boxes).map(([id, b]) => ({ id, parentId: b.parentId }));
  return assignPorts({ nodes, edges }, new Map(Object.entries(boxes)));
}

test('a line to something on the right leaves right and enters left', () => {
  const p = ports({ a: at(0, 0), b: at(400, 0) }, [edge('a', 'b')]).get('a>b');
  assert.deepEqual(p, { sourceSide: 'right', targetSide: 'left', sourcePort: 0.5, targetPort: 0.5 });
});

test('a line to something on the left leaves left instead of looping round', () => {
  const p = ports({ a: at(400, 0), b: at(0, 0) }, [edge('a', 'b')]).get('a>b');
  assert.equal(p?.sourceSide, 'left');
  assert.equal(p?.targetSide, 'right');
});

test('ends stacked in one column both use the right side', () => {
  const p = ports({ a: at(0, 0), b: at(0, 200) }, [edge('a', 'b')]).get('a>b');
  assert.equal(p?.sourceSide, 'right');
  assert.equal(p?.targetSide, 'right');
});

test('positions are absolute through parent plates', () => {
  // b sits at x=0 inside a plate placed at x=600, so it is to the right of a
  const p = ports({ plate: at(600, 0, 300, 300), a: at(0, 0), b: { ...at(0, 0), parentId: 'plate' } }, [edge('a', 'b')]).get('a>b');
  assert.equal(p?.sourceSide, 'right');
});

test('several lines on one side spread out, ordered by the other end', () => {
  const m = ports({ a: at(0, 200), hi: at(400, 0), mid: at(400, 200), lo: at(400, 400) }, [edge('a', 'lo'), edge('a', 'hi'), edge('a', 'mid')]);
  const hi = m.get('a>hi')!.sourcePort, mid = m.get('a>mid')!.sourcePort, lo = m.get('a>lo')!.sourcePort;
  assert.ok(hi < mid && mid < lo, `${hi} < ${mid} < ${lo}`);
  assert.equal(mid, 0.5);
  assert.ok(hi > 0 && lo < 1);
  // each target has a single line on its left side
  assert.equal(m.get('a>hi')!.targetPort, 0.5);
});
