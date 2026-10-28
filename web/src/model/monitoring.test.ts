/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../api/client';
import { useMonitoring, matchingAlarms, monitoringWindow } from './monitoring';
import { MONITORING_RESOURCE_TYPES } from '@orrery/shared';
import type { AlarmRecord, MonitoringAlarmSnapshot } from '@orrery/shared';
const scope = { source: 'profile:test', account: 'dummy-account', region: 'test-region' };
const observation = { attemptedAt: '2026-10-23T00:00:00Z', succeededAt: '2026-10-23T00:00:00Z' };
const alarm = (state: AlarmRecord['state']): AlarmRecord => ({ name: 'fixture', state, type: 'composite', region: scope.region, metrics: [], mapping: 'unresolved', resourceKeys: [] });
test('independent alarms preserve unlinked composites and refresh selected detail', async () => {
  const original = { ...api }; let state: AlarmRecord['state'] = 'ALARM';
  api.monitoringAlarms = async () => ({ scope, observation, complete: true, alarms: [alarm(state)] }); api.monitoringHistory = async () => ({ scope, items: [], observation });
  try { useMonitoring.getState().activate('test', scope.region); await useMonitoring.getState().loadAlarms(); useMonitoring.getState().selectAlarm(alarm(state)); state = 'OK'; await useMonitoring.getState().loadAlarms(); assert.equal(useMonitoring.getState().selectedAlarm?.state, 'OK'); assert.equal(useMonitoring.getState().alarms?.alarms[0].type, 'composite'); assert.equal(matchingAlarms([alarm('ALARM')], 'FIX', 'ALARM').length, 1); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});
test('monitoring A → B → A ignores old alarms and old finally', async () => {
  const original = api.monitoringAlarms; const requests: Array<{ resolve: (v: MonitoringAlarmSnapshot) => void }> = [];
  api.monitoringAlarms = () => new Promise((resolve) => requests.push({ resolve }));
  try { useMonitoring.getState().activate('A', 'r'); useMonitoring.getState().activate('B', 'r'); useMonitoring.getState().activate('A', 'r'); requests[0].resolve({ scope, observation, complete: true, alarms: [alarm('ALARM')] }); await Promise.resolve(); await Promise.resolve(); assert.equal(useMonitoring.getState().alarmLoading, true); assert.equal(useMonitoring.getState().alarms, undefined); requests[2].resolve({ scope, observation, complete: true, alarms: [alarm('OK')] }); requests[1].resolve({ scope, observation, complete: true, alarms: [] }); await Promise.resolve(); await Promise.resolve(); assert.equal(useMonitoring.getState().alarms?.alarms[0].state, 'OK'); } finally { useMonitoring.getState().deactivate(); api.monitoringAlarms = original; }
});
test('relative and custom time windows validate direction and maximum duration', () => { const now = Date.parse('2026-10-23T00:00:00Z'); assert.equal(Date.parse(monitoringWindow('3h', now).end) - Date.parse(monitoringWindow('3h', now).start), 10800000); assert.throws(() => monitoringWindow('custom', now, '2026-10-23', '2026-10-22')); assert.throws(() => monitoringWindow('custom', now, '2026-10-01', '2026-10-22')); });

test('automatic account change in resource index cannot retain previous account resources and selections', async () => {
  const original = { ...api };
  useMonitoring.setState({ profile: 'test', region: 'r', alarms: { scope, observation, complete: true, alarms: [] }, resources: { scope, observation, complete: true, types: ['lambda'], resources: [{ key: 'old', nodeId: 'old', nativeId: 'old', name: 'old', type: 'lambda', region: 'r', tagsStatus: 'complete', props: {} }] }, selectedResources: ['old'] });
  api.monitoringResources = async () => ({ scope: { ...scope, account: 'new' }, observation, complete: true, types: ['sqs-queue'], resources: [] });
  api.monitoringAlarms = () => new Promise(() => {});
  try { await useMonitoring.getState().loadResources('sqs-queue'); assert.deepEqual(useMonitoring.getState().selectedResources, []); assert.equal(useMonitoring.getState().resources?.resources.length, 0); assert.equal(useMonitoring.getState().alarms, undefined); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('store selection stays bounded to eight while workspace controller owns observation scheduling and stale responses cannot cross accounts', async () => {
  const original = { ...api }; let calls = 0; let resolve!: (result: Awaited<ReturnType<typeof api.monitoringMetrics>>) => void;
  useMonitoring.setState({ profile: 'test', region: scope.region, selectedResources: [], alarms: { scope, observation, complete: true, alarms: [] }, metrics: undefined });
  api.monitoringMetrics = async (_p, _r, keys, window) => { calls++; assert.deepEqual(keys, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); return new Promise((r) => { resolve = r; }); };
  api.monitoringAlarms = async () => ({ scope: { ...scope, account: 'new-account' }, observation, complete: true, alarms: [] });
  try { for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) useMonitoring.getState().toggleResource(key); assert.equal(calls, 0); assert.deepEqual(useMonitoring.getState().selectedResources, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']); const pending = useMonitoring.getState().loadMetrics(); assert.equal(calls, 1); await useMonitoring.getState().loadAlarms(); resolve({ scope, range: { startTime: observation.attemptedAt, endTime: observation.attemptedAt }, collectedAt: observation.attemptedAt, series: {}, queryCount: 1, requestCount: 1, maxRequests: 10 }); await pending; assert.equal(useMonitoring.getState().metrics, undefined); assert.deepEqual(useMonitoring.getState().selectedResources, []); assert.equal(useMonitoring.getState().autoRefresh, 0); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('resource types accumulate and a successful requery recovers partial coverage', async () => {
  const original = { ...api }; let complete = true;
  useMonitoring.setState({ profile: 'test', region: scope.region, alarms: { scope, observation, complete: true, alarms: [] }, resources: undefined, resourceCoverage: {} });
  api.monitoringAlarms = async () => ({ scope, observation, complete: true, alarms: [] });
  api.monitoringResources = async (_p, _r, type) => ({ scope, observation, complete, types: [type], resources: [{ key: type, nodeId: type, type, nativeId: type, name: type, region: scope.region, tagsStatus: 'complete', props: {} }] });
  try { await useMonitoring.getState().loadResources('lambda'); complete = false; await useMonitoring.getState().loadResources('sqs-queue'); assert.equal(useMonitoring.getState().resources?.complete, false); assert.equal(useMonitoring.getState().resources?.resources.length, 2); complete = true; await useMonitoring.getState().loadResources('sqs-queue'); assert.equal(useMonitoring.getState().resources?.complete, true); assert.equal(useMonitoring.getState().resources?.resources.length, 2); } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('automatic refresh stops for per-series permission errors and reports transient partial failures', async () => {
  const original = api.monitoringMetrics; let message = 'Forbidden: AccessDenied';
  useMonitoring.setState({ profile: 'test', region: scope.region, selectedResources: ['dummy'], alarms: { scope, observation, complete: true, alarms: [] }, autoRefresh: 60000, metricsError: undefined });
  api.monitoringMetrics = async () => ({ scope, collectedAt: observation.attemptedAt, range: { startTime: observation.attemptedAt, endTime: observation.attemptedAt }, queryCount: 1, requestCount: 1, maxRequests: 10, series: { dummy: [{ id: 'test', name: 'test', label: 'test', stat: 'Sum', unit: 'Count', points: [], latest: null, status: 'error', messages: [message] }] } });
  try { await useMonitoring.getState().loadMetrics(); assert.equal(useMonitoring.getState().autoRefresh, 0); assert.match(useMonitoring.getState().metricsError ?? '', /권한|다시 연결/); message = 'ThrottlingException'; useMonitoring.setState({ autoRefresh: 60000 }); await useMonitoring.getState().loadMetrics(); assert.equal(useMonitoring.getState().autoRefresh, 60000); assert.match(useMonitoring.getState().metricsError ?? '', /Throttling/); } finally { useMonitoring.getState().deactivate(); api.monitoringMetrics = original; }
});

test('resource discovery batch stops on menu departure and clears filters/reference on scope change', async () => {
  const original = { ...api }; const calls: string[] = [];
  let finish!: (value: Awaited<ReturnType<typeof api.monitoringResources>>) => void;
  useMonitoring.setState({ profile: 'test', region: scope.region, alarms: { scope, observation, complete: true, alarms: [] }, resourceFilters: { query: 'old', tags: [{ key: 'Service', value: 'wiki' }], tagStatus: 'all' }, referenceResource: 'old-account-key' });
  api.monitoringResources = async (_p, _r, type) => { calls.push(type); return new Promise((resolve) => { finish = resolve; }); };
  api.monitoringAlarms = () => new Promise(() => {});
  try {
    const pending = useMonitoring.getState().loadResourceTypes(['lambda', 'sqs-queue']);
    useMonitoring.getState().deactivate();
    finish({ scope, observation, complete: true, resources: [], types: ['lambda'] });
    await pending;
    assert.deepEqual(calls, ['lambda']);
    useMonitoring.getState().activate('different-profile', scope.region);
    assert.deepEqual(useMonitoring.getState().resourceFilters, { query: '', tags: [], tagStatus: 'all' });
    assert.equal(useMonitoring.getState().referenceResource, undefined);
  } finally { useMonitoring.getState().deactivate(); Object.assign(api, original); }
});

test('workspace entry discovers all supported resource types with zero paid metric requests', async()=>{
 const original={...api};const types:string[]=[];let metrics=0;
 api.monitoringResources=async(_p,_r,type)=>{types.push(type);return {scope,observation,complete:true,types:[type],resources:[]};};
 api.monitoringAlarms=async()=>({scope,observation,complete:true,alarms:[]});api.monitoringMetrics=async()=>{metrics++;throw new Error('must not run');};
 try {useMonitoring.getState().activate('test',scope.region);await new Promise(resolve => setImmediate(resolve));assert.deepEqual(types,MONITORING_RESOURCE_TYPES.map(([type])=>type));assert.equal(metrics,0);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('selection starts debounced metrics while remaining resource types and relationship lookup are still pending',async()=>{
 const {createMonitoringWorkspaceRequests}=await import('./monitoring-workspace');const original={...api};const requests:string[]=[];let metrics=0;const timers=new Map<number,()=>void>();let timer=0;
 const resource={key:'lambda:first',nodeId:'lambda:first',nativeId:'first',name:'first',type:'lambda' as const,region:scope.region,tagsStatus:'complete' as const,props:{}};
 api.monitoringResources=async(_p,_r,type)=>{requests.push(type);if(type!=='lambda')return new Promise(()=>{});return {scope,observation,complete:true,types:[type],resources:[resource]};};
 api.monitoringAlarms=async()=>({scope,observation,complete:true,alarms:[]});api.monitoringRelated=()=>new Promise(()=>{});
 api.monitoringMetrics=async(_p,_r,keys,range)=>{metrics++;assert.deepEqual(keys,[resource.key]);return {scope,range,collectedAt:observation.attemptedAt,series:{},queryCount:1,requestCount:1,maxRequests:10};};
 const controller=createMonitoringWorkspaceRequests({key:()=>JSON.stringify([useMonitoring.getState().selectedResources,useMonitoring.getState().range]),ready:()=>useMonitoring.getState().workspaceActive&&useMonitoring.getState().selectedResources.length>0,subscribe:(listener)=>useMonitoring.subscribe(listener),run:()=>useMonitoring.getState().loadMetrics(),schedule:(callback)=>{timers.set(++timer,callback);return timer as unknown as ReturnType<typeof setTimeout>;},cancel:(id)=>{timers.delete(id as unknown as number);}});
 try {useMonitoring.setState({profile:'',region:''});controller.start();useMonitoring.getState().activate('test',scope.region);for(let i=0;i<12;i++)await Promise.resolve();assert.deepEqual(requests,['lambda','sqs-queue']);assert.equal(metrics,0);useMonitoring.getState().toggleResource(resource.key);assert.equal(useMonitoring.getState().relatedLoading,true);assert.equal(useMonitoring.getState().resourceLoading,true);for(const [id,callback]of [...timers]){timers.delete(id);callback();}await Promise.resolve();assert.equal(metrics,1);useMonitoring.setState({resourceFilters:{query:'search',tags:[],tagStatus:'all'}});assert.equal(timers.size,0);useMonitoring.getState().deactivate();assert.equal(timers.size,0);}finally{controller.stop();useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('legacy configurations over eight resources are preserved and require explicit target choice',async()=>{
 const original={...api};const resources=Array.from({length:9},(_,i)=>({key:`resource:${i}`,nodeId:`resource:${i}`,nativeId:`resource:${i}`,name:`resource:${i}`,type:'lambda' as const,region:scope.region,tagsStatus:'complete' as const,props:{}}));const group={id:'legacy',name:'old',resourceKeys:resources.map(r=>r.key),tagFilters:[]};
 api.monitoringResolve=async()=>({scope,resources,unresolvedKeys:[],graph:{state:'complete'}});
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]},groups:[group]});await useMonitoring.getState().restoreGroup(group.id);assert.deepEqual(useMonitoring.getState().selectedResources,[]);assert.equal(useMonitoring.getState().restoreCandidates.length,9);assert.equal(useMonitoring.getState().groups[0].resourceKeys.length,9);assert.match(useMonitoring.getState().restoreNotice??'',/8개.*직접 선택/);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('restoration account mismatch cancels pending work and clears every prior-account observation',async()=>{
 const original={...api};api.monitoringResolve=async()=>({scope:{...scope,account:'different'},resources:[],unresolvedKeys:[],graph:{state:'complete'}});
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]},resourceCoverage:{lambda:{...observation,complete:true}},selectedResources:['old'],referenceResource:'old',metricsLoading:true,resourceLoading:true,historyLoading:true,alarmLoading:true,autoRefresh:60000,groups:[{id:'saved',name:'saved',resourceKeys:['old'],tagFilters:[]}]});await useMonitoring.getState().restoreGroup('saved');const s=useMonitoring.getState();assert.deepEqual(s.selectedResources,[]);assert.deepEqual(s.resourceCoverage,{});assert.equal(s.referenceResource,undefined);assert.equal(s.alarmLoading||s.metricsLoading||s.resourceLoading||s.historyLoading,false);assert.equal(s.autoRefresh,0);assert.equal(s.alarms,undefined);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('tag-only legacy configuration restores from the lightweight index without an invalid empty resolve request',async()=>{
 const original={...api};let resolves=0;api.monitoringResolve=async()=>{resolves++;throw new Error('empty keys rejected');};api.monitoringRelated=()=>new Promise(()=>{});
 const resource={key:'tagged',nodeId:'tagged',nativeId:'tagged',name:'tagged',type:'lambda' as const,region:scope.region,tags:{Service:'wiki'},tagsStatus:'complete' as const,props:{}};
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]},resources:{scope,observation,complete:true,types:['lambda'],resources:[resource]},groups:[{id:'tags',name:'tags',resourceKeys:[],tagFilters:[{key:'Service',value:'wiki'}]}]});await useMonitoring.getState().restoreGroup('tags');assert.equal(resolves,0);assert.deepEqual(useMonitoring.getState().selectedResources,['tagged']);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('related lookup preserves immediate tag evidence and ignores a late response after reference/menu changes',async()=>{
 const original={...api};const resources=['a','b','c'].map((key)=>({key,nodeId:key,nativeId:key,name:key,type:'lambda' as const,region:scope.region,tags:{Service:'wiki'},tagsStatus:'complete' as const,props:{}}));const pending:Array<{key:string;resolve:(value:Awaited<ReturnType<typeof api.monitoringRelated>>)=>void}>=[];
 api.monitoringRelated=async(_p,_r,key)=>new Promise(resolve=>pending.push({key,resolve}));
 try{useMonitoring.setState({profile:'test',region:scope.region,workspaceActive:true,alarms:{scope,observation,complete:true,alarms:[]},resources:{scope,observation,complete:true,types:['lambda'],resources}});useMonitoring.getState().setReferenceResource('a');assert.equal(useMonitoring.getState().related?.sameTags.length,2);useMonitoring.getState().setReferenceResource('b');pending[0].resolve({scope,resourceKey:'a',sameTags:[],connected:[],graph:{state:'complete'},tagCoverage:{types:[],incompleteTypes:[]}});await Promise.resolve();await Promise.resolve();assert.equal(useMonitoring.getState().referenceResource,'b');assert.equal(useMonitoring.getState().related?.resourceKey,'b');assert.equal(useMonitoring.getState().relatedLoading,true);useMonitoring.getState().deactivate();pending[1].resolve({scope,resourceKey:'b',sameTags:[],connected:[],graph:{state:'complete'},tagCoverage:{types:[],incompleteTypes:[]}});await Promise.resolve();await Promise.resolve();assert.equal(useMonitoring.getState().related?.graph.state,'not-requested');}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('hidden workspace stops relationship polling and an explicit resume continues the pending graph',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const original={...api};let calls=0;
 const resource={key:'a',nodeId:'a',nativeId:'a',name:'a',type:'lambda' as const,region:scope.region,tagsStatus:'complete' as const,props:{}};
 api.monitoringRelated=async()=>{calls++;return {scope,resourceKey:'a',sameTags:[],connected:[],graph:{state:'loading'},tagCoverage:{types:[],incompleteTypes:[]}};};
 try{useMonitoring.setState({profile:'test',region:scope.region,workspaceActive:true,referenceResource:'a',resources:{scope,observation,complete:true,types:['lambda'],resources:[resource]}});await useMonitoring.getState().loadRelated(false);assert.equal(calls,1);useMonitoring.getState().pauseRequests();t.mock.timers.tick(10000);await Promise.resolve();assert.equal(calls,1);await useMonitoring.getState().loadRelated(false);t.mock.timers.tick(2000);await Promise.resolve();await Promise.resolve();assert.equal(calls,3);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);t.mock.timers.reset();}
});

test('unsupported related resources do not prevent supported selected metrics or create paid requests alone',async()=>{
 const original={...api};const calls:string[][]=[];
 api.monitoringMetrics=async(_p,_r,keys,range)=>{calls.push(keys);return {scope,range,collectedAt:observation.attemptedAt,series:{},queryCount:1,requestCount:1,maxRequests:10};};
 const resources=[{key:'supported',nodeId:'supported',nativeId:'supported',name:'supported',type:'lambda' as const,region:scope.region,props:{},tagsStatus:'complete' as const,metricsSupported:true},{key:'unsupported',nodeId:'unsupported',nativeId:'unsupported',name:'unsupported',type:'iam-role' as const,region:scope.region,props:{},tagsStatus:'complete' as const,metricsSupported:false}];
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]},resources:{scope,observation,complete:true,types:['lambda'],resources},selectedResources:['supported','unsupported']});await useMonitoring.getState().loadMetrics();assert.deepEqual(calls,[['supported']]);useMonitoring.setState({selectedResources:['unsupported'],autoRefresh:60000});await useMonitoring.getState().loadMetrics();assert.equal(calls.length,1);assert.equal(useMonitoring.getState().autoRefresh,0);assert.match(useMonitoring.getState().metricsError??'',/미지원|지원하지/);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('returning to the same monitoring scope resumes a pending relationship snapshot',async()=>{
 const original={...api};let relatedCalls=0;api.monitoringRelated=async()=>{relatedCalls++;return {scope,resourceKey:'saved',sameTags:[],connected:[],graph:{state:'complete'},tagCoverage:{types:[],incompleteTypes:[]}};};api.monitoringAlarms=()=>new Promise(()=>{});api.monitoringResources=()=>new Promise(()=>{});
 try{useMonitoring.setState({profile:'test',region:scope.region,workspaceActive:true,referenceResource:'saved',related:{scope,resourceKey:'saved',sameTags:[],connected:[],graph:{state:'loading'},tagCoverage:{types:[],incompleteTypes:[]}}});useMonitoring.getState().deactivate();useMonitoring.getState().activate('test',scope.region);for(let i=0;i<6;i++)await Promise.resolve();assert.equal(relatedCalls,1);assert.equal(useMonitoring.getState().related?.graph.state,'complete');}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('restoring an isolated graph-only resource refreshes alarm mappings even without any related candidates',async()=>{
 const original={...api};let alarmCalls=0;const resource={key:'graph-only',nodeId:'graph-only',nativeId:'graph-only',name:'graph-only',type:'lambda' as const,region:scope.region,tagsStatus:'complete' as const,props:{}};
 api.monitoringResolve=async()=>({scope,resources:[resource],unresolvedKeys:[],graph:{state:'complete'}});api.monitoringAlarms=async()=>{alarmCalls++;return {scope,observation,complete:true,alarms:[]};};api.monitoringRelated=async()=>({scope,resourceKey:resource.key,sameTags:[],connected:[],graph:{state:'complete'},tagCoverage:{types:[],incompleteTypes:[]}});
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]},resources:{scope,observation,complete:true,types:[],resources:[]},groups:[{id:'restore',name:'restore',resourceKeys:[resource.key],tagFilters:[]}]});await useMonitoring.getState().restoreGroup('restore');for(let i=0;i<6;i++)await Promise.resolve();assert.equal(alarmCalls,1);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('same-profile history returned from another account is rejected and clears prior observations',async()=>{
 const original={...api};api.monitoringHistory=async()=>({scope:{...scope,account:'new-history-account'},items:[{summary:'another account history'}],observation});
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[alarm('ALARM')]},selectedAlarm:alarm('ALARM'),selectedResources:['old'],referenceResource:'old',resourceCoverage:{lambda:{...observation,complete:true}},history:undefined,autoRefresh:60000});await useMonitoring.getState().loadHistory();const s=useMonitoring.getState();assert.equal(s.history,undefined);assert.equal(s.selectedAlarm,undefined);assert.deepEqual(s.selectedResources,[]);assert.equal(s.autoRefresh,0);assert.match(s.scopeNotice??'',/계정|인증/);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});

test('custom time clears stale history immediately and debounces the selected alarm history even without selected resources',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const original={...api};const windows:Array<{start:string;end:string}>=[];api.monitoringHistory=async(_p,_r,_name,_type,window)=>{windows.push(window);return {scope,items:[],observation};};
 try{useMonitoring.setState({profile:'test',region:scope.region,workspaceActive:true,range:'custom',customStart:'2026-10-22T00:00',customEnd:'2026-10-22T01:00',selectedResources:[],alarms:{scope,observation,complete:true,alarms:[]},selectedAlarm:alarm('ALARM'),history:{scope,items:[{summary:'old window'}],observation},historyWindow:{start:'old',end:'old'},historyError:'old error'});useMonitoring.getState().setCustomTime('customStart','2026-10-22T02:00');useMonitoring.getState().setCustomTime('customEnd','2026-10-22T03:00');assert.equal(useMonitoring.getState().history,undefined);assert.equal(useMonitoring.getState().historyWindow,undefined);assert.equal(useMonitoring.getState().historyError,undefined);t.mock.timers.tick(299);assert.equal(windows.length,0);t.mock.timers.tick(1);await Promise.resolve();assert.equal(windows.length,1);assert.equal(windows[0].start,new Date('2026-10-22T02:00').toISOString());useMonitoring.getState().setCustomTime('customEnd','2026-10-22T04:00');useMonitoring.getState().deactivate();t.mock.timers.tick(1000);await Promise.resolve();assert.equal(windows.length,1);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);t.mock.timers.reset();}
});

test('alarm/range changes and pause cancel custom-history debounce without duplicate history requests',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const original={...api};let calls=0;api.monitoringHistory=async()=>{calls++;return {scope,items:[],observation};};
 try{useMonitoring.setState({profile:'test',region:scope.region,workspaceActive:true,range:'custom',customStart:'2026-10-22T00:00',customEnd:'2026-10-22T01:00',selectedAlarm:alarm('ALARM'),alarms:{scope,observation,complete:true,alarms:[]}});useMonitoring.getState().setCustomTime('customEnd','2026-10-22T02:00');useMonitoring.getState().pauseRequests();t.mock.timers.tick(500);assert.equal(calls,0);useMonitoring.getState().setCustomTime('customEnd','2026-10-22T03:00');useMonitoring.getState().selectAlarm(undefined);t.mock.timers.tick(500);assert.equal(calls,0);useMonitoring.setState({selectedAlarm:alarm('ALARM')});useMonitoring.getState().setCustomTime('customEnd','2026-10-22T04:00');useMonitoring.getState().setRange('1h');assert.equal(calls,1);t.mock.timers.tick(500);await Promise.resolve();assert.equal(calls,1);}finally{useMonitoring.getState().deactivate();Object.assign(api,original);t.mock.timers.reset();}
});

test('explicit resource refresh reaches each resource API as refresh=1 while initial discovery keeps cache reuse',async()=>{
 const originalFetch=globalThis.fetch, originalAlarms=api.monitoringAlarms;const urls:URL[]=[];
 globalThis.fetch=async(url,options)=>{urls.push(new URL(String(url),'http://localhost'));assert.ok(options?.signal instanceof AbortSignal);return new Response(JSON.stringify({scope,observation,complete:true,types:[urls.at(-1)!.searchParams.get('type')],resources:[]}),{status:200,headers:{'content-type':'application/json'}});};api.monitoringAlarms=async()=>({scope,observation,complete:true,alarms:[]});
 try{useMonitoring.setState({profile:'test',region:scope.region,alarms:{scope,observation,complete:true,alarms:[]}});await useMonitoring.getState().loadResourceTypes(['lambda','sqs-queue'],true);assert.equal(urls.length,2);assert.ok(urls.every(url=>url.searchParams.get('refresh')==='1'));await useMonitoring.getState().loadResources('lambda');assert.equal(urls[2].searchParams.has('refresh'),false);}finally{useMonitoring.getState().deactivate();globalThis.fetch=originalFetch;api.monitoringAlarms=originalAlarms;}
});

test('context-only candidates cannot consume slots and TG requires explicit context', () => {
 const initial=useMonitoring.getState();
 const base={key:'context',nodeId:'context',type:'security-group' as const,name:'fixture',nativeId:'context',region:scope.region,props:{},tagsStatus:'complete' as const,metricsSupported:false};
 const tg={...base,key:'tg',nodeId:'tg',type:'target-group' as const,metricsSupported:true,metricContexts:[{id:'dummy-alb',label:'dummy',loadBalancerArn:'dummy-alb',region:scope.region}]};
 try {
 useMonitoring.setState({selectedResources:[],metricContexts:{},resources:{scope,resources:[base,tg],types:[],complete:true,observation}});
 useMonitoring.getState().toggleResource('context');assert.equal(useMonitoring.getState().selectedResources.length,0);
 useMonitoring.getState().toggleResource('tg');assert.equal(useMonitoring.getState().selectedResources.length,0);
 useMonitoring.getState().setMetricContext('tg','dummy-alb');useMonitoring.getState().toggleResource('tg');assert.deepEqual(useMonitoring.getState().selectedResources,['tg']);
 }finally{useMonitoring.setState(initial);}
});

test('partial graph diagnostics do not become a failed related request',async()=>{
 const original={...api};
 const resource={key:'a',nodeId:'a',nativeId:'a',name:'dummy',type:'lambda' as const,region:scope.region,tagsStatus:'complete' as const,props:{}};
 api.monitoringRelated=async()=>({scope,resourceKey:'a',connected:[{resource,reasons:[]}],sameTags:[],graph:{state:'partial',observation:{...observation,error:'AccessDenied: dummy ECR tags'}},tagCoverage:{types:[],incompleteTypes:[]}});
 try {
 useMonitoring.setState({profile:'test',region:scope.region,referenceResource:'a',resources:{scope,resources:[resource],types:['lambda'],complete:true,observation}});
 await useMonitoring.getState().loadRelated(false);
 assert.equal(useMonitoring.getState().relatedError,undefined);
 assert.equal(useMonitoring.getState().related?.connected.length,1);
 assert.match(useMonitoring.getState().related?.graph.observation?.error ?? '',/AccessDenied/);
 }finally{useMonitoring.getState().deactivate();Object.assign(api,original);}
});
