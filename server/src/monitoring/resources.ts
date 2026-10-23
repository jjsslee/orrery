import { LambdaClient, ListFunctionsCommand, ListTagsCommand } from '@aws-sdk/client-lambda';
import { SQSClient, ListQueuesCommand, ListQueueTagsCommand } from '@aws-sdk/client-sqs';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { RDSClient, DescribeDBInstancesCommand, ListTagsForResourceCommand } from '@aws-sdk/client-rds';
import type { MonitoringResource, MonitoringResourceIndex, MonitoringResourceType, ResourceGraph } from '@orrery/shared';
import type { MonitoringSession } from './alarms.ts';
import { nid, tagsToRecord } from '../collectors/ids.ts';
import { queriesForNode } from '../metrics/cloudwatch.ts';
import { scopeKey } from '../aws/sessions.ts';

export const MONITORING_TYPES: MonitoringResourceType[] = ['lambda', 'sqs-queue', 'load-balancer', 'ecs-service', 'ec2-instance', 'rds-instance'];
export const resourceKey = (account: string, region: string, type: string, nativeId: string) => JSON.stringify([account, region, type, nativeId]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function listMonitoringResources(s: MonitoringSession, type: MonitoringResourceType): Promise<MonitoringResourceIndex> {
  const resources: MonitoringResource[] = [];
  const attemptedAt = new Date().toISOString();
  const errors: string[] = [];
  const add = (nativeId: string, name = nativeId, arn?: string, tags?: Record<string, string>, props: MonitoringResource['props'] = {}, tagsStatus: MonitoringResource['tagsStatus'] = 'complete') => {
    resources.push({ key: resourceKey(s.account, s.region, type, nativeId), nodeId: nid(type, nativeId), type, nativeId, name, arn, region: s.region, tags, tagsStatus, props });
  };
  async function tags(fn: () => Promise<Record<string, string> | undefined>): Promise<{ value?: Record<string, string>; status: MonitoringResource['tagsStatus'] }> {
    try { return { value: await fn(), status: 'complete' }; } catch { return { status: 'unavailable' }; }
  }
  try {
    if (type === 'lambda') {
      const client = s.clients.get(LambdaClient);
      let Marker: string | undefined;
      do {
        const page = await client.send(new ListFunctionsCommand({ Marker }));
        for (const f of page.Functions ?? []) if (f.FunctionName) {
          const t = f.FunctionArn ? await tags(async () => (await client.send(new ListTagsCommand({ Resource: f.FunctionArn }))).Tags) : { status: 'unavailable' as const, value: undefined };
          add(f.FunctionName, f.FunctionName, f.FunctionArn, t.value, {}, t.status);
        }
        Marker = page.NextMarker;
      } while (Marker);
    } else if (type === 'sqs-queue') {
      const client = s.clients.get(SQSClient);
      let NextToken: string | undefined;
      do {
        const page = await client.send(new ListQueuesCommand({ NextToken, MaxResults: 1000 }));
        for (const url of page.QueueUrls ?? []) {
          const name = url.split('/').pop()!;
          const t = await tags(async () => (await client.send(new ListQueueTagsCommand({ QueueUrl: url }))).Tags);
          add(name, name, undefined, t.value, {}, t.status);
        }
        NextToken = page.NextToken;
      } while (NextToken);
    } else if (type === 'load-balancer') {
      const client = s.clients.get(ElasticLoadBalancingV2Client);
      let Marker: string | undefined;
      do {
        const page = await client.send(new DescribeLoadBalancersCommand({ Marker }));
        for (const lb of page.LoadBalancers ?? []) if (lb.Type === 'application' && lb.LoadBalancerArn) {
          const t = await tags(async () => tagsToRecord((await client.send(new DescribeTagsCommand({ ResourceArns: [lb.LoadBalancerArn!] }))).TagDescriptions?.[0]?.Tags));
          add(lb.LoadBalancerArn, lb.LoadBalancerName, lb.LoadBalancerArn, t.value, { _lbType: 'application' }, t.status);
        }
        Marker = page.NextMarker;
      } while (Marker);
    } else if (type === 'ecs-service') {
      const client = s.clients.get(ECSClient);
      let nextToken: string | undefined;
      do {
        const clusters = await client.send(new ListClustersCommand({ nextToken }));
        for (const cluster of clusters.clusterArns ?? []) {
          let servicesToken: string | undefined;
          try {
            do {
              const page = await client.send(new ListServicesCommand({ cluster, nextToken: servicesToken }));
              const arns = page.serviceArns ?? [];
              for (let i = 0; i < arns.length; i += 10) {
                const described = await client.send(new DescribeServicesCommand({ cluster, services: arns.slice(i, i + 10), include: ['TAGS'] }));
                for (const failure of described.failures ?? []) errors.push(`${failure.arn ?? cluster}: ${failure.reason ?? 'DescribeServices 실패'}`);
                for (const service of described.services ?? []) if (service.serviceName) {
                  const name = `${cluster.split('/').pop()}/${service.serviceName}`;
                  add(name, name, service.serviceArn, Object.fromEntries((service.tags ?? []).filter((t) => t.key).map((t) => [t.key!, t.value ?? ''])), {}, service.tags ? 'complete' : 'unavailable');
                }
              }
              servicesToken = page.nextToken;
            } while (servicesToken);
          } catch (error) { errors.push(message(error)); }
        }
        nextToken = clusters.nextToken;
      } while (nextToken);
    } else if (type === 'ec2-instance') {
      const client = s.clients.get(EC2Client);
      let NextToken: string | undefined;
      do {
        const page = await client.send(new DescribeInstancesCommand({ NextToken }));
        for (const reservation of page.Reservations ?? []) for (const instance of reservation.Instances ?? []) if (instance.InstanceId) {
          const t = tagsToRecord(instance.Tags);
          add(instance.InstanceId, t?.Name || instance.InstanceId, undefined, t, { _monitoring: instance.Monitoring?.State ?? 'disabled' });
        }
        NextToken = page.NextToken;
      } while (NextToken);
    } else if (type === 'rds-instance') {
      const client = s.clients.get(RDSClient);
      let Marker: string | undefined;
      do {
        const page = await client.send(new DescribeDBInstancesCommand({ Marker }));
        for (const db of page.DBInstances ?? []) if (db.DBInstanceIdentifier) {
          const t = db.TagList ? { value: tagsToRecord(db.TagList), status: 'complete' as const } : db.DBInstanceArn ? await tags(async () => tagsToRecord((await client.send(new ListTagsForResourceCommand({ ResourceName: db.DBInstanceArn! }))).TagList)) : { status: 'unavailable' as const, value: undefined };
          add(db.DBInstanceIdentifier, db.DBInstanceIdentifier, db.DBInstanceArn, t.value, {}, t.status);
        }
        Marker = page.Marker;
      } while (Marker);
    }
  } catch (error) { errors.push(message(error)); }
  return { scope: { source: s.source, account: s.account, region: s.region }, resources, types: [type], complete: !errors.length, observation: { attemptedAt, succeededAt: errors.length ? undefined : new Date().toISOString(), error: errors.length ? errors.join('; ') : undefined } };
}

export function graphResources(graph: ResourceGraph): MonitoringResource[] {
  return graph.nodes.filter((node) => node.type !== 'region').map((node) => {
    const queries = queriesForNode(node);
    const metricsSupported = queries.length > 0;
    const otherRegion = queries.find((q) => q.region && q.region !== graph.region)?.region;
    return { key: resourceKey(graph.account, graph.region, node.type, node.nativeId), nodeId: node.id, type: node.type, nativeId: node.nativeId, name: node.name, region: node.region, arn: node.arn, tags: node.tags, tagsStatus: node.tags ? 'complete' as const : 'unavailable' as const, props: node.props, metricsSupported, alarmMappingSupported: metricsSupported, alarmScopeWarning: otherRegion ? `지표는 ${otherRegion}에서 조회합니다. 경보 목록은 선택 리전 ${graph.region} 범위이므로 해당 지표 리전의 경보를 포함하지 않을 수 있습니다.` : metricsSupported ? undefined : '이 유형의 경보·자원 연결을 해석하지 못합니다.', metricsUnsupportedReason: metricsSupported ? undefined : '이 유형의 CloudWatch 지표 프리셋은 아직 지원하지 않습니다.' };
  });
}

export class ResourceRepository {
  private graphs = new Map<string, MonitoringResource[]>();
  private values = new Map<string, MonitoringResourceIndex>();
  private pending = new Map<string, Promise<MonitoringResourceIndex>>();
  get(s: MonitoringSession, type: MonitoringResourceType, refresh = false): Promise<MonitoringResourceIndex> {
    const key = scopeKey(`resources:${type}`, s.source, s.account, s.region);
    const old = this.values.get(key);
    if (!refresh && old?.complete && Date.now() - Date.parse(old.observation.attemptedAt) < 300_000) return Promise.resolve(old);
    const running = this.pending.get(key);
    if (running) return running;
    const task = listMonitoringResources(s, type).then((value) => { this.values.set(key, value); return value; }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  includeGraph(s: MonitoringSession, graph: ResourceGraph): void {
    if (s.source !== graph.source || s.account !== graph.account || s.region !== graph.region) throw Object.assign(new Error('자원 그래프의 계정 범위가 일치하지 않습니다.'), { statusCode: 409 });
    this.graphs.set(scopeKey('resources:graph', s.source, s.account, s.region), graphResources(graph));
  }
  coverage(s: MonitoringSession) {
    const types = MONITORING_TYPES.filter((t) => this.values.has(scopeKey(`resources:${t}`, s.source, s.account, s.region)));
    const incompleteTypes = MONITORING_TYPES.filter((t) => { const value = this.values.get(scopeKey(`resources:${t}`, s.source, s.account, s.region)); return !value?.complete || value.resources.some((r) => r.tagsStatus !== 'complete'); });
    return { types, incompleteTypes };
  }
  known(s: MonitoringSession): MonitoringResource[] {
    const map = new Map((this.graphs.get(scopeKey('resources:graph', s.source, s.account, s.region)) ?? []).map((r) => [r.key, r]));
    for (const t of MONITORING_TYPES) for (const resource of this.values.get(scopeKey(`resources:${t}`, s.source, s.account, s.region))?.resources ?? []) map.set(resource.key, { ...resource, metricsSupported: true });
    return [...map.values()];
  }
}
