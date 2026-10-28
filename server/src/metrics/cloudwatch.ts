/**
 * CloudWatch metrics for the nodes of a graph.
 *
 * A static catalogue maps each node type to a handful of metrics (the first
 * one flagged `throughput` drives the node's traffic intensity). Queries are
 * batched into GetMetricData calls of ≤ 500 queries, grouped by region and
 * period, then folded back into MetricSeries per node. Traffic is the mean of
 * the last hour of the throughput metric, log-normalised per node type.
 */
import { CloudWatchClient, GetMetricDataCommand, type Dimension, type MetricDataQuery, type MetricDataResult } from '@aws-sdk/client-cloudwatch';
import pLimit from 'p-limit';
import type { MetricPoint, MetricSeries, MetricsBundle, ResourceGraph, ResourceNode, ResourceType } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';

export interface MetricSpec {
  namespace: string;
  metric: string;
  stat: 'Sum' | 'Average' | 'Maximum' | 'Minimum' | 'SampleCount' | 'p95';
  label: string;
  unit: string;
  /** This metric drives the node's traffic intensity */
  throughput?: boolean;
  /** Seconds; default 300 */
  period?: number;
  /** Lookback window in seconds; default 3 h */
  window?: number;
}

export interface MetricQuery {
  nodeId: string;
  type: ResourceType;
  spec: MetricSpec;
  dims: Dimension[];
  /** Region override for global services (CloudFront → us-east-1) */
  region?: string;
}

const DEFAULT_PERIOD = 300;
const DEFAULT_WINDOW = 3 * 3600;
const DAY = 86_400;
const BATCH = 500;
const CONCURRENCY = 6;

type Spec = Omit<MetricSpec, 'namespace'>;
const specs = (namespace: string, list: Spec[]): MetricSpec[] => list.map((s) => ({ namespace, ...s }));
const dim = (Name: string, Value: string): Dimension => ({ Name, Value });

const ALB = specs('AWS/ApplicationELB', [
  { metric: 'RequestCount', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: 'TargetResponseTime', stat: 'Average', label: '응답 시간', unit: 's' },
  { metric: 'HTTPCode_Target_5XX_Count', stat: 'Sum', label: '5xx 오류', unit: 'count' },
]);
const NLB = specs('AWS/NetworkELB', [
  { metric: 'ProcessedBytes', stat: 'Sum', label: '처리 바이트', unit: 'bytes', throughput: true },
  { metric: 'ActiveFlowCount', stat: 'Average', label: '활성 플로우', unit: 'count' },
  { metric: 'TCP_Target_Reset_Count', stat: 'Sum', label: '타깃 리셋', unit: 'count' },
]);
const EC2 = specs('AWS/EC2', [
  { metric: 'CPUUtilization', stat: 'Average', label: 'CPU 사용률', unit: '%' },
  { metric: 'NetworkOut', stat: 'Sum', label: '네트워크 송신', unit: 'bytes', throughput: true },
  { metric: 'NetworkIn', stat: 'Sum', label: '네트워크 수신', unit: 'bytes' },
]);
const RDS_INSTANCE = specs('AWS/RDS', [
  { metric: 'DatabaseConnections', stat: 'Average', label: '연결 수', unit: 'count', throughput: true },
  { metric: 'CPUUtilization', stat: 'Average', label: 'CPU 사용률', unit: '%' },
  { metric: 'FreeStorageSpace', stat: 'Average', label: '남은 스토리지', unit: 'bytes' },
]);
const RDS_CLUSTER = specs('AWS/RDS', [
  { metric: 'DatabaseConnections', stat: 'Average', label: '연결 수', unit: 'count', throughput: true },
  { metric: 'CPUUtilization', stat: 'Average', label: 'CPU 사용률', unit: '%' },
]);
const LAMBDA = specs('AWS/Lambda', [
  { metric: 'Invocations', stat: 'Sum', label: '호출 수', unit: 'count', throughput: true },
  { metric: 'Errors', stat: 'Sum', label: '오류', unit: 'count' },
  { metric: 'Duration', stat: 'Average', label: '실행 시간', unit: 'ms' },
]);
const NAT = specs('AWS/NATGateway', [
  { metric: 'BytesOutToDestination', stat: 'Sum', label: '송신 바이트', unit: 'bytes', throughput: true },
  { metric: 'ActiveConnectionCount', stat: 'Maximum', label: '활성 연결', unit: 'count' },
  { metric: 'ErrorPortAllocation', stat: 'Sum', label: '포트 할당 오류', unit: 'count' },
]);
const DYNAMODB = specs('AWS/DynamoDB', [
  { metric: 'ConsumedReadCapacityUnits', stat: 'Sum', label: '읽기 용량 소비', unit: 'count', throughput: true },
  { metric: 'ConsumedWriteCapacityUnits', stat: 'Sum', label: '쓰기 용량 소비', unit: 'count' },
  { metric: 'ThrottledRequests', stat: 'Sum', label: '스로틀링', unit: 'count' },
]);
const SQS = specs('AWS/SQS', [
  { metric: 'NumberOfMessagesSent', stat: 'Sum', label: '전송 메시지', unit: 'count', throughput: true },
  { metric: 'ApproximateNumberOfMessagesVisible', stat: 'Average', label: '대기 메시지', unit: 'count' },
  { metric: 'ApproximateAgeOfOldestMessage', stat: 'Maximum', label: '가장 오래된 메시지 나이', unit: 's' },
]);
const SNS = specs('AWS/SNS', [
  { metric: 'NumberOfMessagesPublished', stat: 'Sum', label: '게시 메시지', unit: 'count', throughput: true },
  { metric: 'NumberOfNotificationsFailed', stat: 'Sum', label: '전달 실패', unit: 'count' },
]);
const ELASTICACHE = specs('AWS/ElastiCache', [
  { metric: 'CurrConnections', stat: 'Average', label: '현재 연결', unit: 'count', throughput: true },
  { metric: 'CPUUtilization', stat: 'Average', label: 'CPU 사용률', unit: '%' },
  { metric: 'CacheHits', stat: 'Sum', label: '캐시 히트', unit: 'count' },
]);
const ECS = specs('AWS/ECS', [
  { metric: 'CPUUtilization', stat: 'Average', label: 'CPU 사용률', unit: '%', throughput: true },
  { metric: 'MemoryUtilization', stat: 'Average', label: '메모리 사용률', unit: '%' },
]);
const CLOUDFRONT = specs('AWS/CloudFront', [
  { metric: 'Requests', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: 'BytesDownloaded', stat: 'Sum', label: '다운로드 바이트', unit: 'bytes' },
  { metric: '5xxErrorRate', stat: 'Average', label: '5xx 비율', unit: '%' },
]);
const API_REST = specs('AWS/ApiGateway', [
  { metric: 'Count', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: '5XXError', stat: 'Sum', label: '5xx 오류', unit: 'count' },
  { metric: 'Latency', stat: 'Average', label: '지연', unit: 'ms' },
]);
const API_V2 = specs('AWS/ApiGateway', [
  { metric: 'Count', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: '5xx', stat: 'Sum', label: '5xx 오류', unit: 'count' },
  { metric: 'Latency', stat: 'Average', label: '지연', unit: 'ms' },
]);
const API_WEBSOCKET = specs('AWS/ApiGateway', [
  { metric: 'MessageCount', stat: 'Sum', label: '메시지 수', unit: 'count', throughput: true },
  { metric: 'IntegrationError', stat: 'Sum', label: '통합 오류', unit: 'count' },
  { metric: 'IntegrationLatency', stat: 'Average', label: '통합 지연', unit: 'ms' },
]);
const EFS = specs('AWS/EFS', [
  { metric: 'TotalIOBytes', stat: 'Sum', label: '총 I/O 바이트', unit: 'bytes', throughput: true },
  { metric: 'ClientConnections', stat: 'Sum', label: '클라이언트 연결', unit: 'count' },
]);
const EVENTS = specs('AWS/Events', [
  { metric: 'Invocations', stat: 'Sum', label: '호출 수', unit: 'count', throughput: true },
  { metric: 'FailedInvocations', stat: 'Sum', label: '호출 실패', unit: 'count' },
]);
const STATES = specs('AWS/States', [
  { metric: 'ExecutionsStarted', stat: 'Sum', label: '실행 시작', unit: 'count', throughput: true },
  { metric: 'ExecutionsFailed', stat: 'Sum', label: '실행 실패', unit: 'count' },
]);
const APPSYNC_GRAPHQL = specs('AWS/AppSync', [
  { metric: 'Requests', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: 'Latency', stat: 'Average', label: '지연', unit: 'ms' },
  { metric: '5XXError', stat: 'Sum', label: '5xx 오류', unit: 'count' },
]);
const APPSYNC_EVENTS = specs('AWS/AppSync', [
  { metric: 'Requests', stat: 'Sum', label: '요청 수', unit: 'count', throughput: true },
  { metric: 'ActiveConnections', stat: 'Average', label: '활성 연결', unit: 'count' },
  { metric: 'SuccessfulEvents', stat: 'Sum', label: '성공 이벤트', unit: 'count' },
  { metric: '5XXError', stat: 'Sum', label: '5xx 오류', unit: 'count' },
]);
const ASG = specs('AWS/AutoScaling', [{ metric: 'GroupInServiceInstances', stat: 'Average', label: '서비스 중 인스턴스', unit: 'count' }]);
const S3_SIZE: MetricSpec = { namespace: 'AWS/S3', metric: 'BucketSizeBytes', stat: 'Average', label: '저장 용량', unit: 'bytes', period: DAY, window: 3 * DAY };
const S3_OBJECTS: MetricSpec = { namespace: 'AWS/S3', metric: 'NumberOfObjects', stat: 'Average', label: '객체 수', unit: 'count', period: DAY, window: 3 * DAY };

/** arn:...:loadbalancer/app/name/id → app/name/id (CloudWatch LoadBalancer dimension) */
export function lbDimension(nativeId: string): string | undefined {
  const i = nativeId.indexOf('loadbalancer/');
  return i >= 0 ? nativeId.slice(i + 'loadbalancer/'.length) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Catalogue lookup: which metrics to fetch for one node. Pure, so it is unit-testable. */
export function queriesForNode(node: ResourceNode): MetricQuery[] {
  const q = (spec: MetricSpec[], dims: Dimension[], region?: string): MetricQuery[] =>
    spec.map((s) => ({ nodeId: node.id, type: node.type, spec: s, dims, region }));
  const id = node.nativeId;
  switch (node.type) {
    case 'load-balancer': {
      const lb = lbDimension(id);
      if (!lb) return [];
      const kind = str(node.props['_lbType']) ?? 'application';
      if (kind === 'application') return q(ALB, [dim('LoadBalancer', lb)]);
      if (kind === 'network') return q(NLB, [dim('LoadBalancer', lb)]);
      return [];
    }
    case 'target-group': {
      const arn = str(node.props._metricLoadBalancerArn);
      const lb = arn ? lbDimension(arn) : undefined;
      const tg = id.match(/:targetgroup\/(.+)$/)?.[1];
      if (!lb?.startsWith('app/') || !tg) return [];
      return q(specs('AWS/ApplicationELB', [
        {metric:'HealthyHostCount',stat:'Minimum',label:'정상 대상 최솟값',unit:'count'},
        {metric:'UnHealthyHostCount',stat:'Maximum',label:'비정상 대상 최댓값',unit:'count'},
        {metric:'HTTPCode_Target_5XX_Count',stat:'Sum',label:'대상 5xx 오류',unit:'count'},
        {metric:'TargetResponseTime',stat:'p95',label:'대상 응답 시간 p95',unit:'s'},
      ]), [dim('LoadBalancer',lb),dim('TargetGroup',`targetgroup/${tg}`)]);
    }
    case 'ec2-instance': return q(EC2, [dim('InstanceId', id)]);
    case 'rds-instance': return q(RDS_INSTANCE, [dim('DBInstanceIdentifier', id)]);
    case 'rds-cluster': return q(RDS_CLUSTER, [dim('DBClusterIdentifier', id)]);
    case 'lambda': return q(LAMBDA, [dim('FunctionName', id)]);
    case 'nat-gateway': return q(NAT, [dim('NatGatewayId', id)]);
    case 'dynamodb-table': return q(DYNAMODB, [dim('TableName', id)]);
    case 'sqs-queue': return q(SQS, [dim('QueueName', id)]);
    case 'sns-topic': return q(SNS, [dim('TopicName', id)]);
    case 'elasticache': {
      const cluster = str(node.props['_cacheClusterId']) ?? id;
      return q(ELASTICACHE, [dim('CacheClusterId', cluster)]);
    }
    case 'ecs-service': {
      const i = id.indexOf('/');
      if (i < 0) return [];
      return q(ECS, [dim('ClusterName', id.slice(0, i)), dim('ServiceName', id.slice(i + 1))]);
    }
    case 'ecs-cluster': return q(ECS, [dim('ClusterName', id)]);
    case 'cloudfront': return q(CLOUDFRONT, [dim('Region', 'Global'), dim('DistributionId', id)], 'us-east-1');
    case 'api-gateway': {
      const kind = str(node.props['_apiKind']) ?? 'rest';
      return kind === 'rest' ? q(API_REST, [dim('ApiName', node.name)]) : q(kind === 'websocket' ? API_WEBSOCKET : API_V2, [dim('ApiId', id)]);
    }
    case 'appsync-api':
      return str(node.props['_apiKind']) === 'events' ? q(APPSYNC_EVENTS, [dim('EventAPIId', id)]) : q(APPSYNC_GRAPHQL, [dim('GraphQLAPIId', id)]);
    case 'efs': return q(EFS, [dim('FileSystemId', id)]);
    case 'eventbridge-rule': return q(EVENTS, [dim('RuleName', str(node.props['_ruleName']) ?? id)]);
    case 'step-function': return node.arn ? q(STATES, [dim('StateMachineArn', node.arn)]) : [];
    case 'autoscaling-group': return q(ASG, [dim('AutoScalingGroupName', id)]);
    case 's3-bucket':
      return [
        ...q([S3_SIZE], [dim('BucketName', id), dim('StorageType', 'StandardStorage')]),
        ...q([S3_OBJECTS], [dim('BucketName', id), dim('StorageType', 'AllStorageTypes')]),
      ];
    default: return [];
  }
}

/** Mean of the points inside the last `windowMs`; falls back to the last 3 points. */
export function recentMean(points: MetricPoint[], now: number, windowMs = 60 * 60_000): number | undefined {
  const valid = points.filter((p) => Number.isFinite(p.v));
  if (!valid.length) return undefined;
  let recent = valid.filter((p) => p.t >= now - windowMs);
  if (!recent.length) recent = valid.slice(-3);
  return recent.reduce((s, p) => s + p.v, 0) / recent.length;
}

/** Per-type log normalisation: traffic = log1p(v) / log1p(max of that type). Zero/no data → omitted. */
export function normaliseTraffic(values: Array<{ nodeId: string; type: string; v: number }>): Record<string, number> {
  const maxByType = new Map<string, number>();
  for (const { type, v } of values) if (v > 0) maxByType.set(type, Math.max(maxByType.get(type) ?? 0, v));
  const out: Record<string, number> = {};
  for (const { nodeId, type, v } of values) {
    const max = maxByType.get(type);
    if (!max || !(v > 0)) continue;
    out[nodeId] = Math.round((Math.log1p(v) / Math.log1p(max)) * 1000) / 1000;
  }
  return out;
}

interface Batch { region?: string; period: number; window: number; queries: MetricQuery[] }

function groupBatches(queries: MetricQuery[]): Batch[] {
  const groups = new Map<string, Batch>();
  for (const q of queries) {
    const period = q.spec.period ?? DEFAULT_PERIOD;
    const window = q.spec.window ?? DEFAULT_WINDOW;
    const key = `${q.region ?? ''}|${period}|${window}`;
    const g = groups.get(key) ?? { region: q.region, period, window, queries: [] };
    g.queries.push(q);
    groups.set(key, g);
  }
  const out: Batch[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.queries.length; i += BATCH) out.push({ ...g, queries: g.queries.slice(i, i + BATCH) });
  }
  return out;
}

async function fetchBatch(clients: ClientFactory, batch: Batch, now: Date): Promise<Map<string, { points: MetricPoint[]; status?: string; awsStatus?: string; errorCode?: string; messages: string[] }>> {
  const cw = clients.get(CloudWatchClient, batch.region);
  // Ids must match /^[a-z][a-zA-Z0-9_]*$/; the index maps back to batch.queries[i]
  const MetricDataQueries: MetricDataQuery[] = batch.queries.map((q, i) => ({
    Id: `q${i}`,
    MetricStat: { Metric: { Namespace: q.spec.namespace, MetricName: q.spec.metric, Dimensions: q.dims }, Period: batch.period, Stat: q.spec.stat },
    ReturnData: true,
  }));
  const points = new Map<string, { points: MetricPoint[]; status?: string; awsStatus?: string; errorCode?: string; messages: string[] }>();
  let NextToken: string | undefined;
  do {
    let res;
    try {
      res = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries,
        StartTime: new Date(now.getTime() - batch.window * 1000),
        EndTime: now,
        ScanBy: 'TimestampAscending',
        NextToken,
      }),
    );
    } catch (err) {
      if (!points.size) throw err;
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      batch.queries.forEach((_query, i) => {
        const key = `q${i}`;
        const entry = points.get(key) ?? { points: [], status: 'InternalError', messages: [] };
        if (entry.status !== 'Forbidden' && entry.status !== 'InternalError') entry.status = 'PartialData';
        entry.errorCode = err instanceof Error ? err.name : 'UnknownError';
        entry.messages.push(message);
        points.set(key, entry);
      });
      return points;
    }
    for (const r of res.MetricDataResults ?? []) appendResult(points, r);
    NextToken = res.NextToken;
  } while (NextToken);
  return points;
}

function appendResult(points: Map<string, { points: MetricPoint[]; status?: string; awsStatus?: string; errorCode?: string; messages: string[] }>, r: MetricDataResult): void {
  if (!r.Id) return;
  const entry = points.get(r.Id) ?? { points: [], messages: [] };
  const list = entry.points;
  // A later complete page resolves PartialData; errors must never become success.
  if (entry.status !== 'InternalError' && entry.status !== 'Forbidden') entry.status = r.StatusCode;
  entry.awsStatus = entry.status;
  entry.messages.push(...(r.Messages ?? []).map((m) => `${m.Code ?? ''}: ${m.Value ?? ''}`));
  const ts = r.Timestamps ?? [];
  const vs = r.Values ?? [];
  for (let i = 0; i < ts.length; i++) {
    const v = vs[i];
    if (v == null || !Number.isFinite(v)) continue;
    list.push({ t: ts[i].getTime(), v });
  }
  points.set(r.Id, entry);
}

export async function collectMetrics(graph: ResourceGraph, clients: ClientFactory): Promise<MetricsBundle> {
  const now = new Date();
  const queries = graph.nodes.flatMap(queriesForNode);
  const batches = groupBatches(queries);
  const limit = pLimit(CONCURRENCY);

  const series: Record<string, MetricSeries[]> = {};
  const trafficInputs: Array<{ nodeId: string; type: string; v: number }> = [];

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        let result: Map<string, { points: MetricPoint[]; status?: string; awsStatus?: string; errorCode?: string; messages: string[] }>;
        let batchError: string | undefined;
        let errorCode: string | undefined;
        try {
          result = await fetchBatch(clients, batch, now);
        } catch (err) {
          // One failed batch should not blank out every other metric.
          errorCode = err instanceof Error ? err.name : 'UnknownError';
          batchError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          result = new Map();
        }
        batch.queries.forEach((q, i) => {
          const response = result.get(`q${i}`);
          const points = (response?.points ?? []).sort((a, b) => a.t - b.t);
          const status = batchError || response?.status === 'Forbidden' || response?.status === 'InternalError' || !response ? 'error' : response.status === 'PartialData' ? 'partial' : points.length ? 'complete' : 'empty';
          const list = series[q.nodeId] ?? (series[q.nodeId] = []);
          list.push({ name: q.spec.metric, label: q.spec.label, unit: q.spec.unit, stat: q.spec.stat, points, latest: points[points.length - 1]?.v ?? null, status, awsStatus: response?.awsStatus, errorCode: errorCode ?? response?.errorCode, messages: batchError ? [batchError] : response?.messages ?? ['CloudWatch 응답에서 지표가 누락되었습니다.'], period: batch.period, startTime: new Date(now.getTime() - batch.window * 1000).toISOString(), endTime: now.toISOString(), fetchedAt: now.toISOString(), lastDataAt: points.length ? new Date(points[points.length - 1].t).toISOString() : undefined, region: batch.region ?? graph.region });
          if (q.spec.throughput && status === 'complete') {
            const v = recentMean(points, now.getTime());
            if (v != null) trafficInputs.push({ nodeId: q.nodeId, type: q.type, v });
          }
        });
      }),
    ),
  );

  return { scope: { source: graph.source, account: graph.account, region: graph.region }, region: graph.region, collectedAt: now.toISOString(), series, traffic: normaliseTraffic(trafficInputs) };
}
