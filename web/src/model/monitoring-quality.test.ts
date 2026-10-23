/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMonitoringError, metricQuality } from './monitoring-quality';
import type { MetricSeries } from '@orrery/shared';
const series = (status: MetricSeries['status'], messages: string[]): MetricSeries => ({ name: 'fixture', label: 'fixture', stat: 'Sum', unit: 'Count', points: [], latest: null, status, messages });
test('permission/expired credentials and invalid input stop auto refresh; 429 and server errors retry', () => {
  for (const error of [Object.assign(new Error('denied'), { status: 403 }), new Error('ExpiredToken'), Object.assign(new Error('invalid query'), { status: 400 })]) assert.equal(classifyMonitoringError(error).disposition, 'stop');
  for (const error of [Object.assign(new Error('slow down'), { status: 429 }), Object.assign(new Error('temporary service error'), { status: 503 }), new Error('ThrottlingException')]) assert.equal(classifyMonitoringError(error).disposition, 'retry');
});
test('empty/zero are success, partial/internal failure back off and auth errors take priority', () => {
  assert.equal(metricQuality([series('empty', [])]).disposition, 'success');
  assert.equal(metricQuality([series('partial', [])]).disposition, 'retry');
  assert.equal(metricQuality([series('error', ['InternalError'])]).disposition, 'retry');
  assert.equal(metricQuality([series('partial', ['PartialData']), series('error', ['Forbidden'])]).disposition, 'stop');
});
