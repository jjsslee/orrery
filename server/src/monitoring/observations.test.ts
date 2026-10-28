import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGraph } from './observations.ts';
import type { ResourceGraph } from '@orrery/shared';
const scope = { source: 'profile:dummy', account: '000000000000', region: 'ap-northeast-2' };
const graph = (at: string, state: 'complete' | 'failed', present: boolean): ResourceGraph => ({ ...scope, collectedAt: at, nodes: ['a','b'].map(id => ({ id, name:id, nativeId:id, type:'lambda', category:'compute', region:scope.region, props:{},status:'unknown' })), reports: [], coverage: [{ key:'rules:lb', collector:'elb', operation:'DescribeRules', owner:'lb', state, attemptedAt:at, ...(state === 'complete' ? { succeededAt:at } : {}) }], edges: present ? [{id:'ab',source:'a',target:'b',kind:'targets',evidence:[{partition:'rules:lb',collector:'elb',operation:'DescribeRules',method:'configuration'}]}] : [] });
test('complete partition removes old relationship despite an unrelated failure', () => {
 const old = reconcileGraph(graph('2026-10-28T01:00:00Z','complete',true));
 const fresh = graph('2026-10-28T01:10:00Z','complete',false); fresh.reports.push({collector:'tags',ok:false,durationMs:0,nodes:0,edges:0});
 const result = reconcileGraph(fresh,old);
 assert.equal(result.edges.length,0); assert.equal(result.relationshipHistory?.[0].observation?.state,'absent');
});
test('failed partition preserves last confirmation only in history', () => {
 const old = reconcileGraph(graph('2026-10-28T01:00:00Z','complete',true));
 const result = reconcileGraph(graph('2026-10-28T01:10:00Z','failed',false),old);
 assert.equal(result.edges.length,0); assert.equal(result.relationshipHistory?.[0].observation?.state,'unverified');
 assert.equal(result.relationshipHistory?.[0].observation?.lastConfirmedAt,'2026-10-28T01:00:00Z');
});
test('late or foreign snapshots cannot replace newer scope state', () => {
 const old = reconcileGraph(graph('2026-10-28T01:10:00Z','complete',true));
 assert.equal(reconcileGraph(graph('2026-10-28T01:00:00Z','complete',false),old).collectedAt,old.collectedAt);
 assert.throws(()=>reconcileGraph({...graph('2026-10-28T01:20:00Z','complete',false),account:'111111111111'},old), /범위/);
});
test('retains failed evidence, reappearance and persisted revisions without false changes', () => {
 const first = graph('2026-10-28T01:00:00Z','complete',true);
 first.edges[0].evidence!.push({partition:'ecs',collector:'ecs',operation:'DescribeServices',method:'configuration'});
 const old = reconcileGraph(first);
 const next = reconcileGraph(graph('2026-10-28T01:10:00Z','complete',true),old);
 assert.equal(next.edges[0].evidence?.length,2);
 assert.deepEqual(reconcileGraph(next),next);
 const missing = graph('2026-10-28T01:20:00Z','complete',false);
 const result = reconcileGraph(missing,next);
 assert.equal(result.relationshipHistory?.[0].observation?.state,'unverified');
 const removed = reconcileGraph({...missing,collectedAt:'2026-10-28T01:30:00Z',coverage:[...missing.coverage!,{key:'ecs',collector:'ecs',operation:'DescribeServices',state:'complete',attemptedAt:missing.collectedAt}]},result);
 assert.equal(removed.relationshipHistory?.[0].observation?.state,'absent');
 const back = reconcileGraph(graph('2026-10-28T01:40:00Z','complete',true),removed);
 assert.equal(back.relationshipChanges?.at(-1)?.kind,'added');
});
test('object key order does not generate configuration changes', () => {
 const first = graph('2026-10-28T01:00:00Z','complete',true);
 first.edges[0].props = {policy:'{"a":1,"b":{"x":2,"y":3}}'};
 const next = graph('2026-10-28T01:10:00Z','complete',true);
 next.edges[0].props = {policy:'{"b":{"y":3,"x":2},"a":1}'};
 assert.equal(reconcileGraph(next,reconcileGraph(first)).relationshipChanges?.length,0);
});
test('missing endpoint does not turn a collected relation into confirmed absence',()=>{
 const old=reconcileGraph(graph('2026-10-28T01:00:00Z','complete',true));
 const next=graph('2026-10-28T01:10:00Z','complete',false);next.unresolvedEdges=[old.edges[0]];
 const result=reconcileGraph(next,old);
 assert.equal(result.relationshipHistory?.[0].observation?.state,'unverified');
 assert.equal(result.relationshipChanges?.length,0);
});
test('failure recovery and initial baseline emit no fake removal or addition',()=>{
 const first=reconcileGraph(graph('2026-10-28T01:00:00Z','complete',true));
 assert.equal(first.relationshipChanges?.length,0);
 const failed=reconcileGraph(graph('2026-10-28T01:10:00Z','failed',false),first);
 const recovered=reconcileGraph(graph('2026-10-28T01:20:00Z','complete',true),failed);
 assert.equal(recovered.relationshipChanges?.length,0);
 const changed=graph('2026-10-28T01:30:00Z','complete',true);changed.edges[0].props={weight:0};
 assert.equal(reconcileGraph(changed,recovered).relationshipChanges?.[0].kind,'changed');
});
test('a completely enumerated collector confirms removal of an owner no longer listed',()=>{
 const old=reconcileGraph(graph('2026-10-28T01:00:00Z','complete',true));
 const next=graph('2026-10-28T01:10:00Z','complete',false);next.coverage=[{key:'collector:elb',collector:'elb',operation:'collector',state:'complete',attemptedAt:next.collectedAt}];
 assert.equal(reconcileGraph(next,old).relationshipHistory?.[0].observation?.state,'absent');
});
