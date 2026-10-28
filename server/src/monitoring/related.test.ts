import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResourceGraph, MonitoringResource } from '@orrery/shared';
import { ResourceRepository, resourceKey } from './resources.ts';
import { relatedCandidates, MonitoringGraphRepository } from './related.ts';
import type { MonitoringSession } from './alarms.ts';

const scope={source:'profile:dummy',account:'000000000000',region:'ap-northeast-2'};
const s={...scope,clients:{}} as MonitoringSession;
const resource=(name:string):MonitoringResource=>({key:resourceKey(scope.account,scope.region,'lambda',name),nodeId:`lambda:${name}`,type:'lambda',nativeId:name,name,region:scope.region,tags:{Service:'dummy',Phase:'test'},tagsStatus:'complete',props:{}});
const graph=():ResourceGraph=>({...scope,collectedAt:new Date().toISOString(),nodes:[{id:'lambda:a',nativeId:'a',name:'a',type:'lambda',category:'compute',region:scope.region,status:'healthy',props:{},tags:{Service:'dummy'}},{id:'lambda:b',nativeId:'b',name:'b',type:'lambda',category:'compute',region:scope.region,status:'healthy',props:{},tags:{Service:'dummy'}},{id:'cloudfront:dist',nativeId:'dist',name:'distribution',type:'cloudfront',category:'network',region:scope.region,status:'healthy',props:{}}],edges:[{id:'ab',source:'lambda:a',target:'lambda:b',kind:'invokes'},{id:'ba',source:'lambda:b',target:'lambda:a',kind:'reads'},{id:'da',source:'cloudfront:dist',target:'lambda:a',kind:'origin'}],reports:[]});

test('related resources preserve both one-hop directions, exact tag reasons and exclude self/duplicates',()=>{
 const a=resource('a'), b=resource('b'), c={...resource('c'),tags:{Service:'other',Phase:'other'}};
 const result=relatedCandidates(a,[a,b,c],graph());
 assert.equal(result.connected.length,2);
 assert.equal(result.connected[0].resource.nativeId,'b');
 assert.deepEqual(result.connected[0].reasons.map((r)=>r.kind==='edge'?r.direction:undefined),['outgoing','incoming']);
 assert.equal(result.sameTags.length,1);
 assert.equal(result.sameTags[0].resource.nativeId,'b');
 assert.equal(result.sameTags[0].reasons.length,2);
});

test('graph-only resources enter actual scope index and unsupported resources are explicit',()=>{
 const repo=new ResourceRepository();
 repo.includeGraph(s,graph());
 assert.equal(repo.known(s).find((r)=>r.type==='cloudfront')?.metricsSupported,true);
 const other={...graph(),account:'111111111111'};
 assert.throws(()=>repo.includeGraph(s,other),/계정|범위/);
 assert.equal(repo.known({...s,account:'111111111111'}).length,0);
});

test('background graph collection is shared and returns loading immediately',async()=>{
 let resolve!:(g:ResourceGraph)=>void;
 let calls=0;
 const repo=new MonitoringGraphRepository({getCached:async()=>undefined,collect:async()=>{calls++;return new Promise<ResourceGraph>((r)=>{resolve=r;});}});
 const first=await repo.read(s,true);
 assert.equal(first.state.state,'loading');
 await repo.read(s,true);
 assert.equal(calls,1);
 resolve(graph());
 await new Promise((r)=>setTimeout(r,0));
 assert.equal((await repo.read(s,true)).state.state,'complete');
});

test('a newer partial cached graph separates unverified relationships into history',async()=>{
 let cached=graph();
 const repo=new MonitoringGraphRepository({getCached:async()=>cached,collect:async()=>cached});
 await repo.read(s);
 cached={...graph(),collectedAt:new Date(Date.now()+1).toISOString(),nodes:[graph().nodes[0]],edges:[],reports:[{collector:'edge',ok:false,nodes:0,edges:0,durationMs:1,error:'AccessDenied'}]};
 const result=await repo.read(s);
 assert.equal(result.state.state,'partial');
 assert.equal(result.graph?.edges.length,0);
 assert.equal(result.graph?.relationshipHistory?.length,3);
 assert.ok(result.graph?.relationshipHistory?.every(e => e.observation?.state === 'unverified'));
});

test('failed refresh keeps prior relationships as unverified history',async()=>{
 const previous={...graph(),collectedAt:new Date(Date.now()-20*60_000).toISOString()};
 let calls=0;
 const repo=new MonitoringGraphRepository({getCached:async()=>previous,collect:async()=>{calls++;throw Object.assign(new Error('denied'),{name:'AccessDenied'});}});
 assert.equal((await repo.read(s,true)).state.state,'loading');
 await new Promise((r)=>setTimeout(r,0));
 const result=await repo.read(s,true);
 assert.equal(result.state.state,'error');
 assert.equal(result.state.stale,true);
 assert.equal(result.state.observation?.errorCode,'AccessDenied');
 assert.equal(result.graph?.edges.length,0);
 assert.equal(result.graph?.relationshipHistory?.length,3);
 assert.ok(result.graph?.relationshipHistory?.every(e => e.observation?.state === 'unverified'));
 assert.equal(calls,1);
});

test('graph inflight requests are isolated by source/account, and a mismatched graph is rejected',async()=>{
 let calls=0;
 const resolvers:Array<()=>void>=[];
 const repo=new MonitoringGraphRepository({getCached:async()=>undefined,collect:async(scope)=>{calls++;return new Promise<ResourceGraph>((r)=>resolvers.push(()=>r({...graph(),source:scope.source,account:scope.account})));}});
 await Promise.all([repo.read(s,true),repo.read(s,true),repo.read({...s,source:'profile:other'},true),repo.read({...s,account:'111111111111'},true)]);
 assert.equal(calls,3);
 resolvers.forEach((resolve)=>resolve());
 await new Promise((r)=>setTimeout(r,0));
 assert.equal((await repo.read(s)).graph?.account,scope.account);
 const wrong=new MonitoringGraphRepository({getCached:async()=>({...graph(),account:'111111111111'}),collect:async()=>graph()});
 await assert.rejects(wrong.read(s),/범위/);
});

test('related and restore routes register graph-only resources for metrics with explicit unsupported/regional limits',async()=>{
 const {default:Fastify}=await import('fastify');
 const {registerMonitoringRoutes}=await import('./routes.ts');
 const {AlarmRepository}=await import('./alarms.ts');
 const {mapAlarms,alarmRecord}=await import('./alarms.ts');
 const calls:Array<{command:any;region?:string}>=[];
 const session={...s,clients:{get:(_ctor:any,region?:string)=>({send:async(command:any)=>{calls.push({command,region});return{MetricDataResults:command.input.MetricDataQueries.map((q:any)=>({Id:q.Id,StatusCode:'Complete'}))};}})}} as unknown as MonitoringSession;
 const g=graph();
 g.nodes.push({id:'security-group:sg-dummy',nativeId:'sg-dummy',name:'group',type:'security-group',category:'security',region:scope.region,status:'unknown',props:{}});
 const app=Fastify();
 registerMonitoringRoutes(app,async()=>session,new AlarmRepository(),new ResourceRepository(),{getCached:async()=>g,collect:async()=>{throw new Error('unexpected collection');}});
 const key=resourceKey(scope.account,scope.region,'cloudfront','dist');
 const restored=await app.inject({method:'POST',url:'/api/monitoring/resources/resolve',payload:{resourceKeys:[key]}});
 assert.equal(restored.statusCode,200);
 const cloudfront=restored.json().resources[0];
 assert.equal(cloudfront.metricsSupported,true);
 assert.match(cloudfront.alarmScopeWarning,/us-east-1/);
 const range={startTime:new Date(Date.now()-3600000).toISOString(),endTime:new Date(Date.now()-1000).toISOString()};
 const metric=await app.inject({method:'POST',url:'/api/monitoring/metrics',payload:{resourceKeys:[key],range}});
 assert.equal(metric.statusCode,200);
 assert.equal(calls.length,1);
 assert.equal(calls[0].region,'us-east-1');
 assert.deepEqual(calls[0].command.input.MetricDataQueries[0].MetricStat.Metric.Dimensions,[{Name:'Region',Value:'Global'},{Name:'DistributionId',Value:'dist'}]);
 const alarm=alarmRecord({AlarmName:'global',Namespace:'AWS/CloudFront',MetricName:'Requests',Dimensions:[{Name:'DistributionId',Value:'dist'},{Name:'Region',Value:'Global'}]},'us-east-1')!;
 assert.deepEqual(mapAlarms([alarm],[cloudfront])[0].resourceKeys,[key]);
 const unsupportedKey=resourceKey(scope.account,scope.region,'security-group','sg-dummy');
 const unsupported=await app.inject({method:'POST',url:'/api/monitoring/metrics',payload:{resourceKeys:[unsupportedKey],range}});
 assert.equal(unsupported.statusCode,400);
 assert.match(unsupported.json().message,/지원/);
 assert.equal(calls.length,1);
 const foreign=await app.inject({method:'POST',url:'/api/monitoring/resources/resolve',payload:{resourceKeys:[resourceKey('111111111111',scope.region,'cloudfront','dist')]}});
 assert.equal(foreign.statusCode,409);
 const related=await app.inject({url:`/api/monitoring/related?connections=1&resourceKey=${encodeURIComponent(resource('a').key)}`});
 assert.equal(related.json().connected.length,2);
 assert.equal(related.json().graph.state,'complete');
 await app.close();
});

test('initial list and selected metrics do not wait for relationship collection, and restoring >4 keys does not truncate',async()=>{
 const {default:Fastify}=await import('fastify');
 const {registerMonitoringRoutes}=await import('./routes.ts');
 const {AlarmRepository}=await import('./alarms.ts');
 let graphCalls=0, metricCalls=0;
 let resolveGraph!:(g:ResourceGraph)=>void;
 const names=['a','b','c','d','e','f'];
 const session={...s,clients:{get:()=>({send:async(command:any)=>{
   if(command.constructor.name==='ListFunctionsCommand')return{Functions:names.map((name)=>({FunctionName:name,FunctionArn:`arn:aws:lambda:${scope.region}:${scope.account}:function:${name}`}))};
   if(command.constructor.name==='ListTagsCommand')return{Tags:{Service:'dummy'}};
   if(command.constructor.name==='GetMetricDataCommand'){metricCalls++;return{MetricDataResults:command.input.MetricDataQueries.map((q:any)=>({Id:q.Id,StatusCode:'Complete'}))};}
   throw new Error(`unexpected ${command.constructor.name}`);
 }})}} as unknown as MonitoringSession;
 const app=Fastify();
 registerMonitoringRoutes(app,async()=>session,new AlarmRepository(),new ResourceRepository(),{getCached:async()=>undefined,collect:async()=>{graphCalls++;return new Promise<ResourceGraph>((resolve)=>{resolveGraph=resolve;});}});
 const listed=await app.inject('/api/monitoring/resources?type=lambda');
 assert.equal(listed.json().resources.length,6);
 assert.equal(graphCalls,0);assert.equal(metricCalls,0);
 const key=resource('a').key;
 const related=await app.inject(`/api/monitoring/related?connections=1&resourceKey=${encodeURIComponent(key)}`);
 assert.equal(related.json().graph.state,'loading');
 assert.equal(related.json().sameTags.length,5);
 const range={startTime:new Date(Date.now()-3600000).toISOString(),endTime:new Date(Date.now()-1000).toISOString()};
 const metrics=await app.inject({method:'POST',url:'/api/monitoring/metrics',payload:{resourceKeys:[key],range}});
 assert.equal(metrics.statusCode,200);assert.equal(metricCalls,1);assert.equal(graphCalls,1);
 const restored=await app.inject({method:'POST',url:'/api/monitoring/resources/resolve',payload:{resourceKeys:names.map((name)=>resource(name).key)}});
 assert.equal(restored.json().resources.length,6);
 assert.deepEqual(restored.json().unresolvedKeys,[]);
 resolveGraph(graph());
 await new Promise((r)=>setTimeout(r,0));
 await app.close();
});

test('explicit retry refreshes fresh complete and partial graphs while sharing current collection',async()=>{
 for(const partial of [false,true]){
  const cached={...graph(),reports:partial?[{collector:'edge',ok:false,nodes:0,edges:0,durationMs:1,error:'temporary'}]:[]};
  let calls=0,finish!:(g:ResourceGraph)=>void;
  const repo=new MonitoringGraphRepository({getCached:async()=>cached,collect:async()=>{calls++;return new Promise<ResourceGraph>((resolve)=>{finish=resolve;});}});
  await repo.read(s);
  repo.retry(s);
  assert.equal((await repo.read(s,true)).state.state,'loading');
  assert.equal(calls,1);
  repo.retry(s);
  await repo.read(s,true);
  assert.equal(calls,1);
  finish(graph());await new Promise((r)=>setTimeout(r,0));
  await repo.read(s,true);assert.equal(calls,1);
 }
});
