/**
 * RDS instances and Aurora clusters.
 *   instance → subnet matching its AZ (containment), instance → sg (attached),
 *   cluster → instance (member), KMS keys via refs.
 */
import { RDSClient, paginateDescribeDBClusters, paginateDescribeDBInstances, type DBInstance } from '@aws-sdk/client-rds';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, iso, nid, statusFromState, tagsToRecord } from './ids.ts';
import { collect, errMsg } from './util.ts';

function instanceParent(i: DBInstance): string | undefined {
  const group = i.DBSubnetGroup;
  const subnet = group?.Subnets?.find((s) => s.SubnetAvailabilityZone?.Name === i.AvailabilityZone && s.SubnetIdentifier);
  if (subnet?.SubnetIdentifier) return nid('subnet', subnet.SubnetIdentifier);
  return group?.VpcId ? nid('vpc', group.VpcId) : undefined;
}

async function run(ctx: CollectorContext) {
  const rds = ctx.clients.get(RDSClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [instances, clusters] = await Promise.all([
    collect(paginateDescribeDBInstances({ client: rds }, {}), (p) => p.DBInstances),
    collect(paginateDescribeDBClusters({ client: rds }, {}), (p) => p.DBClusters).catch((err) => {
      ctx.log(`[rds] DescribeDBClusters 실패: ${errMsg(err)}`);
      return [];
    }),
  ]);

  const vpcByCluster = new Map<string, string>();
  for (const i of instances) {
    if (!i.DBInstanceIdentifier) continue;
    const id = i.DBInstanceIdentifier;
    if (i.DBClusterIdentifier && i.DBSubnetGroup?.VpcId) vpcByCluster.set(i.DBClusterIdentifier, i.DBSubnetGroup.VpcId);
    const refs = [i.KmsKeyId, i.MasterUserSecret?.SecretArn, i.MonitoringRoleArn].filter((r): r is string => Boolean(r));
    nodes.push({
      id: nid('rds-instance', id),
      type: 'rds-instance',
      category: 'database',
      name: id,
      nativeId: id,
      arn: i.DBInstanceArn,
      region: ctx.region,
      parentId: instanceParent(i),
      az: i.AvailabilityZone,
      status: statusFromState(i.DBInstanceStatus),
      statusLabel: i.DBInstanceStatus,
      props: {
        엔진: i.Engine ?? null,
        버전: i.EngineVersion ?? null,
        클래스: i.DBInstanceClass ?? null,
        상태: i.DBInstanceStatus ?? null,
        '다중 AZ': Boolean(i.MultiAZ),
        스토리지: i.AllocatedStorage != null ? `${i.AllocatedStorage} GiB${i.StorageType ? ` (${i.StorageType})` : ''}` : null,
        엔드포인트: i.Endpoint?.Address ?? null,
        포트: i.Endpoint?.Port ?? null,
        '퍼블릭 접근': Boolean(i.PubliclyAccessible),
        암호화: Boolean(i.StorageEncrypted),
        클러스터: i.DBClusterIdentifier ?? null,
        생성: iso(i.InstanceCreateTime),
      },
      tags: tagsToRecord(i.TagList),
      refs,
    });
    for (const sg of i.VpcSecurityGroups ?? []) {
      if (sg.VpcSecurityGroupId) edges.push(edge('attached', nid('rds-instance', id), nid('security-group', sg.VpcSecurityGroupId)));
    }
  }

  for (const c of clusters) {
    if (!c.DBClusterIdentifier) continue;
    const id = c.DBClusterIdentifier;
    const members = c.DBClusterMembers ?? [];
    const vpcId = vpcByCluster.get(id);
    const serverless = Boolean(c.ServerlessV2ScalingConfiguration) || c.EngineMode === 'serverless';
    const refs = [c.KmsKeyId, c.MasterUserSecret?.SecretArn, c.MonitoringRoleArn, ...(c.AssociatedRoles ?? []).map((r) => r.RoleArn)].filter(
      (r): r is string => Boolean(r),
    );
    nodes.push({
      id: nid('rds-cluster', id),
      type: 'rds-cluster',
      category: 'database',
      name: id,
      nativeId: id,
      arn: c.DBClusterArn,
      region: ctx.region,
      parentId: vpcId ? nid('vpc', vpcId) : undefined,
      status: statusFromState(c.Status),
      statusLabel: c.Status,
      props: {
        엔진: c.Engine ?? null,
        버전: c.EngineVersion ?? null,
        상태: c.Status ?? null,
        엔드포인트: c.Endpoint ?? null,
        '리더 엔드포인트': c.ReaderEndpoint ?? null,
        '멤버 수': members.length,
        서버리스: serverless,
        '엔진 모드': c.EngineMode ?? null,
        포트: c.Port ?? null,
        '다중 AZ': Boolean(c.MultiAZ),
        암호화: Boolean(c.StorageEncrypted),
        생성: iso(c.ClusterCreateTime),
      },
      tags: tagsToRecord(c.TagList),
      refs,
    });
    for (const m of members) {
      if (!m.DBInstanceIdentifier) continue;
      edges.push(edge('member', nid('rds-cluster', id), nid('rds-instance', m.DBInstanceIdentifier), { label: m.IsClusterWriter ? 'writer' : 'reader' }));
    }
    for (const sg of c.VpcSecurityGroups ?? []) {
      if (sg.VpcSecurityGroupId) edges.push(edge('attached', nid('rds-cluster', id), nid('security-group', sg.VpcSecurityGroupId)));
    }
  }

  return { nodes, edges };
}

export const rdsCollector: Collector = { name: 'rds', label: 'RDS·Aurora', run };
