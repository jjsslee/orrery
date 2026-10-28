import { create } from 'zustand';
import type { MonitoringScope, Category, CollectorReport, MetricsBundle, ProfileInfo, ResourceGraph, ResourceNode, ResourceType } from '@orrery/shared';
import { api } from '../api/client';
import { sameTagFilter, type TagFilter } from './tags';
import { TYPE_META } from './types';

export type ViewMode = 'topology' | 'types' | 'monitoring' | 'cleanup';

export interface Overlays {
  security: boolean;
  iam: boolean;
  encryption: boolean;
  targetGroups: boolean;
  /** Show regional resources that have no relationship as individual nodes */
  isolated: boolean;
  traffic: boolean;
}

export interface LoadingState {
  active: boolean;
  /** collector name → report (or undefined while pending) */
  reports: Record<string, CollectorReport | undefined>;
  order: string[];
  error?: string;
  startedAt?: number;
}

interface Persisted { view?: ViewMode; profile?: string; region?: string; theme?: 'dark' | 'light'; live?: boolean }

const PERSIST_KEY = 'orrery.prefs';
const loadPrefs = (): Persisted => { try { return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}') as Persisted; } catch { return {}; } };
const savePrefs = (p: Persisted) => { try { localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* ignore */ } };

export interface AppState {
  profiles: ProfileInfo[];
  /** Server-side default (ORRERY_DEFAULT_PROFILE / AWS_PROFILE / default) */
  defaultProfile?: string;
  /** True once the user picked a profile in this session; auto-picked ones may be swapped on auth failure */
  profileChosen: boolean;
  /** 'needed' when this PC has no AWS profiles yet: the stage shows the setup guide instead of collecting */
  setup: 'checking' | 'needed' | 'done';
  collectorLabels: Record<string, string>;
  profile: string;
  region: string;
  regions: string[];
  identity?: { account: string; arn: string };
  theme: 'dark' | 'light';

  graph?: ResourceGraph;
  metrics?: MetricsBundle;
  metricsLoading: boolean;
  metricsError?: string;
  statusError?: string;
  loading: LoadingState;

  view: ViewMode;
  selectedId?: string;
  hoverId?: string;
  query: string;
  categories: Record<Category, boolean>;
  hiddenTypes: Set<ResourceType>;
  overlays: Overlays;
  expanded: Set<string>;
  /** Monotonic counter: bump to ask the canvas to fit the view */
  fitRequest: number;
  /** Ask the canvas to zoom onto one node (set by locate()) */
  locateRequest?: { id: string; seq: number };
  railTab: 'types' | 'tags';
  /** Live mode: periodic status passes (free calls) and silent full re-collects; metrics stay manual */
  live: boolean;
  liveStatusAt?: number;
  liveGraphAt?: number;
  liveBusy: boolean;
  /** Node ids whose status changed in the last status pass (for the highlight animation) */
  changed: Record<string, number>;
  /** Active tag filters; a resource must satisfy all of them */
  tagFilters: TagFilter[];
  /** Also show resources one hop away from a tagged resource */
  tagNeighbors: boolean;

  connectionGeneration: number;
  reconnect(): Promise<void>;
  bootstrap(): Promise<void>;
  setProfile(profile: string): Promise<void>;
  setRegion(region: string): Promise<void>;
  load(refresh?: boolean, opts?: { silent?: boolean }): Promise<void>;
  setLive(v: boolean): void;
  refreshStatus(): Promise<void>;
  loadMetrics(refresh?: boolean): Promise<void>;
  setView(v: ViewMode): void;
  select(id?: string, opts?: { reveal?: boolean }): void;
  /** Switch to the topology, select the node and zoom onto it */
  locate(id: string): void;
  hover(id?: string): void;
  setQuery(q: string): void;
  toggleCategory(c: Category): void;
  toggleType(t: ResourceType): void;
  setOverlay<K extends keyof Overlays>(k: K, v: boolean): void;
  toggleExpanded(id: string): void;
  setTheme(t: 'dark' | 'light'): void;
  requestFit(): void;
  setRailTab(t: 'types' | 'tags'): void;
  /** Check or uncheck every type at once */
  setAllTypes(visible: boolean): void;
  /** Check only this type (VPC/subnet plates stay for context) */
  onlyType(t: ResourceType): void;
  resetFilters(): void;
  addTagFilter(f: TagFilter): void;
  removeTagFilter(f: TagFilter): void;
  clearTagFilters(): void;
  setTagNeighbors(v: boolean): void;
}

type RequestKind = 'graph' | 'metrics' | 'status' | 'identity' | 'regions' | 'bootstrap';
let scopeGeneration = 0;
const requests = new Map<RequestKind, AbortController>();
function beginRequest(kind: RequestKind) {
  requests.get(kind)?.abort();
  const controller = new AbortController();
  requests.set(kind, controller);
  const generation = scopeGeneration;
  return { signal: controller.signal, current: () => generation === scopeGeneration && requests.get(kind) === controller && !controller.signal.aborted };
}
function cancelRequests() {
  scopeGeneration++;
  for (const controller of requests.values()) controller.abort();
  requests.clear();
}

/** Late region responses must never replace a newer profile selection. */
function fetchRegions(profile: string, region: string): void {
  const request = beginRequest('regions');
  api.regions(profile, request.signal)
    .then(({ regions }) => { if (request.current()) useStore.setState((s) => ({ regions, loading: region ? s.loading : { ...s.loading, error: undefined } })); })
    .catch((err: Error) => { if (request.current()) useStore.setState((s) => (region ? { regions: [region] } : { regions: [], loading: { ...s.loading, error: err.message } })); });
}

function fetchIdentity(profile: string, region: string): void {
  if (!region) return;
  const request = beginRequest('identity');
  void api.identity(profile, region, request.signal).then((id) => { if (request.current()) useStore.setState({ identity: { account: id.account, arn: id.arn } }); }).catch(() => {});
}

function matchesCurrentScope(scope: MonitoringScope | undefined): boolean {
  if (!scope) return true; // Older fixtures and cached clients may omit metadata.
  const { graph, identity, region } = useStore.getState();
  return (!graph || (graph.account === scope.account && graph.source === scope.source && graph.region === scope.region)) && (!identity || identity.account === scope.account) && region === scope.region;
}

const ALL_TYPES = Object.keys(TYPE_META) as ResourceType[];
const ALL_ON: Record<Category, boolean> = { compute: true, network: true, database: true, storage: true, security: true, integration: true };

export const useStore = create<AppState>((set, get) => ({
  connectionGeneration: 0,
  profiles: [],
  profileChosen: false,
  setup: 'checking',
  collectorLabels: {},
  profile: loadPrefs().profile ?? '',
  region: loadPrefs().region ?? '',
  regions: [],
  theme: loadPrefs().theme ?? 'dark',
  metricsLoading: false,
  loading: { active: false, reports: {}, order: [] },
  view: loadPrefs().view === 'monitoring' ? 'monitoring' : 'topology',
  query: '',
  categories: { compute: true, network: true, database: true, storage: true, security: true, integration: true },
  hiddenTypes: new Set(),
  overlays: { security: false, iam: false, encryption: false, targetGroups: false, isolated: false, traffic: true },
  expanded: new Set(),
  fitRequest: 0,
  railTab: 'types',
  live: loadPrefs().live ?? false,
  liveBusy: false,
  changed: {},
  tagFilters: [],
  tagNeighbors: false,

  async bootstrap() {
    const request = beginRequest('bootstrap');
    document.documentElement.dataset.theme = get().theme;
    try {
      const [{ profiles, defaultProfile }, collectorLabels] = await Promise.all([api.profiles(), api.collectors()]);
      if (!request.current()) return;
      // Nothing configured on this PC yet: guide the setup rather than try a profile that does not exist.
      if (!profiles.length) {
        set({ profiles, defaultProfile, collectorLabels, setup: 'needed' });
        return;
      }
      const wanted = get().profile;
      const profile = profiles.find((p) => p.name === wanted)?.name ?? defaultProfile;
      // No saved region and none in the profile: wait for the person to pick one rather than guess.
      const region = get().region || profiles.find((p) => p.name === profile)?.region || '';
      // The choice is persisted only after a successful load (see load()), so a broken saved profile does not stick.
      set({ profiles, defaultProfile, collectorLabels, profile, region, setup: 'done' });
      if (get().view !== 'monitoring') void get().load(false);
      else fetchIdentity(profile, region);
      fetchRegions(profile, region);
    } catch (error) {
      if (request.current()) set({ graph: undefined, metrics: undefined, identity: undefined, profiles: [], loading: { active: false, reports: {}, order: [], error: (error as Error).message } });
    }
  },

  async reconnect() {
    cancelRequests();
    const { profile, region } = get();
    set({ connectionGeneration: get().connectionGeneration + 1, graph: undefined, metrics: undefined, identity: undefined, liveBusy: false, metricsLoading: false, loading: { active: true, reports: {}, order: [] } });
    const r = beginRequest('identity');
    try {
      await api.identity(profile, region, r.signal, true);
      if (!r.current()) return;
      await get().setProfile(profile);
    } catch (e) { if (r.current()) set({ loading: { active: false, reports: {}, order: [], error: (e as Error).message } }); }
  },

  async setProfile(profile) {
    cancelRequests();
    set({ connectionGeneration: get().connectionGeneration + 1, loading: { active: false, reports: {}, order: [] } });
    const p = get().profiles.find((x) => x.name === profile);
    const region = p?.region ?? get().region;
    set({ regions: [], metricsLoading: false, liveBusy: false, metricsError: undefined, statusError: undefined, liveStatusAt: undefined, liveGraphAt: undefined, profile, region, profileChosen: true, graph: undefined, metrics: undefined, selectedId: undefined, identity: undefined, expanded: new Set(), tagFilters: [] });
    savePrefs({ profile, region });
    fetchRegions(profile, region);
    if (get().view !== 'monitoring') await get().load(false);
    else fetchIdentity(get().profile, region);
  },

  async setRegion(region) {
    cancelRequests();
    set({ metricsLoading: false, liveBusy: false, metricsError: undefined, statusError: undefined, liveStatusAt: undefined, liveGraphAt: undefined, identity: undefined, region, graph: undefined, metrics: undefined, selectedId: undefined, expanded: new Set(), tagFilters: [] });
    savePrefs({ region });
    fetchRegions(get().profile, region);
    if (get().view !== 'monitoring') await get().load(false);
    else fetchIdentity(get().profile, region);
  },

  async load(refresh = false, opts = {}) {
    if (!get().region) return;
    const silent = Boolean(opts.silent && get().graph);
    const request = beginRequest('graph');
    // A new graph invalidates dependent responses even when the selected scope is unchanged.
    for (const kind of ['status', 'identity', 'metrics'] as const) { requests.get(kind)?.abort(); requests.delete(kind); }
    set({ liveBusy: false, metricsLoading: false });
    const { profile, region, collectorLabels } = get();
    const order = Object.keys(collectorLabels);
    if (!silent) set({ loading: { active: true, reports: {}, order, startedAt: Date.now() }, metrics: undefined });
    else set({ liveBusy: true });
    try {
      const graph = await api.streamGraph(profile, region, refresh, (e) => {
        if (silent || !request.current()) return;
        if (e.type === 'start') set((s) => ({ identity: { account: e.account, arn: s.identity?.arn ?? '' }, loading: { ...s.loading, order: e.collectors.length ? e.collectors : s.loading.order } }));
        if (e.type === 'collector') set((s) => ({ loading: { ...s.loading, reports: { ...s.loading.reports, [e.report.collector]: e.report } } }));
      }, request.signal);
      if (!request.current()) return;
      if (silent) {
        // Keep the existing layout calm: only swap the data, mark what changed, no refit, no metrics (metered).
        const prev = new Map(get().graph?.nodes.map((n) => [n.id, n]));
        const now = Date.now();
        const changed: Record<string, number> = {};
        for (const n of graph.nodes) { const o = prev.get(n.id); if (o && (o.status !== n.status || o.statusLabel !== n.statusLabel)) changed[n.id] = now; }
        set({ graph, liveGraphAt: now, liveBusy: false, changed });
        return;
      }
      const errors = [graph.statusObservation?.error, graph.alarmObservation?.error].filter(Boolean);
      set({ statusError: errors.length ? `일부 상태 조회 실패 · 이전 상태가 포함됩니다: ${errors.join(' / ')}` : undefined, graph, loading: { active: false, reports: {}, order }, fitRequest: get().fitRequest + 1, changed: {} });
      savePrefs({ profile, region });
      const identityRequest = beginRequest('identity');
      void api.identity(profile, region, identityRequest.signal).then((id) => { if (identityRequest.current()) set({ identity: { account: id.account, arn: id.arn } }); }).catch(() => {});

    } catch (err) {
      if (!request.current()) return;
      if ((err as Error).name === 'AbortError') return;
      if (silent) { set({ liveBusy: false, statusError: `구성 조회 실패 · 이전 구성을 표시합니다: ${(err as Error).message}` }); return; }
      // A saved-but-broken profile (401) that the user did not pick this session: fall back to the server default.
      const { defaultProfile, profileChosen } = get();
      if ((err as { status?: number }).status === 401 && get().profiles.find((p) => p.name === profile)?.method !== 'sso' && !profileChosen && defaultProfile && defaultProfile !== profile) {
        console.info(`[orrery] profile '${profile}' failed to authenticate; switching to '${defaultProfile}'`);
        const fallback = get().setProfile(defaultProfile);
        const fallbackGeneration = scopeGeneration;
        await fallback;
        if (scopeGeneration === fallbackGeneration) set({ profileChosen: false });
        return;
      }
      set((s) => ({ loading: { ...s.loading, active: false, error: (err as Error).message } }));
    }
  },

  setLive: (live) => { savePrefs({ live }); set({ live }); },

  /** Status-only pass: merges fresh status fields into the current graph without re-layout. */
  async refreshStatus() {
    const { profile, region, graph } = get();
    if (!graph || get().liveBusy) return;
    const request = beginRequest('status');
    set({ liveBusy: true, statusError: undefined });
    try {
      const bundle = await api.status(profile, region, request.signal);
      const current = get().graph;
      if (!current || !request.current()) return;
      if (!matchesCurrentScope(bundle.scope)) { set({ statusError: 'AWS 계정 또는 인증 소스가 바뀌었습니다. 이전 상태를 표시합니다. 다시 연결로 계정을 확인하세요.' }); return; }
      const now = Date.now();
      const changed: Record<string, number> = {};
      const nodes = current.nodes.map((n) => {
        const f = bundle.nodes[n.id];
        if (!f) return n;
        if (f.status !== n.status || f.statusLabel !== n.statusLabel || (f.alarms?.length ?? 0) !== (n.alarms?.length ?? 0)) changed[n.id] = now;
        return { ...n, status: f.status, statusLabel: f.statusLabel, alarms: f.alarms, props: { ...n.props, ...f.props } };
      });
      const edges = current.edges.map((e) => (bundle.edges[e.id] && bundle.edges[e.id] !== e.status ? { ...e, status: bundle.edges[e.id] } : e));
      const failed = bundle.reports.filter((r) => !r.ok).map((r) => `${r.collector}: ${r.error ?? '조회 실패'}`);
      const observationErrors = [bundle.statusObservation?.error, bundle.alarmObservation?.error].filter(Boolean);
      const errors = [...new Set([...observationErrors, ...failed])];
      set({ statusError: errors.length ? `일부 상태 조회 실패 · 이전 상태가 포함됩니다: ${errors.join(' / ')}` : undefined, graph: { ...current, nodes, edges, statusObservation: bundle.statusObservation, alarmObservation: bundle.alarmObservation }, liveStatusAt: bundle.statusObservation?.succeededAt ? Date.parse(bundle.statusObservation.succeededAt) : (errors.length ? get().liveStatusAt : now), changed: Object.keys(changed).length ? changed : get().changed });
    } catch (err) {
      if (request.current()) set({ statusError: `상태 조회 실패 · 이전 상태를 표시합니다: ${(err as Error).message}` });
    } finally {
      if (request.current()) set({ liveBusy: false });
    }
  },

  async loadMetrics(refresh = false) {
    const { profile, region } = get();
    const request = beginRequest('metrics');
    set({ metricsLoading: true, metricsError: undefined });
    try {
      const metrics = await api.metrics(profile, region, refresh, request.signal);
      if (request.current()) {
        if (!matchesCurrentScope(metrics.scope)) { set({ metricsError: 'AWS 계정 또는 인증 소스가 바뀌었습니다. 다른 계정의 지표를 표시하지 않습니다. 다시 연결로 계정을 확인하세요.' }); return; }
        set({ metrics });
      }
    } catch (err) {
      if (request.current()) set({ metricsError: `지표 조회 실패 · 이전 값이 있으면 유지합니다: ${(err as Error).message}` });
    } finally {
      if (request.current()) set({ metricsLoading: false });
    }
  },

  setView: (view) => {
    if (view === get().view) return;
    if (view === 'monitoring') {
      cancelRequests();
      set({ view, loading: { active: false, reports: {}, order: [] }, metricsLoading: false, liveBusy: false });
      fetchRegions(get().profile, get().region);
      fetchIdentity(get().profile, get().region);
    } else {
      set({ view });
      if (!get().graph && get().region) void get().load();
    }
    savePrefs({ view });
  },
  select: (selectedId, opts) => {
    set({ selectedId });
    if (opts?.reveal && selectedId) {
      // make sure the node is not hidden behind a collapsed aggregate
      const node = get().graph?.nodes.find((n) => n.id === selectedId);
      if (node) set((s) => ({ expanded: new Set([...s.expanded, aggregateKeyFor(node)]) }));
    }
  },
  locate: (id) => {
    get().setView('topology');
    set((s) => ({ selectedId: id, locateRequest: { id, seq: (s.locateRequest?.seq ?? 0) + 1 } }));
  },
  hover: (hoverId) => set({ hoverId }),
  setQuery: (query) => set({ query }),
  // A category checkbox is the union of its types: any visible → hide all, none visible → show all.
  toggleCategory: (c) => set((s) => {
    const types = ALL_TYPES.filter((t) => TYPE_META[t].category === c);
    const anyVisible = types.some((t) => !s.hiddenTypes.has(t));
    const next = new Set(s.hiddenTypes);
    for (const t of types) anyVisible ? next.add(t) : next.delete(t);
    return { hiddenTypes: next, categories: ALL_ON };
  }),
  toggleType: (t) => set((s) => { const next = new Set(s.hiddenTypes); next.has(t) ? next.delete(t) : next.add(t); return { hiddenTypes: next, categories: ALL_ON }; }),
  // Unchecking everything keeps the VPC/subnet plates so whatever gets checked next still has its place.
  setAllTypes: (visible) => set({ hiddenTypes: visible ? new Set() : new Set(ALL_TYPES.filter((t) => t !== 'vpc' && t !== 'subnet')), categories: ALL_ON }),
  onlyType: (t) => set({ hiddenTypes: new Set(ALL_TYPES.filter((x) => x !== t && x !== 'vpc' && x !== 'subnet')), categories: ALL_ON }),
  resetFilters: () => set({ hiddenTypes: new Set(), categories: ALL_ON, query: '', tagFilters: [] }),
  setOverlay: (k, v) => set((s) => ({ overlays: { ...s.overlays, [k]: v } })),
  toggleExpanded: (id) => set((s) => { const next = new Set(s.expanded); next.has(id) ? next.delete(id) : next.add(id); return { expanded: next }; }),
  setTheme: (theme) => { document.documentElement.dataset.theme = theme; savePrefs({ theme }); set({ theme }); },
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
  setRailTab: (railTab) => set({ railTab }),
  addTagFilter: (f) => set((s) => {
    // A key-only filter is replaced by a value filter on the same key (and vice versa)
    const rest = s.tagFilters.filter((x) => x.key !== f.key || (x.value !== undefined && f.value !== undefined && x.value !== f.value));
    if (rest.some((x) => sameTagFilter(x, f))) return { railTab: 'tags' };
    return { tagFilters: [...rest, f], railTab: 'tags' };
  }),
  removeTagFilter: (f) => set((s) => ({ tagFilters: s.tagFilters.filter((x) => !sameTagFilter(x, f)) })),
  clearTagFilters: () => set({ tagFilters: [] }),
  setTagNeighbors: (tagNeighbors) => set({ tagNeighbors }),
}));

/** Aggregate id a node would fold into (parent + type). Mirrors layout/prepare.ts */
export function aggregateKeyFor(node: ResourceNode): string {
  return `agg:${node.parentId ?? `lane:${node.category}`}:${node.type}`;
}

export const selectGraph = (s: AppState) => s.graph;
export const selectSelectedNode = (s: AppState) => (s.selectedId && s.graph ? s.graph.nodes.find((n) => n.id === s.selectedId) : undefined);
