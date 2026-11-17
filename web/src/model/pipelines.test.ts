import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineRunning, stageStatuses } from './pipelines';
test('only running and stopping executions keep polling', () => {
  for (const status of ['InProgress', 'Stopping']) assert.equal(pipelineRunning(status), true);
  for (const status of ['Succeeded', 'Failed', 'Stopped', 'Superseded', 'Cancelled', undefined]) assert.equal(pipelineRunning(status), false);
});
test('parallel actions and retries preserve mixed stage outcomes', () => {
  assert.equal(stageStatuses(['Failed', 'Succeeded', 'Succeeded'].map(status => ({ stage: 'Build', name: 'Compile', status }))), 'Failed / Succeeded');
  assert.equal(stageStatuses([]), '');
});

import { latestActions, stageTone, selectionKey, readPipelineSelection, savePipelineSelection, pipelinePool } from './pipelines';
test('new successful retries replace old failures, incomplete and parallel stages cannot show success', () => {
  const actions = [
    { stage: 'Build', name: 'compile', status: 'Succeeded', startedAt: '2026-01-01T02:00:00Z' },
    { stage: 'Build', name: 'compile', status: 'Failed', startedAt: '2026-01-01T01:00:00Z' },
  ];
  assert.equal(latestActions(actions).length, 1);
  assert.equal(stageTone(actions, 1), 'success');
  assert.equal(stageTone(actions, 2), 'idle');
  assert.equal(stageTone([...actions, { stage: 'Build', name: 'approve', status: 'InProgress', category: 'Approval' }], 2), 'waiting');
  assert.equal(stageTone([]), 'idle');
});
test('selection persistence isolates profile, account and region; corrupted values cannot become names', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const key = selectionKey('demo', '111111111111', 'ap-northeast-2');
  assert.equal(savePipelineSelection(storage, key, ['api', 'web']), true);
  assert.deepEqual(readPipelineSelection(storage, key), ['api', 'web']);
  for (const other of [selectionKey('other', '111111111111', 'ap-northeast-2'), selectionKey('demo', '222222222222', 'ap-northeast-2'), selectionKey('demo', '111111111111', 'us-east-1')]) assert.deepEqual(readPipelineSelection(storage, other), []);
  storage.setItem(key, '["api","api",1,"bad/name"]');
  assert.deepEqual(readPipelineSelection(storage, key), ['api']);
  storage.setItem(key, '{'); assert.deepEqual(readPipelineSelection(storage, key), []);
  assert.equal(savePipelineSelection({ setItem: () => { throw new Error('quota'); } }, key, []), false);
});
test('board bounds concurrent lookups and stops scheduling removed scopes', async () => {
  const controller = new AbortController(); let running = 0, peak = 0, calls = 0;
  await pipelinePool([1, 2, 3, 4, 5, 6], controller.signal, async () => {
    calls++; peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort(); running--;
  });
  assert.equal(peak, 3); assert.equal(calls, 3);
});

import { pipelineMatches, selectPipelineResults } from './pipelines';
test('pipeline search matches names, tag keys, values and key=value without confusing tags', () => {
  const tags = [{ key: 'Environment', value: 'Prod' }, { key: 'Team', value: 'Guest Experience' }];
  for (const query of [' api ', 'environment', 'PROD', 'Environment=Prod', 'guest experience', '']) assert.equal(pipelineMatches('api-service', tags, query), true, query);
  assert.equal(pipelineMatches('api-service', tags, 'Environment=Guest'), false);
  assert.equal(pipelineMatches('api-service', undefined, 'prod'), false);
  assert.equal(pipelineMatches('api-service', undefined, 'API'), true);
});
test('bulk selection preserves choices outside the search and deduplicates all pages', () => {
  assert.deepEqual(selectPipelineResults(['outside', 'api'], ['api', 'worker', 'worker'], true), ['outside', 'api', 'worker']);
  assert.deepEqual(selectPipelineResults(['outside', 'api', 'worker'], ['api', 'worker'], false), ['outside']);
  assert.deepEqual(selectPipelineResults(['outside'], [], true), ['outside']);
});
