/**
 * ElastiCache: one node per replication group (Redis/Valkey) and one per
 * stand-alone cache cluster (Memcached or ungrouped Redis).
 *   node → subnet of its AZ when single-AZ, else vpc (containment); node → sg (attached)
 */
import {
  ElastiCacheClient,
  ListTagsForResourceCommand,
  paginateDescribeCacheClusters,
  paginateDescribeCacheSubnetGroups,
  paginateDescribeReplicationGroups,
  type CacheCluster,
  type CacheSubnetGroup,
} from '@aws-sdk/client-elasticache';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, edge, iso, nid, statusFromState, tagsToRecord } from './ids.ts';
import { attempt, collect, errMsg } from './util.ts';

function placement(azs: string[], group?: CacheSubnetGroup): { parentId?: string; az?: string } {
  const unique = [...new Set(azs.filter(Boolean))];
  if (unique.length === 1) {
    const candidates = group?.Subnets?.filter((s) => s.SubnetAvailabilityZone?.Name === unique[0] && s.SubnetIdentifier) ?? [];
    if (candidates.length === 1) return { parentId: nid('subnet', candidates[0].SubnetIdentifier!), az: unique[0] };
  }
  return { parentId: group?.VpcId ? nid('vpc', group.VpcId) : undefined, az: unique.length === 1 ? unique[0] : undefined };
}

async function run(ctx: CollectorContext) {
  const ec = ctx.clients.get(ElastiCacheClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [groups, clusters, subnetGroups] = await Promise.all([
    collect(paginateDescribeReplicationGroups({ client: ec }, {}), (p) => p.ReplicationGroups),
    collect(paginateDescribeCacheClusters({ client: ec }, { ShowCacheNodeInfo: true }), (p) => p.CacheClusters),
    collect(paginateDescribeCacheSubnetGroups({ client: ec }, {}), (p) => p.CacheSubnetGroups).catch((err) => {
      ctx.log(`[elasticache] DescribeCacheSubnetGroups 실패: ${errMsg(err)}`);
      return [];
    }),
  ]);
  const subnetGroupByName = new Map(subnetGroups.map((g) => [g.CacheSubnetGroupName ?? '', g]));
  const tagsByArn = new Map<string, Record<string, string> | undefined>();
  const taggable = [...groups.map((g) => g.ARN), ...clusters.filter((c) => !c.ReplicationGroupId).map((c) => c.ARN)].filter((a): a is string => Boolean(a));
  await Promise.all(
    taggable.map(async (arn) => {
      const res = await attempt(ctx, `elasticache tags ${arnName(arn)}`, () => ec.send(new ListTagsForResourceCommand({ ResourceName: arn })));
      tagsByArn.set(arn, tagsToRecord(res?.TagList));
    }),
  );
  const clustersByGroup = new Map<string, CacheCluster[]>();
  for (const c of clusters) {
    if (!c.ReplicationGroupId) continue;
    const list = clustersByGroup.get(c.ReplicationGroupId) ?? [];
    list.push(c);
    clustersByGroup.set(c.ReplicationGroupId, list);
  }

  for (const g of groups) {
    if (!g.ReplicationGroupId) continue;
    const id = g.ReplicationGroupId;
    const members = clustersByGroup.get(id) ?? [];
    const first = members[0];
    const nodeAzs = members.flatMap((m) => (m.CacheNodes ?? []).map((n) => n.CustomerAvailabilityZone ?? m.PreferredAvailabilityZone ?? ''));
    const { parentId, az } = placement(nodeAzs, first?.CacheSubnetGroupName ? subnetGroupByName.get(first.CacheSubnetGroupName) : undefined);
    const nodeCount = members.length ? members.reduce((n, m) => n + (m.NumCacheNodes ?? 0), 0) : (g.MemberClusters?.length ?? 0);
    const primary = g.NodeGroups?.[0]?.PrimaryEndpoint?.Address ?? g.ConfigurationEndpoint?.Address ?? null;
    nodes.push({
      id: nid('elasticache', id),
      type: 'elasticache',
      category: 'database',
      name: id,
      nativeId: id,
      arn: g.ARN,
      region: ctx.region,
      parentId,
      az,
      status: statusFromState(g.Status),
      statusLabel: g.Status,
      props: {
        엔진: g.Engine ?? first?.Engine ?? null,
        버전: first?.EngineVersion ?? null,
        '노드 유형': g.CacheNodeType ?? first?.CacheNodeType ?? null,
        '노드 수': nodeCount,
        상태: g.Status ?? null,
        '다중 AZ': g.MultiAZ ?? null,
        '자동 장애 조치': g.AutomaticFailover ?? null,
        엔드포인트: primary,
        포트: g.NodeGroups?.[0]?.PrimaryEndpoint?.Port ?? g.ConfigurationEndpoint?.Port ?? null,
        '클러스터 모드': Boolean(g.ClusterEnabled),
        '전송 암호화': Boolean(g.TransitEncryptionEnabled),
        노드: (g.MemberClusters ?? []).join(', ') || null,
        설명: g.Description ?? null,
        _cacheClusterId: g.MemberClusters?.[0] ?? first?.CacheClusterId ?? null,
      },
      tags: g.ARN ? tagsByArn.get(g.ARN) : undefined,
      refs: g.KmsKeyId ? [g.KmsKeyId] : undefined,
    });
    const sgs = new Set((first?.SecurityGroups ?? []).map((s) => s.SecurityGroupId).filter((s): s is string => Boolean(s)));
    for (const sg of sgs) edges.push(edge('attached', nid('elasticache', id), nid('security-group', sg)));
  }

  for (const c of clusters) {
    if (!c.CacheClusterId || c.ReplicationGroupId) continue;
    const id = c.CacheClusterId;
    const nodeAzs = (c.CacheNodes ?? []).map((n) => n.CustomerAvailabilityZone ?? c.PreferredAvailabilityZone ?? '');
    const { parentId, az } = placement(nodeAzs.length ? nodeAzs : [c.PreferredAvailabilityZone ?? ''], c.CacheSubnetGroupName ? subnetGroupByName.get(c.CacheSubnetGroupName) : undefined);
    nodes.push({
      id: nid('elasticache', id),
      type: 'elasticache',
      category: 'database',
      name: id,
      nativeId: id,
      arn: c.ARN,
      region: ctx.region,
      parentId,
      az,
      status: statusFromState(c.CacheClusterStatus),
      statusLabel: c.CacheClusterStatus,
      props: {
        엔진: c.Engine ?? null,
        버전: c.EngineVersion ?? null,
        '노드 유형': c.CacheNodeType ?? null,
        '노드 수': c.NumCacheNodes ?? 0,
        상태: c.CacheClusterStatus ?? null,
        엔드포인트: c.ConfigurationEndpoint?.Address ?? c.CacheNodes?.[0]?.Endpoint?.Address ?? null,
        포트: c.ConfigurationEndpoint?.Port ?? c.CacheNodes?.[0]?.Endpoint?.Port ?? null,
        '전송 암호화': Boolean(c.TransitEncryptionEnabled),
        생성: iso(c.CacheClusterCreateTime),
        _cacheClusterId: id,
      },
      tags: c.ARN ? tagsByArn.get(c.ARN) : undefined,
    });
    for (const sg of c.SecurityGroups ?? []) {
      if (sg.SecurityGroupId) edges.push(edge('attached', nid('elasticache', id), nid('security-group', sg.SecurityGroupId)));
    }
  }

  return { nodes, edges };
}

export const elasticacheCollector: Collector = { name: 'elasticache', label: 'ElastiCache', run };
