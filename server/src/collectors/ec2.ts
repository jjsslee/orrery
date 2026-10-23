/**
 * EC2 instances, Auto Scaling groups and detached EBS volumes.
 *   instance → subnet (containment), instance → security group (attached),
 *   instance → IAM role (assumes), ASG → instance (member)
 * Attached volumes are summarised on their instance; only volumes with no
 * attachment become ebs-volume nodes (idle storage that still bills).
 */
import {
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeInstanceStatus,
  paginateDescribeVolumes,
  type Instance,
  type Volume,
} from '@aws-sdk/client-ec2';
import { AutoScalingClient, paginateDescribeAutoScalingGroups } from '@aws-sdk/client-auto-scaling';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, iso, nameFromTags, nid, statusFromState, tagsToRecord } from './ids.ts';
import { collect, errMsg, roleNameFromArn } from './util.ts';

interface VolumeSummary { count: number; gib: number; types: Set<string>; encrypted: number }

export function splitVolumes(volumes: Volume[]): { byInstance: Map<string, VolumeSummary>; detached: Volume[] } {
  const byInstance = new Map<string, VolumeSummary>();
  const detached: Volume[] = [];
  for (const v of volumes) {
    if (!v.Attachments?.length) {
      detached.push(v);
      continue;
    }
    for (const a of v.Attachments) {
      if (!a.InstanceId || a.State !== 'attached') continue;
      const cur = byInstance.get(a.InstanceId) ?? { count: 0, gib: 0, types: new Set<string>(), encrypted: 0 };
      cur.count += 1;
      cur.gib += v.Size ?? 0;
      if (v.VolumeType) cur.types.add(v.VolumeType);
      if (v.Encrypted) cur.encrypted += 1;
      byInstance.set(a.InstanceId, cur);
    }
  }
  return { byInstance, detached };
}

/** "2개, 100 GiB (gp3, 암호화)" */
export function volumeLabel(s: VolumeSummary): string {
  const enc = s.encrypted === s.count ? '암호화' : s.encrypted === 0 ? '미암호화' : `암호화 ${s.encrypted}/${s.count}`;
  return `${s.count}개, ${s.gib} GiB (${[...s.types].sort().concat(enc).join(', ')})`;
}

export function volumeNode(id: string, v: Volume, region: string, account: string): ResourceNode {
  const tags = tagsToRecord(v.Tags);
  const state = v.State ?? 'unknown';
  return {
    id: nid('ebs-volume', id),
    type: 'ebs-volume',
    category: 'storage',
    name: nameFromTags(tags, id),
    nativeId: id,
    arn: `arn:aws:ec2:${region}:${account}:volume/${id}`,
    region,
    az: v.AvailabilityZone,
    // A detached volume is idle, not broken: read it like an unused load balancer.
    status: state === 'available' ? 'inactive' : statusFromState(state),
    statusLabel: state === 'available' ? '미연결' : state,
    props: {
      상태: state,
      크기: v.Size != null ? `${v.Size} GiB` : null,
      '볼륨 유형': v.VolumeType ?? null,
      IOPS: v.Iops ?? null,
      처리량: v.Throughput != null ? `${v.Throughput} MiB/s` : null,
      가용영역: v.AvailabilityZone ?? null,
      암호화: Boolean(v.Encrypted),
      '원본 스냅샷': v.SnapshotId || null,
      생성: iso(v.CreateTime),
    },
    tags,
    refs: v.KmsKeyId ? [v.KmsKeyId] : undefined,
  };
}

async function run(ctx: CollectorContext) {
  const ec2 = ctx.clients.get(EC2Client);
  const asgClient = ctx.clients.get(AutoScalingClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const reservations = await collect(paginateDescribeInstances({ client: ec2 }, {}), (p) => p.Reservations);
  const instances: Instance[] = reservations.flatMap((r) => r.Instances ?? []).filter((i) => i.State?.Name !== 'terminated');

  // Secondary signals are best-effort: a failure here must not hide the instances.
  const [statuses, volumes, asgs] = await Promise.all([
    collect(paginateDescribeInstanceStatus({ client: ec2 }, { IncludeAllInstances: false }), (p) => p.InstanceStatuses).catch((err) => {
      ctx.log(`[ec2] DescribeInstanceStatus 실패: ${errMsg(err)}`);
      return [];
    }),
    collect(paginateDescribeVolumes({ client: ec2 }, {}), (p) => p.Volumes).catch((err) => {
      ctx.log(`[ec2] DescribeVolumes 실패: ${errMsg(err)}`);
      return [];
    }),
    collect(paginateDescribeAutoScalingGroups({ client: asgClient }, {}), (p) => p.AutoScalingGroups).catch((err) => {
      ctx.log(`[ec2] DescribeAutoScalingGroups 실패: ${errMsg(err)}`);
      return [];
    }),
  ]);

  const health = new Map<string, { instance?: string; system?: string }>();
  for (const s of statuses) if (s.InstanceId) health.set(s.InstanceId, { instance: s.InstanceStatus?.Status, system: s.SystemStatus?.Status });

  const { byInstance: volumesByInstance, detached } = splitVolumes(volumes);
  for (const v of detached) if (v.VolumeId) nodes.push(volumeNode(v.VolumeId, v, ctx.region, ctx.account));

  const vpcByInstance = new Map<string, string>();
  for (const i of instances) {
    if (!i.InstanceId) continue;
    const id = i.InstanceId;
    if (i.VpcId) vpcByInstance.set(id, i.VpcId);
    const tags = tagsToRecord(i.Tags);
    const state = i.State?.Name ?? 'unknown';
    const h = health.get(id);
    let status: Status = statusFromState(state);
    let statusLabel = state;
    if (state === 'running' && h && (h.instance === 'impaired' || h.system === 'impaired')) {
      status = 'critical';
      statusLabel = 'impaired';
    } else if (state === 'running' && h && (h.instance === 'initializing' || h.system === 'initializing')) {
      status = 'warning';
      statusLabel = 'initializing';
    }
    const vol = volumesByInstance.get(id);
    const profileName = roleNameFromArn(i.IamInstanceProfile?.Arn);
    nodes.push({
      id: nid('ec2-instance', id),
      type: 'ec2-instance',
      category: 'compute',
      name: nameFromTags(tags, id),
      nativeId: id,
      arn: `arn:aws:ec2:${ctx.region}:${ctx.account}:instance/${id}`,
      region: ctx.region,
      parentId: i.SubnetId ? nid('subnet', i.SubnetId) : i.VpcId ? nid('vpc', i.VpcId) : undefined,
      az: i.Placement?.AvailabilityZone,
      status,
      statusLabel,
      props: {
        '인스턴스 유형': i.InstanceType ?? null,
        상태: state,
        '프라이빗 IP': i.PrivateIpAddress ?? null,
        '퍼블릭 IP': i.PublicIpAddress ?? null,
        가용영역: i.Placement?.AvailabilityZone ?? null,
        AMI: i.ImageId ?? null,
        플랫폼: i.PlatformDetails ?? i.Platform ?? null,
        '시작 시각': iso(i.LaunchTime),
        볼륨: vol ? volumeLabel(vol) : null,
        'IAM 프로파일': profileName ?? null,
        '상태 검사': h ? `${h.system ?? '-'} / ${h.instance ?? '-'}` : null,
        아키텍처: i.Architecture ?? null,
      },
      tags,
    });
    for (const sg of i.SecurityGroups ?? []) {
      if (sg.GroupId) edges.push(edge('attached', nid('ec2-instance', id), nid('security-group', sg.GroupId)));
    }
    if (profileName) edges.push(edge('assumes', nid('ec2-instance', id), nid('iam-role', profileName)));
  }

  for (const g of asgs) {
    if (!g.AutoScalingGroupName) continue;
    const name = g.AutoScalingGroupName;
    const members = g.Instances ?? [];
    const inService = members.filter((m) => m.LifecycleState === 'InService').length;
    const desired = g.DesiredCapacity ?? 0;
    const vpcId = members.map((m) => (m.InstanceId ? vpcByInstance.get(m.InstanceId) : undefined)).find(Boolean);
    const template =
      g.LaunchTemplate?.LaunchTemplateName ??
      g.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification?.LaunchTemplateName ??
      g.LaunchConfigurationName ??
      null;
    const tags = tagsToRecord(g.Tags);
    const status: Status = g.Status ? 'warning' : desired === inService ? 'healthy' : 'warning';
    nodes.push({
      id: nid('autoscaling-group', name),
      type: 'autoscaling-group',
      category: 'compute',
      name,
      nativeId: name,
      arn: g.AutoScalingGroupARN,
      region: ctx.region,
      parentId: vpcId ? nid('vpc', vpcId) : undefined,
      status,
      statusLabel: g.Status ?? `${inService}/${desired} InService`,
      props: {
        '최소/희망/최대': `${g.MinSize ?? 0} / ${desired} / ${g.MaxSize ?? 0}`,
        '현재 인스턴스': members.length,
        '서비스 중': inService,
        '시작 템플릿': template,
        가용영역: (g.AvailabilityZones ?? []).join(', ') || null,
        '타깃 그룹': g.TargetGroupARNs?.length ?? 0,
        '헬스체크 유형': g.HealthCheckType ?? null,
        생성: iso(g.CreatedTime),
      },
      tags,
    });
    for (const m of members) {
      if (!m.InstanceId) continue;
      const mStatus: Status = m.LifecycleState === 'InService' ? (m.HealthStatus === 'Healthy' ? 'healthy' : 'warning') : 'warning';
      edges.push(edge('member', nid('autoscaling-group', name), nid('ec2-instance', m.InstanceId), { label: m.LifecycleState, status: mStatus }));
    }
  }

  return { nodes, edges };
}

export const ec2Collector: Collector = { name: 'ec2', label: 'EC2·오토스케일링·EBS', run };
