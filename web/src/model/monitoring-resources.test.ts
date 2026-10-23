/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MonitoringResource } from '@orrery/shared';
import { appendResourceTag, emptyResourceFilters, filterMonitoringResources, metricNeedsAttention } from './monitoring-resources';
import { groupResources } from './monitoring-groups';

const resource = (key: string, tags?: Record<string, string>, tagsStatus: MonitoringResource['tagsStatus'] = 'complete'): MonitoringResource => ({ key, nodeId: key, name: key, nativeId: key, type: 'lambda', region: 'ap-northeast-2', tags, tagsStatus, props: {} });
const resources = [resource('Wiki-dev', { Service: 'wiki', Env: 'dev' }), resource('Wiki-prod', { Service: 'wiki', Env: 'prod' }), resource('stt-dev', { Service: 'stt', Env: 'dev' }), resource('queue-untagged'), resource('queue-denied', undefined, 'unavailable')];
test('resource tag lookup uses same-key OR, different-key AND, name search and exact empty tag values', () => {
  const tags = [{ key: 'Service', value: 'wiki' }, { key: 'Service', value: 'stt' }, { key: 'Env', value: 'dev' }];
  assert.deepEqual(filterMonitoringResources(resources, { ...emptyResourceFilters(), tags }).map((r) => r.key), ['Wiki-dev', 'stt-dev']);
  assert.deepEqual(filterMonitoringResources(resources, { ...emptyResourceFilters(), query: ' WIKI ', tags }).map((r) => r.key), ['Wiki-dev']);
  assert.equal(filterMonitoringResources([resource('blank', { Service: '' })], { ...emptyResourceFilters(), tags: [{ key: 'Service', value: '' }] }).length, 1);
  assert.equal(appendResourceTag(tags, tags[0]).length, 3);
});
test('untagged resources exclude tag permission failures and remain manually included when filters change', () => {
  assert.deepEqual(filterMonitoringResources(resources, { ...emptyResourceFilters(), tagStatus: 'untagged' }).map((r) => r.key), ['queue-untagged']);
  assert.deepEqual(filterMonitoringResources(resources, { ...emptyResourceFilters(), tagStatus: 'unavailable' }).map((r) => r.key), ['queue-denied']);
  assert.deepEqual(filterMonitoringResources(resources, { ...emptyResourceFilters(), tags: [{ key: 'Service', value: 'wiki' }], tagStatus: 'untagged' }).map((r) => r.key), ['queue-untagged']);
  const group = { id: 'fixture', name: 'wiki', tagFilters: [{ key: 'Service', value: 'wiki' }], resourceKeys: ['queue-untagged', 'queue-denied'] };
  assert.deepEqual(groupResources(group, resources).map((r) => r.key), ['Wiki-dev', 'Wiki-prod', 'queue-untagged', 'queue-denied']);
});
test('metric display distinguishes healthy zero from empty, partial and delayed observations', () => {
  const series = { id: 'Count:Sum', name: 'Count', label: '건수', stat: 'Sum', unit: 'count', latest: 0, points: [{ t: 0, v: 0 }], status: 'complete' as const, period: 60, endTime: new Date(60000).toISOString(), lastDataAt: new Date(0).toISOString() };
  assert.equal(metricNeedsAttention(series), false);
  assert.equal(metricNeedsAttention({ ...series, status: 'empty' }), true);
  assert.equal(metricNeedsAttention({ ...series, status: 'partial' }), true);
  assert.equal(metricNeedsAttention({ ...series, endTime: new Date(240000).toISOString() }), true);
});
