import type { AlarmRecord } from '@orrery/shared';
import { X } from 'lucide-react';
import { useMonitoring } from '../model/monitoring';
import { fmtDateTime } from '../components/format';

export function MonitoringAlarmDetail({ alarm }: { alarm: AlarmRecord }) {
  const m = useMonitoring();
  return <section className="mw-alarm-detail" aria-label={`${alarm.name} 경보 상세`}>
    <div className="mw-section-heading"><h4>{alarm.name}</h4><button type="button" className="icon-btn" aria-label="경보 상세 닫기" onClick={() => m.selectAlarm(undefined)}><X size={14} /></button></div>
    <p><span className={`alarm-state state-${alarm.state}`}>{alarm.state}</span> · {alarm.type === 'composite' ? '복합 경보' : '지표 경보'} · {alarm.region}</p><p>{alarm.reason}</p>{alarm.description && <p>{alarm.description}</p>}
    <dl className="monitor-props"><dt>상태 변경</dt><dd>{fmtDateTime(alarm.stateUpdatedAt) || '제공되지 않음'}</dd><dt>임계값</dt><dd>{alarm.comparisonOperator ?? '별도 조건'} {alarm.threshold ?? '제공되지 않음'}</dd><dt>평가 주기 수</dt><dd>{alarm.datapointsToAlarm ?? '–'} / {alarm.evaluationPeriods ?? '–'}</dd><dt>결측 처리</dt><dd>{alarm.treatMissingData ?? 'AWS 기본값'}</dd></dl>
    {!!alarm.childAlarmNames?.length && <p className="mw-subtle">하위 경보: {alarm.childAlarmNames.join(', ')}</p>}
    {alarm.rule && <p><strong>복합 조건</strong><code className="monitor-code">{alarm.rule}</code></p>}
    {alarm.expressions?.map((expression, i) => <code className="monitor-code" key={i}>{expression}</code>)}
    {alarm.metrics.map((metric, i) => <div className="monitor-code" key={i}>{metric.namespace} / {metric.metric} · {metric.stat} · {metric.period ? `${metric.period}초 집계` : '주기 미제공'}<br />{Object.entries(metric.dimensions).map(([key, value]) => `${key}=${value}`).join(', ')}</div>)}
    <h4>선택 기간의 상태 이력</h4>{m.historyLoading && <p role="status">이력 조회 중</p>}{m.historyError && <p role="alert" className="monitor-notice">이력 조회 실패: {m.historyError}</p>}
    <ul className="mw-history-list">{m.history?.items.map((item, i) => <li key={i}><time>{fmtDateTime(item.timestamp)}</time><p>{item.type} · {item.summary}</p>{item.data && <details><summary>원문</summary><pre className="monitor-code">{item.data}</pre></details>}</li>)}</ul>
    {m.history && !m.history.items.length && !m.historyError && <p className="mw-subtle">선택 기간에 반환된 이력이 없습니다.</p>}
    {m.history?.nextToken && <button type="button" className="btn" disabled={m.historyLoading} onClick={() => void m.loadHistory(m.history?.nextToken)}>이력 더 보기</button>}
  </section>;
}

export function MonitoringResourceAlarms({ resourceKey }: { resourceKey: string }) {
  const m = useMonitoring();
  const resource = m.resources?.resources.find((item) => item.key === resourceKey);
  const alarms = m.alarms?.alarms.filter((alarm) => alarm.resourceKeys.includes(resourceKey)) ?? [];
  const selected = alarms.find((alarm) => alarm.name === m.selectedAlarm?.name && alarm.type === m.selectedAlarm.type && alarm.region === m.selectedAlarm.region);
  return <section className="mw-resource-alarms" aria-label="자원 관련 경보"><div className="mw-section-heading"><h4>관련 경보 <span>{alarms.length}</span></h4>{m.alarmLoading && <small role="status">경보 확인 중</small>}</div>{resource?.alarmScopeWarning && <p role="status" className="monitor-notice">{resource.alarmScopeWarning}</p>}{resource?.alarmMappingSupported === false && <p className="monitor-notice">이 유형의 경보 연결은 지원되지 않아 경보 유무를 판단할 수 없습니다.</p>}{!alarms.length && resource?.alarmMappingSupported !== false && <p className="mw-subtle">{m.alarmError || !m.alarms?.complete ? '경보 조회 범위가 부족하여 상태를 확인할 수 없습니다.' : '현재 조회 범위에서 이 자원에 매핑된 경보가 없습니다. 미연결 경보와 지표도 함께 확인하세요.'}</p>}<ul className="mw-alarm-list">{alarms.map((alarm) => <li key={alarm.arn ?? `${alarm.type}:${alarm.name}`}><button type="button" onClick={() => m.selectAlarm(alarm)} aria-expanded={selected === alarm}><span className={`alarm-state state-${alarm.state}`}>{alarm.state}</span><strong>{alarm.name}</strong><span>{fmtDateTime(alarm.stateUpdatedAt)}</span></button></li>)}</ul>{selected && <MonitoringAlarmDetail alarm={selected} />}</section>;
}
