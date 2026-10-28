import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type Edge } from '@xyflow/react';
import type { SceneEdge } from '../../layout/scene';
import { EDGE_KIND_LABEL } from '../../model/types';

export type FlowEdgeData = { [K in keyof SceneEdge]: SceneEdge[K] } & { highlight: boolean; labeled: boolean; showTraffic: boolean; hasMetrics: boolean };
export type FlowEdgeType = Edge<FlowEdgeData, 'flow'>;

const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function FlowEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<FlowEdgeType>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  if (!data) return null;
  const { kind, live, traffic, dim, highlight, status, label, count, showTraffic } = data;
  const animated = showTraffic && live && !reduceMotion && !dim;
  const particles = animated && traffic > 0 ? 1 + Math.round(traffic * 3) : 0;
  const dur = 4.2 - traffic * 2.8;
  const idle = false;
  const cls = `fedge k-${kind} ${live ? 'live' : ''} ${dim ? 'dim' : ''} ${highlight ? 'hl' : ''} ${status ? `st-${status}` : ''} ${idle ? 'idle' : ''} ${data.ghost ? 'ghost' : ''}`;
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
            <span className="fedge-kind">{EDGE_KIND_LABEL[kind] ?? kind}</span>
            {/* Short details (ports, "3개 라우트") only: long ones would cover nearby nodes; the HoverCard and Inspector show them. */}
            {label && label.length <= 14 && <span className="fedge-text">{label}</span>}
            {count > 1 && <span className="fedge-count tnum">×{count}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FlowEdge = memo(FlowEdgeImpl);
