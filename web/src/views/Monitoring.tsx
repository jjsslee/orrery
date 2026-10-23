import { useEffect } from 'react';
import { Activity, Bell, Clock, LayoutDashboard, Search, RefreshCw } from 'lucide-react';
import { useStore } from '../model/store';
import { useMonitoringRefresh } from './useMonitoringRefresh';
import { MonitoringOverview } from './MonitoringOverview';
import { matchingAlarms, useMonitoring, type TimeRange } from '../model/monitoring';
import { fmtDateTime } from '../components/format';
import { RegionPrompt } from '../canvas/RegionPrompt';
import { MonitoringMetrics } from './MonitoringMetrics';
import { MonitoringResources } from './MonitoringResources';
import { SetupGuide } from '../canvas/SetupGuide';

const STATES: Record<string, string> = { ALL: '전체', ALARM: '발생 중', OK: '발생 중 경보 없음', INSUFFICIENT_DATA: '데이터 부족' };
export function Monitoring() {
  const profile = useStore((s) => s.profile), region = useStore((s) => s.region), setup = useStore((s) => s.setup);
  const connectionGeneration = useStore((s) => s.connectionGeneration);
  const connectionBusy = useStore((s) => s.loading.active);
  const connectionError = useStore((s) => s.loading.error);
  const m = useMonitoring();
  const tab = m.activeTab;
  const setTab = (activeTab: typeof m.activeTab) => useMonitoring.setState({ activeTab });
  useMonitoringRefresh();
  useEffect(() => { if (setup !== 'done') return; if (connectionBusy || connectionError) { m.activate('', ''); return () => m.deactivate(); } m.activate(profile, region); return () => m.deactivate(); }, [profile, region, setup, connectionGeneration, connectionBusy, connectionError]);
  if (setup === 'needed') return <SetupGuide />;
  if (!region) return <RegionPrompt />;
  const alarms = matchingAlarms(m.alarms?.alarms ?? [], m.query, m.stateFilter);
  const selected = m.selectedAlarm;
  const scope = m.alarms?.scope ?? m.resources?.scope;
  const scopeKey = scope ? JSON.stringify([scope.source, scope.account, scope.region]) : 'unverified';
  return <div className="monitoring">
    <header className="monitor-heading monitor-page-heading"><div><h1><Activity size={23} /> 모니터링</h1><p className="muted">관심 서비스의 경보와 지표를 같은 맥락에서 확인하세요.</p></div>
      <button type="button" className="btn" disabled={m.alarmLoading} onClick={() => void m.loadAlarms(true)}><RefreshCw size={14} className={m.alarmLoading ? 'spin' : ''} />{m.alarmLoading ? '경보 조회 중' : '경보 새로고침'}</button>
    </header>
    {m.scopeNotice && <p className="monitor-notice" role="alert">{m.scopeNotice}</p>}
    {connectionError && <p className="monitor-notice" role="alert">연결 확인 실패: {connectionError}</p>}
    <div className="monitor-controls">
      <label>기간 <select value={m.range} onChange={(e) => m.setRange(e.target.value as TimeRange)}><option value="1h">최근 1시간</option><option value="3h">최근 3시간</option><option value="24h">최근 24시간</option><option value="7d">최근 7일</option><option value="custom">직접 선택</option></select></label>
      {m.range === 'custom' && <><label>시작 <input type="datetime-local" value={m.customStart} onChange={(e) => m.setCustomTime('customStart', e.target.value)} /></label><label>종료 <input type="datetime-local" value={m.customEnd} onChange={(e) => m.setCustomTime('customEnd', e.target.value)} /></label><button type="button" className="btn" onClick={() => void m.loadHistory()}>기간 적용</button></>}
      <span className="muted">경보 목록은 현재 상태 · 기간은 경보 이력·지표에 적용</span>
    </div>
    <div className="monitor-workspace">
    <nav className="monitor-tabs" aria-label="모니터링 화면">
      {([
        ['overview', LayoutDashboard, '개요', '관심 서비스와 우선 확인', m.groups.length],
        ['alarms', Bell, '경보', '현재 상태와 발생 이력', m.alarms?.alarms.filter((a) => a.state === 'ALARM').length ?? 0],
        ['metrics', Activity, '지표', '시간을 맞춰 자원 비교', m.selectedResources.length],
        ['resources', Search, '자원 찾기', '태그 검색과 묶음 만들기', m.resources?.resources.length ?? 0],
      ] as const).map(([value, Icon, label, description, count]) => <button type="button" key={value} className={`monitor-nav-item ${tab === value ? 'on' : ''}`} aria-pressed={tab === value} onClick={() => setTab(value)}><Icon size={18} /><span><strong>{label}</strong><small>{description}</small></span><b>{count}</b></button>)}
      <div className="monitor-observation"><Clock size={14} /><strong>마지막 경보 확인</strong><span>{fmtDateTime(m.alarms?.observation.succeededAt) || '아직 확인하지 못함'}</span><p>24시간 감지·외부 알림은 AWS 경보가 담당합니다.</p></div>
    </nav>
    <div className="monitor-content">
    {tab === 'overview' ? <MonitoringOverview key={scopeKey} /> : tab === 'metrics' ? <MonitoringMetrics key={scopeKey} /> : tab === 'alarms' ? <>
      <div className="monitor-controls"><label>경보 검색 <input type="search" value={m.query} onChange={(e) => useMonitoring.setState({ query: e.target.value })} placeholder="이름·상태 이유" /></label><label>상태 <select value={m.stateFilter} onChange={(e) => useMonitoring.setState({ stateFilter: e.target.value })}>{Object.entries(STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      {m.alarmError && <p className="monitor-notice" role="alert">경보 조회 실패 · {m.alarms ? '이전 결과가 포함됩니다. ' : '경보 상태를 확인할 수 없습니다. '}{m.alarmError}</p>}
      {m.alarms && <p className="muted">조회 리전 {m.alarms.scope.region} · 마지막 성공 {fmtDateTime(m.alarms.observation.succeededAt) || '없음'} · {!m.alarms.complete ? '부분 결과 · ' : ''}{m.alarms.alarms.length}개 경보</p>}
      {!m.alarmLoading && !m.alarmError && alarms.length === 0 && <p className="monitor-empty">{m.alarms?.complete ? '현재 조건에 해당하는 경보가 없습니다.' : '관측 범위가 부족합니다. 조회 결과를 확인하세요.'}</p>}
      <div className="monitor-columns">
        <div className="monitor-card"><h2>경보 목록</h2><ul className="monitor-list">{alarms.map((a) => <li key={a.arn ?? `${a.region}:${a.type}:${a.name}`}><button type="button" className={`monitor-alarm ${selected?.name === a.name && selected?.region === a.region ? 'selected' : ''}`} onClick={() => m.selectAlarm(a)}><span className={`alarm-state state-${a.state}`}>{a.state}</span><strong>{a.name}</strong><span>{a.type === 'composite' ? '복합 경보' : '지표 경보'} · {a.region}</span><span>{a.reason ?? '상태 이유 없음'}</span><span className="muted">{fmtDateTime(a.stateUpdatedAt)}</span></button></li>)}</ul></div>
        <section className="monitor-card" aria-label="경보 상세">{selected ? <>
          <h2>{selected.name}</h2><p><span className={`alarm-state state-${selected.state}`}>{selected.state}</span> · {selected.type === 'composite' ? '복합 경보' : '지표 경보'}</p><p>{selected.reason}</p>{selected.description && <p>{selected.description}</p>}
          <dl className="monitor-props"><dt>상태 변경</dt><dd>{fmtDateTime(selected.stateUpdatedAt) || '제공되지 않음'}</dd><dt>임계값</dt><dd>{selected.comparisonOperator ?? '별도 조건'} {selected.threshold ?? '제공되지 않음'}</dd><dt>평가 주기 수</dt><dd>{selected.datapointsToAlarm ?? '–'} / {selected.evaluationPeriods ?? '–'}</dd><dt>결측 처리</dt><dd>{selected.treatMissingData ?? 'AWS 기본값'}</dd></dl>
          {!!selected.childAlarmNames?.length && <p className="muted">하위 경보: {selected.childAlarmNames.join(', ')}</p>}
          {selected.rule && <p><strong>복합 조건</strong><code className="monitor-code">{selected.rule}</code></p>}
          {selected.expressions?.map((expression, i) => <code className="monitor-code" key={i}>{expression}</code>)}
          {selected.metrics.map((metric, i) => <div className="monitor-code" key={i}>{metric.namespace} / {metric.metric} · {metric.stat} · {metric.period ? `${metric.period}초 집계` : '주기 미제공'}<br />{Object.entries(metric.dimensions).map(([key, value]) => `${key}=${value}`).join(', ')}</div>)}
          {selected.mapping === 'unresolved' && <p className="muted">연결 자원을 확정하지 못했습니다. 경보 조건 원문을 기준으로 확인하세요.</p>}
          {selected.resourceKeys.map((key) => { const resource = m.resources?.resources.find((r) => r.key === key); return <p key={key}>{resource ? resource.name : key}{resource && <button type="button" className="link-btn" onClick={() => useStore.getState().locate(resource.nodeId)}>지도에서 보기</button>}</p>; })}
          <h3>최근 상태 이력</h3>{m.historyLoading && <p role="status">이력 조회 중</p>}{m.historyError && <p role="alert" className="monitor-notice">이력 조회 실패: {m.historyError}</p>}
          <ul className="monitor-list">{m.history?.items.map((item, i) => <li key={i}><time>{fmtDateTime(item.timestamp)}</time><p>{item.type} · {item.summary}</p>{item.data && <details><summary>원문</summary><pre className="monitor-code">{item.data}</pre></details>}</li>)}</ul>
          {m.history && !m.history.items.length && !m.historyError && <p className="muted">선택 기간에 반환된 이력이 없습니다.</p>}
          {m.history?.nextToken && <button type="button" className="btn" disabled={m.historyLoading} onClick={() => void m.loadHistory(m.history?.nextToken)}>이력 더 보기</button>}
        </> : <p className="muted">경보를 선택하면 조건과 상태 이력을 확인할 수 있습니다.</p>}</section>
      </div>
    </> : <MonitoringResources key={scopeKey} />}
    </div>
    </div>
  </div>;
}
