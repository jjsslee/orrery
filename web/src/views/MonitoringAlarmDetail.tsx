import type { AlarmRecord } from '@orrery/shared';
import { Bell, ChevronDown, X } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { fmtDateTime } from '../components/format';

const STATE_LABEL: Record<AlarmRecord['state'], string> = { ALARM: '경보', OK: '정상', INSUFFICIENT_DATA: '데이터 부족' };

/** Alarm state as a labelled chip: colour backs the word, never replaces it. */
export function AlarmState({ state }: { state: AlarmRecord['state'] }) {
  return <span className={`alarm-state state-${state}`} title={state}>{STATE_LABEL[state] ?? state}</span>;
}

export function MonitoringAlarmDetail({ alarm }: { alarm: AlarmRecord }) {
  const m = useMonitoring();
  return <section className="mw-alarm-detail" aria-label={`${alarm.name} 경보 상세`}>
    <div className="mw-alarm-detail-head"><h4>{alarm.name}</h4><button type="button" className="icon-btn" aria-label="경보 상세 닫기" onClick={() => m.selectAlarm(undefined)}><X size={14} /></button></div>
    <p className="mw-alarm-summary"><AlarmState state={alarm.state} /><span>{alarm.type === 'composite' ? '복합 경보' : '지표 경보'} · {alarm.region}</span></p>
    {alarm.reason && <p>{alarm.reason}</p>}
    {alarm.description && <p className="mw-hint">{alarm.description}</p>}
    <dl className="monitor-props"><dt>상태 변경</dt><dd>{fmtDateTime(alarm.stateUpdatedAt) || '제공되지 않음'}</dd><dt>임계값</dt><dd>{alarm.comparisonOperator ?? '별도 조건'} {alarm.threshold ?? '제공되지 않음'}</dd><dt>평가 주기 수</dt><dd>{alarm.datapointsToAlarm ?? '–'} / {alarm.evaluationPeriods ?? '–'}</dd><dt>결측 처리</dt><dd>{alarm.treatMissingData ?? 'AWS 기본값'}</dd></dl>
    {!!alarm.childAlarmNames?.length && <p className="mw-hint">하위 경보: {alarm.childAlarmNames.join(', ')}</p>}
    {alarm.rule && <div><h5>복합 조건</h5><code className="monitor-code">{alarm.rule}</code></div>}
    {alarm.expressions?.map((expression, i) => <code className="monitor-code" key={i}>{expression}</code>)}
    {alarm.metrics.map((metric, i) => <div className="monitor-code" key={i}>{metric.namespace} / {metric.metric} · {metric.stat} · {metric.period ? `${metric.period}초 집계` : '주기 미제공'}<br />{Object.entries(metric.dimensions).map(([key, value]) => `${key}=${value}`).join(', ')}</div>)}
    <h5>선택 기간의 상태 이력</h5>
    {m.historyLoading && <p className="mw-hint" role="status">이력 조회 중</p>}
    {m.historyError && <p role="alert" className="monitor-notice">이력 조회 실패: {m.historyError}</p>}
    <ul className="mw-history-list">{m.history?.items.map((item, i) => <li key={i}><time>{fmtDateTime(item.timestamp)}</time><p>{item.type} · {item.summary}</p>{item.data && <details><summary>원문</summary><pre className="monitor-code">{item.data}</pre></details>}</li>)}</ul>
    {m.history && !m.history.items.length && !m.historyError && <p className="mw-hint">선택 기간에 반환된 이력이 없습니다.</p>}
    {m.history?.nextToken && <button type="button" className="btn small" disabled={m.historyLoading} onClick={() => void m.loadHistory(m.history?.nextToken)}>이력 더 보기</button>}
  </section>;
}

export function MonitoringResourceAlarms({ resourceKey }: { resourceKey: string }) {
  const m = useMonitoring();
  const resource = m.resources?.resources.find((item) => item.key === resourceKey);
  const alarms = m.alarms?.alarms.filter((alarm) => alarm.resourceKeys.includes(resourceKey)) ?? [];
  const selected = alarms.find((alarm) => alarm.name === m.selectedAlarm?.name && alarm.type === m.selectedAlarm.type && alarm.region === m.selectedAlarm.region);
  const firing = alarms.filter((alarm) => alarm.state === 'ALARM').length;
  return <section className={`mw-card-alarms ${firing ? 'has-alarm' : ''}`} aria-label="자원 관련 경보">
    <div className="mw-card-section-head">
      <h4><Bell size={13} aria-hidden />관련 경보 <span className="mw-count tnum">{alarms.length}</span>{firing > 0 && <span className="alarm-state state-ALARM">경보 {firing}</span>}</h4>
      {m.alarmLoading && <small className="mw-hint" role="status">경보 확인 중</small>}
    </div>
    {resource?.alarmScopeWarning && <p role="status" className="monitor-notice">{resource.alarmScopeWarning}</p>}
    {resource?.alarmMappingSupported === false && <p className="monitor-notice">이 유형의 경보 연결은 지원되지 않아 경보 유무를 판단할 수 없습니다.</p>}
    {!alarms.length && resource?.alarmMappingSupported !== false && <p className="mw-hint">{m.alarmError || !m.alarms?.complete ? '경보 조회 범위가 부족하여 상태를 확인할 수 없습니다.' : '이 자원에 매핑된 경보가 없습니다. 경보가 없다고 정상이라는 뜻은 아니니 지표도 함께 확인하세요.'}</p>}
    {!!alarms.length && <ul className="mw-alarm-list">{alarms.map((alarm) => <li key={alarm.arn ?? `${alarm.type}:${alarm.name}`}><button type="button" onClick={() => m.selectAlarm(selected === alarm ? undefined : alarm)} aria-expanded={selected === alarm}><AlarmState state={alarm.state} /><strong>{alarm.name}</strong><time>{fmtDateTime(alarm.stateUpdatedAt)}</time><ChevronDown size={13} className="mw-alarm-chev" aria-hidden /></button></li>)}</ul>}
    {selected && <MonitoringAlarmDetail alarm={selected} />}
  </section>;
}
