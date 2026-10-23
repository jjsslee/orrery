/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sparkline } from './Sparkline';
import type { MetricSeries } from '@orrery/shared';
const series = (points: MetricSeries['points']): MetricSeries => ({ name: 'Count', label: '건수', stat: 'Sum', unit: 'Count', latest: 0, points, period: 60, startTime: new Date(0).toISOString(), endTime: new Date(240000).toISOString() });
test('a single zero is data and is drawn at its actual position in the requested time window', () => {
  const html = renderToStaticMarkup(createElement(Sparkline, { series: series([{ t: 60000, v: 0 }]), width: 248 }));
  assert.doesNotMatch(html, /데이터 없음/); assert.match(html, /<circle[^>]*cx="64"/);
});
test('missing periods split paths instead of connecting missing intervals', () => {
  const html = renderToStaticMarkup(createElement(Sparkline, { series: series([{ t: 0, v: 1 }, { t: 60000, v: 2 }, { t: 240000, v: 3 }]) }));
  const line = html.match(/<path d="([^"]+)" fill="none"/);
  assert.ok(line); assert.equal((line[1].match(/M/g) ?? []).length, 2);
});

test('shared cursor reports a missing bucket instead of an adjacent value', () => {
  const html = renderToStaticMarkup(createElement(Sparkline, { series: series([{ t: 0, v: 1 }, { t: 240000, v: 3 }]), width: 248, timeDomain: { start: 0, end: 240000 }, hoverTime: 120000 }));
  assert.match(html, /결측/); assert.match(html, /x1="124"/);
});
test('matching metrics can use the same value scale across resources', () => {
  const html = renderToStaticMarkup(createElement(Sparkline, { series: series([{ t: 60000, v: 10 }]), valueDomain: { min: 0, max: 100 }, height: 108 }));
  assert.match(html, /<circle[^>]*cy="94"/);
});
