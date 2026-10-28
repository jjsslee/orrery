import { useState } from 'react';
import type { MonitoringRelatedCandidate, MonitoringRelatedReason } from '@orrery/shared';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, GitBranch, RefreshCw, Tag } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { TypeBadge } from '../components/TypeIcon';
import { fmtDateTime } from '../components/format';
import { SelectToggle } from './MonitoringSelection';

const PAGE = 20;
function Evidence({ reason }: { reason: MonitoringRelatedReason }) {
  if (reason.kind === 'tag') return <><Tag size={12} aria-hidden /><span>{reason.key}: {reason.value || '(빈 값)'}</span></>;
  const observation = reason.observation;
  const expired = observation?.lastConfirmedAt && Date.now() - Date.parse(observation.lastConfirmedAt) > 600_000;
  const state = observation?.state === 'absent' ? '부재 확인' : observation?.state === 'unverified' ? '재확인 실패·미조회' : observation?.state === 'current' ? expired ? '시간 경과' : '현재 확인' : '이전 형식·재확인 필요';
  return <div className="mw-relation-evidence">
    <span>{reason.direction === 'incoming' ? <ArrowDownLeft size={12} aria-hidden /> : <ArrowUpRight size={12} aria-hidden />} {reason.direction === 'incoming' ? '기준 자원으로 들어오는' : '기준 자원에서 나가는'} {EDGE_KIND_LABEL[reason.edgeKind]} · {state}</span>
    <span>{reason.evidence === 'configuration' ? 'AWS 구성 근거' : reason.evidence === 'identifier' ? '식별자 해석 · 사용 여부 미확인' : '근거 미확인'}</span>
    {reason.label && <span className="mw-condition">{reason.label}</span>}
    {observation?.lastConfirmedAt && <small>마지막 확인 {fmtDateTime(observation.lastConfirmedAt)}</small>}
    {observation?.lastAttemptAt && <small>최근 시도 {fmtDateTime(observation.lastAttemptAt)}</small>}
    {!!reason.sources?.length && <details><summary>조회 근거</summary><ul>{reason.sources.map((s,i) => <li key={i}>{s.collector} · {s.operation}{s.owner ? ` · ${s.owner}` : ''}</li>)}</ul></details>}
  </div>;
}

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
      <details className="mw-candidate-details">
        <summary>관계·태그 근거 {reasons.length}개</summary>
        <ul className="mw-evidence">{reasons.map((reason,index) => <li key={index}><Evidence reason={reason} /></li>)}</ul>
      </details>
    </div>
    {resource.metricsSupported === false ? <button type="button" className="btn ghost small" onClick={() => useMonitoring.getState().setReferenceResource(resource.key)}>구성 보기</button> : <SelectToggle resourceKey={resource.key} name={resource.name} />}
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
  const errorDetail = m.relatedError ?? graph?.observation?.error;
  const denied = /access.?denied|explicit deny|forbidden|not authorized/i.test(errorDetail ?? '');
  const failureCount = related?.coverage?.filter(c => c.state === 'failed' || c.state === 'partial').length ?? 0;
  return <aside className="mw-panel mw-related" aria-label="관련 자원 후보">
    <header className="mw-panel-head">
      <h2>관련 자원</h2>
      {reference && <button type="button" className="icon-btn" aria-label="자원 연결 다시 확인" title="전체 구성 다시 확인 (최대 1,000 SDK 호출·120초)" disabled={m.relatedLoading} onClick={() => void m.loadRelated()}><RefreshCw size={14} className={m.relatedLoading ? 'spin' : ''} /></button>}
    </header>
    <div className="mw-reference">{reference
      ? <><TypeBadge type={reference.type} /><div><small>기준 자원</small><strong>{reference.name}</strong><span>{TYPE_META[reference.type].label}</span></div></>
      : <p>함께 볼 자원을 선택하면 관련 후보가 표시됩니다.</p>}</div>
    {m.relatedError && <p className="monitor-notice" role="alert">관련 자원 요청을 완료하지 못했습니다. 아래 오류 상세를 확인하세요.</p>}

    {related?.historyPersistenceError && <p className="monitor-notice" role="status">변화 이력 저장 실패 · {related.historyPersistenceError}</p>}
    {!!related?.coverage?.length && <details className="mw-hint mw-coverage"><summary>수집 범위별 확인 결과</summary><ul>{related.coverage.map(c=><li key={c.key}>{c.collector} · {c.operation} · {c.state === 'complete' ? '완료' : '미완료'}{c.errorCode ? ` · ${c.errorCode}` : ''}</li>)}</ul></details>}
    <div className="mw-related-body">
      <details className="mw-related-help">
        <summary>관련 자원 안내</summary>
        <p className="mw-hint">구성 관계와 설정 참조를 구분합니다. 마지막 확인 시각이 실제 사용 시각을 뜻하지는 않습니다.</p>
        <p className="mw-hint">현재 구성 기준 후보입니다. 과거 기간의 실제 요청 추적이 아닙니다. 호스트 지표는 호스트 전체의 값입니다. 정책·소속 맥락은 공통 허브를 따라 확장하지 않습니다.</p>
        <p className="mw-hint">태그의 키와 값이 정확히 일치하는 자원입니다.</p>
        <p className="mw-hint">연결과 태그는 함께 볼 후보를 찾는 근거일 뿐 원인을 확정하지 않습니다. 직접 고른 자원만 추가됩니다.</p>
{related?.collectionBudget && <p className="mw-hint">전체 구성 조회 {related.collectionBudget.calls}/{related.collectionBudget.maxCalls} 구성 SDK 명령 · 제한 120초 (경보 조회·SDK 내부 재시도 별도). 관계 재확인은 전체 수집을 수행합니다.</p>}
      </details>
      <section className="mw-related-section" aria-label="선으로 연결된 자원">
        <h3><GitBranch size={14} aria-hidden />선으로 연결된 자원 <span className="mw-count tnum">{related?.connected.length ?? 0}</span></h3>
        {graph?.state === 'loading' && <p className="mw-progress" role="status"><RefreshCw size={13} className="spin" aria-hidden />연결 구성 확인 중 · 지표는 먼저 표시합니다.</p>}
        {(graph?.state === 'partial' || graph?.state === 'error' || graph?.stale) && <p className="monitor-notice" role="status">{graph.state === 'partial' ? '일부 구성만 확인했습니다. 확인된 관계는 아래에서 볼 수 있습니다.' : graph.state === 'error' ? '구성 재확인에 실패했습니다. 과거 확인 관계를 참고하세요.' : '구성 확인 후 시간이 지났습니다. 필요하면 다시 확인하세요.'}{denied && ' 일부 조회가 AWS 권한 정책으로 거부됐습니다.'}{failureCount > 0 && ` 미완료 조회 범위 ${failureCount}개.`}</p>}
        <CandidateList key={`c:${m.referenceResource}`} list={related?.connected ?? []} region={m.region} />
        {reference && !related?.connected.length && graph?.state === 'complete' && <p className="mw-empty-line">현재 조회한 구성에서 선으로 연결된 자원을 찾지 못했습니다.</p>}
        {reference && !related?.connected.length && (!graph || graph.state === 'not-requested') && <p className="mw-empty-line">구성 연결을 확인하고 있습니다. 태그 후보와 지표는 먼저 볼 수 있습니다.</p>}
        {graph?.observation?.succeededAt && <p className="mw-hint">구성 확인 {fmtDateTime(graph.observation.succeededAt)}</p>}
      </section>
      {related?.path && <section className="mw-related-section" aria-label="구성 경로">
        <h3>구성 경로</h3>
        <div className="mw-path-options">
          <label>관계 <select value={m.relatedGroup} onChange={e => m.setRelatedOptions(m.relatedDepth, e.target.value as 'execution' | 'context')}><option value="execution">전달·호스트</option><option value="context">소속·설정·정책 포함</option></select></label>
          <label>깊이 <select value={m.relatedDepth} onChange={e => m.setRelatedOptions(Number(e.target.value), m.relatedGroup)}>{[1,2,3].map(d => <option key={d} value={d}>{d}단계</option>)}</select></label>
        </div>
        {related.path.truncated && <p className="monitor-notice">한 페이지에 최대 60자원·120관계를 표시합니다. 다음 페이지 또는 아래 자원을 기준으로 범위를 좁혀 확인하세요.</p>}
        {!!related.path.offset && <button type="button" className="btn small" disabled={m.relatedLoading} onClick={() => void m.loadRelated(false)}>첫 경로 페이지</button>}
        {related.path.nextOffset !== undefined && <button type="button" className="btn small" disabled={m.relatedLoading} onClick={() => void m.loadRelated(false,true)}>다음 경로 페이지</button>}
        <ul className="mw-list">{related.path.nodes.filter(n => n.key !== m.referenceResource).map(resource => <li key={resource.key} className="mw-row">
          <div className="mw-row-main"><strong>{TYPE_META[resource.type].label}</strong><span>{resource.name}</span>
          <button type="button" className="btn ghost small" onClick={() => m.setReferenceResource(resource.key)}>이 자원 기준</button>
          <details><summary>경로의 조건·관계</summary><ul>{related.path!.edges.filter(e => e.source === resource.nodeId || e.target === resource.nodeId).map(e => <li key={e.id}><b>{related.path!.nodes.find(n => n.nodeId === e.source)?.name ?? e.source} → {related.path!.nodes.find(n => n.nodeId === e.target)?.name ?? e.target}</b><Evidence reason={{kind:'edge',direction:e.target === resource.nodeId ? 'incoming' : 'outgoing',edgeKind:e.kind,label:e.label,evidence:e.evidence?.[0]?.method ?? 'unknown',sources:e.evidence,observation:e.observation}} /></li>)}</ul></details>
          </div>{resource.metricsSupported === false ? <small>구성 전용 · 지표 없음</small> : <SelectToggle resourceKey={resource.key} name={resource.name} />}
        </li>)}</ul>
        {related.path.nodes.length <= 1 && <p className="mw-hint">이 범위에서 현재 근거가 있는 경로를 확인하지 못했습니다. 직접 관계·과거 관계도 확인하세요.</p>}
      </section>}
      {!!related?.historical?.length && <section className="mw-related-section"><details><summary>과거 확인 관계 {related.historical.length}개</summary><p className="mw-hint">현재 연결로 추천하지 않습니다. 다시 확인한 결과가 없거나 부재가 확인된 관계입니다.</p><ul>{related.historical.map(c => <li key={c.resource.key}><b>{c.resource.name}</b>{c.reasons.map((r,i) => <Evidence key={i} reason={r} />)}</li>)}</ul></details></section>}
      {!!related?.changes?.length && <section className="mw-related-section"><details><summary>구성 변화 관측 {related.changes.length}건</summary><p className="mw-hint">실제 변경 시각이 아닌 두 관측 사이의 구간입니다. 장애 원인을 확정하지 않습니다.</p><ul>{related.changes.slice().reverse().map(change => <li key={change.id}><b>{change.kind === 'added' ? '추가 확인' : change.kind === 'removed' ? '부재 확인' : '구성 변경 확인'}</b> {fmtDateTime(change.from)} ~ {fmtDateTime(change.to)}<p className="mw-condition">{change.label}</p></li>)}</ul></details></section>}
      <section className="mw-related-section" aria-label="같은 태그의 자원">
        <h3><Tag size={14} aria-hidden />같은 태그의 자원 <span className="mw-count tnum">{related?.sameTags.length ?? 0}</span></h3>
        <CandidateList key={`t:${m.referenceResource}`} list={related?.sameTags ?? []} region={m.region} />
        {reference && !related?.sameTags.length && <p className="mw-empty-line">조회된 태그 범위에서 일치하는 자원이 없습니다.</p>}
        {!!related?.tagCoverage.incompleteTypes.length && <p className="mw-hint">일부 유형·태그가 미조회 상태입니다. 전체 자원의 일치 여부를 뜻하지 않습니다.</p>}
      </section>
    </div>
    {errorDetail && <details className="mw-collection-errors"><summary>수집 오류 상세</summary><p className="mw-hint">전체 수집에서 발생한 오류이며, 모두 기준 자원과 직접 관련된 것은 아닙니다. 권한 정책은 변경하지 않습니다.</p><pre tabIndex={0} aria-label="수집 오류 원문">{errorDetail}</pre></details>}
  </aside>;
}
