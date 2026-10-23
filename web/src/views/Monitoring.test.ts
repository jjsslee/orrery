/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Monitoring } from './Monitoring';
import { MonitoringMetrics } from './MonitoringMetrics';
import { useMonitoring } from '../model/monitoring';
import { useStore } from '../model/store';

test('resource discovery exposes tag search and grouping directly without opening overview', () => {
  // SSR uses Zustand's initial snapshot, just as the first browser render does.
  const app = useStore.getInitialState(), monitoring = useMonitoring.getInitialState();
  const previousApp = { ...app }, previousMonitoring = { ...monitoring };
  Object.assign(app, { setup: 'done', profile: 'fixture', region: 'ap-northeast-2' });
  Object.assign(monitoring, { activeTab: 'resources', resources: undefined, groups: [] });
  try {
    const html = renderToStaticMarkup(createElement(Monitoring));
    assert.match(html, /태그로 조회/);
    assert.match(html, /태그 없는 자원/);
    assert.match(html, /지원 6유형 조회/);
    assert.match(html, /묶음에 추가할 자원/);
  } finally { Object.assign(app, previousApp); Object.assign(monitoring, previousMonitoring); }
});

test('metric comparison exposes a display filter for query problems', () => {
  const html = renderToStaticMarkup(createElement(MonitoringMetrics));
  assert.match(html, /조회 문제만 보기/);
});
