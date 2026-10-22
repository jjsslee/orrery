/**
 * ECS clusters and services.
 *   cluster → service (member), service → vpc (containment), service → sg (attached),
 *   service → task role (assumes), target group → service (targets, from the
 *   service's load balancer config). Container images, env values and secrets
 *   go to refs.
 */
import {
  ECSClient,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  paginateListClusters,
  paginateListServices,
  type Cluster,
  type Service,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import { EC2Client, paginateDescribeSubnets } from '@aws-sdk/client-ec2';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, arnPath, edge, iso, nid, statusFromState } from './ids.ts';
import { attempt, chunk, collect, errMsg, lowerTags } from './util.ts';

/**
 * DescribeClusters in one batch; if the batch is rejected (an explicit deny on
 * a single cluster fails the whole call) fall back to one call per cluster and
 * keep a placeholder for clusters we cannot read.
 */
async function describeClusters(ctx: CollectorContext, ecs: ECSClient, arns: string[]): Promise<Cluster[]> {
  try {
    const res = await ecs.send(new DescribeClustersCommand({ clusters: arns, include: ['STATISTICS', 'TAGS'] }));
    return res.clusters ?? [];
  } catch (err) {
    ctx.log(`[ecs] DescribeClusters 일괄 호출 실패, 클러스터별로 재시도: ${errMsg(err)}`);
  }
  const out: Cluster[] = [];
  await Promise.all(
    arns.map(async (arn) => {
      const res = await attempt(ctx, `ecs describe cluster ${arnName(arn)}`, () => ecs.send(new DescribeClustersCommand({ clusters: [arn], include: ['STATISTICS', 'TAGS'] })));
      if (res?.clusters?.length) out.push(...res.clusters);
      else out.push({ clusterArn: arn, clusterName: arnName(arn), status: 'ACCESS_DENIED' });
    }),
  );
  return out;
}

export function serviceStatus(desired: number, running: number, deployments: number, state?: string): Status {
  if (state && state !== 'ACTIVE') return statusFromState(state) === 'healthy' ? 'warning' : statusFromState(state);
  if (desired > 0 && running === 0) return 'critical';
  if (running < desired || deployments > 1) return 'warning';
  return 'healthy';
}

async function run(ctx: CollectorContext) {
  const ecs = ctx.clients.get(ECSClient);
  const ec2 = ctx.clients.get(EC2Client);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const clusterArns = await collect(paginateListClusters({ client: ecs }, {}), (p) => p.clusterArns);
  if (!clusterArns.length) return { nodes, edges };

  const [subnets, clusterBatches] = await Promise.all([
    collect(paginateDescribeSubnets({ client: ec2 }, {}), (p) => p.Subnets).catch((err) => {
      ctx.log(`[ecs] DescribeSubnets 실패: ${errMsg(err)}`);
      return [];
    }),
    Promise.all(chunk(clusterArns, 100).map((batch) => describeClusters(ctx, ecs, batch))),
  ]);
  const vpcBySubnet = new Map<string, string>();
  for (const s of subnets) if (s.SubnetId && s.VpcId) vpcBySubnet.set(s.SubnetId, s.VpcId);

  const clusters = clusterBatches.flat();
  const services: Array<{ clusterName: string; service: Service }> = [];
  await Promise.all(
    clusters.map(async (c) => {
      if (!c.clusterName || !c.clusterArn) return;
      const name = c.clusterName;
      const stat = (k: string) => Number(c.statistics?.find((s) => s.name === k)?.value ?? 0) || 0;
      nodes.push({
        id: nid('ecs-cluster', name),
        type: 'ecs-cluster',
        category: 'compute',
        name,
        nativeId: name,
        arn: c.clusterArn,
        region: ctx.region,
        status: c.status === 'ACCESS_DENIED' ? 'unknown' : statusFromState(c.status),
        statusLabel: c.status === 'ACCESS_DENIED' ? '접근 거부' : c.status,
        props: {
          상태: c.status ?? null,
          '실행 작업': c.runningTasksCount ?? 0,
          '대기 작업': c.pendingTasksCount ?? 0,
          '활성 서비스': c.activeServicesCount ?? 0,
          '컨테이너 인스턴스': c.registeredContainerInstancesCount ?? 0,
          '용량 공급자': (c.capacityProviders ?? []).join(', ') || null,
          'Fargate 작업': stat('runningFargateTasksCount') || null,
          'EC2 작업': stat('runningEC2TasksCount') || null,
        },
        tags: lowerTags(c.tags),
      });
      // ListServices may still be allowed when DescribeClusters is denied, so always try it.
      const serviceArns = await attempt(ctx, `ecs services ${name}`, () =>
        collect(paginateListServices({ client: ecs }, { cluster: c.clusterArn }), (p) => p.serviceArns),
      );
      if (!serviceArns?.length) return;
      await Promise.all(
        chunk(serviceArns, 10).map(async (batch) => {
          const res = await attempt(ctx, `ecs describe services ${name}`, () => ecs.send(new DescribeServicesCommand({ cluster: c.clusterArn, services: batch, include: ['TAGS'] })));
          if (res) for (const s of res.services ?? []) services.push({ clusterName: name, service: s });
          else for (const arn of batch) services.push({ clusterName: name, service: { serviceArn: arn, serviceName: arnName(arn), status: 'ACCESS_DENIED' } });
        }),
      );
    }),
  );

  // Task definitions: one DescribeTaskDefinition per distinct revision in use.
  const taskDefArns = [...new Set(services.map((s) => s.service.taskDefinition).filter((a): a is string => Boolean(a)))];
  const taskDefs = new Map<string, TaskDefinition>();
  await Promise.all(
    taskDefArns.map(async (arn) => {
      const res = await attempt(ctx, `ecs task definition ${arnPath(arn)}`, () => ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn })));
      if (res?.taskDefinition) taskDefs.set(arn, res.taskDefinition);
    }),
  );

  for (const { clusterName, service: s } of services) {
    if (!s.serviceName) continue;
    const nativeId = `${clusterName}/${s.serviceName}`;
    const id = nid('ecs-service', nativeId);
    const net = s.networkConfiguration?.awsvpcConfiguration;
    const vpcId = (net?.subnets ?? []).map((sn) => vpcBySubnet.get(sn)).find(Boolean);
    const desired = s.desiredCount ?? 0;
    const running = s.runningCount ?? 0;
    const deployments = s.deployments ?? [];
    const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0];
    const td = s.taskDefinition ? taskDefs.get(s.taskDefinition) : undefined;
    const containers = td?.containerDefinitions ?? [];
    const refs = [
      ...containers.map((c) => c.image),
      ...containers.flatMap((c) => (c.environment ?? []).map((e) => e.value)),
      ...containers.flatMap((c) => (c.secrets ?? []).map((e) => e.valueFrom)),
      td?.executionRoleArn,
      td?.taskRoleArn,
    ].filter((r): r is string => Boolean(r));
    const launch = s.launchType ?? ((s.capacityProviderStrategy ?? []).map((p) => p.capacityProvider).filter(Boolean).join(', ') || null);
    nodes.push({
      id,
      type: 'ecs-service',
      category: 'compute',
      name: s.serviceName,
      nativeId,
      arn: s.serviceArn,
      region: ctx.region,
      parentId: vpcId ? nid('vpc', vpcId) : undefined,
      status: serviceStatus(desired, running, deployments.length, s.status),
      statusLabel: s.status === 'ACCESS_DENIED' ? '접근 거부' : `${running}/${desired} 실행`,
      props: {
        상태: s.status ?? null,
        '희망/실행 작업': `${desired} / ${running}`,
        '시작 유형': launch,
        '태스크 정의': s.taskDefinition ? arnPath(s.taskDefinition) : null,
        '배포 상태': primary?.rolloutState ?? (deployments.length > 1 ? `배포 ${deployments.length}개 진행` : null),
        '플랫폼 버전': s.platformVersion ?? null,
        클러스터: clusterName,
        '대기 작업': s.pendingCount ?? 0,
        '태스크 CPU/메모리': td?.cpu || td?.memory ? `${td?.cpu ?? '-'} / ${td?.memory ?? '-'}` : null,
        컨테이너: containers.map((c) => c.name).filter(Boolean).join(', ') || null,
        스케줄링: s.schedulingStrategy ?? null,
        생성: iso(s.createdAt),
      },
      tags: lowerTags(s.tags),
      refs,
    });
    edges.push(edge('member', nid('ecs-cluster', clusterName), id));
    for (const sg of net?.securityGroups ?? []) edges.push(edge('attached', id, nid('security-group', sg)));
    if (td?.taskRoleArn) edges.push(edge('assumes', id, nid('iam-role', arnName(td.taskRoleArn))));
    for (const lb of s.loadBalancers ?? []) {
      if (!lb.targetGroupArn) continue;
      edges.push(edge('targets', nid('target-group', lb.targetGroupArn), id, { label: `${lb.containerName ?? '?'}:${lb.containerPort ?? '?'}` }));
    }
  }

  return { nodes, edges };
}

export const ecsCollector: Collector = { name: 'ecs', label: 'ECS', run };
