import { useState } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, Save, Search, Tag, X } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { appendResourceTag, emptyResourceFilters, filterMonitoringResources, MONITORING_RESOURCE_TYPES } from '../model/monitoring-resources';
import { tagFilterLabel } from '../model/tags';
import { TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';

export function MonitoringResources() {
  const m = useMonitoring();
  const [type, setType] = useState('all');
  const [tagKey, setTagKey] = useState(''), [tagValue, setTagValue] = useState('');
  const [name, setName] = useState(''), [saveOpen, setSaveOpen] = useState(false), [savedName, setSavedName] = useState('');
  const filters = m.resourceFilters;
  const all = m.resources?.resources ?? [];
  const visible = filterMonitoringResources(all, filters).filter((resource) => type === 'all' || resource.type === type);
  const knownTagKeys = [...new Set(all.filter((resource) => resource.tagsStatus === 'complete').flatMap((resource) => Object.keys(resource.tags ?? {})))].sort();
  const knownTagValues = [...new Set(all.filter((resource) => resource.tagsStatus === 'complete' && resource.tags?.[tagKey] !== undefined).map((resource) => resource.tags![tagKey]))].sort();
  const extraTypes = [...new Set(all.map((resource) => resource.type))].filter((value) => !MONITORING_RESOURCE_TYPES.some(([known]) => known === value));
  const selected = m.selectedResources.map((key) => ({ key, resource: all.find((resource) => resource.key === key) }));
  const updateFilters = (patch: Partial<typeof filters>) => useMonitoring.setState({ resourceFilters: { ...filters, ...patch } });
  const save = () => {
    if (!name.trim()) return;
    m.saveSelection(name.trim());
    if (!useMonitoring.getState().groupsError) { setSavedName(name.trim()); setName(''); setSaveOpen(false); }
  };
  return <aside className="mw-search-panel" aria-label="자원 검색과 선택">
    <section className="mw-search-section">
      <div className="mw-section-heading"><h2>자원 찾기</h2><button type="button" className="icon-btn" aria-label="자원 목록 새로고침" disabled={m.resourceLoading} onClick={() => void m.loadResourceTypes(MONITORING_RESOURCE_TYPES.map(([value]) => value), true)}><RefreshCw size={14} className={m.resourceLoading ? 'spin' : ''} /></button></div>
      <label className="mw-search-input"><Search size={16} /><input aria-label="자원 검색" type="search" placeholder="이름, 식별자, 태그로 검색" value={filters.query} onChange={(e) => updateFilters({ query: e.target.value })} /></label>
      <label className="mw-type-select"><span>유형</span><select aria-label="자원 유형 필터" value={type} onChange={(e) => setType(e.target.value)}><option value="all">전체 유형</option>{MONITORING_RESOURCE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}{extraTypes.map((value) => <option key={value} value={value}>{TYPE_META[value].label}</option>)}</select><ChevronDown size={12} aria-hidden /></label>
      <details className="mw-tag-picker" open><summary><Tag size={12} />태그로 찾기</summary><div className="mw-tag-picker-fields"><label>태그 키<select aria-label="태그 키" value={tagKey} onChange={(e) => { setTagKey(e.target.value); setTagValue(''); }}><option value="">키 선택</option>{knownTagKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label><label>태그 값<select aria-label="태그 값" value={tagValue} disabled={!tagKey} onChange={(e) => setTagValue(e.target.value)}><option value="">모든 값</option>{knownTagValues.map((value) => <option key={value} value={JSON.stringify(value)}>{value || '(빈 값)'}</option>)}</select></label></div><button type="button" className="btn" disabled={!tagKey} onClick={() => updateFilters({ tags: appendResourceTag(filters.tags, { key: tagKey, ...(tagValue ? { value: JSON.parse(tagValue) as string } : {}) }), tagStatus: 'all' })}><Plus size={12} />태그 조건 추가</button><p className="mw-subtle">같은 키 OR · 다른 키 AND</p></details>
      {!!filters.tags.length && <div className="mw-tag-filters">{filters.tags.map((filter, i) => <button type="button" key={`${filter.key}:${filter.value ?? '*'}`} onClick={() => updateFilters({ tags: filters.tags.filter((_filter, index) => index !== i) })} aria-label={`${tagFilterLabel(filter)} 조건 제거`}><Tag size={11} />{tagFilterLabel(filter)}<X size={11} /></button>)}</div>}
      {(filters.query || filters.tags.length || type !== 'all') && <button type="button" className="link-btn mw-clear-filter" onClick={() => { useMonitoring.setState({ resourceFilters: emptyResourceFilters() }); setType('all'); }}>검색 초기화</button>}
      <details className="mw-coverage"><summary>조회 범위 · {m.resources?.types.length ?? 0}/6유형 {m.resourceLoading ? '확인 중' : '확인'}</summary><ul>{MONITORING_RESOURCE_TYPES.map(([value, label]) => <li key={value}><span>{label}</span><span>{!m.resourceCoverage[value] ? m.resourceLoading ? '조회 대기' : '미조회' : m.resourceCoverage[value]?.complete ? '목록 확인' : '일부 실패'}</span></li>)}</ul><p>현재 계정·리전의 목록입니다. 태그 권한이 없으면 검색 범위에 포함되지 않을 수 있습니다.</p></details>
      {m.resourceError && <p className="monitor-notice" role="alert">자원 목록 일부 조회 실패: {m.resourceError}</p>}
    </section>

    <section className="mw-selected-section" aria-label="선택한 자원">
      <div className="mw-section-heading"><h2>선택한 자원 <span>{selected.length}/4</span></h2><button type="button" className="icon-btn" aria-label="현재 선택 저장" disabled={!selected.length} onClick={() => { setSaveOpen(!saveOpen); setSavedName(''); }}><Save size={14} /></button></div>
      {!selected.length && <p className="mw-subtle">목록에서 추가하면 지표와 경보가 이 화면에 나타납니다.</p>}
      <ul className="mw-picked-list">{selected.map(({ key, resource }) => <li key={key} className={m.referenceResource === key ? 'is-reference' : ''}><button type="button" className="mw-picked-resource" onClick={() => m.setReferenceResource(key)} aria-pressed={m.referenceResource === key} aria-label={`${resource?.name ?? '찾을 수 없음'} 관련 자원 보기`}>{resource && <TypeIcon type={resource.type} size={15} />}<span><strong>{resource?.name ?? '찾을 수 없음'}</strong><small>{m.referenceResource === key ? '관련 자원의 기준' : '클릭하여 관련 자원 찾기'}</small></span></button><button type="button" className="icon-btn" aria-label={`${resource?.name ?? key} 제거`} onClick={() => m.toggleResource(key)}><X size={13} /></button></li>)}</ul>
      {selected.length >= 4 && <p className="mw-subtle">한 번에 최대 4개까지 관측합니다.</p>}
      {saveOpen && <form className="mw-save-form" onSubmit={(e) => { e.preventDefault(); save(); }}><label>구성 이름<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="예: 위키 수집" /></label><div><button type="submit" className="btn primary" disabled={!name.trim()}>구성 저장</button><button type="button" className="link-btn" onClick={() => setSaveOpen(false)}>취소</button></div></form>}
      {savedName && <p className="mw-save-success" role="status"><Check size={12} />{savedName} 저장됨</p>}
      {m.groupsError && <p className="monitor-notice" role="alert">{m.groupsError}</p>}
      <label className="mw-restore"><span>저장한 구성 불러오기</span><select aria-label="저장한 구성 불러오기" value="" onChange={(e) => { if (e.target.value) void m.restoreGroup(e.target.value); }}><option value="">구성 선택{m.groups.length ? ` · ${m.groups.length}개` : ' · 저장된 구성 없음'}</option>{m.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      {m.restoreNotice && <p className="monitor-notice" role="status">{m.restoreNotice}</p>}
      {!!m.restoreCandidates.length && <div className="mw-restore-candidates" aria-label="저장 구성의 선택 후보"><p className="mw-subtle">저장된 대상 중 최대 4개를 추가하세요.</p><ul className="mw-resource-list">{m.restoreCandidates.map((key) => { const resource = all.find((item) => item.key === key); const chosen = m.selectedResources.includes(key); return <li key={key}><div className="mw-resource-identity"><div><strong>{resource?.name ?? '찾을 수 없음'}</strong><small>{resource ? TYPE_META[resource.type].label : key}</small></div><button type="button" className={`mw-add ${chosen ? 'chosen' : ''}`} aria-label={`${resource?.name ?? key} 저장 구성에서 추가`} disabled={chosen || m.selectedResources.length >= 4} onClick={() => m.toggleResource(key)}>{chosen ? <Check size={13} /> : <Plus size={13} />}{chosen ? '선택됨' : '추가'}</button></div></li>; })}</ul></div>}
      {!!m.restoreMissingKeys.length && <details className="mw-missing"><summary>복원하지 못한 자원 {m.restoreMissingKeys.length}개</summary><ul>{m.restoreMissingKeys.map((key) => <li key={key}>{key}</li>)}</ul></details>}
    </section>

    <section className="mw-results-section" aria-label="자원 검색 결과">
      <div className="mw-section-heading"><h2>검색 결과 <span>{visible.length}</span></h2>{m.resourceLoading && <span className="mw-subtle" role="status">목록 확인 중</span>}</div>
      {m.resourceLoading && !all.length ? <div className="mw-empty"><RefreshCw size={22} className="spin" /><p>지원 6유형의 자원을 찾고 있습니다.</p></div> : !all.length ? <div className="mw-empty"><Search size={24} /><h3>{m.resourceError ? '자원 목록을 확인하지 못했습니다' : '조회된 자원이 없습니다'}</h3><p>{m.resourceError ? '권한·연결 상태를 확인하고 목록을 다시 조회하세요.' : '선택한 계정·리전과 조회 범위를 확인하세요.'}</p></div> : !visible.length ? <div className="mw-empty"><Search size={22} /><h3>일치하는 자원이 없습니다</h3><p>검색어나 태그 조건을 바꿔 보세요. 선택한 자원은 유지됩니다.</p></div> : <ul className="mw-resource-list">{visible.map((resource) => {
        const chosen = m.selectedResources.includes(resource.key);
        return <li key={resource.key} className={chosen ? 'is-selected' : ''}><div className="mw-resource-identity"><TypeIcon type={resource.type} size={17} /><div><strong>{resource.name}</strong><small title={resource.nativeId}>{TYPE_META[resource.type].label} · {resource.nativeId}</small></div><button type="button" className={`mw-add ${chosen ? 'chosen' : ''}`} aria-label={`${resource.name} ${chosen ? '선택됨' : '추가'}`} disabled={chosen || selected.length >= 4} onClick={() => m.toggleResource(resource.key)}>{chosen ? <Check size={14} /> : <Plus size={14} />}<span>{chosen ? '선택됨' : '추가'}</span></button></div><div className="mw-resource-tags">{resource.tagsStatus !== 'complete' ? <span className="mw-tag-unavailable">태그 미조회</span> : !Object.keys(resource.tags ?? {}).length ? <span>태그 없음</span> : Object.entries(resource.tags ?? {}).slice(0, 3).map(([key, value]) => <button type="button" key={key} title={`${key}=${value}`} onClick={() => updateFilters({ tags: appendResourceTag(filters.tags, { key, value }), tagStatus: 'all' })}><span>{key}</span><b>{value || '(빈 값)'}</b></button>)}</div>{resource.metricsSupported === false && <p className="mw-subtle">{resource.metricsUnsupportedReason ?? '이 유형은 지표를 지원하지 않습니다.'}</p>}</li>;
      })}</ul>}
    </section>
  </aside>;
}
