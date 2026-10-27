import type { CleanupHistory, CleanupRule, CleanupSnapshot, ResourceGraph, ResourceNode } from '@orrery/shared';
export const CLEANUP_RULES: Record<CleanupRule,{label:string;condition:string;limitation:string}> = {
 'detached-ebs':{label:'미연결 EBS',condition:'available · 연결된 인스턴스 0개',limitation:'데이터 보존 필요성·백업 용도는 미확인입니다. 분리 API 기록은 실제 분리 완료 시각과 다를 수 있습니다.'},
 'empty-target-group':{label:'빈 Target Group',condition:'등록된 대상 0개',limitation:'등록 해제 기록으로 전체 대상이 0개가 된 시점을 알 수 없습니다. 연결된 서비스·배포 대기 여부를 확인하세요.'},
 'stopped-ec2':{label:'중지 EC2',condition:'stopped',limitation:'예약 기동·재해복구 용도는 미확인입니다. 중지 API 기록은 실제 중지 완료 시각과 다를 수 있습니다.'},
 'disabled-cloudfront':{label:'비활성 CloudFront',condition:'Enabled=false · 글로벌',limitation:'예비 배포일 수 있습니다. 비활성 설정 요청 시각과 edge 반영 완료 시각은 다를 수 있습니다.'},
};
export const cleanupScopeKey=(scope:CleanupSnapshot['scope'])=>JSON.stringify([scope.source,scope.account,scope.region]);
export function validCleanup(graph:ResourceGraph){return graph.cleanup?.schemaVersion===1&&cleanupScopeKey(graph.cleanup.scope)===cleanupScopeKey(graph)?graph.cleanup:undefined}
export function historyMatches(graph:ResourceGraph,findingId:string,result:CleanupHistory){return result.findingId===findingId&&result.graphCollectedAt===graph.collectedAt&&cleanupScopeKey(result.scope)===cleanupScopeKey(graph)}
export function durationLabel(history?:CleanupHistory):string{
 if(!history)return '이력 분석 전';
 const seconds=history.duration.seconds;
 if(history.duration.basis!=='event'||seconds===undefined||!Number.isFinite(seconds)||seconds<0)return '지속 기간 확인 불가';
 const hours=Math.floor(seconds/3600),days=Math.floor(hours/24);
 return days?`${days}일 ${hours%24}시간` : hours?`${hours}시간`:'1시간 미만';
}
export const VERDICT_LABEL={review:'정리 검토 후보',recent:'최근 활동·변경',insufficient:'근거 부족'} as const;
export function cleanupConsoleUrl(node:ResourceNode):string|undefined{
 const partition=node.arn?.split(':')[1]??'aws';
 if(!['aws','aws-cn','aws-us-gov'].includes(partition)||!/^[a-z]{2}(-[a-z]+)+-\d$/.test(node.region)&&node.region!=='global')return undefined;
 const host=partition==='aws-cn'?'console.amazonaws.cn':partition==='aws-us-gov'?'console.amazonaws-us-gov.com':'console.aws.amazon.com';
 const region=encodeURIComponent(node.region),id=encodeURIComponent(node.nativeId);
 if(node.type==='cloudfront')return partition==='aws'?`https://${host}/cloudfront/v4/home#/distributions/${id}`:undefined;
 const root=`https://${host}/ec2/home?region=${region}`;
 if(node.type==='ec2-instance')return `${root}#InstanceDetails:instanceId=${id}`;
 if(node.type==='ebs-volume')return `${root}#VolumeDetails:volumeId=${id}`;
 if(node.type==='target-group')return `${root}#TargetGroup:targetGroupArn=${id}`;
 return undefined;
}

/** Summaries describe only the queried management-event window, never lifetime usage. */
export function latestHistory(history:CleanupHistory){
 const events=[...history.events].sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
 return {events,management:events[0],activity:events.find(e=>e.effect==='active'),state:history.duration.basis==='event'?events.find(e=>e.effect==='idle'&&e.time===history.duration.since):undefined};
}
