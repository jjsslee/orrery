import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, MarkerType, Position,
  type Node, type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../model/store';
import { buildScene, type Scene } from '../layout/scene';
import { layoutScene, type Placement } from '../layout/elk';
import { ResourceNode, type ResourceNodeType } from './nodes/ResourceNode';
import { PlateNode, type PlateNodeType } from './nodes/PlateNode';
import { AggregateNode, type AggregateNodeType } from './nodes/AggregateNode';
import { FlowEdge, type FlowEdgeType } from './edges/FlowEdge';
import { CanvasToolbar } from './CanvasToolbar';
import { CATEGORY_ORDER } from '../model/types';

const nodeTypes = { resource: ResourceNode, plate: PlateNode, aggregate: AggregateNode };
const edgeTypes = { flow: FlowEdge };
const DIRECTIONAL = new Set(['targets', 'invokes', 'publishes', 'reads', 'origin', 'resolves', 'routes', 'allows', 'assumes', 'encrypts', 'mounts']);

type AnyNode = ResourceNodeType | PlateNodeType | AggregateNodeType;

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
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const rf = useReactFlow();

  const scene: Scene | undefined = useMemo(
    () => (graph ? buildScene({ graph, overlays, categories, hiddenTypes, query, tagFilters, tagNeighbors, expanded, selectedId, traffic: metrics?.traffic }) : undefined),
    [graph, overlays, categories, hiddenTypes, query, tagFilters, tagNeighbors, expanded, selectedId, metrics?.traffic],
  );

  // Re-layout only when the structure changes, not on dim/traffic updates.
  const structureKey = useMemo(() => (scene ? `${scene.nodes.map((n) => n.id).join('|')}#${scene.edges.map((e) => e.id).join('|')}` : ''), [scene]);
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

  // Reveal the selected node only when it sits outside the current viewport
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId || !placed) return;
    const t = setTimeout(() => {
      const node = rf.getNode(selectedId);
      const el = container.current;
      if (!node || !el) return;
      const b = rf.getNodesBounds([node]);
      const vp = rf.getViewport();
      const view = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: el.clientWidth / vp.zoom, h: el.clientHeight / vp.zoom };
      const inside = b.x >= view.x && b.y >= view.y && b.x + b.width <= view.x + view.w && b.y + b.height <= view.y + view.h;
      if (!inside) void rf.setCenter(b.x + b.width / 2, b.y + b.height / 2, { zoom: Math.max(vp.zoom, 0.8), duration: 450 });
    }, firstFit.current ? 900 : 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, placed?.key]);

  const { nodes, edges } = useMemo(() => {
    if (!scene || !placed) return { nodes: [] as AnyNode[], edges: [] as FlowEdgeType[] };
    // While a new structure is being laid out, keep drawing the scene the placements belong to.
    const drawn = placed.key === structureKey ? scene : placed.scene;
    const childCount = new Map<string, number>();
    for (const n of drawn.nodes) if (n.parentId) childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    let index = 0;
    const nodes: AnyNode[] = drawn.nodes.map((n) => {
      const p = placed.placements.get(n.id) ?? { x: 0, y: 0, width: n.width, height: n.height };
      const base = { id: n.id, position: { x: p.x, y: p.y }, parentId: n.parentId, extent: n.parentId ? ('parent' as const) : undefined, sourcePosition: Position.Right, targetPosition: Position.Left };
      if (n.kind === 'plate') {
        const node: PlateNodeType = { ...base, type: 'plate', draggable: false, selectable: false, focusable: false, width: p.width, height: p.height, style: { width: p.width, height: p.height }, data: { node: n.node, lane: n.lane, dim: n.dim, depth: n.depth, count: childCount.get(n.id) ?? 0 }, zIndex: -1 };
        return node;
      }
      if (n.kind === 'aggregate') {
        const node: AggregateNodeType = { ...base, type: 'aggregate', width: n.width, height: n.height, style: { width: n.width, height: n.height }, data: { ...n.aggregate!, dim: n.dim, traffic: n.traffic, depth: n.depth, index: index++ } };
        return node;
      }
      const node: ResourceNodeType = { ...base, type: 'resource', width: n.width, height: n.height, style: { width: n.width, height: n.height }, selected: n.id === selectedId, data: { node: n.node!, dim: n.dim, traffic: n.traffic, depth: n.depth, index: index++, alarms: n.node!.alarms?.length ?? 0 } };
      return node;
    });
    const hasMetrics = Boolean(metrics && Object.keys(metrics.traffic).length);
    const focus = selectedId ?? hoverId;
    const edges: FlowEdgeType[] = drawn.edges.map((e) => {
      const highlight = Boolean(focus && (e.source === focus || e.target === focus));
      const color = e.status === 'critical' ? 'var(--status-critical)' : e.status === 'warning' ? 'var(--status-warning)' : highlight ? 'var(--ink-2)' : 'var(--line-strong)';
      return {
        id: e.id, source: e.source, target: e.target, type: 'flow', zIndex: highlight ? 2 : 1,
        data: { ...e, highlight, showTraffic: overlays.traffic, hasMetrics },
        markerEnd: DIRECTIONAL.has(e.kind) ? { type: MarkerType.ArrowClosed, color, width: 14, height: 14 } : undefined,
      };
    });
    return { nodes, edges };
  }, [scene, placed, structureKey, selectedId, hoverId, metrics, overlays.traffic]);

  const onNodeClick = useCallback<NodeMouseHandler<Node>>((_, node) => {
    if (node.type === 'aggregate') { toggleExpanded(node.id); return; }
    if (node.type === 'plate') return;
    select(node.id === selectedId ? undefined : node.id);
  }, [select, selectedId, toggleExpanded]);

  const onNodeEnter = useCallback<NodeMouseHandler<Node>>((_, node) => { if (node.type !== 'plate') hover(node.id); }, [hover]);
  const onNodeLeave = useCallback(() => hover(undefined), [hover]);

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
        minZoom={0.04}
        maxZoom={2.2}
        nodesConnectable={false}
        elevateNodesOnSelect
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
