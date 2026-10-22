import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceNode } from '@orrery/shared';
import { assembleGraph } from './assemble.ts';

const node = (partial: Partial<ResourceNode> & Pick<ResourceNode, 'id' | 'type' | 'category' | 'nativeId'>): ResourceNode => ({
  name: partial.nativeId,
  region: 'ap-northeast-2',
  status: 'healthy',
  props: {},
  ...partial,
});

test('refs resolve ARNs, SQS URLs, S3 hosts, ECR images and plain names into typed edges', () => {
  const lambda = node({
    id: 'lambda:orders-api', type: 'lambda', category: 'compute', nativeId: 'orders-api',
    refs: [
      'arn:aws:dynamodb:ap-northeast-2:000000000000:table/orders',
      'https://sqs.ap-northeast-2.amazonaws.com/000000000000/orders-events',
      'assets-bucket',
      'arn:aws:iam::000000000000:role/orders-lambda-role',
      '000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/orders/api:latest',
      'arn:aws:kms:ap-northeast-2:000000000000:key/11111111-2222-3333-4444-555555555555',
      'arn:aws:lambda:ap-northeast-2:000000000000:function:missing-fn',
    ],
  });
  const cf = node({ id: 'cloudfront:E123', type: 'cloudfront', category: 'network', nativeId: 'E123', refs: ['assets-bucket.s3.ap-northeast-2.amazonaws.com', 'api-lb-123.ap-northeast-2.elb.amazonaws.com'] });
  const nodes: ResourceNode[] = [
    lambda, cf,
    node({ id: 'dynamodb-table:orders', type: 'dynamodb-table', category: 'database', nativeId: 'orders' }),
    node({ id: 'sqs-queue:orders-events', type: 'sqs-queue', category: 'integration', nativeId: 'orders-events', props: { URL: 'https://sqs.ap-northeast-2.amazonaws.com/000000000000/orders-events' } }),
    node({ id: 's3-bucket:assets-bucket', type: 's3-bucket', category: 'storage', nativeId: 'assets-bucket' }),
    node({ id: 'iam-role:orders-lambda-role', type: 'iam-role', category: 'security', nativeId: 'orders-lambda-role' }),
    node({ id: 'ecr-repository:orders/api', type: 'ecr-repository', category: 'storage', nativeId: 'orders/api' }),
    node({ id: 'kms-key:11111111-2222-3333-4444-555555555555', type: 'kms-key', category: 'security', nativeId: '11111111-2222-3333-4444-555555555555' }),
    node({ id: 'load-balancer:arn:lb', type: 'load-balancer', category: 'network', nativeId: 'arn:lb', props: { DNS: 'api-lb-123.ap-northeast-2.elb.amazonaws.com' } }),
  ];
  const graph = assembleGraph([{ nodes, edges: [] }], [], { account: '000000000000', region: 'ap-northeast-2', source: 'test' });
  const kinds = new Map(graph.edges.map((e) => [`${e.source}>${e.target}`, e.kind]));

  assert.equal(kinds.get('lambda:orders-api>dynamodb-table:orders'), 'reads');
  assert.equal(kinds.get('lambda:orders-api>sqs-queue:orders-events'), 'publishes');
  assert.equal(kinds.get('lambda:orders-api>s3-bucket:assets-bucket'), 'reads');
  assert.equal(kinds.get('lambda:orders-api>iam-role:orders-lambda-role'), 'assumes');
  assert.equal(kinds.get('lambda:orders-api>ecr-repository:orders/api'), 'reads');
  assert.equal(kinds.get('kms-key:11111111-2222-3333-4444-555555555555>lambda:orders-api'), 'encrypts', 'KMS edges point from key to resource');
  assert.equal(kinds.get('cloudfront:E123>s3-bucket:assets-bucket'), 'origin');
  assert.equal(kinds.get('cloudfront:E123>load-balancer:arn:lb'), 'origin');
  assert.equal([...kinds.keys()].some((k) => k.includes('missing-fn')), false, 'unresolved refs produce no edge');
  assert.equal(graph.nodes.every((n) => n.refs === undefined), true, 'refs are stripped from the output');
});

test('alarms attach to nodes by dimension and lift status to critical', () => {
  const nodes = [
    node({ id: 'ec2-instance:i-1', type: 'ec2-instance', category: 'compute', nativeId: 'i-1' }),
    node({ id: 'load-balancer:arn:aws:elasticloadbalancing:r:a:loadbalancer/app/web/abc', type: 'load-balancer', category: 'network', nativeId: 'arn:aws:elasticloadbalancing:r:a:loadbalancer/app/web/abc' }),
  ];
  const graph = assembleGraph(
    [{ nodes, edges: [], alarms: [
      { name: 'cpu-high', state: 'ALARM', dimensions: { InstanceId: 'i-1' } },
      { name: 'lb-5xx', state: 'OK', dimensions: { LoadBalancer: 'app/web/abc' } },
    ] }],
    [], { account: 'a', region: 'r', source: 's' },
  );
  const ec2 = graph.nodes.find((n) => n.id === 'ec2-instance:i-1')!;
  const lb = graph.nodes.find((n) => n.type === 'load-balancer')!;
  assert.equal(ec2.status, 'critical');
  assert.deepEqual(ec2.alarms, ['cpu-high']);
  assert.equal(lb.status, 'healthy');
  assert.equal(lb.alarms, undefined);
});

test('dangling edges and missing parents are dropped', () => {
  const nodes = [node({ id: 'subnet:s-1', type: 'subnet', category: 'network', nativeId: 's-1', parentId: 'vpc:missing' })];
  const graph = assembleGraph([{ nodes, edges: [{ id: 'x', source: 'subnet:s-1', target: 'nat-gateway:nope', kind: 'routes' }] }], [], { account: 'a', region: 'r', source: 's' });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes[0].parentId, undefined);
});
