import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedulerCollector } from './scheduler.ts';
import { transitCollector } from './transit.ts';
import { certificatesCollector, certificateStatus } from './certificates.ts';
import { wafCollector } from './waf.ts';
import { discoveryCollector } from './discovery.ts';
import { opensearchCollector } from './opensearch.ts';
import { ClientFactory } from '../aws/clients.ts';
import { isReadOnlyCommand } from '../aws/readonly-guard.ts';
import type { CollectorContext } from './types.ts';
import { assembleGraph } from '../graph/assemble.ts';
import { attempt, collect } from './util.ts';
import type { RelationCoverage, ResourceNode } from '@orrery/shared';

const account = '000000000000';
const region = 'ap-northeast-2';
function context(reply: (name: string, input: any, region: string) => any): CollectorContext {
  const clients = new ClientFactory(region, async () => ({ accessKeyId: 'dummy', secretAccessKey: 'dummy' }));
  const get = clients.get.bind(clients);
  clients.get = ((ctor: any, override?: string) => {
    const client = get(ctor, override) as any;
    client.send = async (command: any) => {
      assert.ok(isReadOnlyCommand(command.constructor.name));
      return reply(command.constructor.name, command.input, override ?? region);
    };
    return client;
  }) as typeof clients.get;
  return { account, region, clients, limit: (fn) => fn(), log: () => {} };
}

test('Scheduler paginates, separates same names by group, omits payload and preserves inaccessible schedules', async () => {
  const ctx = context((name, input) => {
    if (name === 'ListSchedulesCommand') return { Schedules: [{ Name: 'daily', GroupName: input.NextToken ? 'two' : 'one', Arn: `arn:${input.NextToken ?? 'first'}` }], NextToken: input.NextToken ? undefined : 'second' };
    if (input.GroupName === 'two') throw new Error('AccessDenied');
    return { State: 'DISABLED', Target: { Arn: 'arn:target', Input: '{"password":"dummy-secret"}', RoleArn: 'arn:role' }, ScheduleExpression: 'rate(1 day)' };
  });
  const out = await schedulerCollector.run(ctx);
  assert.equal(out.nodes.length, 2);
  assert.equal(new Set(out.nodes.map((n) => n.id)).size, 2);
  assert.equal(out.nodes.find((n) => n.nativeId === 'one/daily')?.status, 'inactive');
  assert.equal(out.nodes.find((n) => n.nativeId === 'two/daily')?.status, 'unknown');
  assert.ok(!JSON.stringify(out).includes('dummy-secret'));
});

test('Transit connects available VPC attachments only', async () => {
  const out = await transitCollector.run(context((name) => name === 'DescribeTransitGatewaysCommand' ? { TransitGateways: [{ TransitGatewayId: 'tgw-1', State: 'available' }] } : { TransitGatewayAttachments: [
    { TransitGatewayId: 'tgw-1', ResourceId: 'vpc-1', ResourceType: 'vpc', State: 'available' },
    { TransitGatewayId: 'tgw-1', ResourceId: 'vpc-2', ResourceType: 'vpc', State: 'deleted' },
  ] }));
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].source, 'vpc:vpc-1');
});

test('ACM checks expiration and does not double collect us-east-1', async () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(certificateStatus('ISSUED', new Date(now - 1), now), 'critical');
  assert.equal(certificateStatus('ISSUED', new Date(now + 86400000), now), 'warning');
  assert.equal(certificateStatus('ISSUED', new Date(now + 90 * 86400000), now), 'healthy');
  const ctx = context(() => { throw new Error('must not query'); });
  ctx.region = 'us-east-1';
  assert.deepEqual(await certificatesCollector('us-east-1').run(ctx), { nodes: [], edges: [] });
});

test('WAF uses global scope region and regional API stage associations resolve to API nodes', async () => {
  const ctx = context((name, input, actualRegion) => {
    if (input.Scope === 'CLOUDFRONT') assert.equal(actualRegion, 'us-east-1');
    if (name === 'ListWebACLsCommand') return { WebACLs: [{ Id: 'id', Name: 'acl', ARN: 'arn:waf' }] };
    if (name === 'GetWebACLCommand') return { WebACL: { Rules: [], DefaultAction: { Block: {} } } };
    if (name === 'ListTagsForResourceCommand') return {};
    if (name === 'ListResourcesForWebACLCommand') return { ResourceArns: input.ResourceType === 'API_GATEWAY' ? ['arn:aws:apigateway:ap-northeast-2::/restapis/api1/stages/prod'] : [] };
    throw new Error(name);
  });
  assert.equal((await wafCollector('CLOUDFRONT').run(ctx)).nodes[0].region, 'global');
  assert.equal((await wafCollector('REGIONAL').run(ctx)).edges[0].source, 'api-gateway:api1');
});

test('Cloud Map retains namespace membership with service detail', async () => {
  const out = await discoveryCollector.run(context((name) => {
    if (name === 'ListNamespacesCommand') return { Namespaces: [{ Id: 'ns-1', Name: 'example' }] };
    if (name === 'GetNamespaceCommand') return { Namespace: { Id: 'ns-1', Name: 'example' } };
    if (name === 'ListServicesCommand') return { Services: [{ Id: 'srv-1', Name: 'api' }] };
    if (name === 'GetServiceCommand') return { Service: { Id: 'srv-1', NamespaceId: 'ns-1', Name: 'api' } };
    throw new Error(name);
  }));
  assert.equal(out.nodes.length, 2);
  assert.equal(out.edges[0].source, 'cloudmap-namespace:ns-1');
  assert.equal(out.edges[0].target, 'cloudmap-service:srv-1');
});

test('OpenSearch retains list result when BatchGetCollection returns per-resource errors', async () => {
  const out = await opensearchCollector.run(context((name) => name === 'ListCollectionsCommand' ? { collectionSummaries: [{ id: 'collection1', name: 'search', status: 'ACTIVE' }] } : { collectionErrorDetails: [{ id: 'collection1', errorCode: 'AccessDenied' }] }));
  assert.equal(out.nodes[0].name, 'search');
  assert.equal(out.nodes[0].status, 'unknown');
});

test('CloudFront certificate and WAF references are attachments, not origins', () => {
  const node = (type: ResourceNode['type'], arn: string): ResourceNode => ({ id: arn, arn, type, name: arn, nativeId: arn, category: 'security', region, status: 'unknown', props: {} });
  const cf = { ...node('cloudfront', 'arn:cf'), refs: ['arn:cert', 'arn:waf'] };
  const graph = assembleGraph([{ nodes: [cf, node('acm-certificate', 'arn:cert'), node('waf-acl', 'arn:waf')], edges: [] }], [], { account, region, source: 'test' });
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((e) => e.kind === 'attached'));
});

test('a failed second rules page retains first-page evidence without complete coverage',async()=>{
 const observations:Omit<RelationCoverage,'collector'>[]=[];
 const ctx={limit:async(fn:()=>Promise<unknown>)=>fn(),log:()=>{},observe:(c:Omit<RelationCoverage,'collector'>)=>observations.push(c)} as unknown as CollectorContext;
 async function* pages(){yield {rules:['dummy-rule']};throw Object.assign(new Error('dummy denial'),{name:'AccessDenied'});}
 assert.deepEqual(await attempt(ctx,'rules:dummy',()=>collect(pages(),p=>p.rules)),['dummy-rule']);
 assert.equal(observations[0].state,'partial');assert.equal(observations[0].succeededAt,undefined);assert.equal(observations[0].errorCode,'AccessDenied');
});
