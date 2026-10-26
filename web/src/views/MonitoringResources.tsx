import { useState } from 'react';
import { ChevronDown, Plus, RefreshCw, Search, Tag, X } from 'lucide-react';
import type { MonitoringResource } from '@orrery/shared';
import { useMonitoring } from '../model/monitoring';
import { appendResourceTag, emptyResourceFilters, filterMonitoringResources, MONITORING_RESOURCE_TYPES } from '../model/monitoring-resources';
import { tagFilterLabel } from '../model/tags';
import { TYPE_META } from '../model/types';
import { TypeBadge } from '../components/TypeIcon';
import { SelectToggle } from './MonitoringSelection';

const PAGE = 40;
const TYPE_ORDER = new Map<string, number>(MONITORING_RESOURCE_TYPES.map(([type], index) => [type, index]));
const ROW_TAGS = 2;

function ResultRow({ resource, onTag }: { resource: MonitoringResource; onTag(key: string, value: string): void }) {
  const chosen = useMonitoring((s) => s.selectedResources.includes(resource.key));
  const tags = Object.entries(resource.tags ?? {});
  return <li className={`mw-row ${chosen ? 'is-selected' : ''}`}>
    <TypeBadge type={resource.type} />
    <div className="mw-row-main">
      <strong className="mw-row-name">{resource.name}</strong>
      <span className="mw-row-meta">
        {TYPE_META[resource.type].label}
        {resource.nativeId !== resource.name && <span className="mono" title={resource.nativeId}>{resource.nativeId}</span>}
        {resource.metricsSupported === false && <span className="mw-badge" title={resource.metricsUnsupportedReason ?? '이 유형은 지표를 지원하지 않습니다.'}>지표 없음</span>}
        {resource.tagsStatus !== 'complete' && <span className="mw-badge is-warn" title="태그를 조회하지 못했습니다. 태그 조건으로 찾을 때 빠질 수 있습니다.">태그 미조회</span>}
      </span>
      {resource.tagsStatus === 'complete' && !!tags.length && <div className="mw-row-tags">
        {tags.slice(0, ROW_TAGS).map(([key, value]) => <button type="button" key={key} className="mw-tag" title={`${key}=${value} 조건으로 찾기`} onClick={() => onTag(key, value)}><span>{key}</span><b>{value || '(빈 값)'}</b></button>)}
        {tags.length > ROW_TAGS && <span className="mw-tag-more" title={tags.slice(ROW_TAGS).map(([key, value]) => `${key}=${value}`).join('\n')}>+{tags.length - ROW_TAGS}</span>}
      </div>}
    </div>
    <SelectToggle resourceKey={resource.key} name={resource.name} />
  </li>;
}

/** Find: search, type and tag conditions, then the matching resources to add. */
export function MonitoringResources() {
  const m = useMonitoring();
  const [type, setType] = useState('all');
  const [tagKey, setTagKey] = useState(''), [tagValue, setTagValue] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const filters = m.resourceFilters;
  const all = m.resources?.resources ?? [];
  const matched = filterMonitoringResources(all, filters);
  // Stable order (type, then name) so the list does not reshuffle as each type finishes loading.
  const visible = matched.filter((resource) => type === 'all' || resource.type === type)
    .sort((a, b) => (TYPE_ORDER.get(a.type) ?? 99) - (TYPE_ORDER.get(b.type) ?? 99) || a.name.localeCompare(b.name));
  const typeCounts = new Map<string, number>();
  for (const resource of matched) typeCounts.set(resource.type, (typeCounts.get(resource.type) ?? 0) + 1);
  const knownTagKeys = [...new Set(all.filter((resource) => resource.tagsStatus === 'complete').flatMap((resource) => Object.keys(resource.tags ?? {})))].sort();
  const knownTagValues = [...new Set(all.filter((resource) => resource.tagsStatus === 'complete' && resource.tags?.[tagKey] !== undefined).map((resource) => resource.tags![tagKey]))].sort();
  const extraTypes = [...new Set(all.map((resource) => resource.type))].filter((value) => !MONITORING_RESOURCE_TYPES.some(([known]) => known === value));
  const filtered = Boolean(filters.query || filters.tags.length || type !== 'all');
  const covered = MONITORING_RESOURCE_TYPES.filter(([value]) => m.resourceCoverage[value]?.complete).length;
  const updateFilters = (patch: Partial<typeof filters>) => { setLimit(PAGE); useMonitoring.setState({ resourceFilters: { ...filters, ...patch } }); };
  const addTag = (key: string, value?: string) => updateFilters({ tags: appendResourceTag(filters.tags, { key, ...(value !== undefined ? { value } : {}) }), tagStatus: 'all' });

  return <aside className="mw-panel mw-find" aria-label="자원 검색과 선택">
    <header className="mw-panel-head">
      <h2>자원 찾기</h2>
      <button type="button" className="icon-btn" aria-label="자원 목록 새로고침" title="자원 목록 새로고침" disabled={m.resourceLoading} onClick={() => void m.loadResourceTypes(MONITORING_RESOURCE_TYPES.map(([value]) => value), true)}><RefreshCw size={14} className={m.resourceLoading ? 'spin' : ''} /></button>
    </header>

    <div className="mw-find-controls">
      <label className="mw-search">
        <Search size={15} aria-hidden />
        <input aria-label="자원 검색" type="search" placeholder="이름, 식별자, 태그 값" value={filters.query} onChange={(e) => updateFilters({ query: e.target.value })} />
        {filters.query && <button type="button" className="mw-search-clear" aria-label="검색어 지우기" onClick={() => updateFilters({ query: '' })}><X size={13} /></button>}
      </label>
      <label className="mw-select">
        <span>유형</span>
        <select aria-label="자원 유형 필터" value={type} onChange={(e) => { setType(e.target.value); setLimit(PAGE); }}>
          <option value="all">전체 유형 ({matched.length})</option>
          {MONITORING_RESOURCE_TYPES.map(([value, label]) => <option key={value} value={value}>{label} ({typeCounts.get(value) ?? 0})</option>)}
          {extraTypes.map((value) => <option key={value} value={value}>{TYPE_META[value].label} ({typeCounts.get(value) ?? 0})</option>)}
        </select>
        <ChevronDown size={14} aria-hidden />
      </label>
      <details className="mw-tag-picker" open>
        <summary><Tag size={13} aria-hidden />태그 조건</summary>
        <div className="mw-tag-picker-fields">
          <select aria-label="태그 키" value={tagKey} onChange={(e) => { setTagKey(e.target.value); setTagValue(''); }}><option value="">키 선택</option>{knownTagKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select>
          <select aria-label="태그 값" value={tagValue} disabled={!tagKey} onChange={(e) => setTagValue(e.target.value)}><option value="">모든 값</option>{knownTagValues.map((value) => <option key={value} value={JSON.stringify(value)}>{value || '(빈 값)'}</option>)}</select>
          <button type="button" className="btn small" disabled={!tagKey} aria-label="태그 조건 추가" onClick={() => addTag(tagKey, tagValue ? JSON.parse(tagValue) as string : undefined)}><Plus size={13} aria-hidden />추가</button>
        </div>
      </details>
      {!!filters.tags.length && <div className="mw-active-filters">
        <div className="tag-chips">{filters.tags.map((filter, i) => <button type="button" className="chip" key={`${filter.key}:${filter.value ?? '*'}`} onClick={() => updateFilters({ tags: filters.tags.filter((_filter, index) => index !== i) })} aria-label={`${tagFilterLabel(filter)} 조건 제거`}><Tag size={11} aria-hidden />{tagFilterLabel(filter)}<X size={11} aria-hidden /></button>)}</div>
        <p className="mw-hint">같은 키는 값 하나만 맞아도, 다른 키는 모두 맞아야 합니다.</p>
      </div>}
      {m.resourceError && <p className="monitor-notice" role="alert">자원 목록 일부를 조회하지 못했습니다: {m.resourceError}</p>}
    </div>

    <section className="mw-results" aria-label="자원 검색 결과">
      <div className="mw-results-head">
        <h3>검색 결과 <span className="mw-count tnum">{visible.length}</span></h3>
        {m.resourceLoading && <span className="mw-hint" role="status"><RefreshCw size={12} className="spin" aria-hidden /> 목록 확인 중</span>}
        {filtered && <button type="button" className="link-btn" onClick={() => { setLimit(PAGE); useMonitoring.setState({ resourceFilters: emptyResourceFilters() }); setType('all'); }}>조건 초기화</button>}
      </div>
      {m.resourceLoading && !all.length ? <div className="mw-empty"><RefreshCw size={20} className="spin" aria-hidden /><p>Lambda, SQS, ALB, ECS, EC2, RDS 목록을 불러오고 있습니다.</p></div>
        : !all.length ? <div className="mw-empty"><Search size={20} aria-hidden /><h4>{m.resourceError ? '자원 목록을 확인하지 못했습니다' : '조회된 자원이 없습니다'}</h4><p>{m.resourceError ? '권한과 연결 상태를 확인한 뒤 새로고침하세요.' : '선택한 계정·리전에 지원 유형의 자원이 있는지 확인하세요.'}</p></div>
        : !visible.length ? <div className="mw-empty"><Search size={20} aria-hidden /><h4>일치하는 자원이 없습니다</h4><p>검색어나 조건을 바꿔 보세요. 함께 보는 자원은 그대로 유지됩니다.</p></div>
        : <ul className="mw-list">
          {visible.slice(0, limit).map((resource) => <ResultRow key={resource.key} resource={resource} onTag={(key, value) => addTag(key, value)} />)}
          {visible.length > limit && <li><button type="button" className="mw-more" onClick={() => setLimit(limit + PAGE)}><ChevronDown size={13} aria-hidden />{Math.min(PAGE, visible.length - limit)}개 더 보기 <span>({visible.length - limit}개 남음)</span></button></li>}
        </ul>}
    </section>

    <details className="mw-coverage">
      <summary>조회 범위 {covered}/{MONITORING_RESOURCE_TYPES.length}유형{m.resourceLoading ? ' · 확인 중' : ''}</summary>
      <ul>{MONITORING_RESOURCE_TYPES.map(([value, label]) => <li key={value}><span>{label}</span><span>{!m.resourceCoverage[value] ? m.resourceLoading ? '조회 대기' : '미조회' : m.resourceCoverage[value]?.complete ? '목록 확인' : '일부 실패'}</span></li>)}</ul>
      <p>현재 계정·리전의 목록입니다. 태그 권한이 없는 자원은 태그 검색에서 빠질 수 있습니다.</p>
    </details>
  </aside>;
}
