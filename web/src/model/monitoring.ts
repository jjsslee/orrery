import { create } from 'zustand';
import type { AlarmHistorySnapshot, AlarmRecord, MonitoringAlarmSnapshot, MonitoringResourceIndex, MonitoringResourceType, MonitoringMetricsSnapshot, SavedResourceGroup, ObservationState, MonitoringScope } from '@orrery/shared';
import { classifyMonitoringError, metricQuality } from './monitoring-quality';
import { readGroups, writeGroups } from './monitoring-groups';
import { api } from '../api/client';
import { emptyResourceFilters, type ResourceFilters } from './monitoring-resources';

export type TimeRange = '1h' | '3h' | '24h' | '7d' | 'custom';
export function monitoringWindow(range: TimeRange, now = Date.now(), start?: string, end?: string) {
  const endMs = range === 'custom' ? Date.parse(end ?? '') : now;
  const startMs = range === 'custom' ? Date.parse(start ?? '') : endMs - ({ '1h': 1, '3h': 3, '24h': 24, '7d': 168 }[range] * 3600000);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || endMs - startMs > 7 * 86400000 || endMs > now || startMs < now - 455 * 86400000) throw new Error('시작은 과거 455일 이내, 기간은 최대 7일, 종료는 현재 이전으로 선택하세요.');
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
interface MonitoringState {
  profile: string; region: string; scopeNotice?: string;
  autoRefresh: 0 | 60000 | 300000;
  pauseRequests(): void;
  activeTab: 'overview' | 'alarms' | 'resources' | 'metrics'; groups: SavedResourceGroup[]; groupsError?: string; activeGroup?: string;
  resourceFilters: ResourceFilters; resourceGroupKeys: string[];
  loadResourceTypes(types: MonitoringResourceType[]): Promise<void>;
  resourceCoverage: Partial<Record<MonitoringResourceType, ObservationState & { complete: boolean }>>;
  saveGroup(group: SavedResourceGroup): void; deleteGroup(id: string): void;
  selectedResources: string[]; metrics?: MonitoringMetricsSnapshot; metricsLoading: boolean; metricsError?: string;
  toggleResource(key: string): void; loadMetrics(refresh?: boolean): Promise<void>;
  alarms?: MonitoringAlarmSnapshot; alarmLoading: boolean; alarmError?: string;
  resources?: MonitoringResourceIndex; resourceLoading: boolean; resourceError?: string;
  history?: AlarmHistorySnapshot; historyLoading: boolean; historyError?: string;
  historyWindow?: { start: string; end: string };
  selectedAlarm?: AlarmRecord; query: string; stateFilter: string;
  range: TimeRange; customStart: string; customEnd: string;
  activate(profile: string, region: string): void; deactivate(): void;
  loadAlarms(refresh?: boolean): Promise<void>; loadResources(type: MonitoringResourceType): Promise<void>;
  selectAlarm(alarm?: AlarmRecord): void; loadHistory(nextToken?: string): Promise<void>;
  setCustomTime(field: 'customStart' | 'customEnd', value: string): void;
  setRange(range: TimeRange): void;
}
let generation = 0;
const controllers = new Map<string, AbortController>();
const sameScope = (a: MonitoringScope, b: MonitoringScope) => a.source === b.source && a.account === b.account && a.region === b.region;
function cancel() { generation++; for (const c of controllers.values()) c.abort(); controllers.clear(); }
function request(key: string) { controllers.get(key)?.abort(); const c = new AbortController(); controllers.set(key, c); const g = generation; return { signal: c.signal, current: () => g === generation && controllers.get(key) === c && !c.signal.aborted }; }
export const useMonitoring = create<MonitoringState>((set, get) => ({
  autoRefresh: 0, resourceFilters: emptyResourceFilters(), resourceGroupKeys: [],
  activeTab: 'overview', groups: [], resourceCoverage: {},
  selectedResources: [], metricsLoading: false,
  profile: '', region: '', alarmLoading: false, resourceLoading: false, historyLoading: false, query: '', stateFilter: 'ALL', range: '3h', customStart: '', customEnd: '',
  activate(profile, region) {
    cancel();
    const changed = get().profile !== profile || get().region !== region;
    set({ profile, region, alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false, ...(changed ? { scopeNotice: undefined, resourceFilters: emptyResourceFilters(), resourceGroupKeys: [], autoRefresh: 0, groups: [], activeGroup: undefined, resourceCoverage: {}, selectedResources: [], metrics: undefined, metricsError: undefined, alarms: undefined, resources: undefined, history: undefined, selectedAlarm: undefined, alarmError: undefined, resourceError: undefined, historyError: undefined } : {}) });
    if (profile && region) void get().loadAlarms();
  },
  pauseRequests() { for (const key of ['metrics', 'alarms']) controllers.get(key)?.abort(); set({ metricsLoading: false, alarmLoading: false }); },
  deactivate() { cancel(); set({ alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false }); },
  async loadAlarms(refresh = false) {
    const { profile, region } = get(); if (!region) return; const r = request('alarms'); set({ alarmLoading: true, alarmError: undefined });
    try {
      const alarms = await api.monitoringAlarms(profile, region, refresh, r.signal);
      if (r.current()) {
        const previous = get().alarms?.scope ?? get().resources?.scope;
        const changedAccount = previous && !sameScope(previous, alarms.scope);
        if (changedAccount) cancel();
        const alarmError = alarms.observation.error || alarms.observation.errorCode ? classifyMonitoringError(Object.assign(new Error(alarms.observation.error ?? alarms.observation.errorCode), { code: alarms.observation.errorCode })) : !alarms.complete ? { disposition: 'retry', message: '경보 부분 결과' } : undefined;
        set({ ...(alarmError?.disposition === 'stop' ? { autoRefresh: 0 } : {}), alarms, alarmError: alarmError?.message, groups: readGroups(alarms.scope), ...(changedAccount ? { scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), resourceGroupKeys: [], autoRefresh: 0, alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false, selectedResources: [], resources: undefined, resourceCoverage: {}, metrics: undefined, history: undefined, selectedAlarm: undefined, activeGroup: undefined } : { selectedAlarm: get().selectedAlarm ? alarms.alarms.find((a) => a.name === get().selectedAlarm?.name && a.type === get().selectedAlarm?.type && a.region === get().selectedAlarm?.region) : undefined }) });
      }
    }
    catch (e) { if (r.current()) { const error = classifyMonitoringError(e); set({ alarmError: error.message, ...(error.disposition === 'stop' ? { autoRefresh: 0 } : {}) }); } }
    finally { if (r.current()) set({ alarmLoading: false }); }
  },
  async loadResources(type) {
    const { profile, region } = get(); if (!region) return; const r = request('resources'); set({ resourceLoading: true, resourceError: undefined });
    try {
      const resources = await api.monitoringResources(profile, region, type, r.signal);
      if (r.current()) {
        const oldScope = get().alarms?.scope ?? get().resources?.scope;
        const changedAccount = oldScope && !sameScope(oldScope, resources.scope);
        if (changedAccount) cancel();
        const coverage = { ...(changedAccount ? {} : get().resourceCoverage), [type]: { ...resources.observation, complete: resources.complete } };
        const previous = changedAccount ? undefined : get().resources;
        const items = new Map(previous?.resources.filter((item) => !resources.complete || item.type !== type).map((item) => [item.key, item]));
        for (const item of resources.resources) items.set(item.key, item);
        set({ ...(changedAccount ? { scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), resourceGroupKeys: [], autoRefresh: 0, alarms: undefined, selectedAlarm: undefined, selectedResources: [], metrics: undefined, history: undefined, resourceLoading: false, metricsLoading: false, alarmLoading: false, historyLoading: false, groups: readGroups(resources.scope), activeGroup: undefined } : {}), resources: { ...resources, resources: [...items.values()], types: [...new Set([...(previous?.types ?? []), ...resources.types])], complete: Object.values(coverage).every((entry) => entry.complete) }, groups: !oldScope ? readGroups(resources.scope) : (changedAccount ? readGroups(resources.scope) : get().groups), resourceCoverage: coverage, resourceError: resources.observation.error });
        void get().loadAlarms();
      }
    }
    catch (e) { if (r.current()) set({ resourceError: (e as Error).message }); }
    finally { if (r.current()) set({ resourceLoading: false }); }
  },
  async loadResourceTypes(types) {
    const batch = request('resource-batch');
    for (const type of [...new Set(types)]) {
      if (!batch.current()) return;
      await get().loadResources(type);
    }
  },
  saveGroup(group) {
    const scope = get().alarms?.scope ?? get().resources?.scope; if (!scope) { set({ groupsError: '먼저 AWS 계정 조회를 완료하세요.' }); return; }
    const groups = [...get().groups.filter((item) => item.id !== group.id), group];
    try { writeGroups(scope, groups); set({ groups, groupsError: undefined }); }
    catch { set({ groupsError: '브라우저 로컬 저장에 실패했습니다. 저장 공간과 설정을 확인하세요.' }); }
  },
  deleteGroup(id) {
    const scope = get().alarms?.scope ?? get().resources?.scope; if (!scope) return;
    const groups = get().groups.filter((item) => item.id !== id);
    try { writeGroups(scope, groups); set({ groups, activeGroup: get().activeGroup === id ? undefined : get().activeGroup, groupsError: undefined }); }
    catch { set({ groupsError: '관심 묶음을 삭제하지 못했습니다.' }); }
  },
  toggleResource(key) {
    const selected = get().selectedResources;
    if (!selected.includes(key) && selected.length >= 4) { set({ metricsError: '자원 비교는 최대 4개까지 가능합니다.' }); return; }
    controllers.get('metrics')?.abort();
    set({ selectedResources: selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key], metrics: undefined, metricsLoading: false, metricsError: undefined });
  },
  async loadMetrics(refresh = false) {
    const { profile, region, selectedResources, range, customStart, customEnd } = get();
    if (!selectedResources.length) { set({ metricsError: '비교할 자원을 1~4개 선택하세요.' }); return; }
    const r = request('metrics'); set({ metricsLoading: true, metricsError: undefined });
    try {
      const window = monitoringWindow(range, Date.now(), customStart, customEnd);
      const metrics = await api.monitoringMetrics(profile, region, selectedResources, { startTime: window.start, endTime: window.end }, refresh, r.signal);
      if (r.current()) {
        const previous = get().alarms?.scope ?? get().resources?.scope;
        if (previous && !sameScope(previous, metrics.scope)) {
          cancel();
          set({ scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌었습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), resourceGroupKeys: [], autoRefresh: 0, selectedResources: [], resources: undefined, resourceCoverage: {}, alarms: undefined, selectedAlarm: undefined, history: undefined, groups: readGroups(metrics.scope), metrics: undefined, metricsLoading: false, alarmLoading: false, historyLoading: false, resourceLoading: false, metricsError: '다른 계정의 지표 응답을 폐기했습니다.' });
          void get().loadAlarms();
          return;
        }
        const quality = metricQuality(Object.values(metrics.series).flat());
        set({ metrics, metricsError: quality.message, ...(quality.disposition === 'stop' ? { autoRefresh: 0 } : {}) });
      }
    } catch (e) { if (r.current()) { const error = classifyMonitoringError(e); set({ metricsError: error.message, ...(error.disposition === 'stop' ? { autoRefresh: 0 } : {}) }); } }
    finally { if (r.current()) set({ metricsLoading: false }); }
  },
  selectAlarm(selectedAlarm) { controllers.get('history')?.abort(); set({ selectedAlarm, history: undefined, historyWindow: undefined, historyError: undefined, historyLoading: false }); if (selectedAlarm) void get().loadHistory(); },
  async loadHistory(nextToken) {
    const { profile, region, selectedAlarm, range, customStart, customEnd } = get(); if (!selectedAlarm) return;
    const r = request('history'); set({ historyLoading: true, historyError: undefined });
    try { const window = nextToken && get().historyWindow ? get().historyWindow! : monitoringWindow(range, Date.now(), customStart, customEnd); if (r.current()) set({ historyWindow: window }); const history = await api.monitoringHistory(profile, region, selectedAlarm.name, selectedAlarm.type, window, nextToken, r.signal); if (r.current()) set({ history: nextToken && get().history ? { ...history, items: [...get().history!.items, ...history.items] } : history, historyError: history.observation.error }); }
    catch (e) { if (r.current()) set({ historyError: (e as Error).message }); }
    finally { if (r.current()) set({ historyLoading: false }); }
  },
  setCustomTime(field, value) { controllers.get('metrics')?.abort(); controllers.get('history')?.abort(); set({ [field]: value, metrics: undefined, metricsLoading: false, historyLoading: false }); },
  setRange(range) { controllers.get('metrics')?.abort(); set({ range, metrics: undefined, metricsLoading: false, ...(range === 'custom' ? { autoRefresh: 0 } : {}) }); if (get().selectedAlarm) void get().loadHistory(); },
}));
export function matchingAlarms(alarms: AlarmRecord[], query: string, state: string): AlarmRecord[] {
  return alarms.filter((a) => (state === 'ALL' || a.state === state) && `${a.name} ${a.reason ?? ''}`.toLowerCase().includes(query.toLowerCase()));
}
