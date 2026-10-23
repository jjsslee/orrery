import { useEffect } from 'react';
import { Activity, ShieldCheck } from 'lucide-react';
import { useStore } from '../model/store';
import { useMonitoringRefresh } from './useMonitoringRefresh';
import { useMonitoring } from '../model/monitoring';
import { RegionPrompt } from '../canvas/RegionPrompt';
import { SetupGuide } from '../canvas/SetupGuide';
import { MonitoringMetrics } from './MonitoringMetrics';
import { MonitoringResources } from './MonitoringResources';
import { MonitoringRelated } from './MonitoringRelated';
import { MonitoringAlarmDetail } from './MonitoringAlarmDetail';

export function Monitoring() {
  const profile = useStore((s) => s.profile), region = useStore((s) => s.region), setup = useStore((s) => s.setup);
  const connectionGeneration = useStore((s) => s.connectionGeneration);
  const connectionBusy = useStore((s) => s.loading.active);
  const connectionError = useStore((s) => s.loading.error);
  const m = useMonitoring();
  useMonitoringRefresh();
  useEffect(() => {
    if (setup !== 'done') return;
    if (connectionBusy || connectionError) { m.activate('', ''); return () => m.deactivate(); }
    m.activate(profile, region); return () => m.deactivate();
  }, [profile, region, setup, connectionGeneration, connectionBusy, connectionError]);
  if (setup === 'needed') return <SetupGuide />;
  if (!region) return <RegionPrompt />;
  const scope = m.alarms?.scope ?? m.resources?.scope;
  const scopeKey = scope ? JSON.stringify([scope.source, scope.account, scope.region]) : `${profile}:${region}:unverified`;
  const unmapped = m.alarms?.alarms.filter((alarm) => alarm.mapping === 'unresolved') ?? [];
  const selectedUnmapped = unmapped.find((alarm) => alarm.name === m.selectedAlarm?.name && alarm.type === m.selectedAlarm.type && alarm.region === m.selectedAlarm.region);
  return <div className="monitoring">
    <header className="mw-page-heading"><div><span className="mw-eyebrow"><Activity size={13} />RESOURCE MONITORING</span><h1>자원을 고르고, 함께 확인하세요.</h1><p>이름과 태그로 찾고 연결된 자원을 더해, 같은 시간의 CloudWatch를 확인합니다.</p></div><div className="mw-readonly-note"><ShieldCheck size={15} /><span>읽기 전용<small>{region}</small></span></div></header>
    {m.scopeNotice && <p className="monitor-notice" role="alert">{m.scopeNotice}</p>}
    {connectionBusy && <p className="mw-loading" role="status">AWS 계정과 연결을 확인하고 있습니다.</p>}
    {connectionError && <p className="monitor-notice" role="alert">연결 확인 실패: {connectionError}</p>}
    {m.alarmError && <p className="monitor-notice" role="alert">경보 조회 문제 · 이전 결과가 포함될 수 있습니다: {m.alarmError}</p>}
    <div className="mw-workspace" key={scopeKey}>
      <MonitoringResources />
      <MonitoringRelated />
      <div className="mw-observation-column"><MonitoringMetrics />
        {!!unmapped.length && <details className="mw-unmapped-alarms"><summary>자원에 연결하지 못한 경보 {unmapped.length}개</summary><p>조회한 자원에 연결할 수 없는 경보입니다. 관련 경보가 없다는 이유만으로 정상으로 단정하지 않습니다.</p><ul className="mw-alarm-list">{unmapped.map((alarm) => <li key={alarm.arn ?? `${alarm.type}:${alarm.name}`}><button type="button" onClick={() => m.selectAlarm(alarm)}><span className={`alarm-state state-${alarm.state}`}>{alarm.state}</span><strong>{alarm.name}</strong></button></li>)}</ul>{selectedUnmapped && <MonitoringAlarmDetail alarm={selectedUnmapped} />}</details>}
      </div>
    </div>
    <p className="mw-monitoring-footnote">화면을 벗어나면 자동 갱신을 중단합니다. 24시간 감지와 외부 알림은 기존 AWS 경보가 담당합니다.</p>
  </div>;
}
