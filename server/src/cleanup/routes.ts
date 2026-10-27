import type { FastifyInstance } from 'fastify';
import type { CleanupHistory, ResourceGraph } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';
import { lookupCleanupHistory } from './history.ts';
interface Session {source:string;account:string;region:string;clients:ClientFactory}
export function registerCleanupRoutes(app: FastifyInstance, session:(query:Record<string,unknown>)=>Promise<Session>, graphFor:(s:Session)=>Promise<ResourceGraph|undefined>, lookup=lookupCleanupHistory) {
  const pending=new Map<string,Promise<CleanupHistory>>();
  const cache=new Map<string,{time:number;value:CleanupHistory}>();
  app.post<{Querystring:Record<string,string>;Body:{findingId?:unknown;collectedAt?:unknown}}>('/api/cleanup/history',async req=>{
    if(typeof req.body?.findingId!=='string'||req.body.findingId.length>4096||typeof req.body.collectedAt!=='string')throw Object.assign(new Error('자원과 구성 수집 시각이 필요합니다.'),{statusCode:400});
    const s=await session(req.query);const graph=await graphFor(s);
    if(!graph||graph.source!==s.source||graph.account!==s.account||graph.region!==s.region||graph.collectedAt!==req.body.collectedAt||Date.now()-Date.parse(graph.collectedAt)>10*60_000)throw Object.assign(new Error('현재 계정의 구성을 다시 수집한 뒤 분석하세요.'),{statusCode:409});
    const snapshot=graph.cleanup;
    if(!snapshot||snapshot.scope.source!==s.source||snapshot.scope.account!==s.account||snapshot.scope.region!==s.region)throw Object.assign(new Error('점검 근거를 다시 수집하세요.'),{statusCode:409});
    const finding=snapshot.findings.find(f=>f.id===req.body.findingId),node=graph.nodes.find(n=>n.id===finding?.resourceId);
    if(!finding||!node)throw Object.assign(new Error('현재 구성에서 확인된 점검 자원을 선택하세요.'),{statusCode:404});
    const key=JSON.stringify([s.source,s.account,s.region,graph.collectedAt,finding.id]);
    const hit=cache.get(key);if(hit&&Date.now()-hit.time<5*60_000)return hit.value;
    if(pending.has(key))return pending.get(key)!;
    // Bound queued scans. Each scan has its own 10-page budget and is de-duplicated.
    if(pending.size>=2)throw Object.assign(new Error('다른 이력을 분석 중입니다. 완료 후 다시 시도하세요.'),{statusCode:429});
    const task=lookup(s.clients,snapshot.scope,node,finding,graph.collectedAt).then(value=>{if(value.coverage==='complete'){if(cache.size>=100)cache.delete(cache.keys().next().value!);cache.set(key,{time:Date.now(),value});}return value}).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  });
}
