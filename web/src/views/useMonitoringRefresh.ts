import { useEffect } from 'react';
import { useMonitoring } from '../model/monitoring';
import { createMonitoringWorkspaceRequests } from '../model/monitoring-workspace';
import { createMonitoringRefresh } from '../model/monitoring-refresh';

export function useMonitoringRefresh() {
  useEffect(() => {
    const ready = () => { const s = useMonitoring.getState(); return s.workspaceActive && Boolean(s.profile && s.region && s.selectedResources.length) && document.visibilityState === 'visible'; };
    const controller = createMonitoringWorkspaceRequests({
      key: () => { const s = useMonitoring.getState(); return JSON.stringify([s.profile, s.region, [(s.alarms?.scope ?? s.resources?.scope)?.source, (s.alarms?.scope ?? s.resources?.scope)?.account], s.selectedResources, s.selectedResources.map(k => s.metricContexts[k]), s.range, s.range === 'custom' ? [s.customStart, s.customEnd] : []]); },
      ready, subscribe: (listener) => useMonitoring.subscribe(listener), run: async () => { await useMonitoring.getState().loadMetrics(); },
    });
    controller.start();
    const visibility = () => { if (document.visibilityState !== 'visible') { if (useMonitoring.getState().metricsLoading) controller.invalidate(); useMonitoring.getState().pauseRequests(); } else { const state = useMonitoring.getState(); if (state.related?.graph.state === 'loading') void state.loadRelated(false); if (state.selectedAlarm && !state.history && !state.historyLoading) void state.loadHistory(); } controller.sync(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.stop(); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const interval = useMonitoring((s) => s.autoRefresh);
  const range = useMonitoring((s) => s.range);
  const active = useMonitoring((s) => s.workspaceActive);
  const selected = useMonitoring((s) => s.selectedResources);
  const profile = useMonitoring((s) => s.profile), region = useMonitoring((s) => s.region);
  useEffect(() => {
    if (!interval || range === 'custom' || !active || !selected.length || !profile || !region) return;
    let inFlight = false;
    const scheduler = createMonitoringRefresh({ interval, run: async () => {
      const state = useMonitoring.getState();
      if (state.metricsLoading || state.alarmLoading) return true;
      inFlight = true;
      try { await Promise.all([state.loadMetrics(true), state.loadAlarms(true)]); }
      finally { inFlight = false; }
      return !useMonitoring.getState().metricsError && !useMonitoring.getState().alarmError;
    } });
    const visibility = () => {
      if (document.visibilityState === 'visible') scheduler.start();
      else { scheduler.stop(); useMonitoring.getState().pauseRequests(); }
    };
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { scheduler.stop(); const current = useMonitoring.getState(); if (inFlight && current.profile === profile && current.region === region && current.selectedResources === selected) current.pauseRequests(false); document.removeEventListener('visibilitychange', visibility); };
  }, [interval, range, active, selected, profile, region]);
}
