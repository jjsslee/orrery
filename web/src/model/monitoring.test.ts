/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../api/client';
import { useMonitoring, matchingAlarms, monitoringWindow } from './monitoring';
import type { AlarmRecord, MonitoringAlarmSnapshot } from '@orrery/shared';
const scope = { source: 'profile:test', account: 'dummy-account', region: 'test-region' };
const observation = { attemptedAt: '2026-10-23T00:00:00Z', succeededAt: '2026-10-23T00:00:00Z' };
const alarm = (state: AlarmRecord['state']): AlarmRecord => ({ name: 'fixture', state, type: 'composite', region: scope.region, metrics: [], mapping: 'unresolved', resourceKeys: [] });
test('independent alarms preserve unlinked composites and refresh selected detail', async () => {
  const original = { ...api }; let state: AlarmRecord['state'] = 'ALARM';
  api.monitoringAlarms = async () => ({ scope, observation, complete: true, alarms: [alarm(state)] }); api.monitoringHistory = async () => ({ items: [], observation });
  try { useMonitoring.getState().activate('test', scope.region); await useMonitoring.getState().loadAlarms(); useMonitoring.getState().selectAlarm(alarm(state)); state = 'OK'; await useMonitoring.getState().loadAlarms(); assert.equal(useMonitoring.getState().selectedAlarm?.state, 'OK'); assert.equal(useMonitoring.getState().alarms?.alarms[0].type, 'composite'); assert.equal(matchingAlarms([alarm('ALARM')], 'FIX', 'ALARM').length, 1); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});
test('monitoring A → B → A ignores old alarms and old finally', async () => {
  const original = api.monitoringAlarms; const requests: Array<{ resolve: (v: MonitoringAlarmSnapshot) => void }> = [];
  api.monitoringAlarms = () => new Promise((resolve) => requests.push({ resolve }));
  try { useMonitoring.getState().activate('A', 'r'); useMonitoring.getState().activate('B', 'r'); useMonitoring.getState().activate('A', 'r'); requests[0].resolve({ scope, observation, complete: true, alarms: [alarm('ALARM')] }); await Promise.resolve(); await Promise.resolve(); assert.equal(useMonitoring.getState().alarmLoading, true); assert.equal(useMonitoring.getState().alarms, undefined); requests[2].resolve({ scope, observation, complete: true, alarms: [alarm('OK')] }); requests[1].resolve({ scope, observation, complete: true, alarms: [] }); await Promise.resolve(); await Promise.resolve(); assert.equal(useMonitoring.getState().alarms?.alarms[0].state, 'OK'); } finally { useMonitoring.getState().deactivate(); api.monitoringAlarms = original; }
});
test('relative and custom time windows validate direction and maximum duration', () => { const now = Date.parse('2026-10-23T00:00:00Z'); assert.equal(Date.parse(monitoringWindow('3h', now).end) - Date.parse(monitoringWindow('3h', now).start), 10800000); assert.throws(() => monitoringWindow('custom', now, '2026-10-23', '2026-10-22')); assert.throws(() => monitoringWindow('custom', now, '2026-10-01', '2026-10-22')); });

test('automatic account change in resource index cannot retain previous account resources and selections', async () => {
  const original = { ...api };
  useMonitoring.setState({ profile: 'test', region: 'r', alarms: { scope, observation, complete: true, alarms: [] }, resources: { scope, observation, complete: true, types: ['lambda'], resources: [{ key: 'old', nodeId: 'old', nativeId: 'old', name: 'old', type: 'lambda', region: 'r', tagsStatus: 'complete', props: {} }] }, selectedResources: ['old'] });
  api.monitoringResources = async () => ({ scope: { ...scope, account: 'new' }, observation, complete: true, types: ['sqs-queue'], resources: [] });
  api.monitoringAlarms = () => new Promise(() => {});
  try { await useMonitoring.getState().loadResources('sqs-queue'); assert.deepEqual(useMonitoring.getState().selectedResources, []); assert.equal(useMonitoring.getState().resources?.resources.length, 0); assert.equal(useMonitoring.getState().alarms, undefined); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('selected metrics are manual, bounded to four resources, and stale responses cannot cross account changes', async () => {
  const original = { ...api }; let calls = 0; let resolve!: (result: Awaited<ReturnType<typeof api.monitoringMetrics>>) => void;
  useMonitoring.setState({ profile: 'test', region: scope.region, selectedResources: [], alarms: { scope, observation, complete: true, alarms: [] }, metrics: undefined });
  api.monitoringMetrics = async (_p, _r, keys, window) => { calls++; assert.deepEqual(keys, ['a', 'b', 'c', 'd']); return new Promise((r) => { resolve = r; }); };
  api.monitoringAlarms = async () => ({ scope: { ...scope, account: 'new-account' }, observation, complete: true, alarms: [] });
  try { for (const key of ['a', 'b', 'c', 'd', 'e']) useMonitoring.getState().toggleResource(key); assert.equal(calls, 0); assert.deepEqual(useMonitoring.getState().selectedResources, ['a', 'b', 'c', 'd']); const pending = useMonitoring.getState().loadMetrics(); assert.equal(calls, 1); await useMonitoring.getState().loadAlarms(); resolve({ scope, range: { startTime: observation.attemptedAt, endTime: observation.attemptedAt }, collectedAt: observation.attemptedAt, series: {}, queryCount: 1, requestCount: 1, maxRequests: 10 }); await pending; assert.equal(useMonitoring.getState().metrics, undefined); assert.deepEqual(useMonitoring.getState().selectedResources, []); assert.equal(useMonitoring.getState().autoRefresh, 0); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('resource types accumulate and a successful requery recovers partial coverage', async () => {
  const original = { ...api }; let complete = true;
  useMonitoring.setState({ profile: 'test', region: scope.region, alarms: { scope, observation, complete: true, alarms: [] }, resources: undefined, resourceCoverage: {} });
  api.monitoringAlarms = async () => ({ scope, observation, complete: true, alarms: [] });
  api.monitoringResources = async (_p, _r, type) => ({ scope, observation, complete, types: [type], resources: [{ key: type, nodeId: type, type, nativeId: type, name: type, region: scope.region, tagsStatus: 'complete', props: {} }] });
  try { await useMonitoring.getState().loadResources('lambda'); complete = false; await useMonitoring.getState().loadResources('sqs-queue'); assert.equal(useMonitoring.getState().resources?.complete, false); assert.equal(useMonitoring.getState().resources?.resources.length, 2); complete = true; await useMonitoring.getState().loadResources('sqs-queue'); assert.equal(useMonitoring.getState().resources?.complete, true); assert.equal(useMonitoring.getState().resources?.resources.length, 2); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('automatic refresh stops for per-series permission errors and reports transient partial failures', async () => {
  const original = api.monitoringMetrics; let message = 'Forbidden: AccessDenied';
  useMonitoring.setState({ profile: 'test', region: scope.region, selectedResources: ['dummy'], alarms: { scope, observation, complete: true, alarms: [] }, autoRefresh: 60000, metricsError: undefined });
  api.monitoringMetrics = async () => ({ scope, collectedAt: observation.attemptedAt, range: { startTime: observation.attemptedAt, endTime: observation.attemptedAt }, queryCount: 1, requestCount: 1, maxRequests: 10, series: { dummy: [{ id: 'test', name: 'test', label: 'test', stat: 'Sum', unit: 'Count', points: [], latest: null, status: 'error', messages: [message] }] } });
  try { await useMonitoring.getState().loadMetrics(); assert.equal(useMonitoring.getState().autoRefresh, 0); assert.match(useMonitoring.getState().metricsError ?? '', /권한|다시 연결/); message = 'ThrottlingException'; useMonitoring.setState({ autoRefresh: 60000 }); await useMonitoring.getState().loadMetrics(); assert.equal(useMonitoring.getState().autoRefresh, 60000); assert.match(useMonitoring.getState().metricsError ?? '', /Throttling/); } finally { useMonitoring.getState().deactivate(); api.monitoringMetrics = original; }
});

test('resource discovery batch stops on menu departure and clears tag/group drafts on scope change', async () => {
  const original = { ...api }; const calls: string[] = [];
  let finish!: (value: Awaited<ReturnType<typeof api.monitoringResources>>) => void;
  useMonitoring.setState({ profile: 'test', region: scope.region, alarms: { scope, observation, complete: true, alarms: [] }, resourceFilters: { query: 'old', tags: [{ key: 'Service', value: 'wiki' }], tagStatus: 'all' }, resourceGroupKeys: ['old-account-key'] });
  api.monitoringResources = async (_p, _r, type) => { calls.push(type); return new Promise((resolve) => { finish = resolve; }); };
  api.monitoringAlarms = () => new Promise(() => {});
  try {
    const pending = useMonitoring.getState().loadResourceTypes(['lambda', 'sqs-queue']);
    useMonitoring.getState().deactivate();
    finish({ scope, observation, complete: true, resources: [], types: ['lambda'] });
    await pending;
    assert.deepEqual(calls, ['lambda']);
    useMonitoring.getState().activate('different-profile', scope.region);
    assert.deepEqual(useMonitoring.getState().resourceFilters, { query: '', tags: [], tagStatus: 'all' });
    assert.deepEqual(useMonitoring.getState().resourceGroupKeys, []);
  } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});
