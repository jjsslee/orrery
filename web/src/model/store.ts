import { create } from 'zustand';
import type { Category, CollectorReport, MetricsBundle, ProfileInfo, ResourceGraph, ResourceNode, ResourceType } from '@orrery/shared';
import { api } from '../api/client';
import { sameTagFilter, type TagFilter } from './tags';

export type ViewMode = 'topology' | 'types';

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

interface Persisted { profile?: string; region?: string; theme?: 'dark' | 'light' }

const PERSIST_KEY = 'orrery.prefs';
const loadPrefs = (): Persisted => { try { return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? '{}') as Persisted; } catch { return {}; } };
const savePrefs = (p: Persisted) => { try { localStorage.setItem(PERSIST_KEY, JSON.stringify({ ...loadPrefs(), ...p })); } catch { /* ignore */ } };

export interface AppState {
  profiles: ProfileInfo[];
  collectorLabels: Record<string, string>;
  profile: string;
  region: string;
  regions: string[];
  identity?: { account: string; arn: string };
  theme: 'dark' | 'light';

  graph?: ResourceGraph;
  metrics?: MetricsBundle;
  metricsLoading: boolean;
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
  railTab: 'types' | 'tags';
  /** Active tag filters; a resource must satisfy all of them */
  tagFilters: TagFilter[];
  /** Also show resources one hop away from a tagged resource */
  tagNeighbors: boolean;

  bootstrap(): Promise<void>;
  setProfile(profile: string): Promise<void>;
  setRegion(region: string): Promise<void>;
  load(refresh?: boolean): Promise<void>;
  loadMetrics(refresh?: boolean): Promise<void>;
  setView(v: ViewMode): void;
  select(id?: string, opts?: { reveal?: boolean }): void;
  hover(id?: string): void;
  setQuery(q: string): void;
  toggleCategory(c: Category): void;
  toggleType(t: ResourceType): void;
  setOverlay<K extends keyof Overlays>(k: K, v: boolean): void;
  toggleExpanded(id: string): void;
  setTheme(t: 'dark' | 'light'): void;
  requestFit(): void;
  setRailTab(t: 'types' | 'tags'): void;
  addTagFilter(f: TagFilter): void;
  removeTagFilter(f: TagFilter): void;
  clearTagFilters(): void;
  setTagNeighbors(v: boolean): void;
}

let abort: AbortController | undefined;

export const useStore = create<AppState>((set, get) => ({
  profiles: [],
  collectorLabels: {},
  profile: loadPrefs().profile ?? '',
  region: loadPrefs().region ?? '',
  regions: [],
  theme: loadPrefs().theme ?? 'dark',
  metricsLoading: false,
  loading: { active: false, reports: {}, order: [] },
  view: 'topology',
  query: '',
  categories: { compute: true, network: true, database: true, storage: true, security: true, integration: true },
  hiddenTypes: new Set(),
  overlays: { security: false, iam: false, encryption: false, targetGroups: false, isolated: false, traffic: true },
  expanded: new Set(),
  fitRequest: 0,
  railTab: 'types',
  tagFilters: [],
  tagNeighbors: false,

  async bootstrap() {
    document.documentElement.dataset.theme = get().theme;
    const [{ profiles, defaultProfile }, collectorLabels] = await Promise.all([api.profiles(), api.collectors()]);
    const wanted = get().profile;
    const profile = profiles.find((p) => p.name === wanted)?.name ?? defaultProfile;
    const region = get().region || profiles.find((p) => p.name === profile)?.region || 'ap-northeast-2';
    set({ profiles, collectorLabels, profile, region });
    savePrefs({ profile, region });
    void get().load(false);
    void api.regions(profile).then(({ regions }) => set({ regions })).catch(() => set({ regions: [region] }));
  },

  async setProfile(profile) {
    const p = get().profiles.find((x) => x.name === profile);
    const region = p?.region ?? get().region;
    set({ profile, region, graph: undefined, metrics: undefined, selectedId: undefined, identity: undefined, expanded: new Set(), tagFilters: [] });
    savePrefs({ profile, region });
    void api.regions(profile).then(({ regions }) => set({ regions })).catch(() => set({ regions: [region] }));
    await get().load(false);
  },

  async setRegion(region) {
    set({ region, graph: undefined, metrics: undefined, selectedId: undefined, expanded: new Set(), tagFilters: [] });
    savePrefs({ region });
    await get().load(false);
  },

  async load(refresh = false) {
    abort?.abort();
    abort = new AbortController();
    const { profile, region, collectorLabels } = get();
    const order = Object.keys(collectorLabels);
    set({ loading: { active: true, reports: {}, order, startedAt: Date.now() }, metrics: undefined });
    try {
      const graph = await api.streamGraph(profile, region, refresh, (e) => {
        if (e.type === 'start') set((s) => ({ identity: { account: e.account, arn: s.identity?.arn ?? '' }, loading: { ...s.loading, order: e.collectors.length ? e.collectors : s.loading.order } }));
        if (e.type === 'collector') set((s) => ({ loading: { ...s.loading, reports: { ...s.loading.reports, [e.report.collector]: e.report } } }));
      }, abort.signal);
      set({ graph, loading: { active: false, reports: {}, order }, fitRequest: get().fitRequest + 1 });
      void api.identity(profile, region).then((id) => set({ identity: { account: id.account, arn: id.arn } })).catch(() => {});
      void get().loadMetrics(refresh);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      set((s) => ({ loading: { ...s.loading, active: false, error: (err as Error).message } }));
    }
  },

  async loadMetrics(refresh = false) {
    const { profile, region } = get();
    set({ metricsLoading: true });
    try {
      const metrics = await api.metrics(profile, region, refresh);
      if (get().profile === profile && get().region === region) set({ metrics });
    } catch (err) {
      console.warn('metrics unavailable', err);
    } finally {
      set({ metricsLoading: false });
    }
  },

  setView: (view) => set({ view }),
  select: (selectedId, opts) => {
    set({ selectedId });
    if (opts?.reveal && selectedId) {
      // make sure the node is not hidden behind a collapsed aggregate
      const node = get().graph?.nodes.find((n) => n.id === selectedId);
      if (node) set((s) => ({ expanded: new Set([...s.expanded, aggregateKeyFor(node)]) }));
    }
  },
  hover: (hoverId) => set({ hoverId }),
  setQuery: (query) => set({ query }),
  toggleCategory: (c) => set((s) => ({ categories: { ...s.categories, [c]: !s.categories[c] } })),
  toggleType: (t) => set((s) => { const next = new Set(s.hiddenTypes); next.has(t) ? next.delete(t) : next.add(t); return { hiddenTypes: next }; }),
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
