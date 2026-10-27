import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Event} from '@aws-sdk/client-cloudtrail';
import type {CleanupFinding,CleanupHistory,ResourceNode} from '@orrery/shared';
import type {ClientFactory} from '../aws/clients.ts';
import {lookupCleanupHistory,parseHistoryEvent,summarizeHistory} from './history.ts';
const now=Date.parse('2026-10-27T00:00:00Z'),day=86400000;
const scope={source:'profile:test',account:'000000000000',region:'ap-northeast-2'};
const node:ResourceNode={id:'ec2-instance:i-test',nativeId:'i-test',name:'test',type:'ec2-instance',category:'compute',region:scope.region,status:'inactive',props:{}};
const finding:CleanupFinding={id:'f',resourceId:node.id,ruleId:'stopped-ec2',reviewClass:'inactive',observedAt:new Date(now).toISOString(),fact:{resourceId:node.id,ruleId:'stopped-ec2',state:'stopped'}};
function base():Omit<CleanupHistory,'duration'|'verdict'|'messages'>{return {scope,findingId:'f',graphCollectedAt:new Date(now).toISOString(),analyzedAt:new Date(now).toISOString(),start:new Date(now-30*day).toISOString(),end:new Date(now).toISOString(),lookbackStart:new Date(now-90*day).toISOString(),coverage:'complete',pages:1,region:scope.region,events:[]}}
function event(days:number,name='StopInstances'):Event{return {EventId:String(days)+name,EventTime:new Date(now-days*day),EventName:name,EventSource:'ec2.amazonaws.com',Resources:[{ResourceName:'i-test'}],CloudTrailEvent:JSON.stringify({requestParameters:{},userIdentity:{accessKeyId:'do-not-retain'},sourceIPAddress:'do-not-retain'})}}
test('old successful stop supports review with event-based estimate; recent stop/start disqualifies',()=>{
 const older=parseHistoryEvent(event(45),node,finding).event!;
 const r=summarizeHistory({...base(),events:[older]},finding);assert.equal(r.verdict,'review');assert.equal(r.duration.seconds,45*86400);assert.equal(r.duration.basis,'event');
 for(const name of ['StopInstances','StartInstances'])assert.equal(summarizeHistory({...base(),events:[older,parseHistoryEvent(event(10,name),node,finding).event!]},finding).verdict,'recent');
});
test('absence, truncation, error, recent unclassified writes and post-snapshot change cannot assert inactivity',()=>{
 assert.equal(summarizeHistory(base(),finding).verdict,'insufficient');
 const e=parseHistoryEvent(event(45),node,finding).event!;
 for(const coverage of ['partial','error'] as const)assert.equal(summarizeHistory({...base(),coverage,events:[e]},finding).duration.basis,'unknown');
 assert.equal(summarizeHistory({...base(),events:[e,parseHistoryEvent(event(5,'UnknownWrite'),node,finding).event!]},finding).verdict,'insufficient');
 assert.equal(summarizeHistory({...base(),graphCollectedAt:new Date(now-2*day).toISOString(),events:[parseHistoryEvent(event(1),node,finding).event!]},finding).duration.basis,'unknown');
});
test('failed API events, reads and foreign resources cannot supply duration; raw identity discarded',()=>{
 const failed=event(45);failed.CloudTrailEvent=JSON.stringify({errorCode:'Denied'});assert.equal(parseHistoryEvent(failed,node,finding).event,undefined);
 const read=event(45);read.ReadOnly='true';assert.equal(parseHistoryEvent(read,node,finding).event,undefined);
 const foreign=event(45);foreign.Resources=[{ResourceName:'i-other'}];assert.equal(parseHistoryEvent(foreign,node,finding).malformed,true);
 const malformed=event(45);malformed.CloudTrailEvent='bad';assert.equal(parseHistoryEvent(malformed,node,finding).malformed,true);
 const clean=parseHistoryEvent(event(45),node,finding);assert.ok(!JSON.stringify(clean).includes('do-not-retain'));
});
test('target deregistration cannot prove empty-state start; multi-attach EBS cannot be promoted',()=>{
 const f={...finding,ruleId:'empty-target-group',fact:{resourceId:'tg',ruleId:'empty-target-group',registeredTargets:0,loadBalancers:0}} as CleanupFinding;
 assert.equal(summarizeHistory({...base(),events:[{id:'x',time:new Date(now-45*day).toISOString(),name:'DeregisterTargets',effect:'change'}]},f).duration.basis,'unknown');
 const volume={...finding,ruleId:'detached-ebs',fact:{resourceId:'v',ruleId:'detached-ebs',state:'available',attachments:0,multiAttach:true}} as CleanupFinding;
 assert.equal(summarizeHistory({...base(),events:[{id:'x',time:new Date(now-45*day).toISOString(),name:'DetachVolume',effect:'idle'}]},volume).verdict,'insufficient');
});
test('CloudFront requires explicit disabled request and scans management history in us-east-1',async()=>{
 const n={...node,type:'cloudfront',nativeId:'EXAMPLECF',region:'global'} as ResourceNode;
 const f={...finding,ruleId:'disabled-cloudfront',fact:{resourceId:n.id,ruleId:'disabled-cloudfront',enabled:false}} as CleanupFinding;
 const e={...event(45),EventName:'UpdateDistribution',EventSource:'cloudfront.amazonaws.com',Resources:[{ResourceName:'EXAMPLECF'}],CloudTrailEvent:JSON.stringify({requestParameters:{distributionConfig:{enabled:false}}})};
 assert.equal(parseHistoryEvent(e,n,f).event?.effect,'idle');
 let override='',input:any;
 const clients={get:(_c:unknown,r:string)=>{override=r;return {send:async(c:any)=>{input=c.input;return {Events:[e]}}}}} as unknown as ClientFactory;
 const result=await lookupCleanupHistory(clients,scope,n,f,new Date(now).toISOString(),now);
 assert.equal(override,'us-east-1');assert.equal(input.LookupAttributes[0].AttributeValue,'EXAMPLECF');assert.equal(result.verdict,'review');assert.equal(result.events.length,1);
});
test('lookup refuses to report complete coverage on denial and malformed records',async()=>{
 for(const denied of [false,true]){
 const clients={get:()=>({send:async()=>{if(denied)throw new Error('secret-error');return {Events:[{...event(45),CloudTrailEvent:'bad'}]}}})} as unknown as ClientFactory;
 const result=await lookupCleanupHistory(clients,scope,node,finding,new Date(now).toISOString(),now);
 assert.equal(result.coverage,denied?'error':'partial');assert.equal(result.verdict,'insufficient');assert.ok(!JSON.stringify(result).includes('secret-error'));
 }
});
