/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../api/client';
import { useStore } from './store';
import type { CollectEvent, MetricsBundle, ResourceGraph } from '@orrery/shared';

function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const graph = (account: string): ResourceGraph => ({ account, source: 'test', region: 'r', collectedAt: '', nodes: [], edges: [], reports: [] });
const metrics = (label: string): MetricsBundle => ({ region: label, collectedAt: '', series: {}, traffic: {} });

test('resource type controls and layer state stay in sync', () => {
  const store = useStore.getState();
  store.setAllTypes(false);
  store.toggleType('security-group');
  assert.equal(useStore.getState().overlays.security, true);
  assert.equal(useStore.getState().hiddenTypes.has('security-group'), false);
  store.setOverlay('security', false);
  assert.equal(useStore.getState().hiddenTypes.has('security-group'), true);
  store.onlyType('kms-key');
  assert.equal(useStore.getState().overlays.encryption, true);
  assert.equal(useStore.getState().overlays.security, false);
  store.toggleCategory('security');
  assert.equal(useStore.getState().overlays.encryption, false);
  store.setAllTypes(true);
  assert.equal(useStore.getState().overlays.targetGroups, true);
  assert.equal(useStore.getState().overlays.iam, true);
  store.setAllTypes(false);
  store.resetFilters();
  assert.equal(useStore.getState().hiddenTypes.size, 0);
  assert.equal(useStore.getState().overlays.security, true);
});

test('status filtering clears selection and resets with the other filters', () => {
  useStore.setState({ selectedId: 'previous-selection' });
  useStore.getState().setStatusFilter('critical');
  assert.equal(useStore.getState().statusFilter, 'critical');
  assert.equal(useStore.getState().selectedId, undefined);
  useStore.getState().resetFilters();
  assert.equal(useStore.getState().statusFilter, undefined);
});
function reset() { useStore.setState({ profile: 'A', region: 'r', graph: graph('new'), metrics: undefined, metricsLoading: false, liveBusy: false, loading: { active: false, reports: {}, order: [] } }); }

test('tag selection toggles values and whole keys without removing other filters', () => {
  const other = { key: 'Environment', value: 'dev' };
  for (const filter of [{ key: 'Service', value: 'api' }, { key: 'Service', value: '' }, { key: 'Service' }]) {
    useStore.setState({ tagFilters: [other] });
    useStore.getState().toggleTagFilter(filter);
    assert.deepEqual(useStore.getState().tagFilters, [other, filter]);
    useStore.getState().toggleTagFilter(filter);
    assert.deepEqual(useStore.getState().tagFilters, [other]);
  }
  useStore.getState().clearTagFilters();
});

test('tag selection preserves multiple values and replaces whole-key filters', () => {
  const first = { key: 'Service', value: 'api' };
  const second = { key: 'Service', value: 'web' };
  useStore.setState({ tagFilters: [] });
  const pick = useStore.getState().toggleTagFilter;
  pick(first);
  pick(second);
  assert.deepEqual(useStore.getState().tagFilters, [first, second]);
  pick(first);
  assert.deepEqual(useStore.getState().tagFilters, [second]);
  pick({ key: 'Service' });
  assert.deepEqual(useStore.getState().tagFilters, [{ key: 'Service' }]);
  pick(first);
  assert.deepEqual(useStore.getState().tagFilters, [first]);
  useStore.getState().clearTagFilters();
});

test('bootstrap authentication failure is visible and clears old account data without rejecting', async () => {
  reset();
  const original = { ...api };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} } } });
  api.profiles = async () => { throw Object.assign(new Error('접속 인증이 필요합니다.'), { status: 401 }); };
  api.collectors = async () => ({});
  try {
    await useStore.getState().bootstrap();
    assert.match(useStore.getState().loading.error ?? '', /접속 인증/);
    assert.equal(useStore.getState().graph, undefined);
    assert.equal(useStore.getState().identity, undefined);
  } finally {
    Object.assign(api, original);
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('same-scope metrics: stale success and finally cannot overwrite newer request', async () => {
  reset(); const old = api.metrics; const first = deferred<MetricsBundle>(), next = deferred<MetricsBundle>(); let n = 0;
  api.metrics = () => (++n === 1 ? first.promise : next.promise);
  try { const a = useStore.getState().loadMetrics(); const b = useStore.getState().loadMetrics(); first.resolve(metrics('stale')); await a; assert.equal(useStore.getState().metricsLoading, true); assert.equal(useStore.getState().metrics, undefined); next.resolve(metrics('fresh')); await b; assert.equal(useStore.getState().metrics?.region, 'fresh'); } finally { api.metrics = old; }
});

test('same-scope graph: stale events and errors cannot replace current loading', async () => {
  reset(); const old = api.streamGraph; const first = deferred<ResourceGraph>(), next = deferred<ResourceGraph>(); const events: Array<(e: CollectEvent) => void> = [];
  api.streamGraph = (_p, _r, _f, cb) => { events.push(cb); return events.length === 1 ? first.promise : next.promise; };
  try { const a = useStore.getState().load(); const b = useStore.getState().load(); events[0]({ type: 'start', account: 'stale', region: 'r', collectors: [] }); assert.notEqual(useStore.getState().identity?.account, 'stale'); first.reject(new Error('old error')); await a; assert.equal(useStore.getState().loading.active, true); assert.equal(useStore.getState().loading.error, undefined); next.reject(new Error('current error')); await b; assert.equal(useStore.getState().loading.error, 'current error'); } finally { api.streamGraph = old; }
});

test('A → B → A: late regions, identity, metrics, events and failures stay in their original generation', async () => {
  reset(); const original = { ...api };
  const graphs = Array.from({ length: 3 }, () => deferred<ResourceGraph>());
  const regions = Array.from({ length: 3 }, () => deferred<{ regions: string[] }>());
  const ids = Array.from({ length: 2 }, () => deferred<{ account: string; arn: string; region: string; source: string }>());
  const events: Array<(e: CollectEvent) => void> = []; let r = 0, i = 0;
  api.streamGraph = (_p, _r, _f, cb) => { events.push(cb); return graphs[events.length - 1].promise; };
  api.regions = () => regions[r++].promise;
  api.identity = () => ids[i++].promise;
  const staleMetrics = deferred<MetricsBundle>(); api.metrics = () => staleMetrics.promise;
  try {
    const first = useStore.getState().setProfile('A'); graphs[0].resolve(graph('old-account')); await first;
    const metricRequest = useStore.getState().loadMetrics();
    const second = useStore.getState().setProfile('B'); const third = useStore.getState().setProfile('A');
    graphs[2].resolve(graph('new-account')); await third;
    ids[1].resolve({ account: 'new-account', arn: 'new', region: 'r', source: 'test' });
    regions[2].resolve({ regions: ['new-region'] }); await Promise.resolve();
    regions[0].resolve({ regions: ['old-region'] }); regions[1].reject(new Error('old regions'));
    ids[0].resolve({ account: 'old-account', arn: 'old', region: 'r', source: 'test' });
    staleMetrics.resolve(metrics('old')); await metricRequest;
    events[1]({ type: 'start', account: 'B-account', region: 'r', collectors: [] });
    graphs[1].reject(new Error('B failure')); await second;
    assert.equal(useStore.getState().identity?.account, 'new-account');
    assert.deepEqual(useStore.getState().regions, ['new-region']);
    assert.equal(useStore.getState().metrics, undefined);
    assert.equal(useStore.getState().graph?.account, 'new-account');
    assert.equal(useStore.getState().loading.error, undefined);
  } finally { Object.assign(api, original); }
});

test('old status finally cannot clear a newer busy flag after a scope change', async () => {
  reset(); const original = { ...api }; const old = deferred<Awaited<ReturnType<typeof api.status>>>(); const next = deferred<Awaited<ReturnType<typeof api.status>>>(); let n = 0;
  api.status = () => ++n === 1 ? old.promise : next.promise;
  api.regions = async () => ({ regions: [] }); api.streamGraph = async () => graph('current'); api.identity = async () => ({ account: 'current', arn: '', region: 'r', source: '' });
  try {
    const first = useStore.getState().refreshStatus(); await useStore.getState().setProfile('B'); const second = useStore.getState().refreshStatus();
    old.reject(new Error('old status')); await first; assert.equal(useStore.getState().liveBusy, true); assert.equal(useStore.getState().statusError, undefined);
    next.reject(new Error('current status')); await second; assert.equal(useStore.getState().liveBusy, false); assert.match(useStore.getState().statusError ?? '', /current status/);
  } finally { Object.assign(api, original); }
});

test('partial status is visible and preserves distinct alarm/status success times', async () => {
  reset(); const original = api.status;
  api.status = async () => ({ collectedAt: '2026-10-23T01:00:00Z', checked: 0, nodes: {}, edges: {}, durationMs: 1, reports: [{ collector: 'alarms', ok: false, durationMs: 1, nodes: 0, edges: 0, error: 'AccessDenied' }], statusObservation: { attemptedAt: '2026-10-23T01:00:00Z', succeededAt: '2026-10-23T01:00:00Z' }, alarmObservation: { attemptedAt: '2026-10-23T01:00:00Z', succeededAt: '2026-10-23T00:00:00Z', error: 'AccessDenied' } });
  try { await useStore.getState().refreshStatus(); assert.match(useStore.getState().statusError ?? '', /AccessDenied/); assert.equal(useStore.getState().graph?.alarmObservation?.succeededAt, '2026-10-23T00:00:00Z'); } finally { api.status = original; }
});

test('topology collection does not automatically request metered metrics', async () => {
  reset(); const original = { ...api }; let calls = 0;
  api.streamGraph = async () => graph('test'); api.identity = async () => ({ account: 'test', arn: '', region: 'r', source: '' }); api.metrics = async () => { calls++; return metrics('unexpected'); };
  try { await useStore.getState().load(); await Promise.resolve(); assert.equal(calls, 0); } finally { Object.assign(api, original); }
});

test('direct monitoring and profile/region changes never collect the full topology', async () => {
  reset(); const original = { ...api }; let graphs = 0, identities = 0;
  api.streamGraph = async () => { graphs++; return graph('unexpected'); }; api.identity = async () => { identities++; return { account: 'test', arn: '', region: 'r', source: '' }; }; api.regions = async () => ({ regions: ['r'] });
  try { useStore.getState().setView('monitoring'); await useStore.getState().setProfile('B'); await useStore.getState().setRegion('next'); assert.equal(graphs, 0); assert.ok(identities > 0); assert.equal(useStore.getState().loading.active, false); } finally { useStore.setState({ view: 'topology' }); Object.assign(api, original); }
});
test('explicit reconnect rechecks identity before any topology collection', async () => {
  reset(); const original = { ...api }; const order: string[] = [];
  api.identity = async (_p, _r, _s, reconnect) => { order.push(reconnect ? 'reconnect' : 'identity'); return { account: 'new', arn: '', region: 'r', source: '' }; }; api.streamGraph = async () => { order.push('graph'); return graph('new'); }; api.regions = async () => ({ regions: ['r'] });
  try { await useStore.getState().reconnect(); assert.equal(order[0], 'reconnect'); assert.equal(order[1], 'graph'); } finally { Object.assign(api, original); }
});

test('automatic session account change rejects status and metrics from a different graph scope', async () => {
  reset(); const original = { ...api };
  api.status = async () => ({ scope: { source: 'test', account: 'other-account', region: 'r' }, collectedAt: '', checked: 0, nodes: {}, edges: {}, durationMs: 0, reports: [] });
  api.metrics = async () => ({ ...metrics('r'), scope: { source: 'test', account: 'other-account', region: 'r' } });
  try { await useStore.getState().refreshStatus(); assert.match(useStore.getState().statusError ?? '', /계정|다시 연결/); await useStore.getState().loadMetrics(); assert.equal(useStore.getState().metrics, undefined); assert.match(useStore.getState().metricsError ?? '', /계정|다시 연결/); } finally { Object.assign(api, original); }
});

test('late successful graph after profile switch cannot restore the previous account graph', async () => {
  reset(); useStore.setState({ view: 'topology' });
  const original = { ...api };
  const first = deferred<ResourceGraph>();
  api.regions = async () => ({ regions: ['r'] });
  api.identity = async () => ({ account: 'account-B', arn: '', region: 'r', source: 'test' });
  api.streamGraph = (profile) => profile === 'A' ? first.promise : Promise.resolve(graph('account-B'));
  try {
    const pending = useStore.getState().setProfile('A');
    await useStore.getState().setProfile('B');
    first.resolve(graph('account-A'));
    await pending;
    assert.equal(useStore.getState().graph?.account, 'account-B');
  } finally { Object.assign(api, original); }
});

test('an expired saved SSO profile stays selected for login instead of falling back to another account', async () => {
  reset();
  const original = api.streamGraph;
  const previous = useStore.getState();
  useStore.setState({ profile: 'sso-dev', profiles: [{ name: 'sso-dev', method: 'sso', isDefault: false }], defaultProfile: 'other-account', profileChosen: false });
  api.streamGraph = async () => { throw Object.assign(new Error('SSO login required'), { status: 401 }); };
  try {
    await useStore.getState().load();
    assert.equal(useStore.getState().profile, 'sso-dev');
    assert.equal(useStore.getState().loading.error, 'SSO login required');
  } finally {
    api.streamGraph = original;
    useStore.setState({ profiles: previous.profiles, defaultProfile: previous.defaultProfile, profileChosen: previous.profileChosen });
  }
});
