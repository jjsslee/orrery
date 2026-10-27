import { CloudTrailClient, LookupEventsCommand, type Event } from '@aws-sdk/client-cloudtrail';
import type { CleanupFinding, CleanupHistory, CleanupHistoryEvent, CleanupSnapshot, ResourceNode } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';
const DAY = 86400000;
export const MAX_HISTORY_PAGES = 10;
const SOURCES = { 'detached-ebs': 'ec2.amazonaws.com', 'stopped-ec2': 'ec2.amazonaws.com', 'empty-target-group': 'elasticloadbalancing.amazonaws.com', 'disabled-cloudfront': 'cloudfront.amazonaws.com' } as const;

/** Resource-filtered events; only an allowlisted actor type/label leaves this module, never raw payload or credentials. */
export function parseHistoryEvent(event: Event, node: ResourceNode, finding: CleanupFinding): { event?: CleanupHistoryEvent; malformed?: boolean } {
  if (!event.EventSource) return { malformed: true };
  if (event.EventSource !== SOURCES[finding.ruleId]) return {};
  if (!event.Resources?.some(r => r.ResourceName === node.nativeId || (node.arn && r.ResourceName === node.arn))) return { malformed: true };
  let raw: { errorCode?: unknown; readOnly?: unknown; requestParameters?: Record<string, unknown>; responseElements?: Record<string, unknown>; userIdentity?: { type?: unknown; arn?: unknown; userName?: unknown; invokedBy?: unknown } };
  try { raw = JSON.parse(event.CloudTrailEvent ?? ''); if (!raw || typeof raw !== 'object') return { malformed: true }; } catch { return { malformed: true }; }
  if (raw.errorCode || raw.readOnly === true || raw.readOnly === 'true' || event.ReadOnly === 'true') return {};
  const name = event.EventName;
  if (!name || !event.EventTime || !Number.isFinite(event.EventTime.getTime())) return { malformed: true };
  const metadata = ['CreateTags', 'DeleteTags', 'TagResource', 'UntagResource', 'AddTags', 'RemoveTags'].includes(name);
  let effect: CleanupHistoryEvent['effect'] | undefined = metadata ? 'metadata' : undefined;
  if (finding.ruleId === 'stopped-ec2') {
    if (name === 'StopInstances') effect = 'idle';
    else if (['StartInstances', 'RunInstances', 'RebootInstances'].includes(name)) effect = 'active';
    else if (name === 'TerminateInstances') effect = 'change';
  } else if (finding.ruleId === 'detached-ebs') {
    if (name === 'AttachVolume') effect = 'active';
    // A detach request is not proof that ALL multi-attach connections were removed.
    else if (name === 'DetachVolume' || name === 'CreateVolume') effect = 'idle';
    else if (name === 'DeleteVolume') effect = 'change';
  } else if (finding.ruleId === 'empty-target-group') {
    if (name === 'RegisterTargets') effect = 'active';
    else if (['DeregisterTargets', 'CreateTargetGroup', 'DeleteTargetGroup'].includes(name)) effect = 'change';
  } else if (['UpdateDistribution', 'CreateDistribution', 'CreateDistributionWithTags'].includes(name)) {
    const config = raw.requestParameters?.distributionConfig as Record<string, unknown> | undefined;
    if (config?.enabled === true || config?.Enabled === true) effect = 'active';
    else if (config?.enabled === false || config?.Enabled === false) effect = 'idle';
    else effect = 'change';
  } else if (name === 'DeleteDistribution') effect = 'change';
  // Unknown writes may affect state. Retain their safe name, but do not infer idle duration.
  if (!effect && !/^(Get|List|Describe|Lookup|Head)/.test(name)) effect = 'change';
  if (!effect) return {};
  const identity = raw.userIdentity;
  const label = [identity?.arn, identity?.userName, identity?.invokedBy].find(v => typeof v === 'string' && v.length > 0 && v.length <= 2048);
  const actor = typeof label === 'string' ? { type: typeof identity?.type === 'string' ? identity.type.slice(0,80) : 'Unknown', label } : undefined;
  return { event: { actor, id: event.EventId ?? `${name}:${event.EventTime.toISOString()}`, time: event.EventTime.toISOString(), name, effect } };
}

export function summarizeHistory(base: Omit<CleanupHistory, 'duration' | 'verdict' | 'messages'>, finding: CleanupFinding): CleanupHistory {
  const events = [...base.events].sort((a,b) => Date.parse(b.time)-Date.parse(a.time));
  const snapshot = Date.parse(base.graphCollectedAt), start = Date.parse(base.start);
  const messages = ['CloudTrail 관리 이벤트 기준입니다. 애플리케이션 로그·데이터 접근·전체 사용량은 확인하지 않았습니다.', 'API 성공 기록 시각은 실제 상태 전환 완료 시각과 다를 수 있습니다.'];
  const result: CleanupHistory = { ...base, events, duration: { basis: 'unknown' }, verdict: 'insufficient', messages };
  if (base.coverage !== 'complete') { messages.push('조회 실패·상한·해석 불가로 기간 전체를 평가하지 못했습니다.'); return result; }
  if (events.some(e=>Date.parse(e.time)>snapshot)) { messages.push('구성 수집 후 변경 기록이 있습니다. 구성을 다시 수집하세요.'); return result; }
  const latest = events.find(e=>e.effect!=='metadata');
  if (latest?.effect === 'idle' && finding.ruleId !== 'empty-target-group') {
    // Display the event age, explicitly not a measured continuous idle interval.
    result.duration = { basis: 'event', since: latest.time, seconds: Math.max(0, (snapshot-Date.parse(latest.time))/1000) };
  }
  if (events.some(e=>Date.parse(e.time)>=start && e.effect==='active')) {
    result.verdict='recent'; messages.push('최근 30일 안에 기동·연결·등록·활성화 기록이 있어 정리 후보에서 제외합니다.'); return result;
  }
  if (!latest) messages.push('조회된 변경 기록이 없습니다. 로그 부재는 30일 미사용의 증거가 아닙니다.');
  else if (finding.ruleId === 'empty-target-group') messages.push('등록 해제 기록만으로 대상 전체가 0개가 된 시점을 확정할 수 없습니다.');
  else if (latest.effect !== 'idle') messages.push('현재 상태의 시작 시점을 뒷받침하는 기록이 없습니다.');
  else if (Date.parse(latest.time)>=start) { result.verdict='recent'; messages.push('상태 변경 기록 후 30일이 지나지 않았습니다.'); }
  else {
    // EBS multi-attach history cannot determine final detach from a single event.
    if (finding.ruleId === 'detached-ebs' && finding.fact.ruleId === 'detached-ebs' && finding.fact.multiAttach !== false) {
      messages.push('Multi-Attach 여부가 미확인이거나 사용 중이므로 마지막 분리 시점을 확정하지 않습니다.');
    } else { result.verdict='review'; messages.push('30일 이전의 상태 변경 기록과 현재 상태가 일치하고, 조회된 이후 이력에 재사용 기록이 없습니다. 정리 검토 근거이며 삭제 안전성 보장은 아닙니다.'); }
  }
  return result;
}

// All sessions in this process share a per-account/per-region queue. Avoid a second profile bypassing the service limit.
const queues = new Map<string, Promise<void>>();
async function throttled<T>(key: string, fn:()=>Promise<T>): Promise<T> {
  const previous=queues.get(key)??Promise.resolve();
  let release!:()=>void;
  const next=new Promise<void>(resolve=>{release=resolve}); queues.set(key,next);
  await previous;
  try { return await fn(); } finally {
    await new Promise(resolve=>setTimeout(resolve,600)); release();
    if(queues.get(key)===next)queues.delete(key);
  }
}
export async function lookupCleanupHistory(clients: Pick<ClientFactory,'get'>, scope: CleanupSnapshot['scope'], node: ResourceNode, finding: CleanupFinding, graphCollectedAt: string, now = Date.now()): Promise<CleanupHistory> {
  const region = node.type==='cloudfront' ? 'us-east-1' : scope.region;
  const end = new Date(now).toISOString(), start = new Date(now-30*DAY).toISOString(), lookbackStart=new Date(now-90*DAY+60000).toISOString();
  const events = new Map<string,CleanupHistoryEvent>();
  let coverage: CleanupHistory['coverage']='complete', pages=0, token:string|undefined;
  const client=clients.get(CloudTrailClient,region);
  try {
    do {
      const res=await throttled(`${scope.account}:${region}`,()=>client.send(new LookupEventsCommand({LookupAttributes:[{AttributeKey:'ResourceName',AttributeValue:node.nativeId}],StartTime:new Date(lookbackStart),EndTime:new Date(end),MaxResults:50,NextToken:token})));
      pages++;
      for(const event of res.Events??[]){const parsed=parseHistoryEvent(event,node,finding);if(parsed.malformed)coverage='partial';if(parsed.event && Date.parse(parsed.event.time)>=Date.parse(lookbackStart) && Date.parse(parsed.event.time)<=now)events.set(parsed.event.id,parsed.event);}
      token=res.NextToken;
      if(token&&pages>=MAX_HISTORY_PAGES){coverage='partial';break;}
    } while(token);
  } catch { coverage='error'; }
  return summarizeHistory({scope:{...scope},findingId:finding.id,graphCollectedAt,analyzedAt:end,start,end,lookbackStart,region,coverage,pages,events:[...events.values()]},finding);
}
