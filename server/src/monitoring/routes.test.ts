import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { AlarmRepository, alarmRecord, mapAlarms, type MonitoringSession } from './alarms.ts';
import { registerMonitoringRoutes } from './routes.ts';
import { listMonitoringResources, resourceKey } from './resources.ts';
import type { ClientFactory } from '../aws/clients.ts';

function fixture(send: (command: { constructor: { name: string }; input: any }) => Promise<any>): MonitoringSession {
  return { source: 'profile:test', account: '000000000000', region: 'ap-northeast-2', clients: { get: () => ({ send }) } as unknown as ClientFactory };
}

test('monitoring alarms independent of graph, preserves composite and unlinked alarms, shares concurrent work', async () => {
  const calls: string[] = [];
  const s = fixture(async (command) => {
    calls.push(command.constructor.name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { MetricAlarms: [{ AlarmName: 'unknown', StateValue: 'ALARM', MetricName: 'Custom', Namespace: 'Custom' }], CompositeAlarms: [{ AlarmName: 'combined', AlarmRule: 'ALARM("unknown")', StateValue: 'OK' }] };
  });
  const app = Fastify();
  registerMonitoringRoutes(app, async () => s, new AlarmRepository());
  const responses = await Promise.all([app.inject('/api/monitoring/alarms'), app.inject('/api/monitoring/alarms')]);
  assert.deepEqual(calls, ['DescribeAlarmsCommand']);
  assert.equal(responses[0].statusCode, 200);
  assert.equal(responses[0].json().alarms.length, 2);
  assert.equal(responses[0].json().alarms[1].type, 'composite');
  assert.equal(responses[0].json().alarms[0].mapping, 'unresolved');
  await app.close();
});

test('alarm failure preserves last successful ALARM and success alone clears it', async () => {
  let denied = false, state = 'ALARM';
  const s = fixture(async () => { if (denied) throw new Error('AccessDenied'); return { MetricAlarms: [{ AlarmName: 'alarm', StateValue: state }] }; });
  const alarms = new AlarmRepository();
  const initial = await alarms.get(s);
  denied = true;
  const failed = await alarms.get(s, true);
  assert.equal(failed.complete, false);
  assert.equal(failed.alarms[0].state, 'ALARM');
  assert.equal(failed.observation.succeededAt, initial.observation.succeededAt);
  denied = false; state = 'OK';
  assert.equal((await alarms.get(s, true)).alarms[0].state, 'OK');
});

test('all MetricStat dimensions map to zero or many resources without losing alarm', () => {
  const record = alarmRecord({ AlarmName: 'math', Metrics: ['one', 'two'].map((Value) => ({ Id: Value, MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value }] }, Stat: 'Sum', Period: 60 } })) }, 'ap-northeast-2')!;
  const resources = ['one', 'two'].map((nativeId) => ({ key: nativeId, nodeId: nativeId, type: 'lambda' as const, nativeId, name: nativeId, region: 'ap-northeast-2', tagsStatus: 'complete' as const, props: {} }));
  assert.deepEqual(mapAlarms([record], resources)[0].resourceKeys, ['one', 'two']);
  assert.equal(mapAlarms([record], [])[0].name, 'math');
});

test('resources reject unknown types before session, only selected service APIs run, tags failure is explicit', async () => {
  const calls: string[] = [];
  let sessions = 0;
  const s = fixture(async (command) => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'ListTagsCommand') throw new Error('AccessDenied');
    return { Functions: [{ FunctionName: 'test-function', FunctionArn: 'arn:aws:lambda:ap-northeast-2:000000000000:function:test-function' }] };
  });
  const app = Fastify();
  registerMonitoringRoutes(app, async () => { sessions++; return s; }, new AlarmRepository());
  assert.equal((await app.inject('/api/monitoring/resources?type=anything')).statusCode, 400);
  assert.equal(sessions, 0);
  const res = await app.inject('/api/monitoring/resources?type=lambda');
  assert.deepEqual(calls, ['ListFunctionsCommand', 'ListTagsCommand']);
  assert.equal(res.json().resources[0].tagsStatus, 'unavailable');
  assert.equal(res.json().resources[0].key, resourceKey(s.account, s.region, 'lambda', 'test-function'));
  assert.equal(res.json().complete, true);
  await app.close();
});

test('resource pagination failure preserves partial items and does not report complete', async () => {
  const s = fixture(async (command) => {
    if (command.input.NextToken) throw new Error('Throttling');
    return { QueueUrls: ['https://sqs.test/000000000000/queue'], NextToken: command.constructor.name === 'ListQueuesCommand' ? 'next' : undefined, Tags: {} };
  });
  const result = await listMonitoringResources(s, 'sqs-queue');
  assert.equal(result.resources.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.observation.error!, /Throttling/);
});

test('history validates bounded range and returns page token/error distinctly', async () => {
  const calls: any[] = [];
  const s = fixture(async (command) => { calls.push(command); return { AlarmHistoryItems: [{ HistorySummary: 'changed', Timestamp: new Date('2026-10-22') }], NextToken: 'next' }; });
  const app = Fastify();
  registerMonitoringRoutes(app, async () => s, new AlarmRepository());
  assert.equal((await app.inject('/api/monitoring/alarms/history?name=test&type=metric&start=invalid&end=invalid')).statusCode, 400);
  assert.equal(calls.length, 0);
  const res = await app.inject('/api/monitoring/alarms/history?name=test&type=composite&start=2026-10-21&end=2026-10-22');
  assert.equal(res.json().nextToken, 'next');
  assert.deepEqual(calls[0].input.AlarmTypes, ['CompositeAlarm']);
  assert.equal(calls[0].input.MaxRecords, 100);
  await app.close();
});

test('each initial resource type lists only its service and keeps monitoring dimensions', async () => {
  const cases = [
    { type: 'sqs-queue' as const, responses: { ListQueuesCommand: { QueueUrls: ['https://sqs.test/000000000000/queue'] }, ListQueueTagsCommand: { Tags: { Service: 'dummy' } } }, expected: ['ListQueuesCommand', 'ListQueueTagsCommand'], nativeId: 'queue' },
    { type: 'load-balancer' as const, responses: { DescribeLoadBalancersCommand: { LoadBalancers: [{ Type: 'application', LoadBalancerName: 'dummy', LoadBalancerArn: 'arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/dummy/123' }, { Type: 'network', LoadBalancerArn: 'ignore' }] }, DescribeTagsCommand: { TagDescriptions: [{ Tags: [] }] } }, expected: ['DescribeLoadBalancersCommand', 'DescribeTagsCommand'], nativeId: 'arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/dummy/123' },
    { type: 'ecs-service' as const, responses: { ListClustersCommand: { clusterArns: ['arn:aws:ecs:ap-northeast-2:000000000000:cluster/dummy'] }, ListServicesCommand: { serviceArns: ['arn:aws:ecs:ap-northeast-2:000000000000:service/dummy/service'] }, DescribeServicesCommand: { services: [{ serviceArn: 'arn:aws:ecs:ap-northeast-2:000000000000:service/dummy/service', serviceName: 'service', tags: [] }] } }, expected: ['ListClustersCommand', 'ListServicesCommand', 'DescribeServicesCommand'], nativeId: 'dummy/service' },
    { type: 'ec2-instance' as const, responses: { DescribeInstancesCommand: { Reservations: [{ Instances: [{ InstanceId: 'i-dummy', Monitoring: { State: 'enabled' }, Tags: [{ Key: 'Name', Value: 'dummy' }] }] }] } }, expected: ['DescribeInstancesCommand'], nativeId: 'i-dummy' },
    { type: 'rds-instance' as const, responses: { DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceIdentifier: 'dummy-db', TagList: [] }] } }, expected: ['DescribeDBInstancesCommand'], nativeId: 'dummy-db' },
  ];
  for (const fixtureCase of cases) {
    const calls: string[] = [];
    const s = fixture(async (command) => { calls.push(command.constructor.name); return (fixtureCase.responses as Record<string, any>)[command.constructor.name]; });
    const result = await listMonitoringResources(s, fixtureCase.type);
    assert.deepEqual(calls, fixtureCase.expected);
    assert.equal(result.complete, true);
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0].nativeId, fixtureCase.nativeId);
  }
});
test('alarm observation preserves structured authorization error code',async()=>{const s=fixture(async()=>{throw Object.assign(new Error('denied'),{name:'AccessDeniedException'});});const result=await new AlarmRepository().get(s);assert.equal(result.observation.errorCode,'AccessDeniedException');});

test('alarm history returns actual session scope on success and permission failure after same-profile account switch',async()=>{
 let denied=false;
 const s=fixture(async()=>{if(denied)throw Object.assign(new Error('denied'),{name:'AccessDeniedException'});return{AlarmHistoryItems:[{HistorySummary:'changed'}]};});
 const app=Fastify();
 registerMonitoringRoutes(app,async()=>s,new AlarmRepository());
 const url='/api/monitoring/alarms/history?name=same-alarm&type=metric&start=2026-10-21&end=2026-10-22';
 assert.deepEqual((await app.inject(url)).json().scope,{source:s.source,account:s.account,region:s.region});
 s.account='111111111111';
 denied=true;
 const failed=(await app.inject(url)).json();
 assert.deepEqual(failed.scope,{source:s.source,account:'111111111111',region:s.region});
 assert.equal(failed.observation.errorCode,'AccessDeniedException');
 await app.close();
});

test('resource route reuses five-minute cache and refresh=1 performs exactly one new list call',async()=>{
 let lists=0;
 const s=fixture(async(command)=>{assert.equal(command.constructor.name,'ListFunctionsCommand');lists++;return{Functions:[]};});
 const app=Fastify();
 registerMonitoringRoutes(app,async()=>s,new AlarmRepository());
 const url='/api/monitoring/resources?type=lambda';
 assert.equal((await app.inject(url)).statusCode,200);
 assert.equal(lists,1);
 assert.equal((await app.inject(url)).statusCode,200);
 assert.equal(lists,1);
 assert.equal((await app.inject(`${url}&refresh=1`)).statusCode,200);
 assert.equal(lists,2);
 assert.equal((await app.inject(url)).statusCode,200);
 assert.equal(lists,2);
 await app.close();
});
