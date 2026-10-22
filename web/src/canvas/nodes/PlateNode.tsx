import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { Category, ResourceNode as RNode } from '@orrery/shared';
import { TypeIcon } from '../../components/TypeIcon';
import { CATEGORY_ORDER } from '../../model/types';
import { Layers } from 'lucide-react';

export type PlateNodeData = { node?: RNode; lane?: { category: Category; label: string }; dim: boolean; depth: number; count: number };
export type PlateNodeType = Node<PlateNodeData, 'plate'>;

function PlateNodeImpl({ data }: NodeProps<PlateNodeType>) {
  const { node, lane, dim, count } = data;
  const kind = lane ? 'lane' : node?.type ?? 'vpc';
  const title = lane ? lane.label : node?.name ?? '';
  const sub = lane
    ? null
    : node?.type === 'vpc'
      ? String(node.props['CIDR'] ?? '')
      : [node?.props['CIDR'], node?.statusLabel].filter(Boolean).join(' · ');
  const laneIndex = lane ? CATEGORY_ORDER.indexOf(lane.category) : -1;
  return (
    <div className={`plate plate-${kind} ${dim ? 'dim' : ''} ${lane ? `cat-${lane.category}` : ''}`} style={{ '--lane': laneIndex } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="plate-head">
        <span className="plate-icon">{lane ? <Layers size={14} strokeWidth={1.75} aria-hidden /> : node ? <TypeIcon type={node.type} size={14} /> : null}</span>
        <span className="plate-title" title={node?.az ? `${title} · ${node.az}` : title}>{title}</span>
        {sub && <span className="plate-sub">{sub}</span>}
        <span className="plate-count tnum">{count}</span>
      </div>
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

export const PlateNode = memo(PlateNodeImpl);
