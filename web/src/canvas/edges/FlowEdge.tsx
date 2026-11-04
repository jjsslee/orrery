import { uiText, useLanguage } from '../../i18n';
import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, Position, type EdgeProps, type Edge, type InternalNode } from '@xyflow/react';
import type { SceneEdge } from '../../layout/scene';
import type { EdgePorts, Side } from '../../layout/ports';
import { EDGE_KIND_LABEL } from '../../model/types';

export type FlowEdgeData = { [K in keyof SceneEdge]: SceneEdge[K] } & { ports?: EdgePorts; highlight: boolean; muted: boolean; labeled: boolean; showTraffic: boolean; hasMetrics: boolean };
export type FlowEdgeType = Edge<FlowEdgeData, 'flow'>;

const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const POSITION: Record<Side, Position> = { left: Position.Left, right: Position.Right };

function anchor(node: InternalNode, side: Side, port: number) {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured.width ?? node.width ?? 0, height = node.measured.height ?? node.height ?? 0;
  return { x: side === 'right' ? x + width : x, y: y + height * port };
}

function FlowEdgeImpl({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<FlowEdgeType>) {
  useLanguage();
  const sourceNode = useInternalNode(source), targetNode = useInternalNode(target);
  const ports = data?.ports;
  let path: string, labelX: number, labelY: number;
  if (ports && sourceNode && targetNode) {
    const s = anchor(sourceNode, ports.sourceSide, ports.sourcePort), t = anchor(targetNode, ports.targetSide, ports.targetPort);
    if (ports.sourceSide === ports.targetSide) {
      // Ends stacked in one column: bow out beside the column like a bracket rather than cut through the cards between.
      const bow = (36 + Math.abs(t.y - s.y) * 0.15) * (ports.sourceSide === 'right' ? 1 : -1);
      path = `M${s.x},${s.y} C${s.x + bow},${s.y} ${t.x + bow},${t.y} ${t.x},${t.y}`;
      labelX = (s.x + t.x) / 2 + bow * 0.75;
      labelY = (s.y + t.y) / 2;
    } else {
      [path, labelX, labelY] = getBezierPath({ sourceX: s.x, sourceY: s.y, targetX: t.x, targetY: t.y, sourcePosition: POSITION[ports.sourceSide], targetPosition: POSITION[ports.targetSide], curvature: 0.3 });
    }
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  }
  if (!data) return null;
  const { kind, live, traffic, dim, highlight, muted, status, label, count, showTraffic } = data;
  const animated = showTraffic && live && !reduceMotion && !dim && !muted;
  const particles = animated && traffic > 0 ? 1 + Math.round(traffic * 3) : 0;
  const dur = 4.2 - traffic * 2.8;
  const idle = false;
  const cls = `fedge k-${kind} ${live ? 'live' : ''} ${dim ? 'dim' : ''} ${highlight ? 'hl' : ''} ${muted ? 'muted' : ''} ${status ? `st-${status}` : ''} ${idle ? 'idle' : ''} ${data.ghost ? 'ghost' : ''}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} interactionWidth={14} />
      {particles > 0 && (
        <g className="fedge-particles" aria-hidden>
          {Array.from({ length: particles }, (_, i) => (
            <circle key={i} r={highlight ? 2.6 : 2.1} className="fedge-particle">
              <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${-(i * dur) / particles}s`} path={path} rotate="auto" />
            </circle>
          ))}
        </g>
      )}
      {data.labeled && (
        <EdgeLabelRenderer>
          <div className="fedge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <span className="fedge-kind">{uiText(EDGE_KIND_LABEL[kind] ?? kind)}</span>
            {/* Short details (ports, "3개 라우트") only: long ones would cover nearby nodes; the HoverCard and Inspector show them. */}
            {label && label.length <= 14 && <span className="fedge-text">{uiText(label)}</span>}
            {count > 1 && <span className="fedge-count tnum">×{count}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FlowEdge = memo(FlowEdgeImpl);
