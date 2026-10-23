/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MonitoringResource, SavedResourceGroup } from '@orrery/shared';
import { groupResources, groupHasIncompleteCoverage, groupStorageKey, readGroups, writeGroups } from './monitoring-groups';
const scope = { source: 'profile:dummy', account: 'dummy-account', region: 'r' };
const resource = (id: string, tags?: Record<string, string>, complete = true): MonitoringResource => ({ key: JSON.stringify([scope.account, 'r', 'lambda', id]), nodeId: id, nativeId: id, name: id, region: 'r', type: 'lambda', tags, tagsStatus: complete ? 'complete' : 'unavailable', props: {} });
test('groups use manual OR tags, same-key OR and cross-key AND, and exclude unavailable tags', () => {
  const a = resource('a', { Service: 'wiki', Phase: 'prod' }), b = resource('b', { Service: 'stt', Phase: 'prod' }), c = resource('c', { Service: 'wiki', Phase: 'dev' }), d = resource('d', { Service: 'wiki', Phase: 'prod' }, false);
  const group: SavedResourceGroup = { id: 'g', name: 'dummy', resourceKeys: [c.key], tagFilters: [{ key: 'Service', value: 'wiki' }, { key: 'Service', value: 'stt' }, { key: 'Phase', value: 'prod' }] };
  assert.deepEqual(groupResources(group, [a, b, c, d]).map((r) => r.nodeId), ['a', 'b', 'c']);
});
test('versioned storage isolates authentication source/account/region and stores only configuration', () => {
  const data = new Map<string, string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const group: SavedResourceGroup = { id: 'g', name: 'dummy', tagFilters: [], resourceKeys: ['dummy-resource'] };
  writeGroups(scope, [group], storage); assert.deepEqual(readGroups(scope, storage), [group]);
  for (const other of [{ ...scope, source: 'other' }, { ...scope, account: 'other' }, { ...scope, region: 'other' }]) assert.deepEqual(readGroups(other, storage), []);
  assert.equal(data.size, 1); assert.deepEqual(Object.keys(JSON.parse(data.get(groupStorageKey(scope))!)), ['version', 'groups']);
  storage.setItem(groupStorageKey(scope), '{bad'); assert.deepEqual(readGroups(scope, storage), []);
});
test('unqueried/deleted manual resources and missing tag coverage never claim a fully observed group', () => {
  const a = resource('a'); const group: SavedResourceGroup = { id: 'g', name: 'dummy', resourceKeys: [a.key], tagFilters: [] };
  assert.equal(groupHasIncompleteCoverage(group, [], { lambda: { complete: true } }), true);
  assert.equal(groupHasIncompleteCoverage(group, [a], {}), true);
  assert.equal(groupHasIncompleteCoverage(group, [a], { lambda: { complete: true } }), false);
  assert.equal(groupHasIncompleteCoverage({ ...group, tagFilters: [{ key: 'Service' }] }, [a], { lambda: { complete: true } }), true);
});
