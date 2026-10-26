import test from 'node:test';
import assert from 'node:assert/strict';
import type { MonitoringMetricRequest, MonitoringResource } from '@orrery/shared';
import { MetricsRepository, derivedErrorRate, effectivePeriod, monitoringQueries, planMetrics, validateMetricRequest } from './metrics.ts';
import type { MonitoringSession } from './alarms.ts';
import type { ClientFactory } from '../aws/clients.ts';

const now = Date.now();
const resource = (name: string, type: MonitoringResource['type'] = 'lambda'): MonitoringResource => ({ key: name, nodeId: name, type, nativeId: name, name, region: 'ap-northeast-2', tagsStatus: 'complete', props: {} });
const body = (keys = ['one']): MonitoringMetricRequest => ({ resourceKeys: keys, range: { startTime: new Date(now - 3600_000).toISOString(), endTime: new Date(now - 1000).toISOString() } });
const session = (send: (command: any) => Promise<any>): MonitoringSession => ({ source: 'profile:test', account: '000000000000', region: 'ap-northeast-2', clients: { get: () => ({ send }) } as unknown as ClientFactory });

test('metric validation rejects resource/query/range/command expansion before AWS', () => {
  for (const invalid of [body(Array.from({ length: 9 }, (_, i) => `k${i}`)), { ...body(), metricIds: Array.from({ length: 101 }, (_, i) => `metric${i}`) }, { ...body(), namespace: 'Custom' }, { ...body(), range: { startTime: new Date(now).toISOString(), endTime: new Date(now + 1000).toISOString() } }, { ...body(), range: { startTime: new Date(now - 8 * 86400_000).toISOString(), endTime: new Date(now - 1).toISOString() } }]) assert.throws(() => validateMetricRequest(invalid, now), { statusCode: 400 });
  assert.doesNotThrow(() => validateMetricRequest(body(Array.from({ length: 8 }, (_, i) => `k${i}`)), now));
  assert.throws(() => planMetrics(body(), [], now), /현재 계정/);
  assert.throws(() => planMetrics({ ...body(), metricIds: ['Anything:Sum'] }, [resource('one')], now), /지원하지 않는/);
});

test('selected 2 resources generate only selected catalog queries and exact dimensions', async () => {
  const calls: any[] = [];
  const s = session(async (c) => { calls.push(c); return { MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({ Id: q.Id, StatusCode: 'Complete', Timestamps: [new Date(now - 60_000)], Values: [0] })) }; });
  const result = await new MetricsRepository().get(s, { ...body(['one', 'two']), metricIds: ['Invocations:Sum'] }, [resource('one'), resource('two'), resource('unselected')]);
  assert.equal(result.queryCount, 2);
  assert.deepEqual(calls[0].input.MetricDataQueries.map((q: any) => q.MetricStat.Metric.Dimensions), [[{ Name: 'FunctionName', Value: 'one' }], [{ Name: 'FunctionName', Value: 'two' }]]);
  assert.equal(result.series.one[0].latest, 0);
  assert.equal(result.series.one[0].status, 'complete');
  assert.equal(result.series.unselected, undefined);
});

test('quality keeps zero, empty, forbidden, partial, missing distinct', async () => {
  const s = session(async () => ({ MetricDataResults: [
    { Id: 'q0', StatusCode: 'Complete', Timestamps: [], Values: [] },
    { Id: 'q1', StatusCode: 'Forbidden', Messages: [{ Code: 'AccessDenied', Value: 'denied' }] },
    { Id: 'q2', StatusCode: 'PartialData', Timestamps: [new Date(now - 60000)], Values: [1] },
  ] }));
  const result = await new MetricsRepository().get(s, body(), [resource('one')]);
  assert.deepEqual(result.series.one.slice(0, 4).map((s) => s.status), ['empty', 'error', 'partial', 'error']);
  assert.match(result.series.one[1].messages!.join(' '), /AccessDenied/);
});

test('pagination has 10 SDK command cap and repeated tokens cannot loop', async () => {
  let sends = 0;
  const s = session(async () => ({ NextToken: String(++sends), MetricDataResults: [{ Id: 'q0', StatusCode: 'PartialData', Timestamps: [new Date(now - 60000)], Values: [1] }] }));
  const result = await new MetricsRepository().get(s, { ...body(), metricIds: ['Invocations:Sum'] }, [resource('one')]);
  assert.equal(sends, 10); assert.equal(result.requestCount, 10); assert.equal(result.series.one[0].status, 'partial');
  sends = 0;
  const repeated = await new MetricsRepository().get(session(async () => { sends++; return { NextToken: 'repeat' }; }), { ...body(), metricIds: ['Invocations:Sum'] }, [resource('one')]);
  assert.equal(sends, 2); assert.equal(repeated.series.one[0].status, 'error');
});

test('identical metric work shares inflight/cache but different target/time does not', async () => {
  let sends = 0;
  const s = session(async (c) => { sends++; await new Promise((r) => setTimeout(r, 5)); return { MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({ Id: q.Id, StatusCode: 'Complete' })) }; });
  const repo = new MetricsRepository();
  const request = { ...body(), metricIds: ['Invocations:Sum'] };
  await Promise.all([repo.get(s, request, [resource('one')]), repo.get(s, request, [resource('one')])]);
  await repo.get(s, request, [resource('one')]);
  assert.equal(sends, 1);
  await repo.get(s, { ...request, resourceKeys: ['two'] }, [resource('two')]);
  assert.equal(sends, 2);
});

test('supported percentiles and service periods/regions use documented catalog', () => {
  assert.equal(monitoringQueries(resource('one')).find((q) => q.spec.stat === 'p95')?.spec.metric, 'Duration');
  const lb = resource('arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/example/123', 'load-balancer');
  assert.equal(monitoringQueries(lb).find((q) => q.spec.stat === 'p95')?.spec.metric, 'TargetResponseTime');
  const ec2 = resource('i-dummy', 'ec2-instance');
  assert.equal(effectivePeriod(monitoringQueries(ec2)[0], ec2, now - 3600000, now, now), 300);
  const s3 = resource('dummy-bucket', 's3-bucket');
  assert.equal(effectivePeriod(monitoringQueries(s3)[0], s3, now - 3600000, now, now), 86400);
  assert.equal(monitoringQueries(resource('dummy', 'cloudfront'))[0].region, 'us-east-1');
  assert.deepEqual(monitoringQueries(resource('cluster/service', 'ecs-service'))[0].dims, [{ Name: 'ClusterName', Value: 'cluster' }, { Name: 'ServiceName', Value: 'service' }]);
  assert.deepEqual(monitoringQueries(resource('db', 'rds-instance'))[0].dims, [{ Name: 'DBInstanceIdentifier', Value: 'db' }]);
  assert.equal(effectivePeriod(monitoringQueries(ec2)[0], ec2, now - 64 * 86400_000, now - 64 * 86400_000 + 3600_000, now), 3600);
});

test('Lambda error rate aligns buckets and leaves zero denominator or missing numerator empty', () => {
  const basic = { name: '', label: '', unit: 'count', stat: 'Sum', latest: null, status: 'complete' as const };
  const rate = derivedErrorRate([{ ...basic, id: 'Errors:Sum', points: [{ t: 1, v: 1 }, { t: 2, v: 0 }] }, { ...basic, id: 'Invocations:Sum', points: [{ t: 1, v: 10 }, { t: 2, v: 0 }, { t: 3, v: 5 }] }])!;
  assert.deepEqual(rate.points, [{ t: 1, v: 10 }]);
  assert.match(rate.messages!.join(' '), /호출 0/);
});

test('shared aligned cache retains each caller requested range', async () => {
  const fixedEnd = Math.floor(Date.now() / 300000) * 300000 - 300000;
  const request = { ...body(), period: 300, metricIds: ['Invocations:Sum'], range: { startTime: new Date(fixedEnd - 3600000 + 1000).toISOString(), endTime: new Date(fixedEnd + 1000).toISOString() } };
  const other = { ...request, range: { startTime: new Date(fixedEnd - 3600000 + 2000).toISOString(), endTime: new Date(fixedEnd + 2000).toISOString() } };
  let sends = 0;
  const s = session(async (c) => { sends++; await new Promise((r) => setTimeout(r, 5)); return { MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({ Id: q.Id, StatusCode: 'Complete' })) }; });
  const repo = new MetricsRepository();
  const [first, second] = await Promise.all([repo.get(s, request, [resource('one')]), repo.get(s, other, [resource('one')])]);
  assert.deepEqual(first.range, request.range);
  assert.deepEqual(second.range, other.range);
  assert.deepEqual((await repo.get(s, other, [resource('one')])).range, other.range);
  assert.equal(sends, 1);
});

test('metric cache separates accounts, auth sources, statistics and current resource dimensions', async () => {
  let sends = 0;
  const s = session(async (c) => { sends++; return { MetricDataResults: c.input.MetricDataQueries.map((q: any) => ({ Id: q.Id, StatusCode: 'Complete' })) }; });
  const repo = new MetricsRepository();
  const request = { ...body(), metricIds: ['Duration:Average'] };
  await repo.get(s, request, [resource('one')]);
  await repo.get({ ...s, account: '111111111111' }, request, [resource('one')]);
  await repo.get({ ...s, source: 'profile:other' }, request, [resource('one')]);
  await repo.get(s, { ...request, metricIds: ['Duration:p95'] }, [resource('one')]);
  await repo.get(s, request, [{ ...resource('one'), nativeId: 'other-native-name' }]);
  assert.equal(sends, 5);
});
test('monitoring preserves message-free Forbidden and thrown ExpiredToken codes',async()=>{const repo=new MetricsRepository();const request={...body(),metricIds:['Invocations:Sum']};const denied=await repo.get(session(async()=>({MetricDataResults:[{Id:'q0',StatusCode:'Forbidden'}]})),request,[resource('one')]);assert.equal(denied.series.one[0].awsStatus,'Forbidden');const expired=await new MetricsRepository().get(session(async()=>{throw Object.assign(new Error('expired'),{name:'ExpiredToken'});}),request,[resource('one')]);assert.equal(expired.series.one[0].errorCode,'ExpiredToken');});
