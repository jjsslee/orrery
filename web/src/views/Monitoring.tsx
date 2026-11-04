import { uiText, useLanguage } from '../i18n';
import { useEffect } from 'react';
import { useStore } from '../model/store';
import { useMonitoringRefresh } from './useMonitoringRefresh';
import { useMonitoring } from '../model/monitoring';
import { RegionPrompt } from '../canvas/RegionPrompt';
import { SetupGuide } from '../canvas/SetupGuide';
import { MonitoringMetrics } from './MonitoringMetrics';
import { MonitoringResources } from './MonitoringResources';
import { MonitoringRelated } from './MonitoringRelated';
import { MonitoringSelection } from './MonitoringSelection';
import { AlarmState, MonitoringAlarmDetail } from './MonitoringAlarmDetail';

export function Monitoring() {
  useLanguage();
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
  if (!region) return connectionError ? <p className="monitor-notice" role="alert">{uiText(connectionError ?? '')}</p> : <RegionPrompt />;
  const scope = m.alarms?.scope ?? m.resources?.scope;
  const scopeKey = scope ? JSON.stringify([scope.source, scope.account, scope.region]) : `${profile}:${region}:unverified`;
  const unmapped = m.alarms?.alarms.filter((alarm) => alarm.mapping === 'unresolved') ?? [];
  const selectedUnmapped = unmapped.find((alarm) => alarm.name === m.selectedAlarm?.name && alarm.type === m.selectedAlarm.type && alarm.region === m.selectedAlarm.region);
  const notices = [
    m.scopeNotice && <p key="scope" className="monitor-notice" role="alert">{m.scopeNotice}</p>,
    connectionBusy && <p key="busy" className="mw-progress" role="status">{uiText("AWS 계정과 연결을 확인하고 있습니다.")}</p>,
    connectionError && <p key="conn" className="monitor-notice" role="alert">{uiText("연결 확인 실패: ")}{uiText(connectionError ?? '')}</p>,
    m.alarmError && <p key="alarm" className="monitor-notice" role="alert">{uiText("경보 조회 문제 · 이전 결과가 포함될 수 있습니다: ")}{uiText(m.alarmError ?? '')}</p>,
  ].filter(Boolean);
  return <div className="monitoring">
    {!!notices.length && <div className="mw-notices">{notices}</div>}
    <div className="mw-workspace" key={scopeKey}>
      <MonitoringResources />
      <div className="mw-observation-column">
        <MonitoringSelection />
        <MonitoringMetrics />
        {!!unmapped.length && <details className="mw-unmapped-alarms">
          <summary>{uiText("자원에 연결하지 못한 경보 ")}{unmapped.length}{uiText("개")}</summary>
          <p className="mw-hint">{uiText("조회한 자원에 연결할 수 없는 경보입니다. 관련 경보가 없다는 이유만으로 정상으로 단정하지 않습니다.")}</p>
          <ul className="mw-alarm-list">{unmapped.map((alarm) => <li key={alarm.arn ?? `${alarm.type}:${alarm.name}`}><button type="button" aria-expanded={selectedUnmapped === alarm} onClick={() => m.selectAlarm(selectedUnmapped === alarm ? undefined : alarm)}><AlarmState state={alarm.state} /><strong>{alarm.name}</strong></button></li>)}</ul>
          {selectedUnmapped && <MonitoringAlarmDetail alarm={selectedUnmapped} />}
        </details>}
        <p className="mw-footnote">{uiText("화면을 벗어나면 자동 갱신을 멈춥니다. 24시간 감지와 외부 알림은 기존 AWS 경보가 담당합니다.")}</p>
      </div>
      <MonitoringRelated />
    </div>
  </div>;
}
