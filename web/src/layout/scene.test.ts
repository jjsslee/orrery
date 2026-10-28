import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneStructureKey, buildScene, type SceneInput } from './scene';
import type { ResourceNode, ResourceEdge } from '@orrery/shared';
const node = (type: ResourceNode['type'], name: string, extra: Partial<ResourceNode> = {}): ResourceNode => ({ id: `${type}:${name}`, type, name, nativeId: name, category: 'compute', region: 'ap-northeast-2', status: 'healthy', props: {}, ...extra });
function scene(nodes: ResourceNode[], edges: ResourceEdge[] = [], extra: Partial<SceneInput> = {}) {
  return buildScene({ graph: { nodes, edges, reports: [], account: '000000000000', region: 'ap-northeast-2', source: 'test', collectedAt: '' }, overlays: { security: true, iam: true, encryption: true, targetGroups: true, isolated: true, traffic: true }, categories: { compute: true, network: true, database: true, storage: true, integration: true, security: true }, hiddenTypes: new Set(), expanded: new Set(), query: '', ...extra });
}
test('hiding VPC preserves the visible child containment', () => {
  const s = scene([node('vpc', 'one'), node('lambda', 'fn', { parentId: 'vpc:one' })], [], { hiddenTypes: new Set(['vpc']) });
  assert.equal(s.nodes.find(n => n.id === 'lambda:fn')?.parentId, 'vpc:one');
});
test('global and unresolved network scope have distinct labels', () => {
  const s = scene([node('cloudfront', 'cdn', { region: 'global' }), node('ecs-service', 'unknown')]);
  assert.ok(s.nodes.some(n => n.lane?.label.includes('글로벌')));
  assert.ok(s.nodes.some(n => n.lane?.label.includes('위치 미확인')));
});
test('resource activity is never asserted as edge traffic', () => {
  const s = scene([node('lambda', 'fn'), node('sqs-queue', 'q')], [{ id: 'x', source: 'sqs-queue:q', target: 'lambda:fn', kind: 'invokes', status: 'inactive' }], { traffic: { 'lambda:fn': 1 } });
  assert.equal(s.edges[0].traffic, 0);
  assert.equal(s.edges[0].live, false);
});
test('collapsed target group retains worst status', () => {
  const s = scene([node('load-balancer', 'lb'), node('target-group', 'tg'), node('ecs-service', 'svc')], [
    { id: 'a', source: 'load-balancer:lb', target: 'target-group:tg', kind: 'targets', status: 'critical' },
    { id: 'b', source: 'target-group:tg', target: 'ecs-service:svc', kind: 'targets' },
  ], { overlays: { security: true, iam: true, encryption: true, targetGroups: false, isolated: true, traffic: true } });
  assert.equal(s.edges[0].status, 'critical');
});

test('unresolved target group remains visible when folding is enabled', () => {
  const s = scene([node('load-balancer', 'lb'), node('target-group', 'tg')], [{ id: 'a', source: 'load-balancer:lb', target: 'target-group:tg', kind: 'targets' }], { overlays: { security: true, iam: true, encryption: true, targetGroups: false, isolated: true, traffic: true } });
  assert.ok(s.nodes.some(n => n.id === 'target-group:tg'));
  assert.equal(s.edges.length, 1);
});

test('parent-only change invalidates layout', () => {
  const make = (parentId: string) => scene([node('vpc', 'one'), node('vpc', 'two'), node('lambda', 'fn', { parentId })]);
  assert.notEqual(sceneStructureKey(make('vpc:one')), sceneStructureKey(make('vpc:two')));
});
