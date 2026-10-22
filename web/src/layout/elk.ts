import ELK, { type ElkNode, type ElkExtendedEdge, type LayoutOptions } from 'elkjs/lib/elk-api';
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';
import type { Scene, SceneNode } from './scene';

const elk = new ELK({ workerFactory: () => new ElkWorker() });

export interface Placement { x: number; y: number; width: number; height: number }

/**
 * Hierarchical layout, one algorithm per level:
 *  - every compound (root, lane, VPC, subnet) is laid out on its own
 *    (ELK's default SEPARATE_CHILDREN), so a plate's children never
 *    stretch into a single tall column just because they are unconnected;
 *  - relationships that cross plates are projected onto the deepest level
 *    where both ends are siblings, so connected plates still line up
 *    left → right (edge services → VPC → data);
 *  - children without any projected relationship are packed into an
 *    invisible `pack:` group laid out as a grid (rectpacking).
 * Returns positions relative to each node's parent, as React Flow expects.
 */
export async function layoutScene(scene: Scene): Promise<Map<string, Placement>> {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const kids = new Map<string | undefined, SceneNode[]>();
  for (const n of scene.nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);

  // ancestor chain root → node
  const chain = (id: string): string[] => {
    const out: string[] = [];
    let cur = byId.get(id);
    while (cur) { out.unshift(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  };

  // projected edges per level (keyed by parent id, 'root' for top level)
  const levelEdges = new Map<string, Map<string, [string, string]>>();
  for (const e of scene.edges) {
    const a = chain(e.source), b = chain(e.target);
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    const cs = a[i], ct = b[i];
    if (!cs || !ct || cs === ct) continue;
    const level = i === 0 ? 'root' : a[i - 1];
    const m = levelEdges.get(level) ?? new Map();
    m.set(`${cs}>${ct}`, [cs, ct]);
    levelEdges.set(level, m);
  }

  const build = (parentId: string | undefined): { children: ElkNode[]; edges: ElkExtendedEdge[] } => {
    const level = parentId ?? 'root';
    const members = kids.get(parentId) ?? [];
    const edges = [...(levelEdges.get(level)?.values() ?? [])];
    const connected = new Set(edges.flat());
    const toElk = (n: SceneNode): ElkNode => {
      if (n.kind !== 'plate') return { id: n.id, width: n.width, height: n.height };
      const inner = build(n.id);
      const isSubnet = n.node?.type === 'subnet';
      return {
        id: n.id,
        children: inner.children,
        edges: inner.edges,
        layoutOptions: isSubnet ? packOptions(2.6, 52) : layeredOptions(n.lane ? 44 : 52),
      };
    };
    const loose = members.filter((m) => !connected.has(m.id));
    const linked = members.filter((m) => connected.has(m.id));
    const children: ElkNode[] = linked.map(toElk);
    if (loose.length >= 3 && linked.length > 0) {
      children.push({ id: `pack:${level}`, children: loose.map(toElk), layoutOptions: packOptions(level === 'root' ? 1.2 : 2.2, 0) });
    } else {
      children.push(...loose.map(toElk));
    }
    return {
      children,
      edges: edges.map(([s, t]) => ({ id: `${level}|${s}>${t}`, sources: [s], targets: [t] })),
    };
  };

  const top = build(undefined);
  const root: ElkNode = {
    id: 'root',
    layoutOptions: { ...layeredOptions(0), 'elk.spacing.nodeNode': '64', 'elk.layered.spacing.nodeNodeBetweenLayers': '140', 'elk.spacing.componentComponent': '96' },
    children: top.children.length > 1 && !top.edges.length ? [{ id: 'pack:root', children: top.children, layoutOptions: packOptions(1.4, 0) }] : top.children,
    edges: top.edges,
  };

  const out = await elk.layout(root);
  const placements = new Map<string, Placement>();
  // Flatten synthetic pack groups: their children become children of the pack's parent.
  const walk = (n: ElkNode, offset: { x: number; y: number }) => {
    for (const c of n.children ?? []) {
      const x = (c.x ?? 0) + offset.x, y = (c.y ?? 0) + offset.y;
      if (c.id.startsWith('pack:')) { walk(c, { x, y }); continue; }
      placements.set(c.id, { x, y, width: c.width ?? 0, height: c.height ?? 0 });
      walk(c, { x: 0, y: 0 });
    }
  };
  walk(out, { x: 0, y: 0 });
  return placements;
}

function layeredOptions(top: number): LayoutOptions {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.padding': `[top=${top},left=20,bottom=20,right=20]`,
    'elk.spacing.nodeNode': '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    'elk.spacing.componentComponent': '36',
    'elk.separateConnectedComponents': 'true',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.thoroughness': '5',
    'elk.edgeRouting': 'POLYLINE',
    // Long single layers (many siblings hanging off one hub) wrap into rows instead of one tall column
    'elk.layered.wrapping.strategy': 'MULTI_EDGE',
    'elk.layered.wrapping.multiEdge.improveCuts': 'true',
    'elk.aspectRatio': '1.8',
  };
}

function packOptions(aspectRatio: number, top: number): LayoutOptions {
  return {
    'elk.algorithm': 'org.eclipse.elk.rectpacking',
    'elk.aspectRatio': String(aspectRatio),
    'elk.padding': `[top=${top},left=${top ? 20 : 0},bottom=${top ? 20 : 0},right=${top ? 20 : 0}]`,
    'elk.spacing.nodeNode': '20',
    'elk.rectpacking.widthApproximation.optimizationGoal': 'ASPECT_RATIO_DRIVEN',
    'elk.contentAlignment': 'H_LEFT V_TOP',
  };
}
