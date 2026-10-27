import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CleanupDiscovery, CleanupFact, CleanupRule, ResourceNode } from '@orrery/shared';
import { evaluateCleanup } from './evaluate.ts';
import { observeCleanup } from './observe.ts';
const scope = { source: 'profile:test', account: '000000000000', region: 'us-east-1' };
const when = '2026-10-27T00:00:00.000Z';
const types = { 'detached-ebs': 'ebs-volume', 'empty-target-group': 'target-group', 'stopped-ec2': 'ec2-instance', 'disabled-cloudfront': 'cloudfront' } as const;
function run(facts: CleanupFact[], patch?: (input: CleanupDiscovery) => void, customScope = scope) {
 const nodes: ResourceNode[] = facts.map((f) => ({ id: f.resourceId, type: types[f.ruleId], nativeId:f.resourceId, name:f.resourceId, region:scope.region, category:'compute', status:'inactive', props:{} }));
 const discovery: CleanupDiscovery = { facts, coverage: [...new Set(facts.map(f=>f.ruleId))].map(ruleId=>({ruleId,api:'List',state:'complete',attemptedAt:when,succeededAt:when})) };
 for(const fact of facts) if(fact.ruleId==='empty-target-group') discovery.coverage.push({ruleId:fact.ruleId,resourceId:fact.resourceId,api:'DescribeTargetHealth',state:'complete',attemptedAt:when,succeededAt:when});
 patch?.(discovery);
 return evaluateCleanup([discovery],nodes,[],customScope,when);
}
test('EBS candidate requires available AND zero attachments, regardless of inactive graph status',()=>{
 const states=['available','in-use','creating','deleting','error',undefined];
 for(const state of states) for(const attachments of [0,1,2]) assert.equal(run([{ruleId:'detached-ebs',resourceId:'v',state,attachments}]).findings.length,state==='available'&&attachments===0?1:0);
});
test('raw target count, stopped state and explicit disabled flag determine candidates',()=>{
 for(const registeredTargets of [0,1,3]) assert.equal(run([{ruleId:'empty-target-group',resourceId:'tg',registeredTargets,loadBalancers:1}]).findings.length,registeredTargets===0?1:0);
 for(const state of ['stopped','stopping','pending','running',undefined]) assert.equal(run([{ruleId:'stopped-ec2',resourceId:'i',state}]).findings.length,state==='stopped'?1:0);
 for(const enabled of [false,true,undefined]) assert.equal(run([{ruleId:'disabled-cloudfront',resourceId:'cf',enabled}]).findings.length,enabled===false?1:0);
});
test('failed list or per-resource query never produces a candidate, other successful targets survive',()=>{
 const facts:CleanupFact[]=['a','b'].map(resourceId=>({ruleId:'empty-target-group',resourceId,registeredTargets:0,loadBalancers:0}));
 const partial=run(facts,d=>{d.coverage.find(c=>c.resourceId==='a')!.state='error'});
 assert.deepEqual(partial.findings.map(f=>f.resourceId),['b']);
 assert.equal(run(facts,d=>{d.coverage[0].state='error'}).findings.length,0);
});
test('failed, uncollected and successful empty rules remain distinguishable; missing field is unknown',()=>{
 const result=evaluateCleanup([],[],[{collector:'ec2',ok:false,durationMs:0,nodes:0,edges:0}],scope,when);
 assert.equal(result.coverage.find(c=>c.ruleId==='detached-ebs')!.state,'error');
 assert.equal(result.coverage.find(c=>c.ruleId==='empty-target-group')!.state,'not-collected');
 const empty=evaluateCleanup([{facts:[],coverage:[{ruleId:'disabled-cloudfront',api:'ListDistributions',state:'complete',attemptedAt:when,succeededAt:when}]}],[],[],scope,when);
 assert.equal(empty.findings.length,0);assert.equal(empty.coverage[0].state,'complete');
 assert.ok(run([{ruleId:'disabled-cloudfront',resourceId:'cf'}]).coverage.some(c=>c.errorCode==='MissingField'));
});
test('finding IDs isolate source, account and region and never use display names',()=>{
 const f:CleanupFact={ruleId:'stopped-ec2',resourceId:'i',state:'stopped'};
 const ids=[scope,{...scope,source:'profile:b'},{...scope,account:'111111111111'},{...scope,region:'eu-west-1'}].map(s=>run([f],undefined,s).findings[0].id);
 assert.equal(new Set(ids).size,4);
});
test('observation preserves error behavior and never stores arbitrary error messages',async()=>{
 const d:CleanupDiscovery={facts:[],coverage:[]};
 await assert.rejects(observeCleanup(d,'detached-ebs','DescribeVolumes',async()=>{throw Object.assign(new Error('secret-response'),{name:'AccessDeniedException'})}));
 assert.equal(d.coverage[0].state,'error');assert.equal(d.coverage[0].errorCode,'AccessDeniedException');assert.ok(!JSON.stringify(d).includes('secret-response'));
 await observeCleanup(d,'detached-ebs','DescribeVolumes',async()=>[]);
 assert.equal(d.coverage[1].state,'complete');assert.ok(d.coverage[1].succeededAt);
});
