/**
 * EKS clusters and their managed node groups.
 *   cluster → vpc (containment), cluster → sg (attached), cluster → IAM role (assumes)
 */
import { EKSClient, DescribeClusterCommand, DescribeNodegroupCommand, paginateListClusters, paginateListNodegroups, type Nodegroup } from '@aws-sdk/client-eks';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, edge, iso, nid, statusFromState } from './ids.ts';
import { attempt, collect, hostOf } from './util.ts';

async function run(ctx: CollectorContext) {
  const eks = ctx.clients.get(EKSClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const names = await collect(paginateListClusters({ client: eks }, {}), (p) => p.clusters);
  await Promise.all(
    names.map(async (name) => {
      const res = await attempt(ctx, `eks describe ${name}`, () => eks.send(new DescribeClusterCommand({ name })));
      const c = res?.cluster;
      if (!c?.name) return;
      const groupNames = (await attempt(ctx, `eks nodegroups ${name}`, () => collect(paginateListNodegroups({ client: eks }, { clusterName: name }), (p) => p.nodegroups))) ?? [];
      const groups: Nodegroup[] = [];
      await Promise.all(
        groupNames.map(async (ng) => {
          const r = await attempt(ctx, `eks nodegroup ${name}/${ng}`, () => eks.send(new DescribeNodegroupCommand({ clusterName: name, nodegroupName: ng })));
          if (r?.nodegroup) groups.push(r.nodegroup);
        }),
      );
      const vpc = c.resourcesVpcConfig;
      const sgs = new Set<string>([...(vpc?.securityGroupIds ?? []), ...(vpc?.clusterSecurityGroupId ? [vpc.clusterSecurityGroupId] : [])]);
      const desired = groups.reduce((n, g) => n + (g.scalingConfig?.desiredSize ?? 0), 0);
      const min = groups.reduce((n, g) => n + (g.scalingConfig?.minSize ?? 0), 0);
      const max = groups.reduce((n, g) => n + (g.scalingConfig?.maxSize ?? 0), 0);
      const unhealthyGroups = groups.filter((g) => g.status && g.status !== 'ACTIVE').length;
      const base = statusFromState(c.status);
      const refs = [c.roleArn, ...(c.encryptionConfig ?? []).map((e) => e.provider?.keyArn), ...groups.map((g) => g.nodeRole)].filter((r): r is string => Boolean(r));
      nodes.push({
        id: nid('eks-cluster', c.name),
        type: 'eks-cluster',
        category: 'compute',
        name: c.name,
        nativeId: c.name,
        arn: c.arn,
        region: ctx.region,
        parentId: vpc?.vpcId ? nid('vpc', vpc.vpcId) : undefined,
        status: base === 'healthy' && unhealthyGroups ? 'warning' : base,
        statusLabel: unhealthyGroups ? `노드 그룹 ${unhealthyGroups}개 비정상` : c.status,
        props: {
          상태: c.status ?? null,
          버전: c.version ?? null,
          엔드포인트: hostOf(c.endpoint) ?? null,
          '플랫폼 버전': c.platformVersion ?? null,
          '노드 그룹': groups.length ? groups.map((g) => `${g.nodegroupName} (${g.scalingConfig?.desiredSize ?? '-'})`).join(', ') : groupNames.length,
          '노드 수': groups.length ? `${desired} (${min}~${max})` : null,
          '인스턴스 유형': [...new Set(groups.flatMap((g) => g.instanceTypes ?? []))].join(', ') || null,
          서브넷: vpc?.subnetIds?.length ?? 0,
          '퍼블릭 엔드포인트': vpc?.endpointPublicAccess ?? null,
          '인증 모드': c.accessConfig?.authenticationMode ?? null,
          생성: iso(c.createdAt),
        },
        tags: c.tags && Object.keys(c.tags).length ? c.tags : undefined,
        refs,
      });
      for (const sg of sgs) edges.push(edge('attached', nid('eks-cluster', c.name), nid('security-group', sg)));
      if (c.roleArn) edges.push(edge('assumes', nid('eks-cluster', c.name), nid('iam-role', arnName(c.roleArn))));
    }),
  );

  return { nodes, edges };
}

export const eksCollector: Collector = { name: 'eks', label: 'EKS', run };
