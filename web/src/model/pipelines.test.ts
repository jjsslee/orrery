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
