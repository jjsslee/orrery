/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Monitoring } from './Monitoring';
import { useMonitoring } from '../model/monitoring';
import { useStore } from '../model/store';

const scope = { source: 'profile:fixture', account: '000000000000', region: 'ap-northeast-2' };
const observed = { attemptedAt: '2026-10-23T00:00:00Z', succeededAt: '2026-10-23T00:00:00Z' };
const resource = (key: string, name: string) => ({ key, nodeId: key, name, nativeId: key, type: 'lambda' as const, region: scope.region, tags: { Service: 'fixture-wiki' }, tagsStatus: 'complete' as const, props: {} });
function render(patch = {}) {
  const app = useStore.getInitialState(), monitoring = useMonitoring.getInitialState();
  const previousApp = { ...app }, previousMonitoring = { ...monitoring };
  Object.assign(app, { setup: 'done', profile: 'fixture', region: scope.region, loading: { active: false, reports: {}, order: [] } });
  Object.assign(monitoring, { resources: { scope, resources: [resource('one', 'fixture-worker')], types: ['lambda'], complete: true, observation: observed }, resourceLoading: false, resourceError: undefined, selectedResources: [], groups: [], alarms: { scope, alarms: [], complete: true, observation: observed }, ...patch });
  try { return renderToStaticMarkup(createElement(Monitoring)); }
  finally { Object.assign(app, previousApp); Object.assign(monitoring, previousMonitoring); }
}

test('first render is a resource workspace with search, explicit add, same-screen CloudWatch and related evidence', () => {
  const html = render();
  assert.match(html, /aria-label="자원 검색"/);
  assert.match(html, /fixture-worker 추가/);
  assert.match(html, /mw-tag-picker[^>]*open/);
  assert.match(html, /aria-label="태그 키"/);
  assert.match(html, /aria-label="태그 값"/);
  assert.match(html, /CloudWatch/);
  assert.match(html, /선으로 연결된 자원/);
  assert.match(html, /같은 태그의 자원/);
  assert.doesNotMatch(html, /모니터링 화면|묶음에 추가할 자원|선택 자원 지표 보기|지원 6유형 조회/);
});

test('selection renders resource-specific charts and alarms in the workspace without a separate metric menu', () => {
  const html = render({ selectedResources: ['one'], referenceResource: 'one', metrics: { scope, collectedAt: observed.succeededAt, range: { startTime: observed.attemptedAt, endTime: observed.attemptedAt }, queryCount: 1, requestCount: 1, maxRequests: 10, series: { one: [{ id: 'Invocations:Sum', name: 'Invocations', label: '호출 수', stat: 'Sum', unit: 'Count', latest: 0, points: [{ t: Date.parse(observed.attemptedAt), v: 0 }], status: 'complete', period: 60 }] } }, alarms: { scope, observation: observed, complete: true, alarms: [{ name: 'fixture-alarm', state: 'ALARM', type: 'metric', region: scope.region, metrics: [], mapping: 'matched', resourceKeys: ['one'] }] } });
  assert.match(html, /fixture-worker/);
  assert.match(html, /호출 수/);
  assert.match(html, /fixture-alarm/);
  assert.ok(html.indexOf('fixture-alarm') < html.indexOf('호출 수'));
  assert.match(html, /유료|비용/);
  assert.match(html, /fixture-worker 빼기/);
  assert.doesNotMatch(html, /자원 찾기에서 최대 4개를 선택|선택 지표 조회/);
});

test('related candidates retain exact tag evidence, connection direction and provenance limits', () => {
  const candidate = resource('two', 'fixture-queue');
  const html = render({ selectedResources: ['one'], referenceResource: 'one', related: { scope, resourceKey: 'one', connected: [{ resource: candidate, reasons: [{ kind: 'edge', direction: 'incoming', edgeKind: 'invokes', label: 'fixture trigger', evidence: 'unknown' }] }], sameTags: [{ resource: candidate, reasons: [{ kind: 'tag', key: 'Service', value: 'fixture-wiki' }] }], graph: { state: 'partial', observation: { ...observed, error: 'fixture partial' } }, tagCoverage: { types: ['lambda'], incompleteTypes: ['sqs-queue'] } } });
  assert.match(html, /fixture-queue 추가/);
  assert.match(html, /Service/); assert.match(html, /fixture-wiki/);
  assert.match(html, /들어오는|기준 자원으로/);
  assert.match(html, /직접 확인·추정 구분 미제공/);
  assert.match(html, /일부|부분/);
});

test('unsupported metrics and regional alarm mapping limits cannot be mistaken for a healthy resource', () => {
  const html = render({ selectedResources: ['one'], referenceResource: 'one', resources: { scope, resources: [{ ...resource('one', 'fixture-global'), metricsSupported: false, metricsUnsupportedReason: 'fixture 지표 미지원', alarmMappingSupported: false, alarmScopeWarning: 'fixture 글로벌 경보는 선택 리전의 조회 범위입니다.' }], types: [], complete: false, observation: observed }, related: { scope, resourceKey: 'one', connected: [], sameTags: [], graph: { state: 'loading' }, tagCoverage: { types: [], incompleteTypes: ['lambda'] } } });
  assert.match(html, /fixture 지표 미지원/);
  assert.match(html, /경보 유무를 판단할 수 없습니다/);
  assert.match(html, /fixture 글로벌 경보는 선택 리전의 조회 범위/);
  assert.match(html, /연결 구성 확인 중/);
  assert.doesNotMatch(html, /이 자원에 매핑된 경보가 없습니다|선으로 연결된 자원을 찾지 못했습니다/);
});

test('an added resource can be taken back out wherever it is offered: tray, search result, related candidate and its card', () => {
  const worker = resource('one', 'fixture-worker'), queue = resource('two', 'fixture-queue');
  const html = render({ selectedResources: ['one', 'two'], referenceResource: 'one', resources: { scope, resources: [worker, queue], types: ['lambda'], complete: true, observation: observed }, related: { scope, resourceKey: 'one', connected: [{ resource: queue, reasons: [{ kind: 'edge', direction: 'outgoing', edgeKind: 'publishes', evidence: 'unknown' }] }], sameTags: [], graph: { state: 'complete', observation: observed }, tagCoverage: { types: ['lambda'], incompleteTypes: [] } } });
  assert.equal(html.match(/aria-label="fixture-queue 빼기"/g)?.length, 4);
  assert.equal(html.match(/aria-label="fixture-worker 빼기"/g)?.length, 3);
  assert.doesNotMatch(html, /fixture-queue 추가/);
});

test('a full set of eight keeps the add controls visible but disabled and says how to make room', () => {
  const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const html = render({ selectedResources: keys, resources: { scope, resources: [...keys.map((key) => resource(key, `fixture-${key}`)), resource('extra', 'fixture-extra')], types: ['lambda'], complete: true, observation: observed } });
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="fixture-extra 추가"|<button[^>]*aria-label="fixture-extra 추가"[^>]*disabled=""/);
  assert.match(html, /8\/8/);
  assert.match(html, /하나를 빼세요/);
});

test('the eight-resource limit is stated before the user hits it: empty tray, remaining slots and the cost note', () => {
  const empty = render();
  assert.match(empty, /최대 8개/);
  const html = render({ selectedResources: ['one'], referenceResource: 'one' });
  assert.match(html, /1\/8/);
  assert.match(html, /7개 더 추가할 수 있습니다/);
  assert.match(html, /최대 8개 자원/);
});
