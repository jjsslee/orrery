/**
 * EFS file systems. Mount targets become edges (efs → subnet, 'mounts') and
 * their security groups become attached edges.
 */
import { EFSClient, DescribeMountTargetSecurityGroupsCommand, paginateDescribeFileSystems, paginateDescribeMountTargets } from '@aws-sdk/client-efs';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, fmtBytes, iso, nameFromTags, nid, statusFromState, tagsToRecord } from './ids.ts';
import { attempt, collect } from './util.ts';

async function run(ctx: CollectorContext) {
  const efs = ctx.clients.get(EFSClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const systems = await collect(paginateDescribeFileSystems({ client: efs }, {}), (p) => p.FileSystems);
  await Promise.all(
    systems.map(async (fs) => {
      if (!fs.FileSystemId) return;
      const id = fs.FileSystemId;
      const tags = tagsToRecord(fs.Tags);
      const targetsResult = await attempt(ctx, `efs mount targets ${id}`, () => collect(paginateDescribeMountTargets({ client: efs }, { FileSystemId: id }), (p) => p.MountTargets));
      const targets = targetsResult ?? [];
      const sgs = new Set<string>();
      await Promise.all(
        targets.map(async (mt) => {
          if (!mt.MountTargetId) return;
          const res = await attempt(ctx, `efs mount target sgs ${mt.MountTargetId}`, () => efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: mt.MountTargetId })));
          for (const sg of res?.SecurityGroups ?? []) sgs.add(sg);
        }),
      );
      const vpcId = targets.map((t) => t.VpcId).find(Boolean);
      nodes.push({
        id: nid('efs', id),
        type: 'efs',
        category: 'storage',
        name: fs.Name ?? nameFromTags(tags, id),
        nativeId: id,
        arn: fs.FileSystemArn,
        region: ctx.region,
        parentId: vpcId ? nid('vpc', vpcId) : undefined,
        status: statusFromState(fs.LifeCycleState),
        statusLabel: fs.LifeCycleState,
        props: {
          '배치 근거': !targetsResult ? '위치 미확인 · 마운트 타깃 조회 실패' : targets.length ? '마운트 타깃의 VPC 연결 · 파일 시스템은 리전 자원' : '마운트 타깃 없음',
          이름: fs.Name ?? null,
          상태: fs.LifeCycleState ?? null,
          크기: fmtBytes(fs.SizeInBytes?.Value),
          '성능 모드': fs.PerformanceMode ?? null,
          '처리량 모드': fs.ThroughputMode ?? null,
          암호화: Boolean(fs.Encrypted),
          '마운트 타깃': fs.NumberOfMountTargets ?? targets.length,
          '단일 AZ': fs.AvailabilityZoneName ?? null,
          생성: iso(fs.CreationTime),
        },
        tags,
        refs: fs.KmsKeyId ? [fs.KmsKeyId] : undefined,
      });
      for (const mt of targets) {
        if (mt.SubnetId) edges.push(edge('mounts', nid('efs', id), nid('subnet', mt.SubnetId), { label: mt.AvailabilityZoneName, status: statusFromState(mt.LifeCycleState) }));
      }
      for (const sg of sgs) edges.push(edge('attached', nid('efs', id), nid('security-group', sg)));
    }),
  );

  return { nodes, edges };
}

export const efsCollector: Collector = { name: 'efs', label: 'EFS', run };
