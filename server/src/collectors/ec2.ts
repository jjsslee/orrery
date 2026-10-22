/**
 * EC2 instances and Auto Scaling groups.
 *   instance → subnet (containment), instance → security group (attached),
 *   instance → IAM role (assumes), ASG → instance (member)
 */
import {
  EC2Client,
  paginateDescribeInstances,
  paginateDescribeInstanceStatus,
  paginateDescribeVolumes,
  type Instance,
} from '@aws-sdk/client-ec2';
import { AutoScalingClient, paginateDescribeAutoScalingGroups } from '@aws-sdk/client-auto-scaling';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, iso, nameFromTags, nid, statusFromState, tagsToRecord } from './ids.ts';
import { collect, errMsg, roleNameFromArn } from './util.ts';

interface VolumeSummary { count: number; gib: number }

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
    collect(paginateDescribeVolumes({ client: ec2 }, { Filters: [{ Name: 'attachment.status', Values: ['attached'] }] }), (p) => p.Volumes).catch((err) => {
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

  const volumesByInstance = new Map<string, VolumeSummary>();
  for (const v of volumes) {
    for (const a of v.Attachments ?? []) {
      if (!a.InstanceId) continue;
      const cur = volumesByInstance.get(a.InstanceId) ?? { count: 0, gib: 0 };
      cur.count += 1;
      cur.gib += v.Size ?? 0;
      volumesByInstance.set(a.InstanceId, cur);
    }
  }

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
        볼륨: vol ? `${vol.count}개, ${vol.gib} GiB` : null,
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

export const ec2Collector: Collector = { name: 'ec2', label: 'EC2·오토스케일링', run };
