import { create } from 'zustand';
import { MAX_OBSERVED_RESOURCES } from '@orrery/shared';
import type { AlarmHistorySnapshot, AlarmRecord, MonitoringAlarmSnapshot, MonitoringResourceIndex, MonitoringResourceType, MonitoringMetricsSnapshot, SavedResourceGroup, ObservationState, MonitoringScope, MonitoringRelatedSnapshot } from '@orrery/shared';
import { classifyMonitoringError, metricQuality } from './monitoring-quality';
import { sameTagCandidates, mergeRelatedCandidates } from './monitoring-related';
import { readGroups, writeGroups, groupResources } from './monitoring-groups';
import { api } from '../api/client';
import { emptyResourceFilters, MONITORING_RESOURCE_TYPES, type ResourceFilters } from './monitoring-resources';

export type TimeRange = '1h' | '3h' | '24h' | '7d' | 'custom';
/** Resources observed together; shared with the server's metric API so both enforce one ceiling. */
export const MAX_OBSERVED = MAX_OBSERVED_RESOURCES;
export function monitoringWindow(range: TimeRange, now = Date.now(), start?: string, end?: string) {
  const endMs = range === 'custom' ? Date.parse(end ?? '') : now;
  const startMs = range === 'custom' ? Date.parse(start ?? '') : endMs - ({ '1h': 1, '3h': 3, '24h': 24, '7d': 168 }[range] * 3600000);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || endMs - startMs > 7 * 86400000 || endMs > now || startMs < now - 455 * 86400000) throw new Error('시작은 과거 455일 이내, 기간은 최대 7일, 종료는 현재 이전으로 선택하세요.');
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
interface MonitoringState {
  profile: string; region: string; scopeNotice?: string;
  autoRefresh: 0 | 60000 | 300000;
  pauseRequests(includeRelated?: boolean): void;
  workspaceActive: boolean; groups: SavedResourceGroup[]; groupsError?: string;
  referenceResource?: string; related?: MonitoringRelatedSnapshot; relatedLoading: boolean; relatedError?: string;
  relatedDepth: number; relatedGroup: 'execution' | 'context'; setRelatedOptions(depth: number, group: 'execution' | 'context'): void;
  setReferenceResource(key: string): void; loadRelated(refresh?: boolean, nextPage?: boolean): Promise<void>;
  saveSelection(name: string): void; restoreGroup(id: string): Promise<void>;
  restoreNotice?: string; restoreCandidates: string[]; restoreMissingKeys: string[];
  resourceFilters: ResourceFilters;
  loadResourceTypes(types: MonitoringResourceType[], refresh?: boolean): Promise<void>;
  resourceCoverage: Partial<Record<MonitoringResourceType, ObservationState & { complete: boolean }>>;
  saveGroup(group: SavedResourceGroup): void; deleteGroup(id: string): void;
  metricContexts: Record<string,string>; setMetricContext(key:string, id:string): void;
  selectedResources: string[]; metrics?: MonitoringMetricsSnapshot; metricsLoading: boolean; metricsError?: string;
  toggleResource(key: string): void; loadMetrics(refresh?: boolean): Promise<void>;
  alarms?: MonitoringAlarmSnapshot; alarmLoading: boolean; alarmError?: string;
  resources?: MonitoringResourceIndex; resourceLoading: boolean; resourceError?: string;
  history?: AlarmHistorySnapshot; historyLoading: boolean; historyError?: string;
  historyWindow?: { start: string; end: string };
  selectedAlarm?: AlarmRecord;
  range: TimeRange; customStart: string; customEnd: string;
  activate(profile: string, region: string): void; deactivate(): void;
  loadAlarms(refresh?: boolean): Promise<void>; loadResources(type: MonitoringResourceType, refresh?: boolean): Promise<void>;
  selectAlarm(alarm?: AlarmRecord): void; loadHistory(nextToken?: string): Promise<void>;
  setCustomTime(field: 'customStart' | 'customEnd', value: string): void;
  setRange(range: TimeRange): void;
}
let generation = 0;
let relatedTimer: ReturnType<typeof setTimeout> | undefined;
let historyTimer: ReturnType<typeof setTimeout> | undefined;
function clearHistoryTimer() { if (historyTimer) clearTimeout(historyTimer); historyTimer = undefined; }
const controllers = new Map<string, AbortController>();
const sameScope = (a: MonitoringScope, b: MonitoringScope) => a.source === b.source && a.account === b.account && a.region === b.region;
function cancel() { clearHistoryTimer(); if (relatedTimer) clearTimeout(relatedTimer); relatedTimer = undefined; generation++; for (const c of controllers.values()) c.abort(); controllers.clear(); }
function request(key: string) { controllers.get(key)?.abort(); const c = new AbortController(); controllers.set(key, c); const g = generation; return { signal: c.signal, current: () => g === generation && controllers.get(key) === c && !c.signal.aborted }; }
export const useMonitoring = create<MonitoringState>((set, get) => ({
  autoRefresh: 0, resourceFilters: emptyResourceFilters(), workspaceActive: false, relatedLoading: false, restoreCandidates: [], restoreMissingKeys: [],
  groups: [], resourceCoverage: {},
  metricContexts: {},
  setMetricContext(key,id) {
    if (!get().resources?.resources.find(r => r.key === key)?.metricContexts?.some(c => c.id === id)) return;
    const selected = get().selectedResources.includes(key);
    if (selected) controllers.get('metrics')?.abort();
    set({metricContexts:{...get().metricContexts,[key]:id},...(selected ? {metrics:undefined,metricsLoading:false} : {})});
  },
  selectedResources: [], metricsLoading: false,
  profile: '', region: '', alarmLoading: false, resourceLoading: false, historyLoading: false, range: '3h', customStart: '', customEnd: '',
  activate(profile, region) {
    cancel();
    const changed = get().profile !== profile || get().region !== region;
    set({ profile, region, workspaceActive: Boolean(profile && region), alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false, ...(changed ? { scopeNotice: undefined, resourceFilters: emptyResourceFilters(), referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, restoreNotice: undefined, restoreCandidates: [], restoreMissingKeys: [], autoRefresh: 0, groups: [], resourceCoverage: {}, selectedResources: [], metricContexts: {}, metrics: undefined, metricsError: undefined, alarms: undefined, resources: undefined, history: undefined, selectedAlarm: undefined, alarmError: undefined, resourceError: undefined, historyError: undefined } : {}) });
    if (profile && region) { void get().loadAlarms(); void get().loadResourceTypes(MONITORING_RESOURCE_TYPES.map(([type]) => type)); if (!changed && get().referenceResource) void get().loadRelated(false); if (!changed && get().selectedAlarm && !get().history && !get().historyLoading) void get().loadHistory(); }
  },
  pauseRequests(includeRelated = true) { for (const key of (includeRelated ? ['metrics', 'alarms', 'related'] : ['metrics', 'alarms'])) controllers.get(key)?.abort(); if (includeRelated) { controllers.get('history')?.abort(); clearHistoryTimer(); } if (includeRelated && relatedTimer) clearTimeout(relatedTimer); if (includeRelated) relatedTimer = undefined; set({ metricsLoading: false, alarmLoading: false, ...(includeRelated ? { relatedLoading: false, historyLoading: false } : {}) }); },
  deactivate() { cancel(); set({ workspaceActive: false, relatedLoading: false, alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false }); },
  async loadAlarms(refresh = false) {
    const { profile, region } = get(); if (!region) return; const r = request('alarms'); set({ alarmLoading: true, alarmError: undefined });
    try {
      const alarms = await api.monitoringAlarms(profile, region, refresh, r.signal);
      if (r.current()) {
        const previous = get().alarms?.scope ?? get().resources?.scope;
        const changedAccount = previous && !sameScope(previous, alarms.scope);
        if (changedAccount) cancel();
        const alarmError = alarms.observation.error || alarms.observation.errorCode ? classifyMonitoringError(Object.assign(new Error(alarms.observation.error ?? alarms.observation.errorCode), { code: alarms.observation.errorCode })) : !alarms.complete ? { disposition: 'retry', message: '경보 부분 결과' } : undefined;
        set({ ...(alarmError?.disposition === 'stop' ? { autoRefresh: 0 } : {}), alarms, alarmError: alarmError?.message, groups: readGroups(alarms.scope), ...(changedAccount ? { scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, restoreNotice: undefined, restoreCandidates: [], restoreMissingKeys: [], autoRefresh: 0, alarmLoading: false, resourceLoading: false, historyLoading: false, metricsLoading: false, selectedResources: [], resources: undefined, resourceCoverage: {}, metrics: undefined, history: undefined, selectedAlarm: undefined,  } : { selectedAlarm: get().selectedAlarm ? alarms.alarms.find((a) => a.name === get().selectedAlarm?.name && a.type === get().selectedAlarm?.type && a.region === get().selectedAlarm?.region) : undefined }) });
      }
    }
    catch (e) { if (r.current()) { const error = classifyMonitoringError(e); set({ alarmError: error.message, ...(error.disposition === 'stop' ? { autoRefresh: 0 } : {}) }); } }
    finally { if (r.current()) set({ alarmLoading: false }); }
  },
  async loadResources(type, refresh = false) {
    const { profile, region } = get(); if (!region) return; const r = request('resources'); set({ resourceLoading: true, resourceError: undefined });
    try {
      const resources = await api.monitoringResources(profile, region, type, r.signal, refresh);
      if (r.current()) {
        const oldScope = get().alarms?.scope ?? get().resources?.scope;
        const changedAccount = oldScope && !sameScope(oldScope, resources.scope);
        if (changedAccount) cancel();
        const coverage = { ...(changedAccount ? {} : get().resourceCoverage), [type]: { ...resources.observation, complete: resources.complete } };
        const previous = changedAccount ? undefined : get().resources;
        const items = new Map(previous?.resources.filter((item) => !resources.complete || item.type !== type).map((item) => [item.key, item]));
        for (const item of resources.resources) items.set(item.key, item);
        set({ ...(changedAccount ? { scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, restoreNotice: undefined, restoreCandidates: [], restoreMissingKeys: [], autoRefresh: 0, alarms: undefined, selectedAlarm: undefined, selectedResources: [], metricContexts: {}, metrics: undefined, history: undefined, resourceLoading: false, metricsLoading: false, alarmLoading: false, historyLoading: false, groups: readGroups(resources.scope),  } : {}), resources: { ...resources, resources: [...items.values()], types: [...new Set([...(previous?.types ?? []), ...resources.types])], complete: Object.values(coverage).every((entry) => entry.complete) }, groups: !oldScope ? readGroups(resources.scope) : (changedAccount ? readGroups(resources.scope) : get().groups), resourceCoverage: coverage, resourceError: resources.observation.error });
        const reference = get().referenceResource;
        if (reference && get().related) { const index = get().resources?.resources ?? []; set({ related: { ...get().related!, sameTags: mergeRelatedCandidates(get().related!.sameTags, sameTagCandidates(index.find((item) => item.key === reference), index)) } }); }
        void get().loadAlarms();
      }
    }
    catch (e) { if (r.current()) set({ resourceError: (e as Error).message, resourceCoverage: { ...get().resourceCoverage, [type]: { attemptedAt: new Date().toISOString(), complete: false, error: (e as Error).message } }, ...(get().resources ? { resources: { ...get().resources!, complete: false } } : {}) }); }
    finally { if (r.current()) set({ resourceLoading: false }); }
  },
  async loadResourceTypes(types, refresh = false) {
    const batch = request('resource-batch');
    for (const type of [...new Set(types)]) {
      if (!batch.current()) return;
      await get().loadResources(type, refresh);
    }
  },
  relatedDepth: 1, relatedGroup: 'execution',
  setRelatedOptions(depth, group) {
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) return;
    set({ relatedDepth: depth, relatedGroup: group });
    void get().loadRelated(false);
  },
  setReferenceResource(key) {
    controllers.get('related')?.abort(); if (relatedTimer) clearTimeout(relatedTimer);
    const resources = get().resources?.resources ?? [], scope = get().resources?.scope ?? get().alarms?.scope;
    if (!scope || !resources.some((resource) => resource.key === key)) return;
    set({ referenceResource: key, relatedError: undefined, related: { scope, resourceKey: key, connected: [], sameTags: sameTagCandidates(resources.find((resource) => resource.key === key), resources), graph: { state: 'not-requested' }, tagCoverage: { types: get().resources?.types ?? [], incompleteTypes: MONITORING_RESOURCE_TYPES.map(([type]) => type).filter((type) => !get().resourceCoverage[type]?.complete) } } });
    void get().loadRelated(false);
  },
  async loadRelated(refresh = true, nextPage = false) {
    const { profile, region, referenceResource } = get(); if (!referenceResource || !region) return;
    if (relatedTimer) clearTimeout(relatedTimer);
    const r = request('related'); set({ relatedLoading: true, relatedError: undefined });
    try {
      const related = await api.monitoringRelated(profile, region, referenceResource, r.signal, refresh, get().relatedDepth, get().relatedGroup, nextPage ? get().related?.path?.nextOffset : 0, nextPage ? get().related?.path?.revision : undefined);
      if (!r.current()) return;
      const scope = get().resources?.scope ?? get().alarms?.scope;
      if (scope && !sameScope(scope, related.scope)) { cancel(); set({ referenceResource: undefined, related: undefined, relatedLoading: false, selectedResources: [], metricContexts: {}, metrics: undefined, metricsLoading: false, resourceFilters: emptyResourceFilters(), resources: undefined, resourceCoverage: {}, alarms: undefined, history: undefined, selectedAlarm: undefined, autoRefresh: 0, groups: readGroups(related.scope), restoreCandidates: [], restoreMissingKeys: [], scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', resourceLoading: false, alarmLoading: false, historyLoading: false, metricsError: undefined, alarmError: undefined, historyError: undefined, resourceError: undefined, restoreNotice: undefined }); return; }
      const index = get().resources;
      const items = new Map(index?.resources.map((resource) => [resource.key, resource]));
      for (const candidate of [...related.connected, ...related.sameTags]) items.set(candidate.resource.key, candidate.resource);
      for (const resource of related.path?.nodes ?? []) items.set(resource.key, resource);
      const resources = [...items.values()];
      const hasNewResources = resources.length !== (index?.resources.length ?? 0);
      set({ related: { ...related, sameTags: mergeRelatedCandidates(related.sameTags, sameTagCandidates(resources.find((resource) => resource.key === referenceResource), resources)) }, relatedError: related.error, ...(index ? { resources: { ...index, resources } } : {}) });
      if (hasNewResources) void get().loadAlarms();
      if (related.graph.state === 'loading') relatedTimer = setTimeout(() => { if (r.current() && get().workspaceActive) void get().loadRelated(false); }, 2000);
    } catch (error) { if (r.current()) set({ relatedError: (error as Error).message }); }
    finally { if (r.current()) set({ relatedLoading: false }); }
  },
  saveSelection(name) {
    if (!name.trim()) { set({ groupsError: '저장할 구성 이름을 입력하세요.' }); return; }
    if (!get().selectedResources.length || get().selectedResources.length > MAX_OBSERVED) { set({ groupsError: `저장할 자원을 1~${MAX_OBSERVED}개 선택하세요.` }); return; }
    get().saveGroup({ id: crypto.randomUUID(), name: name.trim().slice(0, 80), tagFilters: [], resourceKeys: [...get().selectedResources] });
  },
  async restoreGroup(id) {
    const group = get().groups.find((item) => item.id === id); if (!group) return;
    const { profile, region } = get(), r = request('restore');
    set({ restoreNotice: '저장한 자원을 확인합니다.', restoreMissingKeys: [], restoreCandidates: [] });
    try {
      const currentScope = get().resources?.scope ?? get().alarms?.scope;
      if (!currentScope) { set({ restoreNotice: '먼저 AWS 계정과 자원 목록을 확인하세요.' }); return; }
      const found = group.resourceKeys.length ? await api.monitoringResolve(profile, region, group.resourceKeys, r.signal) : { scope: currentScope, resources: [], unresolvedKeys: [], graph: { state: 'not-requested' as const } };
      if (!r.current()) return;
      const scope = get().resources?.scope ?? get().alarms?.scope;
      if (scope && !sameScope(scope, found.scope)) { cancel(); set({ scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 이전 선택을 비웠습니다. 다시 연결로 계정을 확인하세요.', restoreNotice: '계정이 바뀌어 복원을 중단했습니다. 다시 연결하세요.', selectedResources: [], metricContexts: {}, metrics: undefined, metricsError: undefined, metricsLoading: false, resources: undefined, resourceCoverage: {}, resourceLoading: false, resourceError: undefined, alarms: undefined, alarmError: undefined, alarmLoading: false, selectedAlarm: undefined, history: undefined, historyWindow: undefined, historyError: undefined, historyLoading: false, referenceResource: undefined, related: undefined, relatedError: undefined, relatedLoading: false, autoRefresh: 0, resourceFilters: emptyResourceFilters(), groups: readGroups(found.scope), groupsError: undefined, restoreCandidates: [], restoreMissingKeys: [] }); return; }
      const old = get().resources, items = new Map(old?.resources.map((resource) => [resource.key, resource]));
      for (const resource of found.resources) items.set(resource.key, resource);
      const resources = [...items.values()];
      const candidates = groupResources(group, group.tagFilters.length ? resources : found.resources).filter(resource => resource.metricsSupported !== false && resource.type !== 'target-group').map(resource => resource.key);
      const skipped = found.resources.filter(r => r.metricsSupported === false || r.type === 'target-group');
      const legacyTooLarge = group.resourceKeys.length > MAX_OBSERVED || candidates.length > MAX_OBSERVED;
      controllers.get('metrics')?.abort(); controllers.get('related')?.abort(); if (relatedTimer) clearTimeout(relatedTimer);
      set({ resources: old ? { ...old, resources } : { scope: found.scope, resources, types: [], complete: false, observation: { attemptedAt: new Date().toISOString() } }, selectedResources: legacyTooLarge ? [] : candidates, metrics: undefined, metricsLoading: false, referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, restoreCandidates: legacyTooLarge ? candidates : [], restoreMissingKeys: found.unresolvedKeys, restoreNotice: legacyTooLarge ? `저장된 구성의 대상이 ${MAX_OBSERVED}개를 넘습니다. 후보 ${candidates.length}개에서 최대 ${MAX_OBSERVED}개를 직접 선택하세요. 원래 구성은 보존됩니다.` : found.unresolvedKeys.length ? `자원 ${found.unresolvedKeys.length}개를 아직 확인하지 못했습니다. 관계 수집 상태를 확인한 뒤 다시 복원하세요.` : !candidates.length ? '현재 조회 범위에 일치하는 자원이 없습니다. 자원 목록을 확인한 뒤 다시 복원하세요.' : `구성 '${group.name}'을 복원했습니다.` });
      if (skipped.length) set({restoreNotice: `${get().restoreNotice} 구성 전용 또는 ALB 맥락을 다시 선택해야 하는 자원 ${skipped.length}개는 자동 추가하지 않았습니다.`});
      if (found.resources.length) void get().loadAlarms();
      if (group.tagFilters.length && (MONITORING_RESOURCE_TYPES.some(([type]) => !get().resourceCoverage[type]?.complete) || resources.some((resource) => resource.tagsStatus !== 'complete'))) set({ restoreNotice: `${get().restoreNotice} 태그 조회 범위가 부족하여 아직 확인하지 못한 대상이 있을 수 있습니다.` });
      if (!legacyTooLarge && candidates.length) get().setReferenceResource(candidates[0]);
    } catch (error) { if (r.current()) set({ restoreNotice: `구성 복원 실패: ${(error as Error).message}` }); }
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
    try { writeGroups(scope, groups); set({ groups, groupsError: undefined }); }
    catch { set({ groupsError: '관심 묶음을 삭제하지 못했습니다.' }); }
  },
  toggleResource(key) {
    const selected = get().selectedResources;
    const resource = get().resources?.resources.find(r => r.key === key);
    if (!selected.includes(key) && resource?.metricsSupported === false) { set({metricsError:'구성 전용 자원은 지표 비교에 추가하지 않습니다.'}); return; }
    if (!selected.includes(key) && resource?.type === 'target-group' && !resource.metricContexts?.some(c => c.id === get().metricContexts[key])) { set({metricsError:'Target Group의 연결 ALB를 먼저 선택하세요.'}); return; }
    if (!selected.includes(key) && selected.length >= MAX_OBSERVED) { set({ metricsError: `자원 비교는 최대 ${MAX_OBSERVED}개까지 가능합니다.` }); return; }
    controllers.get('metrics')?.abort();
    const next = selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
    set({ selectedResources: next, metrics: undefined, metricsLoading: false, metricsError: next.length && next.every((key) => get().resources?.resources.find((resource) => resource.key === key)?.metricsSupported === false) ? '선택한 자원은 CloudWatch 지표를 지원하지 않습니다. 관계와 경보는 계속 확인할 수 있습니다.' : undefined });
    if (!get().referenceResource || !next.includes(get().referenceResource!)) { if (next.length) get().setReferenceResource(next[0]); else { controllers.get('related')?.abort(); if (relatedTimer) clearTimeout(relatedTimer); set({ referenceResource: undefined, related: undefined, relatedLoading: false }); } }
  },
  async loadMetrics(refresh = false) {
    const { profile, region, selectedResources, range, customStart, customEnd } = get();
    if (!selectedResources.length) { set({ metricsError: `비교할 자원을 1~${MAX_OBSERVED}개 선택하세요.` }); return; }
    const metricResources = selectedResources.filter((key) => get().resources?.resources.find((resource) => resource.key === key)?.metricsSupported !== false);
    if (!metricResources.length) { set({ metrics: undefined, metricsLoading: false, metricsError: '선택한 자원은 CloudWatch 지표를 지원하지 않습니다. 관계와 경보는 계속 확인할 수 있습니다.', autoRefresh: 0 }); return; }
    const r = request('metrics'); set({ metricsLoading: true, metricsError: undefined });
    try {
      const window = monitoringWindow(range, Date.now(), customStart, customEnd);
      const metrics = await api.monitoringMetrics(profile, region, metricResources, { startTime: window.start, endTime: window.end }, refresh, r.signal, Object.fromEntries(metricResources.filter(k => get().resources?.resources.find(r => r.key === k)?.type === 'target-group').map(k => [k,get().metricContexts[k]])));
      if (r.current()) {
        const previous = get().alarms?.scope ?? get().resources?.scope;
        if (previous && !sameScope(previous, metrics.scope)) {
          cancel();
          set({ scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌었습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, restoreNotice: undefined, restoreCandidates: [], restoreMissingKeys: [], autoRefresh: 0, selectedResources: [], resources: undefined, resourceCoverage: {}, alarms: undefined, selectedAlarm: undefined, history: undefined, groups: readGroups(metrics.scope), metrics: undefined, metricsLoading: false, alarmLoading: false, historyLoading: false, resourceLoading: false, metricsError: '다른 계정의 지표 응답을 폐기했습니다.' });
          void get().loadAlarms();
          return;
        }
        const quality = metricQuality(Object.values(metrics.series).flat());
        set({ metrics, metricsError: quality.message, ...(quality.disposition === 'stop' ? { autoRefresh: 0 } : {}) });
      }
    } catch (e) { if (r.current()) { const error = classifyMonitoringError(e); set({ metricsError: error.message, ...(error.disposition === 'stop' ? { autoRefresh: 0 } : {}) }); } }
    finally { if (r.current()) set({ metricsLoading: false }); }
  },
  selectAlarm(selectedAlarm) { clearHistoryTimer(); controllers.get('history')?.abort(); set({ selectedAlarm, history: undefined, historyWindow: undefined, historyError: undefined, historyLoading: false }); if (selectedAlarm) void get().loadHistory(); },
  async loadHistory(nextToken) {
    clearHistoryTimer();
    const { profile, region, selectedAlarm, range, customStart, customEnd } = get(); if (!selectedAlarm) return;
    const r = request('history'); set({ historyLoading: true, historyError: undefined });
    try {
      const window = nextToken && get().historyWindow ? get().historyWindow! : monitoringWindow(range, Date.now(), customStart, customEnd);
      if (r.current()) set({ historyWindow: window });
      const history = await api.monitoringHistory(profile, region, selectedAlarm.name, selectedAlarm.type, window, nextToken, r.signal);
      if (!r.current()) return;
      const scope = get().alarms?.scope ?? get().resources?.scope;
      if (scope && !sameScope(scope, history.scope)) {
        cancel();
        set({ scopeNotice: 'AWS 계정 또는 인증 소스가 바뀌어 경보 이력을 폐기했습니다. 다시 연결로 계정을 확인하세요.', resourceFilters: emptyResourceFilters(), autoRefresh: 0, selectedResources: [], referenceResource: undefined, related: undefined, relatedLoading: false, relatedError: undefined, resources: undefined, resourceCoverage: {}, resourceLoading: false, resourceError: undefined, metrics: undefined, metricsLoading: false, metricsError: undefined, alarms: undefined, alarmLoading: false, alarmError: undefined, selectedAlarm: undefined, history: undefined, historyWindow: undefined, historyLoading: false, historyError: '다른 계정의 경보 이력 응답을 폐기했습니다.', groups: readGroups(history.scope), groupsError: undefined, restoreNotice: undefined, restoreCandidates: [], restoreMissingKeys: [] });
        return;
      }
      set({ history: nextToken && get().history ? { ...history, items: [...get().history!.items, ...history.items] } : history, historyError: history.observation.error });
    }
    catch (e) { if (r.current()) set({ historyError: (e as Error).message }); }
    finally { if (r.current()) set({ historyLoading: false }); }
  },
  setCustomTime(field, value) {
    controllers.get('metrics')?.abort(); controllers.get('history')?.abort(); clearHistoryTimer();
    set({ [field]: value, metrics: undefined, metricsLoading: false, history: undefined, historyWindow: undefined, historyError: undefined, historyLoading: false });
    if (!get().selectedAlarm || get().range !== 'custom') return;
    const g = generation, selected = get().selectedAlarm!;
    historyTimer = setTimeout(() => {
      historyTimer = undefined;
      const current = get().selectedAlarm;
      if (g === generation && get().workspaceActive && get().range === 'custom' && current?.name === selected.name && current.type === selected.type && current.region === selected.region) void get().loadHistory();
    }, 300);
  },
  setRange(range) { clearHistoryTimer(); controllers.get('metrics')?.abort(); set({ range, metrics: undefined, metricsLoading: false, ...(range === 'custom' ? { autoRefresh: 0 } : {}) }); if (get().selectedAlarm) void get().loadHistory(); },
}));
export function matchingAlarms(alarms: AlarmRecord[], query: string, state: string): AlarmRecord[] {
  return alarms.filter((a) => (state === 'ALL' || a.state === state) && `${a.name} ${a.reason ?? ''}`.toLowerCase().includes(query.toLowerCase()));
}
