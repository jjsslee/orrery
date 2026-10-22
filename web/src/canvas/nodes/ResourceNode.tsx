import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ResourceNode as RNode } from '@orrery/shared';
import { TYPE_META } from '../../model/types';
import { TypeIcon } from '../../components/TypeIcon';
import { StatusDot } from '../../components/StatusDot';
import { fmtProp } from '../../components/format';

export type ResourceNodeData = { node: RNode; dim: boolean; traffic: number; depth: number; index: number; alarms: number; changed?: boolean; ghost?: boolean };
export type ResourceNodeType = Node<ResourceNodeData, 'resource'>;

function ResourceNodeImpl({ data, selected }: NodeProps<ResourceNodeType>) {
  const { node, dim, traffic, index } = data;
  const meta = TYPE_META[node.type];
  const keyProp = meta.keyProp ? node.props[meta.keyProp] : undefined;
  return (
    <div
      className={`rnode cat-${node.category} st-${node.status} ${dim ? 'dim' : ''} ${selected ? 'selected' : ''} ${data.changed ? 'changed' : ''} ${data.ghost ? 'ghost' : ''}`}
      title={data.ghost ? `${node.name} · 필터에 가려진 유형이지만 선택한 자원과 연결되어 있어 표시합니다` : undefined}
      style={{ '--i': index } as React.CSSProperties}
      data-type={node.type}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="rnode-icon"><TypeIcon type={node.type} size={16} /></div>
      <div className="rnode-body">
        <div className="rnode-name" title={node.name}>{node.name}</div>
        <div className="rnode-sub">
          <span className="rnode-type">{meta.short}</span>
          {keyProp != null && keyProp !== '' && <span className="rnode-kv" title={`${meta.keyProp}: ${fmtProp(keyProp)}`}>{String(fmtProp(keyProp)).slice(0, 28)}</span>}
        </div>
      </div>
      <div className="rnode-status">
        {data.ghost && <span className="rnode-ghost-tag">숨김</span>}
        {data.alarms > 0 && <span className="rnode-alarm" title={`경보 ${data.alarms}건`}>{data.alarms}</span>}
        <StatusDot status={node.status} label={node.statusLabel} />
      </div>
      {traffic > 0 && <div className="rnode-traffic" style={{ width: `${Math.max(8, traffic * 100)}%` }} aria-hidden />}
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

export const ResourceNode = memo(ResourceNodeImpl);
