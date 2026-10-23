import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceNode } from '@orrery/shared';
import { lbDimension, normaliseTraffic, queriesForNode, recentMean } from './cloudwatch.ts';

const node = (partial: Partial<ResourceNode> & Pick<ResourceNode, 'type' | 'nativeId'>): ResourceNode => ({
  id: `${partial.type}:${partial.nativeId}`,
  category: 'compute',
  name: partial.nativeId,
  region: 'ap-northeast-2',
  status: 'healthy',
  props: {},
  ...partial,
});

test('lbDimension strips everything before loadbalancer/', () => {
  assert.equal(lbDimension('arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/web/0123abcd'), 'app/web/0123abcd');
  assert.equal(lbDimension('not-an-arn'), undefined);
});

test('catalogue picks namespace and dimensions per type', () => {
  const alb = queriesForNode(node({ type: 'load-balancer', nativeId: 'arn:aws:elasticloadbalancing:r:a:loadbalancer/app/web/1', props: { _lbType: 'application' } }));
  assert.equal(alb.length, 3);
  assert.equal(alb[0].spec.namespace, 'AWS/ApplicationELB');
  assert.deepEqual(alb[0].dims, [{ Name: 'LoadBalancer', Value: 'app/web/1' }]);
  assert.equal(alb.filter((q) => q.spec.throughput).length, 1);

  const nlb = queriesForNode(node({ type: 'load-balancer', nativeId: 'arn:aws:elasticloadbalancing:r:a:loadbalancer/net/tcp/1', props: { _lbType: 'network' } }));
  assert.equal(nlb[0].spec.namespace, 'AWS/NetworkELB');

  const svc = queriesForNode(node({ type: 'ecs-service', nativeId: 'prod/api' }));
  assert.deepEqual(svc[0].dims, [{ Name: 'ClusterName', Value: 'prod' }, { Name: 'ServiceName', Value: 'api' }]);

  const cf = queriesForNode(node({ type: 'cloudfront', nativeId: 'E123' }));
  assert.equal(cf[0].region, 'us-east-1');
  assert.deepEqual(cf[0].dims, [{ Name: 'Region', Value: 'Global' }, { Name: 'DistributionId', Value: 'E123' }]);

  const rest = queriesForNode(node({ type: 'api-gateway', nativeId: 'abc123', name: 'orders-api', props: { _apiKind: 'rest' } }));
  assert.deepEqual(rest[0].dims, [{ Name: 'ApiName', Value: 'orders-api' }]);
  const http = queriesForNode(node({ type: 'api-gateway', nativeId: 'abc123', name: 'orders-api', props: { _apiKind: 'http' } }));
  assert.deepEqual(http[0].dims, [{ Name: 'ApiId', Value: 'abc123' }]);
  assert.equal(http[1].spec.metric, '5xx');

  const cache = queriesForNode(node({ type: 'elasticache', nativeId: 'rg-1', props: { _cacheClusterId: 'rg-1-001' } }));
  assert.deepEqual(cache[0].dims, [{ Name: 'CacheClusterId', Value: 'rg-1-001' }]);

  const s3 = queriesForNode(node({ type: 's3-bucket', nativeId: 'my-bucket' }));
  assert.equal(s3.length, 2);
  assert.equal(s3[0].spec.period, 86400);

  assert.deepEqual(queriesForNode(node({ type: 'vpc', nativeId: 'vpc-1' })), []);
});

test('recentMean prefers the last hour, falls back to the last 3 points', () => {
  const now = 10_000_000;
  const min = 60_000;
  const recent = [
    { t: now - 200 * min, v: 100 },
    { t: now - 50 * min, v: 10 },
    { t: now - 10 * min, v: 20 },
  ];
  assert.equal(recentMean(recent, now), 15);
  const stale = [
    { t: now - 400 * min, v: 1 },
    { t: now - 300 * min, v: 2 },
    { t: now - 200 * min, v: 4 },
    { t: now - 100 * min, v: 6 },
  ];
  assert.equal(recentMean(stale, now), 4);
  assert.equal(recentMean([], now), undefined);
});

test('normaliseTraffic is log-scaled per type and omits zero', () => {
  const out = normaliseTraffic([
    { nodeId: 'a', type: 'lambda', v: 1000 },
    { nodeId: 'b', type: 'lambda', v: 10 },
    { nodeId: 'c', type: 'lambda', v: 0 },
    { nodeId: 'd', type: 'sqs-queue', v: 5 },
  ]);
  assert.equal(out.a, 1);
  assert.equal(out.b, Math.round((Math.log1p(10) / Math.log1p(1000)) * 1000) / 1000);
  assert.equal('c' in out, false);
  assert.equal(out.d, 1);
});

test('metrics bundle identifies actual account/source independently of profile name', async () => {
  const { collectMetrics } = await import('./cloudwatch.ts');
  const graph = { account: '111111111111', source: 'profile:same-profile', region: 'ap-northeast-2', collectedAt: new Date().toISOString(), nodes: [], edges: [], reports: [] };
  const bundle = await collectMetrics(graph, {} as import('../aws/clients.ts').ClientFactory);
  assert.deepEqual((bundle as unknown as { scope: unknown }).scope, { source: graph.source, account: graph.account, region: graph.region });
});
