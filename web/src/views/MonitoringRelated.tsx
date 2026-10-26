import { useState } from 'react';
import type { MonitoringRelatedCandidate } from '@orrery/shared';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, GitBranch, RefreshCw, Tag } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { TypeBadge } from '../components/TypeIcon';
import { fmtDateTime } from '../components/format';
import { SelectToggle } from './MonitoringSelection';

const PAGE = 20;
const ROW_REASONS = 3;

function Candidate({ candidate, region }: { candidate: MonitoringRelatedCandidate; region: string }) {
  const selected = useMonitoring((s) => s.selectedResources.includes(candidate.resource.key));
  const { resource, reasons } = candidate;
  return <li className={`mw-row ${selected ? 'is-selected' : ''}`}>
    <TypeBadge type={resource.type} />
    <div className="mw-row-main">
      <strong className="mw-row-name">{resource.name}</strong>
      <span className="mw-row-meta">
        {TYPE_META[resource.type].label}
        {resource.region !== region && <span>{resource.region}</span>}
        {resource.metricsSupported === false && <span className="mw-badge" title={resource.metricsUnsupportedReason ?? '이 유형은 제공되는 지표가 없습니다.'}>지표 없음</span>}
      </span>
      <ul className="mw-evidence">
        {reasons.slice(0, ROW_REASONS).map((reason, index) => <li key={index}>{reason.kind === 'tag'
          ? <><Tag size={12} aria-hidden /><span className="mw-evidence-tag"><span>{reason.key}</span><b>{reason.value || '(빈 값)'}</b></span></>
          : <>{reason.direction === 'incoming' ? <ArrowDownLeft size={12} aria-hidden /> : <ArrowUpRight size={12} aria-hidden />}<span>{reason.direction === 'incoming' ? '들어오는 연결' : '나가는 연결'} · <strong>{EDGE_KIND_LABEL[reason.edgeKind] ?? reason.edgeKind}</strong>{reason.label ? ` · ${reason.label}` : ''}</span></>}</li>)}
        {reasons.length > ROW_REASONS && <li className="mw-evidence-more">근거 {reasons.length - ROW_REASONS}개 더</li>}
      </ul>
    </div>
    <SelectToggle resourceKey={resource.key} name={resource.name} />
  </li>;
}

/** Resources with metrics first, so the useful candidates lead; order is otherwise kept. */
const metricsFirst = (list: MonitoringRelatedCandidate[]) => [...list].sort((a, b) => Number(a.resource.metricsSupported === false) - Number(b.resource.metricsSupported === false));

function CandidateList({ list, region }: { list: MonitoringRelatedCandidate[]; region: string }) {
  const [limit, setLimit] = useState(PAGE);
  if (!list.length) return null;
  return <ul className="mw-list">
    {metricsFirst(list).slice(0, limit).map((candidate) => <Candidate key={candidate.resource.key} candidate={candidate} region={region} />)}
    {list.length > limit && <li><button type="button" className="mw-more" onClick={() => setLimit(limit + PAGE)}><ChevronDown size={13} aria-hidden />{Math.min(PAGE, list.length - limit)}개 더 보기 <span>({list.length - limit}개 남음)</span></button></li>}
  </ul>;
}

/** Candidates around the reference resource, each with the evidence that put it here. */
export function MonitoringRelated() {
  const m = useMonitoring();
  const reference = m.resources?.resources.find((resource) => resource.key === m.referenceResource);
  const related = m.related?.resourceKey === m.referenceResource ? m.related : undefined;
  const graph = related?.graph;
  return <aside className="mw-panel mw-related" aria-label="관련 자원 후보">
    <header className="mw-panel-head">
      <h2>관련 자원</h2>
      {reference && <button type="button" className="icon-btn" aria-label="자원 연결 다시 확인" title="연결 다시 확인" disabled={m.relatedLoading} onClick={() => void m.loadRelated()}><RefreshCw size={14} className={m.relatedLoading ? 'spin' : ''} /></button>}
    </header>
    <div className="mw-reference">{reference
      ? <><TypeBadge type={reference.type} /><div><small>기준 자원</small><strong>{reference.name}</strong><span>{TYPE_META[reference.type].label}</span></div></>
      : <p>함께 보는 자원을 고르면, 그 자원과 선으로 연결되거나 태그가 같은 자원을 여기에서 찾아 드립니다.</p>}</div>
    {m.relatedError && <p className="monitor-notice" role="alert">관련 자원을 확인하지 못했습니다: {m.relatedError}</p>}

    <div className="mw-related-body">
      <section className="mw-related-section" aria-label="선으로 연결된 자원">
        <h3><GitBranch size={14} aria-hidden />선으로 연결된 자원 <span className="mw-count tnum">{related?.connected.length ?? 0}</span></h3>
        <p className="mw-hint">토폴로지 구성에서 찾은 연결입니다 (직접 확인·추정 구분 미제공).</p>
        {graph?.state === 'loading' && <p className="mw-progress" role="status"><RefreshCw size={13} className="spin" aria-hidden />연결 구성 확인 중 · 지표는 먼저 표시합니다.</p>}
        {(graph?.state === 'partial' || graph?.state === 'error' || graph?.stale) && <p className="monitor-notice" role="status">{graph.state === 'error' ? '연결 조회 실패' : graph.stale ? '이전 구성의 연결이 포함됩니다' : '일부 연결만 확인했습니다'}{graph.observation?.error ? ` · ${graph.observation.error}` : ''}</p>}
        <CandidateList key={`c:${m.referenceResource}`} list={related?.connected ?? []} region={m.region} />
        {reference && !related?.connected.length && graph?.state === 'complete' && <p className="mw-empty-line">현재 조회한 구성에서 선으로 연결된 자원을 찾지 못했습니다.</p>}
        {reference && !related?.connected.length && (!graph || graph.state === 'not-requested') && <p className="mw-empty-line">구성 연결을 확인하고 있습니다. 태그 후보와 지표는 먼저 볼 수 있습니다.</p>}
        {graph?.observation?.succeededAt && <p className="mw-hint">구성 확인 {fmtDateTime(graph.observation.succeededAt)}</p>}
      </section>
      <section className="mw-related-section" aria-label="같은 태그의 자원">
        <h3><Tag size={14} aria-hidden />같은 태그의 자원 <span className="mw-count tnum">{related?.sameTags.length ?? 0}</span></h3>
        <p className="mw-hint">태그의 키와 값이 정확히 일치하는 자원입니다.</p>
        <CandidateList key={`t:${m.referenceResource}`} list={related?.sameTags ?? []} region={m.region} />
        {reference && !related?.sameTags.length && <p className="mw-empty-line">조회된 태그 범위에서 일치하는 자원이 없습니다.</p>}
        {!!related?.tagCoverage.incompleteTypes.length && <p className="mw-hint">일부 유형·태그가 미조회 상태입니다. 전체 자원의 일치 여부를 뜻하지 않습니다.</p>}
      </section>
    </div>
    <p className="mw-footnote">연결과 태그는 함께 볼 후보를 찾는 근거일 뿐 원인을 확정하지 않습니다. 직접 고른 자원만 추가됩니다.</p>
  </aside>;
}
