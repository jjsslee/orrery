import type { MonitoringRelatedCandidate } from '@orrery/shared';
import { ArrowDownLeft, ArrowUpRight, GitBranch, Plus, RefreshCw, Tag, Check } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { fmtDateTime } from '../components/format';

function Candidate({ candidate }: { candidate: MonitoringRelatedCandidate }) {
  const m = useMonitoring();
  const { resource, reasons } = candidate;
  const selected = m.selectedResources.includes(resource.key);
  return <li className="mw-candidate"><div className="mw-resource-identity"><TypeIcon type={resource.type} size={17} /><div><strong>{resource.name}</strong><small>{TYPE_META[resource.type].label} · {resource.region}</small></div><button type="button" className={`mw-add ${selected ? 'chosen' : ''}`} aria-label={`${resource.name} ${selected ? '선택됨' : '추가'}`} disabled={selected || m.selectedResources.length >= 4} onClick={() => m.toggleResource(resource.key)}>{selected ? <Check size={14} /> : <Plus size={14} />}<span>{selected ? '선택됨' : '추가'}</span></button></div>
    <ul className="mw-evidence-list">{reasons.map((reason, index) => <li key={index}>{reason.kind === 'tag' ? <><Tag size={12} /><span className="mw-exact-tag"><strong>{reason.key}</strong><span>=</span><b>{reason.value || '(빈 값)'}</b></span></> : <>{reason.direction === 'incoming' ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}<span>{reason.direction === 'incoming' ? '기준 자원으로 들어오는 연결' : '기준 자원에서 나가는 연결'}<br /><strong>{EDGE_KIND_LABEL[reason.edgeKind] ?? reason.edgeKind}</strong>{reason.label ? ` · ${reason.label}` : ''}<small>구성에서 발견 · 직접 확인·추정 구분 미제공</small></span></>}</li>)}</ul>
    {resource.metricsSupported === false && <p className="mw-subtle">{resource.metricsUnsupportedReason ?? '이 유형은 제공되는 지표가 없습니다.'}</p>}
  </li>;
}

export function MonitoringRelated() {
  const m = useMonitoring();
  const reference = m.resources?.resources.find((resource) => resource.key === m.referenceResource);
  const related = m.related?.resourceKey === m.referenceResource ? m.related : undefined;
  const graph = related?.graph;
  return <aside className="mw-related-panel" aria-label="관련 자원 후보">
    <div className="mw-related-heading"><span className="mw-eyebrow">RELATED RESOURCES</span><h2>함께 볼 자원</h2><p>근거를 확인하고 필요한 자원만 추가하세요.</p></div>
    <div className="mw-reference">{reference ? <><TypeIcon type={reference.type} size={19} /><div><small>기준 자원</small><strong>{reference.name}</strong><span>{TYPE_META[reference.type].label}</span></div></> : <p>선택한 자원을 누르면 연결과 같은 태그를 찾아 보여드립니다.</p>}</div>
    {m.relatedError && <p className="monitor-notice" role="alert">관련 자원을 확인하지 못했습니다: {m.relatedError}</p>}
    <section className="mw-related-section" aria-label="선으로 연결된 자원"><div className="mw-section-heading"><h3><GitBranch size={15} />선으로 연결된 자원 <span>{related?.connected.length ?? 0}</span></h3>{reference && <button type="button" className="icon-btn" aria-label="자원 연결 다시 확인" disabled={m.relatedLoading} onClick={() => void m.loadRelated()}><RefreshCw size={13} className={m.relatedLoading ? 'spin' : ''} /></button>}</div>
      {graph?.state === 'loading' && <p className="mw-related-progress" role="status"><RefreshCw size={13} className="spin" />연결 구성 확인 중 · 지표는 먼저 표시합니다.</p>}
      {(graph?.state === 'partial' || graph?.state === 'error' || graph?.stale) && <p className="monitor-notice" role="status">{graph.state === 'error' ? '연결 조회 실패' : graph.stale ? '이전 구성의 연결이 포함됩니다' : '일부 연결만 확인했습니다'}{graph.observation?.error ? ` · ${graph.observation.error}` : ''}</p>}
      <ul className="mw-candidate-list">{related?.connected.map((candidate) => <Candidate key={candidate.resource.key} candidate={candidate} />)}</ul>
      {reference && !related?.connected.length && graph?.state === 'complete' && <p className="mw-subtle">현재 조회한 구성에서 선으로 연결된 자원을 찾지 못했습니다.</p>}
      {reference && !related?.connected.length && (!graph || graph.state === 'not-requested') && <p className="mw-subtle">구성 연결을 확인하고 있습니다. 태그 후보와 지표는 먼저 확인할 수 있습니다.</p>}
      {graph?.observation?.succeededAt && <p className="mw-subtle">구성 확인 {fmtDateTime(graph.observation.succeededAt)}</p>}
    </section>
    <section className="mw-related-section" aria-label="같은 태그의 자원"><div className="mw-section-heading"><h3><Tag size={15} />같은 태그의 자원 <span>{related?.sameTags.length ?? 0}</span></h3></div><p className="mw-subtle">태그의 키와 값이 정확히 일치하는 자원입니다.</p><ul className="mw-candidate-list">{related?.sameTags.map((candidate) => <Candidate key={candidate.resource.key} candidate={candidate} />)}</ul>{reference && !related?.sameTags.length && <p className="mw-subtle">조회된 태그 범위에서 일치하는 자원이 없습니다.</p>}{!!related?.tagCoverage.incompleteTypes.length && <p className="mw-subtle">일부 유형·태그가 미조회 상태입니다. 전체 자원의 일치 여부를 뜻하지 않습니다.</p>}</section>
    <p className="mw-relationship-note">연결과 태그는 함께 볼 대상을 찾는 근거입니다. 문제의 원인을 확정하지 않으며 후보를 자동으로 포함하지 않습니다.</p>
  </aside>;
}
