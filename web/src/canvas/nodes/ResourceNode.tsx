import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ResourceNode as RNode } from '@orrery/shared';
import { TYPE_META } from '../../model/types';
import { TypeIcon } from '../../components/TypeIcon';
import { StatusDot } from '../../components/StatusDot';
import { fmtProp } from '../../components/format';
import { fitName } from '../../components/fitName';
import { NODE_W } from '../../layout/scene';

// Card width minus border (1 + 1), padding (9 + 10), icon (32), the two gaps (10 + 10), the status dot (8)
// and 1px for subpixel rounding.
const NAME_W = NODE_W - 82;

export type ResourceNodeData = { node: RNode; dim: boolean; traffic: number; depth: number; index: number; alarms: number; changed?: boolean; ghost?: boolean };
export type ResourceNodeType = Node<ResourceNodeData, 'resource'>;

function ResourceNodeImpl({ data, selected }: NodeProps<ResourceNodeType>) {
  const { node, dim, traffic, index } = data;
  const meta = TYPE_META[node.type];
  const keyProp = meta.keyProp ? node.props[meta.keyProp] : undefined;
  // The alarm badge and the "숨김" tag share the row with the name.
  const nameLines = fitName(node.name, NAME_W - (data.alarms > 0 ? 22 : 0) - (data.ghost ? 36 : 0));
  return (
    <div
      className={`rnode cat-${node.category} st-${node.status} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''} ${data.changed ? 'changed' : ''} ${data.ghost ? 'ghost' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
      data-type={node.type}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="rnode-icon"><TypeIcon type={node.type} size={16} /></div>
      <div className="rnode-body">
        {/* Full name, status and alarms show in the HoverCard; no native title to pile on top of it. */}
        <div className="rnode-name">
          {nameLines.map((line, i) => <span key={i}>{line}</span>)}
        </div>
        <div className="rnode-sub">
          <span className="rnode-type">{meta.short}</span>
          {keyProp != null && keyProp !== '' && <span className="rnode-kv">{String(fmtProp(keyProp)).slice(0, 28)}</span>}
        </div>
      </div>
      <div className="rnode-status">
        {data.ghost && <span className="rnode-ghost-tag">숨김</span>}
        {data.alarms > 0 && <span className="rnode-alarm">{data.alarms}</span>}
        <StatusDot status={node.status} label={node.statusLabel} />
      </div>
      {traffic > 0 && <div className="rnode-traffic" style={{ width: `${Math.max(8, traffic * 100)}%` }} aria-hidden />}
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

export const ResourceNode = memo(ResourceNodeImpl);
