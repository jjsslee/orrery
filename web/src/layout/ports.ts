import type { Placement } from './elk';

export type Side = 'left' | 'right';
export interface EdgePorts { sourceSide: Side; targetSide: Side; sourcePort: number; targetPort: number }

// Several lines on one side spread over the middle of the card, clear of its rounded corners.
const SPREAD_FROM = 0.28, SPREAD_TO = 0.72;

/**
 * Where each line leaves and enters its cards:
 *  - the side facing the other end, so a line to something on the left leaves
 *    from the left instead of looping round the card; ends stacked in one
 *    column both use the right side and bow out as a bracket instead of
 *    cutting through the cards between them;
 *  - several lines on one side spread along it, ordered by the other end's
 *    height so they do not cross, instead of meeting in one point.
 * Ports are fractions of the card height, so lines still follow a dragged card.
 */
export function assignPorts(
  scene: { nodes: { id: string; parentId?: string }[]; edges: { id: string; source: string; target: string }[] },
  placements: Map<string, Placement>,
): Map<string, EdgePorts> {
  const parentOf = new Map(scene.nodes.map((n) => [n.id, n.parentId]));
  const absolute = new Map<string, Placement>();
  const box = (id: string): Placement | undefined => {
    const hit = absolute.get(id);
    if (hit) return hit;
    const p = placements.get(id);
    if (!p) return undefined;
    const parentId = parentOf.get(id);
    const origin = parentId ? box(parentId) : undefined;
    const b = { ...p, x: p.x + (origin?.x ?? 0), y: p.y + (origin?.y ?? 0) };
    absolute.set(id, b);
    return b;
  };

  const sides = new Map<string, { sourceSide: Side; targetSide: Side }>();
  const slots = new Map<string, { edge: string; end: 'sourcePort' | 'targetPort'; otherY: number }[]>();
  const slot = (key: string, item: { edge: string; end: 'sourcePort' | 'targetPort'; otherY: number }) => slots.set(key, [...(slots.get(key) ?? []), item]);
  for (const e of scene.edges) {
    const s = box(e.source), t = box(e.target);
    if (!s || !t || e.source === e.target) continue;
    const sx = s.x + s.width / 2, tx = t.x + t.width / 2;
    const stacked = Math.abs(tx - sx) < (s.width + t.width) / 2;
    const sourceSide: Side = stacked || tx >= sx ? 'right' : 'left';
    const targetSide: Side = stacked || tx < sx ? 'right' : 'left';
    sides.set(e.id, { sourceSide, targetSide });
    slot(`${e.source}|${sourceSide}`, { edge: e.id, end: 'sourcePort', otherY: t.y + t.height / 2 });
    slot(`${e.target}|${targetSide}`, { edge: e.id, end: 'targetPort', otherY: s.y + s.height / 2 });
  }

  const out = new Map<string, EdgePorts>();
  for (const [id, side] of sides) out.set(id, { ...side, sourcePort: 0.5, targetPort: 0.5 });
  for (const list of slots.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.otherY - b.otherY);
    list.forEach((item, i) => { out.get(item.edge)![item.end] = SPREAD_FROM + ((SPREAD_TO - SPREAD_FROM) * i) / (list.length - 1); });
  }
  return out;
}
