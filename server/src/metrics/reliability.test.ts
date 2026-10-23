import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMetrics } from './cloudwatch.ts';
import type { ClientFactory } from '../aws/clients.ts';
import type { ResourceGraph } from '@orrery/shared';
const graph: ResourceGraph = {account:'000000000000',region:'ap-northeast-2',source:'profile:test',collectedAt:'',edges:[],reports:[],nodes:[{id:'lambda:fn',nativeId:'fn',name:'fn',type:'lambda',category:'compute',region:'ap-northeast-2',status:'healthy',props:{}}]};
test('preserves zero, empty and partial metric results with their quality metadata', async () => {
 const clients = {get:()=>({send:async()=>({MetricDataResults:[{Id:'q0',StatusCode:'Complete',Timestamps:[new Date(1000)],Values:[0]},{Id:'q1',StatusCode:'Complete'},{Id:'q2',StatusCode:'PartialData',Messages:[{Code:'PartialData',Value:'limited'}],Timestamps:[new Date(1000)],Values:[2]}]})})} as unknown as ClientFactory;
 const result = await collectMetrics(graph, clients);
 assert.equal(result.series['lambda:fn'].length,3);
 const [zero,empty,partial] = result.series['lambda:fn'];
 assert.equal(zero.latest,0); assert.equal(zero.status,'complete'); assert.equal(zero.period,300); assert.equal(zero.lastDataAt,new Date(1000).toISOString());
 assert.equal(empty.status,'empty'); assert.equal(empty.latest,null);
 assert.equal(partial.status,'partial'); assert.match(partial.messages?.join(' ')??'',/limited/);
});
test('failed metric batch emits error results rather than disappearing', async()=>{
 const clients = {get:()=>({send:async()=>{throw Object.assign(new Error('denied'),{name:'AccessDenied'});}})} as unknown as ClientFactory;
 const result=await collectMetrics(graph,clients);
 assert.equal(result.series['lambda:fn']?.length,3);
 assert.equal(result.series['lambda:fn'][0].status,'error');
 assert.match(result.series['lambda:fn'][0].messages?.join(' ')??'',/AccessDenied/);
});
test('pagination resolves partial status only after a complete page and retains CloudWatch messages',async()=>{let calls=0;const clients={get:()=>({send:async()=>++calls===1?{NextToken:'next',MetricDataResults:[{Id:'q0',StatusCode:'PartialData',Timestamps:[new Date(1000)],Values:[0]}]}:{MetricDataResults:[{Id:'q0',StatusCode:'Complete',Timestamps:[new Date(2000)],Values:[1]},{Id:'q1',StatusCode:'Forbidden',Messages:[{Code:'AccessDenied',Value:'denied'}]},{Id:'q2',StatusCode:'Complete'}]}})} as unknown as ClientFactory;const r=await collectMetrics(graph,clients);assert.equal(calls,2);assert.equal(r.series['lambda:fn'][0].status,'complete');assert.equal(r.series['lambda:fn'][0].points.length,2);assert.equal(r.series['lambda:fn'][1].status,'error');assert.match(r.series['lambda:fn'][1].messages?.join(' ')??'',/AccessDenied/);});
test('throttled continuation preserves retrieved points as partial and missing IDs as errors',async()=>{let calls=0;const clients={get:()=>({send:async()=>{if(++calls===1)return {NextToken:'next',MetricDataResults:[{Id:'q0',StatusCode:'PartialData',Timestamps:[new Date(1000)],Values:[0]}]};throw Object.assign(new Error('retry later'),{name:'ThrottlingException'});}})} as unknown as ClientFactory;const r=await collectMetrics(graph,clients);assert.equal(r.series['lambda:fn'][0].status,'partial');assert.equal(r.series['lambda:fn'][0].latest,0);assert.match(r.series['lambda:fn'][0].messages?.join(' ')??'',/ThrottlingException/);assert.equal(r.series['lambda:fn'][1].status,'error');});
test('original AWS status and thrown error code survive normalization without messages',async()=>{const clients={get:()=>({send:async()=>({MetricDataResults:[{Id:'q0',StatusCode:'Forbidden'},{Id:'q1',StatusCode:'InternalError'}]})})} as unknown as ClientFactory;const result=await collectMetrics(graph,clients);assert.equal(result.series['lambda:fn'][0].awsStatus,'Forbidden');assert.equal(result.series['lambda:fn'][1].awsStatus,'InternalError');const denied=await collectMetrics(graph,{get:()=>({send:async()=>{throw Object.assign(new Error('denied'),{name:'AccessDeniedException'});}})} as unknown as ClientFactory);assert.equal(denied.series['lambda:fn'][0].errorCode,'AccessDeniedException');});
