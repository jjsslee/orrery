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
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  DescribeContainerInstancesCommand,
  paginateListTasks,
  paginateListClusters,
  paginateListServices,
  type Cluster,
  type Service,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import { readEcsServices } from './ecs-services.ts';
import { EC2Client, DescribeInstancesCommand, paginateDescribeSubnets } from '@aws-sdk/client-ec2';
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
      else out.push({ clusterArn: arn, clusterName: arnName(arn), status: 'DETAIL_UNAVAILABLE' });
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
        status: c.status === 'DETAIL_UNAVAILABLE' ? 'unknown' : statusFromState(c.status),
        statusLabel: c.status === 'DETAIL_UNAVAILABLE' ? '상세 조회 실패' : c.status,
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
          const found = await readEcsServices(ecs, c.clusterArn!, batch, message => ctx.log(`[ecs services] ${message}`), ctx.limit);
          for (const arn of batch) ctx.observe?.({key:`ecs service ${arn}`,operation:'DescribeServices',owner:arn,state:found.some(s=>s.serviceArn===arn)?'complete':'failed',attemptedAt:new Date().toISOString()});
          services.push(...found.map(service => ({ clusterName: name, service })));
          for (const arn of batch.filter(arn => !found.some(s => s.serviceArn === arn))) services.push({ clusterName: name, service: { serviceArn: arn, serviceName: arnName(arn), status: 'DETAIL_UNAVAILABLE' } });
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

  // Host/bridge tasks use the EC2 host network. Read runtime membership,
  // never copy the VPC of an arbitrary sibling service in the cluster.
  const runtime = new Map<string, { vpcs: Set<string>; hosts: Set<string>; complete: boolean }>();
  for (const c of clusters) {
    const candidates = services.filter(s => s.clusterName === c.clusterName && !s.service.networkConfiguration?.awsvpcConfiguration && (s.service.runningCount ?? 0) > 0);
    if (!candidates.length) continue;
    const arns = await attempt(ctx, `ecs running tasks ${c.clusterName}`, () => collect(paginateListTasks({ client: ecs }, { cluster: c.clusterArn, desiredStatus: 'RUNNING' }), p => p.taskArns));
    const taskResults = await Promise.all(chunk(arns ?? [], 100).map(batch => attempt(ctx, 'ecs describe tasks', () => ecs.send(new DescribeTasksCommand({ cluster: c.clusterArn, tasks: batch })))));
    for (const result of taskResults) if (result?.failures?.length) ctx.log('[ecs tasks] 일부 태스크 상세 미확인');
    const tasks = taskResults.flatMap(r => r?.tasks ?? []);
    const containers = [...new Set(tasks.map(t => t.containerInstanceArn).filter((id): id is string => Boolean(id)))];
    const ciResults = await Promise.all(chunk(containers, 100).map(batch => attempt(ctx, 'ecs container instances', () => ecs.send(new DescribeContainerInstancesCommand({ cluster: c.clusterArn, containerInstances: batch })))));
    for (const result of ciResults) if (result?.failures?.length) ctx.log('[ecs container instances] 일부 호스트 상세 미확인');
    const hostByContainer = new Map(ciResults.flatMap(r => r?.containerInstances ?? []).map(i => [i.containerInstanceArn, i.ec2InstanceId]));
    const ids = [...new Set([...hostByContainer.values()].filter((id): id is string => Boolean(id)))];
    const hosts = await Promise.all(chunk(ids, 100).map(batch => attempt(ctx, 'ecs host placement', () => ec2.send(new DescribeInstancesCommand({ InstanceIds: batch })))));
    const vpcByHost = new Map(hosts.flatMap(r => r?.Reservations ?? []).flatMap(r => r.Instances ?? []).map(i => [i.InstanceId, i.VpcId]));
    for (const { service } of candidates) {
      const own = tasks.filter(t => t.group === `service:${service.serviceName}`);
      const hostIds = own.map(t => hostByContainer.get(t.containerInstanceArn));
      const vpcs = hostIds.map(id => vpcByHost.get(id));
      runtime.set(`${c.clusterName}/${service.serviceName}`, {
        hosts: new Set(hostIds.filter((id): id is string => Boolean(id))),
        vpcs: new Set(vpcs.filter((id): id is string => Boolean(id))),
        complete: Boolean(arns) && own.length >= (service.runningCount ?? 0) && own.length > 0 && vpcs.every(Boolean),
      });
    }
  }

  for (const { clusterName, service: s } of services) {
    if (!s.serviceName) continue;
    const nativeId = `${clusterName}/${s.serviceName}`;
    const id = nid('ecs-service', nativeId);
    const net = s.networkConfiguration?.awsvpcConfiguration;
    const placement = runtime.get(nativeId);
    const configuredVpcs = (net?.subnets ?? []).map(sn => vpcBySubnet.get(sn));
    const vpcs = net ? new Set(configuredVpcs.filter((v): v is string => Boolean(v))) : placement?.vpcs ?? new Set<string>();
    const complete = net ? configuredVpcs.length > 0 && configuredVpcs.every(Boolean) : placement?.complete;
    const vpcId = complete && vpcs.size === 1 ? [...vpcs][0] : undefined;
    const desired = s.desiredCount ?? 0;
    const running = s.runningCount ?? 0;
    const deployments = s.deployments ?? [];
    const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0];
    const td = s.taskDefinition ? taskDefs.get(s.taskDefinition) : undefined;
    const containers = td?.containerDefinitions ?? [];
    const refs = [
      ...(s.serviceRegistries ?? []).map((r) => r.registryArn),
      primary?.serviceConnectConfiguration?.namespace,
      ...(primary?.serviceConnectResources ?? []).map((r) => r.discoveryArn),
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
      status: s.status === 'DETAIL_UNAVAILABLE' ? 'unknown' : serviceStatus(desired, running, deployments.length, s.status),
      statusLabel: s.status === 'DETAIL_UNAVAILABLE' ? '상세 조회 실패' : `${running}/${desired} 실행`,
      props: {
        상태: s.status ?? null,
        '희망/실행 작업': `${desired} / ${running}`,
        '시작 유형': launch,
        '태스크 정의': s.taskDefinition ? arnPath(s.taskDefinition) : null,
        '배포 상태': primary?.rolloutState ?? (deployments.length > 1 ? `배포 ${deployments.length}개 진행` : null),
        '플랫폼 버전': s.platformVersion ?? null,
        클러스터: clusterName,
        '네트워크 모드': td?.networkMode ?? (net ? 'awsvpc' : null),
        '배치 근거': vpcId ? (net ? '서비스 설정 서브넷' : '실행 태스크의 EC2 호스트') : vpcs.size > 1 ? '여러 VPC에 걸친 실행 위치' : '위치 미확인 · 실행 태스크 없음 또는 조회 불완전',
        '확인된 VPC': [...vpcs].join(', ') || null,
        '설정 서브넷': net?.subnets?.join(', ') || null,
        '대기 작업': s.pendingCount ?? 0,
        '태스크 CPU/메모리': td?.cpu || td?.memory ? `${td?.cpu ?? '-'} / ${td?.memory ?? '-'}` : null,
        컨테이너: containers.map((c) => c.name).filter(Boolean).join(', ') || null,
        스케줄링: s.schedulingStrategy ?? null,
        생성: iso(s.createdAt),
      },
      tags: lowerTags(s.tags),
      refs,
    });
    const serviceEvidence = [{partition:`ecs service ${s.serviceArn}`,collector:'ecs',operation:'DescribeServices',owner:s.serviceArn,method:'configuration' as const}];
    const runtimeKey = `ecs runtime ${s.serviceArn}`;
    ctx.observe?.({key:runtimeKey,operation:'ListTasks/DescribeTasks/DescribeContainerInstances/DescribeInstances',owner:s.serviceArn,state:s.status === 'DETAIL_UNAVAILABLE' ? 'failed' : s.runningCount === 0 || placement?.complete ? 'complete' : 'partial',attemptedAt:new Date().toISOString()});
    edges.push(edge('member', nid('ecs-cluster', clusterName), id, {evidence:serviceEvidence}));
    for (const host of placement?.hosts ?? []) edges.push(edge('attached', id, nid('ec2-instance', host), { evidence:[{partition:runtimeKey,collector:'ecs',operation:'DescribeTasks/DescribeContainerInstances',owner:s.serviceArn,method:'configuration'}], label: '실행 호스트', props: { role: 'execution-host' } }));
    if (!vpcId) for (const vpc of vpcs) edges.push(edge('attached', id, nid('vpc', vpc), { label: '확인된 실행 VPC' }));
    for (const sg of net?.securityGroups ?? []) edges.push(edge('attached', id, nid('security-group', sg)));
    if (td?.taskRoleArn) edges.push(edge('assumes', id, nid('iam-role', arnName(td.taskRoleArn))));
    for (const lb of s.loadBalancers ?? []) {
      if (!lb.targetGroupArn) continue;
      edges.push(edge('targets', nid('target-group', lb.targetGroupArn), id, {configurationId:`serviceTarget|${s.serviceArn}|${lb.targetGroupArn}|${lb.containerName}`,evidence:serviceEvidence,label: `${lb.containerName ?? '?'}:${lb.containerPort ?? '?'}`,props:{containerName:lb.containerName ?? null,containerPort:lb.containerPort ?? null}}));
    }
  }

  return { nodes, edges };
}

export const ecsCollector: Collector = { name: 'ecs', label: 'ECS', run };
