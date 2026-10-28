import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildMonitoringPath, pathOptions } from './paths.ts';
import type { ResourceGraph, ResourceEdge } from '@orrery/shared';
const edge = (source:string,target:string,kind:ResourceEdge['kind']='targets'):ResourceEdge => ({id:`${source}:${target}`,source,target,kind,evidence:[{partition:'dummy',collector:'dummy',operation:'DescribeDummy',method:'configuration'}],observation:{state:'current'}});
function graph(ids:string[], edges:ResourceEdge[]):ResourceGraph { return {source:'dummy',account:'000000000000',region:'ap-northeast-2',collectedAt:'2026-10-28T01:00:00Z',revision:'test',nodes:ids.map(id=>({id,nativeId:id,name:id,type:'lambda',category:'compute',region:'ap-northeast-2',status:'unknown',props:{}})),edges,reports:[]}; }
test('paths preserve direction, stop shared hubs and cycles, exclude weight zero but retain unhealthy targets',()=>{
 const g=graph(['alb','tg','service','other','sg','host'],[edge('alb','tg'),edge('tg','service'),edge('other','tg'),edge('service','sg','attached'),edge('other','sg','attached'),{...edge('service','host','attached'),props:{role:'execution-host'}}]);
 g.edges[0].status='inactive'; // configuration still exists with no healthy targets
 assert.deepEqual(buildMonitoringPath(g,'alb',{depth:3,group:'execution'}).nodes.map(n=>n.nodeId),['alb','tg','service','host']);
 assert.deepEqual(buildMonitoringPath(g,'service',{depth:3,group:'context'}).nodes.map(n=>n.nodeId),['tg','service','sg','host']);
 g.edges.push(edge('service','alb')); assert.ok(buildMonitoringPath(g,'alb',{depth:3,group:'execution'}).edges.length<10);
 g.edges[0].props={weight:0}; g.edges.pop(); assert.equal(buildMonitoringPath(g,'alb',{depth:3,group:'execution'}).edges.length,0);
 assert.throws(()=>buildMonitoringPath(g,'alb',{depth:1,group:'execution',revision:'old'}),{statusCode:409});
 assert.throws(()=>pathOptions({depth:'4'}),{statusCode:400});
});
test('large graph has stable pages within response caps and bounded runtime',()=>{
 const ids=Array.from({length:10000},(_,i)=>String(i));
 const edges=ids.slice(1).flatMap((id,i)=>[edge('0',id),edge(id,String((i+2)%10000)),edge(id,String((i+3)%10000))]);
 const g=graph(ids,edges); const times:number[]=[];
 for(let i=0;i<21;i++){ const at=performance.now(); const result=buildMonitoringPath(g,'0',{depth:1,group:'execution'}); if(i)times.push(performance.now()-at);assert.ok(result.nodes.length<=60);assert.ok(result.edges.length<=120);assert.ok(result.nextOffset); }
 const first=buildMonitoringPath(g,'0',{depth:1,group:'execution'}), second=buildMonitoringPath(g,'0',{depth:1,group:'execution',offset:first.nextOffset,revision:first.revision});
 assert.ok(!first.edges.some(e=>second.edges.some(n=>n.id===e.id)));
 const p95=times.sort((a,b)=>a-b)[18]; console.log(`path fixture 10000 nodes/${edges.length} edges warm p95=${p95.toFixed(1)}ms`); assert.ok(p95<100,'path p95 target 100ms');
});
