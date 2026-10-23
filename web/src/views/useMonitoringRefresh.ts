import { useEffect } from 'react';
import { useMonitoring } from '../model/monitoring';
import { createMonitoringRefresh } from '../model/monitoring-refresh';

export function useMonitoringRefresh() {
  const interval = useMonitoring((s) => s.autoRefresh);
  const range = useMonitoring((s) => s.range);
  const tab = useMonitoring((s) => s.activeTab);
  const selected = useMonitoring((s) => s.selectedResources);
  const profile = useMonitoring((s) => s.profile), region = useMonitoring((s) => s.region);
  useEffect(() => {
    if (!interval || range === 'custom' || tab !== 'metrics' || !selected.length || !profile || !region) return;
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
    return () => { scheduler.stop(); const current = useMonitoring.getState(); if (inFlight && current.profile === profile && current.region === region && current.selectedResources === selected) current.pauseRequests(); document.removeEventListener('visibilitychange', visibility); };
  }, [interval, range, tab, selected, profile, region]);
}
