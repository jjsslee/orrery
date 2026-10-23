import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, Clock, Layers, Tag } from 'lucide-react';
import type { SavedResourceGroup } from '@orrery/shared';
import { groupResources, groupHasIncompleteCoverage } from '../model/monitoring-groups';
import { useMonitoring } from '../model/monitoring';
import { useStore } from '../model/store';
import { fmtDateTime } from '../components/format';

export function MonitoringOverview() {
  const m = useMonitoring();
  const graph = useStore((s) => s.graph);
  const [editing, setEditing] = useState<SavedResourceGroup | null>(null);
  const [tagKey, setTagKey] = useState(''), [tagValue, setTagValue] = useState('');
  const [nameError, setNameError] = useState('');
  const editor = useRef<HTMLElement>(null);
  useEffect(() => { if (editing) editor.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [editing?.id]);
  const resources = m.resources?.resources ?? [];
  const tagKeys = [...new Set(resources.filter((r) => r.tagsStatus === 'complete').flatMap((r) => Object.keys(r.tags ?? {})))];
  const alarms = m.alarms?.alarms ?? [];
  const alarmCount = alarms.filter((alarm) => alarm.state === 'ALARM').length;
  const insufficient = alarms.filter((alarm) => alarm.state === 'INSUFFICIENT_DATA').length;
  const unknown = Boolean(m.alarmError || !m.alarms?.complete);
  const graphNeighbors = editing && graph ? [...new Set(graph.edges.flatMap((edge) => {
    const selected = new Set(resources.filter((r) => editing.resourceKeys.includes(r.key)).map((r) => r.nodeId));
    return selected.has(edge.source) ? [edge.target] : selected.has(edge.target) ? [edge.source] : [];
  }))].map((id) => resources.find((r) => r.nodeId === id)).filter((r) => r && !editing.resourceKeys.includes(r.key)) : [];
  return <>
    <div className="monitor-summary">
      <button type="button" className="monitor-card monitor-stat critical" onClick={() => useMonitoring.setState({ activeTab: 'alarms', stateFilter: 'ALARM' })}><Bell size={18} /><span>발생 중 경보</span><strong>{m.alarms ? alarmCount : '–'}</strong><small>{unknown ? '조회 범위 확인 필요' : '경보 상세 확인'}</small></button>
      <button type="button" className="monitor-card monitor-stat warning" onClick={() => useMonitoring.setState({ activeTab: 'alarms', stateFilter: 'INSUFFICIENT_DATA' })}><Clock size={18} /><span>데이터 부족 경보</span><strong>{m.alarms ? insufficient : '–'}</strong><small>관측되지 않은 상태 확인</small></button>
      <button type="button" className="monitor-card monitor-stat resources" onClick={() => useMonitoring.setState({ activeTab: 'resources' })}><Layers size={18} /><span>조회된 자원</span><strong>{resources.length}</strong><small>태그 미조회 {resources.filter((r) => r.tagsStatus !== 'complete').length}개</small></button>
    </div>
    <div className="monitor-overview-panels">
      <section className="monitor-card monitor-priority"><div className="monitor-section-title"><h2><Bell size={17} /> 먼저 확인할 경보</h2><button type="button" className="link-btn" onClick={() => useMonitoring.setState({ activeTab: 'alarms', stateFilter: 'ALL' })}>전체 경보 <ArrowRight size={13} /></button></div>
        {unknown && <p className="monitor-notice" role="status">{m.alarmError || '경보 조회를 완료하지 못했습니다. 이전 결과가 포함될 수 있습니다.'}</p>}
        <ul className="monitor-priority-list">{alarms.filter((a) => a.state !== 'OK').sort((a, b) => Number(b.state === 'ALARM') - Number(a.state === 'ALARM')).slice(0, 5).map((alarm) => <li key={alarm.arn ?? alarm.name}><button type="button" onClick={() => { m.selectAlarm(alarm); useMonitoring.setState({ activeTab: 'alarms' }); }}><span className={`alarm-state state-${alarm.state}`}>{alarm.state === 'ALARM' ? '발생 중' : '데이터 부족'}</span><strong>{alarm.name}</strong><small>{alarm.reason || '상태 이유가 제공되지 않았습니다.'}</small><ArrowRight size={14} /></button></li>)}</ul>
        {!alarms.some((a) => a.state !== 'OK') && !unknown && <div className="monitor-priority-empty"><Bell size={24} /><strong>발생 중·데이터 부족 경보 없음</strong><p>조회된 AWS 경보 기준입니다. 지표와 자원 조회 범위도 함께 확인하세요.</p></div>}
      </section>
      <section className="monitor-card monitor-changes"><div className="monitor-section-title"><h2><Clock size={17} /> 최근 상태 변경</h2></div><p className="muted">현재 경보 목록의 상태 변경 시각 기준입니다.</p><ol>{alarms.filter((a) => a.stateUpdatedAt).sort((a, b) => Date.parse(b.stateUpdatedAt!) - Date.parse(a.stateUpdatedAt!)).slice(0, 5).map((alarm) => <li key={alarm.arn ?? alarm.name}><time>{fmtDateTime(alarm.stateUpdatedAt)}</time><button type="button" onClick={() => { m.selectAlarm(alarm); useMonitoring.setState({ activeTab: 'alarms' }); }}>{alarm.name}</button><span className={`alarm-state state-${alarm.state}`}>{alarm.state}</span></li>)}</ol>{!alarms.some((a) => a.stateUpdatedAt) && <p className="muted">표시할 변경 시각이 없습니다. 경보 상세에서 이력을 조회할 수 있습니다.</p>}</section>
    </div>
    <div className="monitor-heading"><div><h2><Layers size={18} /> 관심 자원 묶음</h2><p className="muted">태그 조건과 수동 자원의 합집합입니다. 설정만 이 브라우저에 저장하며 계정·인증 소스·리전별로 분리합니다.</p></div><button type="button" className="btn" disabled={!m.alarms && !m.resources} onClick={() => { setEditing({ id: crypto.randomUUID(), name: '', tagFilters: [], resourceKeys: [...m.selectedResources] }); setNameError(''); }}>묶음 만들기</button></div>
    {m.groupsError && <p role="alert" className="monitor-notice">{m.groupsError}</p>}
    {!m.groups.length && <div className="monitor-empty monitor-group-empty"><Tag size={26} /><div><h3>태그와 관련 자원으로 관심 서비스를 만드세요</h3><p className="muted">같은 태그의 자원을 찾고, 태그 없는 큐나 데이터베이스도 추가할 수 있습니다.</p></div><button type="button" className="btn" onClick={() => useMonitoring.setState({ activeTab: 'resources' })}>태그로 자원 찾기 <ArrowRight size={14} /></button></div>}
    <div className="monitor-group-grid">{m.groups.map((group) => {
      const matched = groupResources(group, resources);
      const keys = new Set(matched.map((r) => r.key));
      const related = alarms.filter((alarm) => alarm.resourceKeys.some((key) => keys.has(key)));
      const active = related.filter((alarm) => alarm.state === 'ALARM');
      const missing = group.resourceKeys.filter((key) => !keys.has(key));
      return <article className="monitor-card" key={group.id}><h3>{group.name}</h3><div className="resource-tag-chips">{group.tagFilters.map((filter, i) => <span className="monitor-group-tag" key={i}><Tag size={11} />{filter.key}={filter.value ?? '모든 값'}</span>)}<span className="muted">수동 {group.resourceKeys.length}개</span></div><p>{active.length ? `발생 중 경보 ${active.length}개` : unknown || groupHasIncompleteCoverage(group, resources, m.resourceCoverage) ? '관측 범위가 부족합니다' : '발생 중 경보 없음'}</p><p className="muted">조회된 자원 {matched.length}개 · 미확인 수동 자원 {missing.length}개 · 태그 미조회 자원 {resources.filter((r) => r.tagsStatus !== 'complete').length}개</p>{missing.map((key) => { let complete = false; try { const type = JSON.parse(key)[2] as keyof typeof m.resourceCoverage; complete = Boolean(m.resourceCoverage[type]?.complete); } catch { /* old or unavailable key */ } return <p className="muted" key={key}>{complete ? '찾을 수 없음' : '자원 유형 미조회'} · {key}</p>; })}<p className="muted">마지막 경보 확인 {fmtDateTime(m.alarms?.observation.succeededAt) || '없음'}</p><div className="monitor-controls"><button type="button" className="btn" onClick={() => useMonitoring.setState({ activeGroup: group.id, activeTab: 'resources' })}>자원·지표 확인</button><button type="button" className="link-btn" onClick={() => { setEditing({ ...group, tagFilters: [...group.tagFilters], resourceKeys: [...group.resourceKeys] }); setNameError(''); }}>편집</button><button type="button" className="link-btn" onClick={() => m.deleteGroup(group.id)}>삭제</button></div>{active.map((alarm) => <button type="button" className="link-btn" key={alarm.name} onClick={() => { m.selectAlarm(alarm); useMonitoring.setState({ activeTab: 'alarms' }); }}>{alarm.name} 상세</button>)}</article>;
    })}</div>
    {editing && <section ref={editor} className="monitor-card monitor-group-editor" aria-label="관심 묶음 편집"><h3>관심 묶음 편집</h3><div className="monitor-controls"><label>묶음 이름 <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={80} /></label></div>{nameError && <p role="alert">{nameError}</p>}<h4>태그 조건</h4><p className="muted">같은 키는 OR, 다른 키는 AND입니다. 태그를 조회한 자원만 일치 여부를 확인합니다.</p><div className="monitor-controls"><label>태그 키 <input list="monitor-tag-keys" value={tagKey} onChange={(e) => setTagKey(e.target.value)} /></label><datalist id="monitor-tag-keys">{tagKeys.map((key) => <option key={key} value={key} />)}</datalist><label>값 <input value={tagValue} placeholder="비워두면 모든 값" onChange={(e) => setTagValue(e.target.value)} /></label><button type="button" className="btn" disabled={!tagKey.trim()} onClick={() => { setEditing({ ...editing, tagFilters: [...editing.tagFilters, { key: tagKey.trim(), ...(tagValue ? { value: tagValue } : {}) }] }); setTagKey(''); setTagValue(''); }}>조건 추가</button></div><ul className="monitor-list">{editing.tagFilters.map((filter, i) => <li key={i}>{filter.key} = {filter.value ?? '모든 값'} <button type="button" className="link-btn" onClick={() => setEditing({ ...editing, tagFilters: editing.tagFilters.filter((_f, index) => index !== i) })}>제거</button></li>)}</ul><h4>수동 포함 자원</h4>{!resources.length && <p className="muted">먼저 자원 찾기에서 자원 유형을 조회하세요.</p>}<ul className="monitor-list">{resources.map((resource) => <li key={resource.key}><label className="monitor-resource-check"><input type="checkbox" checked={editing.resourceKeys.includes(resource.key)} onChange={() => setEditing({ ...editing, resourceKeys: editing.resourceKeys.includes(resource.key) ? editing.resourceKeys.filter((key) => key !== resource.key) : [...editing.resourceKeys, resource.key] })} />{resource.name} · {resource.type}</label></li>)}</ul>{graphNeighbors.length > 0 && <><h4>지도에서 연결된 자원 후보</h4><p className="muted">연결은 원인 판정이 아닙니다. 선택한 후보만 수동 포함합니다.</p>{graphNeighbors.map((resource) => resource && <button type="button" className="btn" key={resource.key} onClick={() => setEditing({ ...editing, resourceKeys: [...editing.resourceKeys, resource.key] })}>{resource.name} 포함</button>)}</>}<div className="monitor-controls"><button type="button" className="btn primary" onClick={() => { if (!editing.name.trim()) { setNameError('묶음 이름을 입력하세요.'); return; } m.saveGroup({ ...editing, name: editing.name.trim() }); if (!useMonitoring.getState().groupsError) setEditing(null); }}>묶음 저장</button><button type="button" className="btn" onClick={() => setEditing(null)}>취소</button></div></section>}
  </>;
}
