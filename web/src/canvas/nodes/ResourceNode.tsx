import { uiText, useLanguage } from '../../i18n';
import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ResourceNode as RNode } from '@orrery/shared';
import { TYPE_META } from '../../model/types';
import { TypeIcon } from '../../components/TypeIcon';
import { StatusDot } from '../../components/StatusDot';
export type ResourceNodeData = { node: RNode; dim: boolean; traffic: number; depth: number; index: number; alarms: number; changed?: boolean; ghost?: boolean };
export type ResourceNodeType = Node<ResourceNodeData, 'resource'>;

function ResourceNodeImpl({ data, selected }: NodeProps<ResourceNodeType>) {
  useLanguage();
  const { node, dim, traffic, index } = data;
  const meta = TYPE_META[node.type];
  return (
    <div
      className={`rnode cat-${node.category} st-${node.status} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''} ${data.changed ? 'changed' : ''} ${data.ghost ? 'ghost' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
      data-type={node.type}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="rnode-icon"><TypeIcon type={node.type} size={16} /></div>
      <div className="rnode-body">
        {/* Full name and key properties remain available in the HoverCard and Inspector. */}
        <div className="rnode-heading" title={node.name}>{node.name}</div>
        <div className="rnode-type">{uiText(meta.label ?? '')}</div>
      </div>
      <div className="rnode-status">
        {data.ghost && <span className="rnode-ghost-tag">{uiText("숨김")}</span>}
        {data.alarms > 0 && <span className="rnode-alarm">{data.alarms}</span>}
        <StatusDot status={node.status} label={node.statusLabel} />
      </div>
      {traffic > 0 && <div className="rnode-traffic" style={{ width: `${Math.max(8, traffic * 100)}%` }} aria-hidden />}
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

export const ResourceNode = memo(ResourceNodeImpl);
