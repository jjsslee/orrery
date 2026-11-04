import { uiText, useLanguage } from '../../i18n';
import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ResourceNode as RNode, ResourceType, Status } from '@orrery/shared';
import { ChevronRight } from 'lucide-react';
import { TypeIcon } from '../../components/TypeIcon';
import { TYPE_META } from '../../model/types';

export type AggregateNodeData = { type: ResourceType; count: number; members: RNode[]; worst: Status; label: string; unlinked: boolean; dim: boolean; traffic: number; depth: number; index: number };
export type AggregateNodeType = Node<AggregateNodeData, 'aggregate'>;

function AggregateNodeImpl({ data, selected }: NodeProps<AggregateNodeType>) {
  useLanguage();
  const counts: Partial<Record<Status, number>> = {};
  for (const m of data.members) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const category = TYPE_META[data.type].category;
  return (
    <div className={`rnode agg cat-${category} ${data.dim ? 'dim' : ''} ${selected ? 'selected' : ''}`} style={{ '--i': data.index } as React.CSSProperties}>
      <Handle type="target" position={Position.Left} className="rf-handle" isConnectable={false} />
      <div className="rnode-icon stack"><TypeIcon type={data.type} size={16} /></div>
      <div className="rnode-body">
        <div className="rnode-name">{uiText`${uiText(TYPE_META[data.type].short)} ${data.count}개`}</div>
        <div className="agg-sub">
          <div className="agg-status" aria-label={uiText("상태 분포")}>
            {(['critical', 'warning', 'healthy', 'inactive', 'unknown'] as Status[]).filter((s) => counts[s]).map((s) => (
              <span key={s} className={`agg-seg st-${s}`} style={{ flex: counts[s] }} title={`${s} ${counts[s]}`} />
            ))}
          </div>
          {data.unlinked && <span className="agg-note">{uiText("관계 없음")}</span>}
        </div>
      </div>
      <ChevronRight size={14} className="agg-chev" aria-hidden />
      {data.traffic > 0 && <div className="rnode-traffic" style={{ width: `${Math.max(8, data.traffic * 100)}%` }} aria-hidden />}
      <Handle type="source" position={Position.Right} className="rf-handle" isConnectable={false} />
    </div>
  );
}

export const AggregateNode = memo(AggregateNodeImpl);
