import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {ResourceGraph} from '@orrery/shared';
import type {ClientFactory} from '../aws/clients.ts';
import {registerCleanupRoutes} from './routes.ts';
import {summarizeHistory} from './history.ts';
function fixture(){const scope={source:'profile:test',account:'000000000000',region:'us-east-1'};const collectedAt=new Date().toISOString();const graph:ResourceGraph={...scope,collectedAt,nodes:[{id:'i',nativeId:'i',name:'i',type:'ec2-instance',category:'compute',region:scope.region,status:'inactive',props:{}}],edges:[],reports:[],cleanup:{schemaVersion:1,scope,observedAt:collectedAt,coverage:[],findings:[{id:'f',resourceId:'i',ruleId:'stopped-ec2',fact:{resourceId:'i',ruleId:'stopped-ec2',state:'stopped'},reviewClass:'inactive',observedAt:collectedAt}]}};return {scope,graph}}
test('history endpoint resolves only server-known findings in the current snapshot and scope',async()=>{
 const {scope,graph}=fixture();let calls=0;const app=Fastify();
 registerCleanupRoutes(app,async()=>({...scope,clients:{} as ClientFactory}),async()=>graph,async()=>{calls++;return summarizeHistory({scope,findingId:'f',graphCollectedAt:graph.collectedAt,analyzedAt:graph.collectedAt,start:graph.collectedAt,end:graph.collectedAt,lookbackStart:graph.collectedAt,region:scope.region,coverage:'complete',pages:1,events:[]},graph.cleanup!.findings[0])});
 const req=(payload:unknown)=>app.inject({method:'POST',url:'/api/cleanup/history',payload:payload as object});
 assert.equal((await req({findingId:'f',collectedAt:'old'})).statusCode,409);
 assert.equal((await req({findingId:'foreign',collectedAt:graph.collectedAt})).statusCode,404);
 assert.equal((await req({})).statusCode,400);assert.equal(calls,0);
 const body={findingId:'f',collectedAt:graph.collectedAt};
 const responses=await Promise.all([req(body),req(body)]);assert.ok(responses.every(r=>r.statusCode===200));assert.equal(calls,1);
 graph.account='111111111111';assert.equal((await req(body)).statusCode,409);assert.equal(calls,1);await app.close();
});
