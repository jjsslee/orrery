import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, MarkerType, Position,
  type Node, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../model/store';
import { sceneStructureKey, buildScene, type Scene } from '../layout/scene';
import { layoutScene, type Placement } from '../layout/elk';
import { assignPorts } from '../layout/ports';
import { ResourceNode, type ResourceNodeType } from './nodes/ResourceNode';
import { PlateNode, type PlateNodeType } from './nodes/PlateNode';
import { AggregateNode, type AggregateNodeType } from './nodes/AggregateNode';
import { FlowEdge, type FlowEdgeType } from './edges/FlowEdge';
import { CanvasToolbar } from './CanvasToolbar';
import { HoverCard, type HoverAnchor } from './HoverCard';
import { CATEGORY_ORDER, TYPE_META } from '../model/types';
import type { ResourceType } from '@orrery/shared';

const nodeTypes = { resource: ResourceNode, plate: PlateNode, aggregate: AggregateNode };
const edgeTypes = { flow: FlowEdge };
const DIRECTIONAL = new Set(['targets', 'invokes', 'publishes', 'reads', 'origin', 'resolves', 'routes', 'allows', 'assumes', 'encrypts', 'mounts']);

type AnyNode = ResourceNodeType | PlateNodeType | AggregateNodeType;

// Explicit stacking (zIndexMode="manual"): plates < edges < cards, so lines pass behind resource cards instead of over them.
const Z_PLATE = -10, Z_EDGE = 0, Z_CARD = 10;

const CAT_HEX: Record<string, string> = { compute: '#c1821f', network: '#974fed', database: '#6ca2fd', storage: '#77c58e', security: '#c71f28', integration: '#e55caf' };

function TopologyInner() {
  const graph = useStore((s) => s.graph);
  const metrics = useStore((s) => s.metrics);
  const overlays = useStore((s) => s.overlays);
  const categories = useStore((s) => s.categories);
  const hiddenTypes = useStore((s) => s.hiddenTypes);
  const query = useStore((s) => s.query);
  const tagFilters = useStore((s) => s.tagFilters);
  const tagNeighbors = useStore((s) => s.tagNeighbors);
  const expanded = useStore((s) => s.expanded);
  const selectedId = useStore((s) => s.selectedId);
  const hoverId = useStore((s) => s.hoverId);
  const fitRequest = useStore((s) => s.fitRequest);
  const locateRequest = useStore((s) => s.locateRequest);
  const changed = useStore((s) => s.changed);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const rf = useReactFlow();

  // Narrow mode: the user has checked only a few resource types. Those are never folded into
  // aggregates and plates that end up empty are dropped, so "show me the load balancers" reads as such.
  const narrow = useMemo(() => {
    if (!graph || hiddenTypes.size === 0) return undefined;
    const present = new Set(graph.nodes.map((n) => n.type));
    const visible = (Object.keys(TYPE_META) as ResourceType[]).filter((t) => present.has(t) && !hiddenTypes.has(t) && !TYPE_META[t].plate && !TYPE_META[t].overlay);
    return visible.length > 0 && visible.length <= 3 ? new Set(visible) : undefined;
  }, [graph, hiddenTypes]);

  const scene: Scene | undefined = useMemo(
    () => (graph ? buildScene({
      graph, overlays, categories, hiddenTypes, query, tagFilters, tagNeighbors, expanded, selectedId, traffic: metrics?.traffic,
      pruneEmptyPlates: Boolean(narrow), noFoldTypes: narrow,
    }) : undefined),
    [graph, overlays, categories, hiddenTypes, query, tagFilters, tagNeighbors, expanded, selectedId, metrics?.traffic, narrow],
  );

  // Re-layout only when the structure changes, not on dim/traffic updates.
  const structureKey = useMemo(() => (scene ? sceneStructureKey(scene) : ''), [scene]);
  const [placed, setPlaced] = useState<{ key: string; placements: Map<string, Placement>; scene: Scene }>();
  const [laying, setLaying] = useState(false);
  const layoutGen = useRef(0);
  const firstFit = useRef(true);
  // Filters and search change what is on the map: fit the view once the new layout lands.
  const fitAfterLayout = useRef(false);
  useEffect(() => { fitAfterLayout.current = true; }, [query, tagFilters, tagNeighbors, categories, hiddenTypes, overlays.security, overlays.iam, overlays.encryption, overlays.targetGroups, overlays.isolated]);

  useEffect(() => {
    if (!scene || !structureKey) return;
    if (placed?.key === structureKey) return;
    const gen = ++layoutGen.current;
    const started = performance.now();
    setLaying(true);
    layoutScene(scene)
      .then((placements) => {
        if (gen !== layoutGen.current) return;
        console.info(`[orrery] layout: ${scene.nodes.length} nodes, ${scene.edges.length} edges in ${Math.round(performance.now() - started)} ms`);
        setPlaced({ key: structureKey, placements, scene });
        setLaying(false);
        if (firstFit.current || fitAfterLayout.current) {
          pendingFit.current = { first: firstFit.current };
          firstFit.current = false;
          fitAfterLayout.current = false;
        }
      })
      .catch((err) => { console.error('layout failed', err); setLaying(false); });
  }, [scene, structureKey, placed?.key, rf]);

  // Nodes carry explicit width/height, so React Flow can fit them before they are measured
  // (with onlyRenderVisibleElements, off-screen nodes are never measured at all).
  const pendingFit = useRef<{ first: boolean } | null>(null);
  useEffect(() => {
    if (!pendingFit.current || !placed) return;
    const t = setTimeout(() => {
      const pending = pendingFit.current;
      if (!pending) return;
      pendingFit.current = null;
      void rf.fitView({ padding: pending.first ? 0.08 : 0.2, duration: pending.first ? 600 : 400, maxZoom: 1.2 });
    }, 60);
    return () => clearTimeout(t);
  }, [placed, rf]);

  useEffect(() => {
    if (!graph) { firstFit.current = true; setPlaced(undefined); }
  }, [graph]);

  useEffect(() => {
    if (fitRequest > 0 && placed) rf.fitView({ padding: 0.08, duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  // Explicit "지도에서 보기": zoom onto the node once the layout that contains it has landed
  const container = useRef<HTMLDivElement>(null);
  const handledLocate = useRef(0);
  const absoluteBounds = useCallback((id: string) => {
    const internal = rf.getInternalNode(id);
    if (!internal) return undefined;
    const p = internal.internals.positionAbsolute;
    return { x: p.x, y: p.y, width: internal.measured.width ?? internal.width ?? 0, height: internal.measured.height ?? internal.height ?? 0 };
  }, [rf]);

  useEffect(() => {
    if (!locateRequest || !placed || handledLocate.current === locateRequest.seq) return;
    if (!rf.getNode(locateRequest.id)) return; // not in this layout yet; try again when placements change
    handledLocate.current = locateRequest.seq;
    pendingFit.current = null; // the locate zoom wins over a pending fit-to-view
    const t = setTimeout(() => {
      const b = absoluteBounds(locateRequest.id);
      if (b) void rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: 1.1, duration: 550 });
    }, 160);
    return () => clearTimeout(t);
  }, [locateRequest, placed, rf, absoluteBounds]);
  useEffect(() => {
    if (!selectedId || !placed) return;
    const t = setTimeout(() => {
      if (locateRequest && handledLocate.current !== locateRequest.seq) return; // locate will position the view
      const el = container.current;
      const b = absoluteBounds(selectedId);
      if (!b || !el) return;
      const vp = rf.getViewport();
      const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: el.clientWidth / vp.zoom, h: el.clientHeight / vp.zoom };
      const inside = b.x >= view.x && b.y >= view.y && b.x + b.width <= view.x + view.w && b.y + b.height <= view.y + view.h;
      if (!inside) void rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: Math.max(vp.zoom, 0.8), duration: 450 });
    }, firstFit.current ? 900 : 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, placed?.key]);

  const { nodes, edges, drawn } = useMemo(() => {
    if (!scene || !placed) return { nodes: [] as AnyNode[], edges: [] as FlowEdgeType[], drawn: undefined };
    // While a new structure is being laid out, keep drawing the scene the placements belong to.
    const drawn = placed.key === structureKey ? scene : placed.scene;
    const childCount = new Map<string, number>();
    for (const n of drawn.nodes) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    let index = 0;
    const nodes: AnyNode[] = drawn.nodes.map((n) => {
      const p = placed.placements.get(n.id) ?? { x: 0, y: 0, width: n.width, height: n.height };
      const base = { id: n.id, position: { x: p.x, y: p.y }, parentId: n.parentId, extent: n.parentId ? ('parent' as const) : undefined, sourcePosition: Position.Right, targetPosition: Position.Left };
      if (n.kind === 'plate') {
        const node: PlateNodeType = { ...base, type: 'plate', draggable: false, selectable: false, focusable: false, width: p.width, height: p.height, style: { width: p.width, height: p.height }, data: { node: n.node, lane: n.lane, dim: n.dim, depth: n.depth, count: childCount.get(n.id) ?? 0 }, zIndex: Z_PLATE + n.depth };
        return node;
      }
      if (n.kind === 'aggregate') {
        const node: AggregateNodeType = { ...base, type: 'aggregate', width: n.width, height: n.height, style: { width: n.width, height: n.height }, zIndex: Z_CARD, data: { ...n.aggregate!, dim: n.dim, traffic: n.traffic, depth: n.depth, index: index++ } };
        return node;
      }
      const node: ResourceNodeType = { ...base, type: 'resource', width: n.width, height: n.height, style: { width: n.width, height: n.height }, selected: n.id === selectedId, zIndex: n.id === selectedId ? Z_CARD + 1 : Z_CARD, data: { node: n.node!, dim: n.dim, traffic: n.traffic, depth: n.depth, index: index++, alarms: n.node!.alarms?.length ?? 0, changed: Boolean(changed[n.id]), ghost: Boolean(n.ghost) } };
      return node;
    });
    const hasMetrics = Boolean(metrics && Object.keys(metrics.traffic).length);
    const focus = selectedId ?? hoverId;
    const ports = assignPorts(drawn, placed.placements);
    const edges: FlowEdgeType[] = drawn.edges.map((e) => {
      const highlight = Boolean(focus && (e.source === focus || e.target === focus));
      // While a node is in focus, its own lines stay strong and the rest fade back so they can be followed behind cards.
      const muted = Boolean(focus) && !highlight;
      // Mid-line labels only for the selected node; hovering shows the HoverCard instead.
      const labeled = Boolean(selectedId && (e.source === selectedId || e.target === selectedId));
      const color = e.status === 'critical' ? 'var(--status-critical)' : e.status === 'warning' ? 'var(--status-warning)' : highlight ? 'var(--ink-2)' : 'var(--line-strong)';
      return {
        id: e.id, source: e.source, target: e.target, type: 'flow', zIndex: highlight ? Z_EDGE + 1 : Z_EDGE,
        data: { ...e, ports: ports.get(e.id), highlight, muted, labeled, showTraffic: overlays.traffic, hasMetrics },
        markerEnd: DIRECTIONAL.has(e.kind) ? { type: MarkerType.ArrowClosed, color, width: 14, height: 14 } : undefined,
      };
    });
    return { nodes, edges, drawn };
  }, [scene, placed, structureKey, selectedId, hoverId, metrics, overlays.traffic, changed]);

  // Hover card: shown after a short rest on a node so sweeping across the map does not flicker.
  const [card, setCard] = useState<{ anchor: HoverAnchor; bounds: { width: number; height: number } }>();
  const cardTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideCard = useCallback(() => { clearTimeout(cardTimer.current); setCard(undefined); }, []);

  const onNodeClick = useCallback<NodeMouseHandler<Node>>((_, node) => {
    hideCard();
    if (node.type === 'aggregate') { toggleExpanded(node.id); return; }
    if (node.type === 'plate') return;
    select(node.id === selectedId ? undefined : node.id);
  }, [select, selectedId, toggleExpanded, hideCard]);

  const onNodeEnter = useCallback<NodeMouseHandler<Node>>((event, node) => {
    if (node.type === 'plate') return;
    hover(node.id);
    const el = event.currentTarget as HTMLElement; // React clears currentTarget once the handler returns
    clearTimeout(cardTimer.current);
    cardTimer.current = setTimeout(() => {
      const box = container.current?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (box) setCard({ anchor: { id: node.id, x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }, bounds: { width: box.width, height: box.height } });
    }, 280);
  }, [hover]);
  const onNodeLeave = useCallback(() => { hideCard(); hover(undefined); }, [hover, hideCard]);

  return (
    <div className={`topology ${laying ? 'laying' : ''}`} ref={container}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={onNodeLeave}
        onPaneClick={() => select(undefined)}
        onMoveStart={hideCard}
        minZoom={0.04}
        maxZoom={2.2}
        nodesConnectable={false}
        zIndexMode="manual"
        onlyRenderVisibleElements
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="var(--line)" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(n) => {
            const d = n.data as { node?: { category?: string }; type?: string; lane?: { category: string } };
            const cat = d.node?.category ?? d.lane?.category ?? (d.type ? CATEGORY_ORDER.find(() => true) : undefined);
            return n.type === 'plate' ? 'rgba(255,255,255,0.04)' : CAT_HEX[cat ?? ''] ?? '#6e7b99';
          }}
          nodeStrokeWidth={0}
          maskColor="rgba(7, 13, 25, 0.6)"
          bgColor="var(--panel)"
        />
      </ReactFlow>
      {scene && scene.nodes.length === 0 && (
        <div className="empty">
          <div className="empty-card">
            <div className="empty-title">{query ? `'${query}'에 맞는 자원이 없습니다` : tagFilters.length ? '선택한 태그를 가진 자원이 없습니다' : '표시할 자원이 없습니다'}</div>
            <div className="empty-sub">
              {scene.hiddenMatches > 0
                ? `꺼진 레이어나 필터에 숨겨진 자원 ${scene.hiddenMatches}개가 검색어와 일치합니다. 하단 레이어나 왼쪽 필터를 켜 보세요.`
                : '검색어를 바꾸거나 왼쪽 필터를 조정하세요.'}
            </div>
          </div>
        </div>
      )}
      {card && drawn && <HoverCard anchor={card.anchor} scene={drawn} bounds={card.bounds} />}
      <CanvasToolbar scene={scene} laying={laying} />
    </div>
  );
}

export function Topology() {
  return (
    <ReactFlowProvider>
      <TopologyInner />
    </ReactFlowProvider>
  );
}
