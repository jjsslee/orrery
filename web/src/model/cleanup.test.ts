import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CleanupHistory,ResourceGraph,ResourceNode} from '@orrery/shared';
import {cleanupScopeKey,validCleanup,historyMatches,durationLabel,cleanupConsoleUrl} from './cleanup';
const scope={source:'profile:test',account:'000000000000',region:'us-east-1'};
test('legacy and foreign scope are uninspected; delayed historical responses cannot cross scope or snapshot',()=>{
 const graph={...scope,collectedAt:'now',cleanup:{schemaVersion:1,scope}} as ResourceGraph;
 assert.ok(validCleanup(graph));assert.equal(validCleanup({...graph,cleanup:undefined}),undefined);assert.equal(validCleanup({...graph,account:'other'}),undefined);
 const h={scope,findingId:'f',graphCollectedAt:'now'} as CleanupHistory;
 assert.ok(historyMatches(graph,'f',h));assert.ok(!historyMatches({...graph,source:'profile:other'},'f',h));assert.ok(!historyMatches({...graph,collectedAt:'new'},'f',h));assert.ok(!historyMatches(graph,'other',h));
 assert.notEqual(cleanupScopeKey(scope),cleanupScopeKey({...scope,region:'eu-west-1'}));
});
test('duration never fabricates a zero or continuous idle interval when time evidence is missing',()=>{
 assert.equal(durationLabel(),'이력 분석 전');assert.equal(durationLabel({duration:{basis:'unknown'}} as CleanupHistory),'지속 기간 확인 불가');
 assert.equal(durationLabel({duration:{basis:'event',seconds:42*86400+7200}} as CleanupHistory),'42일 2시간');
});
test('console URLs stay on AWS domains, encode identifiers and reject unsupported partitions',()=>{
 const n={type:'ebs-volume',nativeId:'vol-test',region:'us-east-1'} as ResourceNode;
 assert.match(cleanupConsoleUrl(n)!,/^https:\/\/console.aws.amazon.com\/ec2/);
 assert.match(cleanupConsoleUrl({...n,nativeId:'a&fake=1'})!,/a%26fake%3D1/);
 assert.equal(cleanupConsoleUrl({...n,arn:'arn:other:ec2:r:a:volume/x'}),undefined);
 assert.equal(cleanupConsoleUrl({...n,region:'evil.example.com'}),undefined);
});
