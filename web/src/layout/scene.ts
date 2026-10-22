import type { Category, EdgeKind, ResourceEdge, ResourceGraph, ResourceNode, ResourceType, Status } from '@orrery/shared';
import { CATEGORY_LABEL } from '@orrery/shared';
import { LIVE_EDGE_KINDS, TYPE_META } from '../model/types';
import type { Overlays } from '../model/store';
import { matchesTags, type TagFilter } from '../model/tags';

export interface SceneNode {
  id: string;
  kind: 'plate' | 'resource' | 'aggregate';
  parentId?: string;
  /** The underlying resource (plates for vpc/subnet, resources) */
  node?: ResourceNode;
  /** Regional lane plate */
  lane?: { category: Category; label: string };
  aggregate?: { type: ResourceType; count: number; members: ResourceNode[]; worst: Status; label: string; unlinked: boolean };
  depth: number;
  dim: boolean;
  traffic: number;
  width: number;
  height: number;
  /** Hidden by a filter but shown faintly because it neighbours the selected node */
  ghost?: boolean;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  status?: Status;
  traffic: number;
  live: boolean;
  dim: boolean;
  /** How many raw edges were folded into this one */
  count: number;
  /** Connects the selected node to a ghost neighbour */
  ghost?: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Node ids hidden by filters (not aggregated) */
  hidden: number;
  /** Visible resource count (individual + aggregated) */
  visible: number;
  /** Search hits that are hidden by a filter or a switched-off layer */
  hiddenMatches: number;
}

export interface SceneInput {
  graph: ResourceGraph;
  overlays: Overlays;
  categories: Record<Category, boolean>;
  hiddenTypes: Set<ResourceType>;
  query: string;
  tagFilters?: TagFilter[];
  tagNeighbors?: boolean;
  /** Drop VPC/subnet plates that end up empty (used while isolating one type) */
  pruneEmptyPlates?: boolean;
  /** Types that are never folded into aggregates (the isolated type) */
  noFoldTypes?: Set<ResourceType>;
  expanded: Set<string>;
  selectedId?: string;
  traffic?: Record<string, number>;
}

// Room for a name on two lines (see components/fitName.ts).
export const NODE_W = 228;
export const NODE_H = 66;
export const AGG_H = 50;
const GROUP_THRESHOLD = 6;
/** Hub-like types are never folded while they have relationships: folding them hides the shape of the system. */
const HUB_TYPES = new Set<ResourceType>([
  'load-balancer', 'api-gateway', 'appsync-api', 'cloudfront', 'route53-zone', 'nat-gateway', 'internet-gateway', 'rds-cluster', 'rds-instance',
  'elasticache', 'ecs-cluster', 'eks-cluster', 'sns-topic', 'sqs-queue', 'eventbridge-rule', 'step-function', 'efs', 'autoscaling-group',
  'cognito-user-pool', 'kms-key',
]);
const STATUS_RANK: Record<Status, number> = { unknown: 0, inactive: 1, healthy: 2, warning: 3, critical: 4 };

export const laneId = (c: Category) => `lane:${c}`;
export const aggregateId = (parentId: string, type: ResourceType) => `agg:${parentId}:${type}`;

function typeVisible(t: ResourceType, input: SceneInput): boolean {
  const meta = TYPE_META[t];
  if (!input.categories[meta.category]) return false;
  if (input.hiddenTypes.has(t)) return false;
  if (meta.overlay && !input.overlays[meta.overlay]) return false;
  return true;
}

function matches(n: ResourceNode, q: string): boolean {
  if (!q) return false;
  if (n.name.toLowerCase().includes(q) || n.nativeId.toLowerCase().includes(q) || n.arn?.toLowerCase().includes(q)) return true;
  for (const v of Object.values(n.props)) if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
  if (n.tags) for (const [k, v] of Object.entries(n.tags)) if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
  return false;
}

export function buildScene(input: SceneInput): Scene {
  const { graph, overlays, expanded, selectedId } = input;
  const q = input.query.trim().toLowerCase();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // 0. edges with target groups folded unless shown (LB → TG → target becomes LB → target)
  const rawEdges: ResourceEdge[] = [];
  if (!overlays.targetGroups) {
    const tgIn = new Map<string, ResourceEdge[]>(); // tg → lb edges
    const tgOut = new Map<string, ResourceEdge[]>(); // tg → target edges
    for (const e of graph.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (t?.type === 'target-group' && e.kind === 'targets') tgIn.set(e.target, [...(tgIn.get(e.target) ?? []), e]);
      else if (s?.type === 'target-group' && e.kind === 'targets') tgOut.set(e.source, [...(tgOut.get(e.source) ?? []), e]);
      else if (s?.type !== 'target-group' && t?.type !== 'target-group') rawEdges.push(e);
    }
    for (const [tgId, ins] of tgIn) {
      const tg = byId.get(tgId);
      for (const inE of ins) for (const outE of tgOut.get(tgId) ?? []) {
        rawEdges.push({ id: `targets|${inE.source}|${outE.target}|${tgId}`, source: inE.source, target: outE.target, kind: 'targets', label: tg?.name, status: outE.status, props: outE.props });
      }
    }
  } else {
    rawEdges.push(...graph.edges);
  }
  const adjacency = new Map<string, Set<string>>();
  const touch = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const e of rawEdges) { touch(e.source, e.target); touch(e.target, e.source); }

  // 1. type/category/overlay visibility
  let visible = new Set<string>();
  for (const n of graph.nodes) if (typeVisible(n.type, input)) visible.add(n.id);

  // 2. narrowing: tag filters, then search. Each keeps its matches, their ancestors and
  //    (optionally) 1-hop neighbours with their ancestors. Matches never fold into aggregates.
  const matched = new Set<string>();
  let hiddenMatches = 0;
  const narrow = (pred: (n: ResourceNode) => boolean, withNeighbors: boolean) => {
    const hits = new Set<string>();
    for (const n of graph.nodes) {
      if (!pred(n)) continue;
      if (visible.has(n.id)) hits.add(n.id);
      else hiddenMatches++;
    }
    const keep = new Set<string>();
    const addWithAncestors = (id: string) => {
      let cur: ResourceNode | undefined = byId.get(id);
      while (cur) { keep.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    };
    for (const id of hits) {
      addWithAncestors(id);
      if (withNeighbors) for (const nb of adjacency.get(id) ?? []) if (visible.has(nb)) addWithAncestors(nb);
    }
    visible = new Set([...visible].filter((id) => keep.has(id)));
    for (const id of hits) matched.add(id);
  };
  const tagFilters = input.tagFilters ?? [];
  if (tagFilters.length) narrow((n) => matchesTags(n, tagFilters), Boolean(input.tagNeighbors));
  if (q) narrow((n) => matches(n, q), true);
  if (tagFilters.length && q) for (const id of [...matched]) if (!visible.has(id)) matched.delete(id);

  // 2b. the selected node is always on the map, and its hidden neighbours appear as ghosts
  const ghosts = new Set<string>();
  const withAncestors = (id: string) => {
    let cur: ResourceNode | undefined = byId.get(id);
    while (cur) { visible.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  };
  if (selectedId && byId.has(selectedId)) {
    if (!visible.has(selectedId)) withAncestors(selectedId);
    for (const nb of adjacency.get(selectedId) ?? []) {
      const n = byId.get(nb);
      if (!n || visible.has(nb) || n.type === 'target-group') continue;
      ghosts.add(nb);
      withAncestors(nb);
    }
  }

  // 3. edges between visible nodes; a ghost only connects to the selected node
  const edges = rawEdges.filter((e) => {
    if (!visible.has(e.source) || !visible.has(e.target)) return false;
    if (ghosts.has(e.source)) return e.target === selectedId;
    if (ghosts.has(e.target)) return e.source === selectedId;
    return true;
  });
  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.source); connected.add(e.target); }

  // 4. neighbours of the selection (and isolated types) stay individual
  const pinned = new Set<string>([...matched, ...ghosts]);
  if (input.noFoldTypes?.size) for (const id of visible) { const n = byId.get(id)!; if (input.noFoldTypes.has(n.type)) pinned.add(n.id); }
  if (selectedId) {
    pinned.add(selectedId);
    for (const e of edges) { if (e.source === selectedId) pinned.add(e.target); if (e.target === selectedId) pinned.add(e.source); }
  }

  // 5. parent resolution and grouping
  const isPlate = (n: ResourceNode) => Boolean(TYPE_META[n.type].plate);
  const parentOf = (n: ResourceNode): string | undefined => {
    if (n.parentId && visible.has(n.parentId) && isPlate(byId.get(n.parentId)!)) return n.parentId;
    if (isPlate(n)) return undefined; // top-level plate
    return laneId(n.category);
  };
  const children = new Map<string, ResourceNode[]>(); // parent (or 'root') → nodes
  for (const id of visible) {
    const n = byId.get(id)!;
    const p = parentOf(n) ?? 'root';
    children.set(p, [...(children.get(p) ?? []), n]);
  }

  const sceneNodes = new Map<string, SceneNode>();
  const redirect = new Map<string, string>(); // member id → aggregate id
  const trafficOf = (id: string) => input.traffic?.[id] ?? 0;
  const lanesUsed = new Set<Category>();

  const addResource = (n: ResourceNode, parentId: string | undefined, depth: number) => {
    sceneNodes.set(n.id, { id: n.id, kind: 'resource', parentId, node: n, depth, dim: false, traffic: trafficOf(n.id), width: NODE_W, height: NODE_H, ghost: ghosts.has(n.id) || undefined });
  };

  const placeChildren = (parentKey: string, parentId: string | undefined, depth: number, isLane: boolean) => {
    const kids = children.get(parentKey) ?? [];
    const groups = new Map<ResourceType, ResourceNode[]>();
    for (const k of kids) {
      if (isPlate(k)) continue;
      groups.set(k.type, [...(groups.get(k.type) ?? []), k]);
    }
    for (const [type, members] of groups) {
      const aggId = aggregateId(parentId ?? 'root', type);
      const isExpanded = expanded.has(aggId);
      let folded: ResourceNode[] = [];
      let shown: ResourceNode[] = members;
      if (!isExpanded) {
        const loose = members.filter((m) => !connected.has(m.id) && !pinned.has(m.id));
        if (isLane && !overlays.isolated && loose.length >= 2) {
          folded = loose;
          shown = members.filter((m) => !loose.includes(m));
        }
        if (shown.length > GROUP_THRESHOLD) {
          const keep = (m: ResourceNode) => pinned.has(m.id) || (HUB_TYPES.has(m.type) && connected.has(m.id));
          const extra = shown.filter((m) => !keep(m));
          folded = [...folded, ...extra];
          shown = shown.filter(keep);
        }
      }
      for (const m of shown) addResource(m, parentId, depth);
      if (folded.length) {
        const worst = folded.reduce<Status>((w, m) => (STATUS_RANK[m.status] > STATUS_RANK[w] ? m.status : w), 'unknown');
        const meta = TYPE_META[type];
        const unlinked = folded.every((m) => !connected.has(m.id));
        sceneNodes.set(aggId, {
          id: aggId, kind: 'aggregate', parentId, depth, dim: false,
          traffic: Math.max(0, ...folded.map((m) => trafficOf(m.id))),
          aggregate: { type, count: folded.length, members: folded, worst, label: `${meta.label} ${folded.length}개`, unlinked },
          width: NODE_W, height: AGG_H,
        });
        for (const m of folded) redirect.set(m.id, aggId);
      }
    }
  };

  // Root plates (VPCs, orphan subnets) and lanes
  const rootKids = children.get('root') ?? [];
  const hasResourceDescendant = (id: string): boolean =>
    (children.get(id) ?? []).some((k) => (isPlate(k) ? hasResourceDescendant(k.id) : true));
  for (const n of rootKids) {
    if (!isPlate(n)) continue;
    if (input.pruneEmptyPlates && !pinned.has(n.id) && !hasResourceDescendant(n.id)) continue;
    sceneNodes.set(n.id, { id: n.id, kind: 'plate', node: n, depth: 0, dim: false, traffic: 0, width: 0, height: 0 });
    const subPlates = (children.get(n.id) ?? []).filter(isPlate);
    const emptySubs: ResourceNode[] = [];
    for (const s of subPlates) {
      const hasKids = (children.get(s.id) ?? []).length > 0;
      if (!hasKids && !pinned.has(s.id) && !expanded.has(aggregateId(n.id, 'subnet'))) { emptySubs.push(s); continue; }
      sceneNodes.set(s.id, { id: s.id, kind: 'plate', parentId: n.id, node: s, depth: 1, dim: false, traffic: 0, width: 0, height: 0 });
      placeChildren(s.id, s.id, 2, false);
    }
    if (emptySubs.length && !input.pruneEmptyPlates) {
      const aggId = aggregateId(n.id, 'subnet');
      sceneNodes.set(aggId, {
        id: aggId, kind: 'aggregate', parentId: n.id, depth: 1, dim: false, traffic: 0, width: NODE_W, height: AGG_H,
        aggregate: { type: 'subnet', count: emptySubs.length, members: emptySubs, worst: 'healthy', label: `빈 서브넷 ${emptySubs.length}개`, unlinked: false },
      });
      for (const s of emptySubs) redirect.set(s.id, aggId);
    }
    placeChildren(n.id, n.id, 1, false);
  }
  // Lane members
  for (const [key, kids] of children) {
    if (!key.startsWith('lane:')) continue;
    const category = key.slice(5) as Category;
    if (!kids.length) continue;
    lanesUsed.add(category);
    sceneNodes.set(key, { id: key, kind: 'plate', lane: { category, label: `${CATEGORY_LABEL[category]} · 리전 서비스` }, depth: 0, dim: false, traffic: 0, width: 0, height: 0 });
    placeChildren(key, key, 1, true);
  }

  // 6. edges → scene edges (redirected through aggregates, deduped)
  const sceneEdges = new Map<string, SceneEdge>();
  for (const e of edges) {
    const s = redirect.get(e.source) ?? e.source;
    const t = redirect.get(e.target) ?? e.target;
    if (s === t || !sceneNodes.has(s) || !sceneNodes.has(t)) continue;
    const key = `${e.kind}|${s}|${t}`;
    const live = LIVE_EDGE_KINDS.has(e.kind);
    const traffic = live ? Math.max(trafficOf(e.source), trafficOf(e.target), e.traffic ?? 0) : 0;
    const existing = sceneEdges.get(key);
    if (existing) {
      existing.count += 1;
      existing.traffic = Math.max(existing.traffic, traffic);
      if (e.status && (!existing.status || STATUS_RANK[e.status] > STATUS_RANK[existing.status])) existing.status = e.status;
      if (existing.label && e.label && existing.label !== e.label && !existing.label.includes(e.label)) existing.label = `${existing.label}, ${e.label}`.slice(0, 60);
    } else {
      sceneEdges.set(key, { id: key, source: s, target: t, kind: e.kind, label: e.label, status: e.status, traffic, live, dim: false, count: 1, ghost: ghosts.has(e.source) || ghosts.has(e.target) || undefined });
    }
  }

  // 7. focus dimming
  if (selectedId && (sceneNodes.has(selectedId) || redirect.has(selectedId))) {
    const focusId = redirect.get(selectedId) ?? selectedId;
    const keep = new Set<string>([focusId]);
    for (const e of sceneEdges.values()) {
      if (e.source === focusId) keep.add(e.target);
      else if (e.target === focusId) keep.add(e.source);
      else e.dim = true;
    }
    for (const id of [...keep]) {
      let cur = sceneNodes.get(id);
      while (cur?.parentId) { keep.add(cur.parentId); cur = sceneNodes.get(cur.parentId); }
    }
    for (const n of sceneNodes.values()) if (!keep.has(n.id)) n.dim = true;
  }

  // Parents must precede children
  const ordered = [...sceneNodes.values()].sort((a, b) => a.depth - b.depth);
  const hidden = graph.nodes.length - visible.size;
  return { nodes: ordered, edges: [...sceneEdges.values()], hidden, visible: visible.size, hiddenMatches };
}
