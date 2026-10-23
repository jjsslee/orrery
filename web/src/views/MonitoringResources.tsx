import { useState } from 'react';
import type { MonitoringResourceType } from '@orrery/shared';
import { Check, Filter, Layers, LocateFixed, Plus, Search, Tag, X } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { useStore } from '../model/store';
import { appendResourceTag, emptyResourceFilters, filterMonitoringResources, MONITORING_RESOURCE_TYPES } from '../model/monitoring-resources';
import { groupResources } from '../model/monitoring-groups';
import { tagFilterLabel } from '../model/tags';
import { TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';

export function MonitoringResources() {
  const m = useMonitoring();
  const graph = useStore((s) => s.graph);
  const [type, setType] = useState<MonitoringResourceType>('lambda');
  const [tagKey, setTagKey] = useState(''), [tagValue, setTagValue] = useState('');
  const [saving, setSaving] = useState(false), [name, setName] = useState(''), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const filters = m.resourceFilters;
  const all = m.resources?.resources ?? [];
  const active = m.groups.find((group) => group.id === m.activeGroup);
  const candidates = active ? groupResources(active, all) : all;
  const visible = filterMonitoringResources(candidates, filters);
  const tagResultCount = filterMonitoringResources(candidates, { ...filters, tagStatus: 'all' }).length;
  const keys = [...new Set(all.filter((r) => r.tagsStatus === 'complete').flatMap((r) => Object.keys(r.tags ?? {})))].sort();
  const values = [...new Set(all.filter((r) => r.tagsStatus === 'complete' && r.tags?.[tagKey] !== undefined).map((r) => r.tags![tagKey]))].sort();
  const manual = all.filter((r) => m.resourceGroupKeys.includes(r.key));
  const draft = { id: '', name, tagFilters: filters.tags, resourceKeys: m.resourceGroupKeys };
  const included = groupResources(draft, all);
  const matched = groupResources({ ...draft, resourceKeys: [] }, all);
  const unknownTags = all.filter((r) => r.tagsStatus !== 'complete').length;
  const untagged = all.filter((r) => r.tagsStatus === 'complete' && !Object.keys(r.tags ?? {}).length).length;
  const updateFilters = (patch: Partial<typeof filters>) => useMonitoring.setState({ resourceFilters: { ...filters, ...patch } });
  const toggleManual = (key: string) => useMonitoring.setState({ resourceGroupKeys: m.resourceGroupKeys.includes(key) ? m.resourceGroupKeys.filter((item) => item !== key) : [...m.resourceGroupKeys, key] });
  const save = () => {
    if (!name.trim()) { setError('묶음 이름을 입력하세요.'); return; }
    m.saveGroup({ ...draft, id: crypto.randomUUID(), name: name.trim() });
    if (!useMonitoring.getState().groupsError) { setSaved(name.trim()); setSaving(false); setName(''); useMonitoring.setState({ resourceGroupKeys: [] }); }
  };
  return <>
    <section className="monitor-card resource-discovery">
      <div className="resource-title"><div><h2>태그로 조회</h2><p className="muted">태그 조건으로 자원을 찾고, 태그 없는 관련 자원을 추가해 하나의 묶음으로 관리하세요.</p></div><Tag size={24} aria-hidden /></div>
      <div className="resource-load-bar monitor-controls">
        <label>조회할 유형 <select aria-label="조회할 유형" value={type} onChange={(e) => setType(e.target.value as MonitoringResourceType)}>{MONITORING_RESOURCE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="btn" disabled={m.resourceLoading} onClick={() => void m.loadResources(type)}>{m.resourceLoading ? '목록 조회 중' : '선택 유형 조회'}</button>
        <button type="button" className="btn" disabled={m.resourceLoading} onClick={() => void m.loadResourceTypes(MONITORING_RESOURCE_TYPES.map(([value]) => value))}><Layers size={14} /> 지원 6유형 조회</button>
      </div>
      <div className="resource-coverage" aria-label="자원 조회 범위">{MONITORING_RESOURCE_TYPES.map(([value, label]) => <span key={value} className={m.resourceCoverage[value]?.complete ? 'observed' : ''}>{m.resourceCoverage[value]?.complete && <Check size={12} />}{label}<small>{!m.resourceCoverage[value] ? '미조회' : m.resourceCoverage[value]?.complete ? '확인' : '부분 결과'}</small></span>)}</div>
      <p className="resource-scope-note muted">선택한 계정·리전의 조회된 유형에만 필터를 적용합니다. 자원·태그 목록 조회는 지표를 읽지 않습니다.</p>
      {m.resourceError && <p className="monitor-notice" role="alert">일부 자원을 확인하지 못했습니다: {m.resourceError}</p>}
      {active && <div className="resource-active-group"><span><Layers size={14} /> {active.name} 안에서 찾는 중</span><button type="button" className="link-btn" onClick={() => useMonitoring.setState({ activeGroup: undefined })}>전체 자원에서 찾기</button></div>}
      <div className="resource-filter-grid monitor-controls">
        <label className="resource-name-search"><Search size={15} /><span className="sr-only">자원 검색</span><input type="search" value={filters.query} onChange={(e) => updateFilters({ query: e.target.value })} placeholder="이름 또는 식별자로 검색" /></label>
        <label>태그 키 <select aria-label="태그 키" value={tagKey} onChange={(e) => { setTagKey(e.target.value); setTagValue(''); }}><option value="">키 선택</option>{keys.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
        <label>태그 값 <select aria-label="태그 값" value={tagValue} disabled={!tagKey} onChange={(e) => setTagValue(e.target.value)}><option value="">모든 값</option>{values.map((value) => <option key={value} value={JSON.stringify(value)}>{value || '(빈 값)'}</option>)}</select></label>
        <button type="button" className="btn" disabled={!tagKey} onClick={() => { updateFilters({ tags: appendResourceTag(filters.tags, { key: tagKey, ...(tagValue ? { value: JSON.parse(tagValue) as string } : {}) }), tagStatus: 'all' }); setSaved(''); }}><Plus size={14} /> 태그 조건 추가</button>
      </div>
      <div className="resource-tag-chips" aria-label="적용한 태그 조건">{filters.tags.map((filter, index) => <button type="button" key={`${filter.key}:${filter.value ?? '*'}`} className="chip" onClick={() => updateFilters({ tags: filters.tags.filter((_f, i) => i !== index) })} aria-label={`${tagFilterLabel(filter)} 조건 제거`}><Tag size={12} />{tagFilterLabel(filter)}<X size={12} /></button>)}{filters.tags.length > 0 && <span className="muted">같은 키 OR · 다른 키 AND</span>}</div>
      <div className="resource-result-toolbar">
        <div className="resource-modes" aria-label="태그 확인 상태">
          {([['all', '태그 조건 결과', tagResultCount], ['untagged', '태그 없는 자원', untagged], ['unavailable', '태그 미조회', unknownTags]] as const).map(([value, label, count]) => <button type="button" key={value} className={filters.tagStatus === value ? 'on' : ''} aria-pressed={filters.tagStatus === value} onClick={() => updateFilters({ tagStatus: value })}>{label}<span>{count}</span></button>)}
        </div>
        <button type="button" className="link-btn" onClick={() => { useMonitoring.setState({ resourceFilters: emptyResourceFilters() }); setTagKey(''); setTagValue(''); }}><X size={12} /> 필터 초기화</button>
      </div>
      {filters.tagStatus !== 'all' && filters.tags.length > 0 && <p className="resource-scope-note muted">태그 조건은 유지됩니다. 여기서 체크한 자원은 태그 매칭 결과에 추가로 포함됩니다.</p>}
      <div className="resource-result-count"><span><Filter size={14} /> 조회 결과 <strong>{visible.length}</strong> / {candidates.length}개</span><span className="muted">체크는 묶음에 추가 · 비교는 최대 4개</span></div>
      {!all.length && !m.resourceLoading ? <div className="resource-empty"><Search size={28} /><h3>먼저 자원 목록을 조회하세요</h3><p>위에서 유형을 선택하면 태그 키·값과 관련 자원을 찾을 수 있습니다.</p></div> : <div className="resource-table-scroll"><table className="resource-table"><thead><tr><th><span className="sr-only">묶음에 추가</span></th><th>자원</th><th>태그</th><th>경보</th><th>동작</th></tr></thead><tbody>{visible.map((resource) => {
        const alarmCount = m.alarms?.alarms.filter((alarm) => alarm.state === 'ALARM' && alarm.resourceKeys.includes(resource.key)).length ?? 0;
        const compared = m.selectedResources.includes(resource.key);
        return <tr key={resource.key} className={m.resourceGroupKeys.includes(resource.key) ? 'picked' : ''}>
          <td><input type="checkbox" aria-label={`${resource.name} 묶음에 추가`} checked={m.resourceGroupKeys.includes(resource.key)} onChange={() => toggleManual(resource.key)} /></td>
          <td><div className="resource-identity"><TypeIcon type={resource.type} size={16} /><div><strong>{resource.name}</strong><small>{TYPE_META[resource.type].label} · {resource.nativeId}</small></div></div></td>
          <td><div className="resource-inline-tags">{resource.tagsStatus !== 'complete' ? <span className="resource-tag-unavailable">태그 미조회</span> : !Object.keys(resource.tags ?? {}).length ? <span className="muted">태그 없음</span> : Object.entries(resource.tags ?? {}).slice(0, 3).map(([key, value]) => <button type="button" key={key} title={`${key}=${value}`} onClick={() => updateFilters({ tags: appendResourceTag(filters.tags, { key, value }), tagStatus: 'all' })}>{key}<b>{value || '(빈 값)'}</b></button>)}{Object.keys(resource.tags ?? {}).length > 3 && <span className="muted">+{Object.keys(resource.tags!).length - 3}</span>}</div></td>
          <td>{alarmCount ? <span className="resource-alarm-count">{alarmCount} 발생</span> : <span className="muted">{m.alarms?.complete ? '발생 중 없음' : '확인 필요'}</span>}</td>
          <td><div className="resource-row-actions"><button type="button" className={`btn ${compared ? 'compared' : ''}`} disabled={!compared && m.selectedResources.length >= 4} onClick={() => m.toggleResource(resource.key)}>{compared ? <Check size={13} /> : <Plus size={13} />}{compared ? '비교 중' : '비교'}</button><button type="button" className="icon-btn" aria-label={`${resource.name} 지도에서 보기`} title={`지도에서 보기${!graph ? ' (구성 수집)' : ''}`} onClick={() => useStore.getState().locate(resource.nodeId)}><LocateFixed size={15} /></button></div></td>
        </tr>;
      })}</tbody></table>{!visible.length && all.length > 0 && <div className="resource-empty"><h3>일치하는 자원이 없습니다</h3><p>태그 조건이나 이름 검색을 바꾸거나 다른 유형을 조회하세요.</p></div>}</div>}
    </section>
    <section className="resource-group-tray monitor-card" aria-label="묶음에 추가할 자원">
      <div className="resource-tray-head"><div><h2><Layers size={17} /> 묶음에 추가할 자원</h2><p className="muted">태그 매칭 {matched.length}개 + 수동 포함 {manual.length}개 · 중복 제외 {included.length}개</p></div><button type="button" className="btn primary" disabled={!included.length || (!m.alarms && !m.resources)} onClick={() => { setSaving(true); setError(''); }}><Plus size={14} /> 이 조건으로 묶음 만들기</button></div>
      <div className="resource-tag-chips">{manual.map((resource) => <button type="button" className="chip" key={resource.key} onClick={() => toggleManual(resource.key)} aria-label={`${resource.name} 수동 포함 제거`}>{resource.name}<X size={12} /></button>)}</div>
      {saving && <div className="monitor-controls resource-save-group"><label>묶음 이름 <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) save(); }} placeholder="예: 위키 수집" /></label><button type="button" className="btn primary" onClick={save}>묶음 저장</button><button type="button" className="link-btn" onClick={() => setSaving(false)}>취소</button></div>}
      {(error || m.groupsError) && <p className="monitor-notice" role="alert">{error || m.groupsError}</p>}
      {saved && <p className="resource-saved" role="status"><Check size={14} /> {saved} 저장됨<button type="button" className="link-btn" onClick={() => useMonitoring.setState({ activeTab: 'overview' })}>관심 묶음 보기</button></p>}
      {m.selectedResources.length > 0 && <div className="resource-comparison-tray"><span>비교할 자원 <strong>{m.selectedResources.length}/4</strong></span><div>{m.selectedResources.map((key) => <button type="button" className="link-btn" key={key} onClick={() => m.toggleResource(key)}>{all.find((r) => r.key === key)?.name ?? '찾을 수 없음'}<X size={12} /></button>)}</div><button type="button" className="btn" onClick={() => useMonitoring.setState({ activeTab: 'metrics' })}>선택 자원 지표 보기</button></div>}
    </section>
  </>;
}
