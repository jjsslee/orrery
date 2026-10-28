import { OpenSearchServerlessClient, BatchGetVpcEndpointCommand, GetSecurityPolicyCommand, GetAccessPolicyCommand, paginateListSecurityPolicies, paginateListAccessPolicies, paginateListVpcEndpoints } from '@aws-sdk/client-opensearchserverless';
import type { ResourceNode, ResourceEdge } from '@orrery/shared';
import type { CollectorContext } from './types.ts';
import { attempt, collect, chunk } from './util.ts';
import { nid, edge, statusFromState } from './ids.ts';
import { matchesCollection } from './relationships.ts';

// AWS document values are validated before use; policy content is never executed.
type Rule = { ResourceType?: string; Resource?: string[]; Permission?: string[] };
type Policy = { Rules?: Rule[]; AllowFromPublic?: boolean; SourceVPCEs?: string[]; SourceServices?: string[]; Principal?: string[] };
function policies(value: unknown): Policy[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter(v => v && typeof v === 'object') : [];
}
export async function collectOpenSearchNetwork(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]): Promise<void> {
  const client = ctx.clients.get(OpenSearchServerlessClient);
  const collections = nodes.filter(n => n.type === 'opensearch-collection');
  const endpoints = await attempt(ctx, 'aoss endpoints', () => collect(paginateListVpcEndpoints({ client }, {}), p => p.vpcEndpointSummaries));
  for (const batch of chunk((endpoints ?? []).flatMap(e => e.id ? [e.id] : []), 100)) {
    const result = await attempt(ctx, 'aoss endpoint details', () => client.send(new BatchGetVpcEndpointCommand({ ids: batch })));
    if (result?.vpcEndpointErrorDetails?.length) ctx.log('[aoss endpoint details] 일부 상세 미확인');
    for (const summary of (endpoints ?? []).filter(e => e.id && batch.includes(e.id))) {
      const detail = result?.vpcEndpointDetails?.find(e => e.id === summary.id);
      const id = nid('vpc-endpoint', summary.id!);
      nodes.push({ id, nativeId: summary.id!, name: detail?.name ?? summary.name ?? summary.id!, type: 'vpc-endpoint', category: 'network', region: ctx.region, parentId: detail?.vpcId ? nid('vpc', detail.vpcId) : undefined,
        status: detail ? statusFromState(detail.status) : 'unknown', statusLabel: detail?.status ?? '상세 미확인', props: { 서비스: 'OpenSearch Serverless', '서브넷 목록': detail?.subnetIds?.join(', ') ?? null },
        relations: (detail?.subnetIds ?? []).map(s => ({ ref: nid('subnet', s), kind: 'attached', label: 'AOSS Endpoint 서브넷' })) });
      for (const sg of detail?.securityGroupIds ?? []) edges.push(edge('attached', id, nid('security-group', sg)));
    }
  }
  for (const type of ['network', 'data'] as const) {
    const summaries = type === 'network'
      ? await attempt(ctx, 'aoss network policies', () => collect(paginateListSecurityPolicies({ client }, { type: 'network' }), p => p.securityPolicySummaries))
      : await attempt(ctx, 'aoss data policies', () => collect(paginateListAccessPolicies({ client }, { type: 'data' }), p => p.accessPolicySummaries));
    for (const summary of summaries ?? []) {
      if (!summary.name) continue;
      const detail = await attempt(ctx, `aoss ${type} policy ${summary.name}`, async () => {
        const value = type === 'network' ? (await client.send(new GetSecurityPolicyCommand({ type: 'network', name: summary.name! }))).securityPolicyDetail?.policy
          : (await client.send(new GetAccessPolicyCommand({ type: 'data', name: summary.name! }))).accessPolicyDetail?.policy;
        if (value === undefined) throw new Error('정책 상세 응답 없음');
        return policies(value);
      });
      const policyId = nid('configuration-target', `aoss-${type}-policy:${summary.name}`);
      const policyNode: ResourceNode = { id: policyId, nativeId: summary.name, name: `${type === 'network' ? '네트워크' : '데이터 접근'} 정책 · ${summary.name}`, type: 'configuration-target', category: 'security', region: ctx.region, status: 'unknown', statusLabel: detail ? '정책 구성 확인 · 통신/권한 판정 아님' : '정책 상세 미확인', props: { '정책 유형': type, '정책 이름': summary.name, '정책 구성': detail ? JSON.stringify(detail) : null }, relations: [] };
      nodes.push(policyNode);
      for (const statement of detail ?? []) {
        for (const rule of statement.Rules ?? []) {
          for (const collection of collections) {
            const patterns = (rule.Resource ?? []).map(resource => resource.startsWith('index/') ? `collection/${resource.split('/')[1]}` : resource);
            if (!patterns.some(pattern => matchesCollection(pattern, collection.name))) continue;
            edges.push(edge('allows', policyId, collection.id, { label: `${rule.ResourceType ?? '?'} · ${rule.Resource?.join(', ')} · ${type === 'network' ? statement.AllowFromPublic ? 'public 허용 구성' : 'private 구성' : rule.Permission?.join(', ') ?? '?'}` }));
          }
        }
        for (const ep of statement.SourceVPCEs ?? []) policyNode.relations!.push({ ref: nid('vpc-endpoint', ep), kind: 'references', label: '네트워크 정책 SourceVPCE · 다른 정책의 public 허용과 함께 판단' });
        for (const service of statement.SourceServices ?? []) policyNode.relations!.push({ ref: service, kind: 'references', label: '네트워크 정책 SourceService' });
        for (const principal of statement.Principal ?? []) policyNode.relations!.push({ ref: principal, kind: 'references', label: '데이터 정책 Principal · IAM 전체 권한 판정 아님' });
      }
    }
  }
}
