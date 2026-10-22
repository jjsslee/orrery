/**
 * Messaging and orchestration: SQS queues, SNS topics, EventBridge rules and
 * Step Functions state machines.
 *   queue → DLQ (routes), topic → lambda (invokes), topic → queue (publishes),
 *   rule → target (invokes), state machine → IAM role (assumes)
 */
import { SQSClient, GetQueueAttributesCommand, paginateListQueues } from '@aws-sdk/client-sqs';
import { SNSClient, GetTopicAttributesCommand, paginateListSubscriptionsByTopic, paginateListTopics } from '@aws-sdk/client-sns';
import { EventBridgeClient, ListEventBusesCommand, ListRulesCommand, ListTargetsByRuleCommand, type EventBus, type Rule, type Target } from '@aws-sdk/client-eventbridge';
import { SFNClient, DescribeStateMachineCommand, paginateListStateMachines } from '@aws-sdk/client-sfn';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, arnService, edge, iso, nid } from './ids.ts';
import { attempt, collect, countSummary, errMsg, lambdaNameFromArn, truncate } from './util.ts';

/** EventBridge target ARN → node id of a resource we collect (undefined → keep as ref) */
export function targetNodeId(arn: string): string | undefined {
  switch (arnService(arn)) {
    case 'lambda': { const fn = lambdaNameFromArn(arn); return fn ? nid('lambda', fn) : undefined; }
    case 'sqs': return nid('sqs-queue', arnName(arn));
    case 'sns': return nid('sns-topic', arnName(arn));
    case 'states': return arn.includes(':stateMachine:') ? nid('step-function', arnName(arn)) : undefined;
    case 'ecs': return arn.includes(':cluster/') ? nid('ecs-cluster', arnName(arn)) : undefined;
    default: return undefined;
  }
}

/** ARNs and FunctionName values referenced inside a state machine definition */
export function refsFromDefinition(definition?: string | null): string[] {
  if (!definition) return [];
  const out = new Set<string>();
  for (const m of definition.matchAll(/arn:aws[a-z-]*:[^"'\s,]+/g)) out.add(m[0]);
  for (const m of definition.matchAll(/"FunctionName"\s*:\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of definition.matchAll(/"(?:QueueUrl|TopicArn|TableName|StateMachineArn|Bucket)"\s*:\s*"([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

async function sqs(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]) {
  const client = ctx.clients.get(SQSClient);
  const urls = await collect(paginateListQueues({ client }, {}), (p) => p.QueueUrls);
  await Promise.all(
    urls.map(async (url) => {
      const name = url.split('/').pop() ?? url;
      const res = await attempt(ctx, `sqs attributes ${name}`, () => client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] })));
      const a: Record<string, string | undefined> = res?.Attributes ?? {};
      let dlq: string | undefined;
      try {
        dlq = a.RedrivePolicy ? (JSON.parse(a.RedrivePolicy) as { deadLetterTargetArn?: string }).deadLetterTargetArn : undefined;
      } catch { /* malformed policy: ignore */ }
      const num = (k: string) => (a[k] != null ? Number(a[k]) : null);
      const retentionDays = a.MessageRetentionPeriod ? Math.round((Number(a.MessageRetentionPeriod) / 86400) * 10) / 10 : null;
      nodes.push({
        id: nid('sqs-queue', name),
        type: 'sqs-queue',
        category: 'integration',
        name,
        nativeId: name,
        arn: a.QueueArn ?? `arn:aws:sqs:${ctx.region}:${ctx.account}:${name}`,
        region: ctx.region,
        status: res ? 'healthy' : 'unknown',
        props: {
          URL: url,
          유형: a.FifoQueue === 'true' ? 'FIFO' : '표준',
          '대기 메시지': num('ApproximateNumberOfMessages'),
          '처리 중': num('ApproximateNumberOfMessagesNotVisible'),
          지연: num('ApproximateNumberOfMessagesDelayed'),
          '가시성 타임아웃': a.VisibilityTimeout ? `${a.VisibilityTimeout}s` : null,
          '보존 기간': retentionDays != null ? `${retentionDays}일` : null,
          DLQ: dlq ? arnName(dlq) : null,
          암호화: a.KmsMasterKeyId ?? (a.SqsManagedSseEnabled === 'true' ? 'SQS 관리' : null),
          생성: a.CreatedTimestamp ? iso(new Date(Number(a.CreatedTimestamp) * 1000)) : null,
        },
        refs: a.KmsMasterKeyId ? [a.KmsMasterKeyId] : undefined,
      });
      if (dlq) edges.push(edge('routes', nid('sqs-queue', name), nid('sqs-queue', arnName(dlq)), { label: 'DLQ' }));
    }),
  );
}

async function sns(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]) {
  const client = ctx.clients.get(SNSClient);
  const topics = await collect(paginateListTopics({ client }, {}), (p) => p.Topics);
  await Promise.all(
    topics.map(async (t) => {
      if (!t.TopicArn) return;
      const arn = t.TopicArn;
      const name = arnName(arn);
      const [attrs, subs] = await Promise.all([
        attempt(ctx, `sns attributes ${name}`, () => client.send(new GetTopicAttributesCommand({ TopicArn: arn }))),
        attempt(ctx, `sns subscriptions ${name}`, () => collect(paginateListSubscriptionsByTopic({ client }, { TopicArn: arn }), (p) => p.Subscriptions)),
      ]);
      const a = attrs?.Attributes ?? {};
      const byProtocol: Record<string, number> = {};
      for (const s of subs ?? []) {
        const proto = s.Protocol ?? '?';
        byProtocol[proto] = (byProtocol[proto] ?? 0) + 1;
        const ep = s.Endpoint;
        if (!ep) continue;
        if (proto === 'lambda') {
          const fn = lambdaNameFromArn(ep);
          if (fn) edges.push(edge('invokes', nid('sns-topic', name), nid('lambda', fn)));
        } else if (proto === 'sqs') {
          edges.push(edge('publishes', nid('sns-topic', name), nid('sqs-queue', arnName(ep))));
        }
      }
      nodes.push({
        id: nid('sns-topic', name),
        type: 'sns-topic',
        category: 'integration',
        name: a.DisplayName || name,
        nativeId: name,
        arn,
        region: ctx.region,
        status: attrs ? 'healthy' : 'unknown',
        props: {
          유형: a.FifoTopic === 'true' ? 'FIFO' : '표준',
          '표시 이름': a.DisplayName || null,
          '구독 확인': a.SubscriptionsConfirmed != null ? Number(a.SubscriptionsConfirmed) : null,
          '구독 대기': a.SubscriptionsPending != null ? Number(a.SubscriptionsPending) : null,
          구독: countSummary(byProtocol),
          암호화: a.KmsMasterKeyId ?? null,
        },
        refs: a.KmsMasterKeyId ? [a.KmsMasterKeyId] : undefined,
      });
    }),
  );
}

async function eventbridge(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]) {
  const client = ctx.clients.get(EventBridgeClient);
  const buses: EventBus[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(new ListEventBusesCommand({ NextToken: token, Limit: 100 }));
    buses.push(...(res.EventBuses ?? []));
    token = res.NextToken;
  } while (token);

  const rules: Array<{ bus: string; rule: Rule }> = [];
  await Promise.all(
    buses.map(async (b) => {
      if (!b.Name) return;
      const bus = b.Name;
      await attempt(ctx, `eventbridge rules ${bus}`, async () => {
        let next: string | undefined;
        do {
          const res = await client.send(new ListRulesCommand({ EventBusName: bus, NextToken: next, Limit: 100 }));
          for (const r of res.Rules ?? []) rules.push({ bus, rule: r });
          next = res.NextToken;
        } while (next);
      });
    }),
  );

  await Promise.all(
    rules.map(async ({ bus, rule: r }) => {
      if (!r.Name) return;
      const nativeId = bus === 'default' ? r.Name : `${bus}/${r.Name}`;
      const id = nid('eventbridge-rule', nativeId);
      const res = await attempt(ctx, `eventbridge targets ${nativeId}`, () => client.send(new ListTargetsByRuleCommand({ Rule: r.Name, EventBusName: bus })));
      const targets: Target[] = res?.Targets ?? [];
      const refs = new Set<string>();
      for (const t of targets) {
        if (!t.Arn) continue;
        const target = targetNodeId(t.Arn);
        if (target) edges.push(edge('invokes', id, target, { label: t.EcsParameters?.TaskDefinitionArn ? arnName(t.EcsParameters.TaskDefinitionArn) : undefined }));
        else refs.add(t.Arn);
        if (t.RoleArn) refs.add(t.RoleArn);
        if (t.DeadLetterConfig?.Arn) refs.add(t.DeadLetterConfig.Arn);
      }
      const state = r.State ?? 'unknown';
      const status: Status = state.startsWith('ENABLED') ? 'healthy' : state === 'DISABLED' ? 'inactive' : 'unknown';
      nodes.push({
        id,
        type: 'eventbridge-rule',
        category: 'integration',
        name: r.Name,
        nativeId,
        arn: r.Arn,
        region: ctx.region,
        status,
        statusLabel: state,
        props: {
          버스: bus,
          상태: state,
          스케줄: r.ScheduleExpression ?? null,
          '이벤트 패턴': truncate(r.EventPattern, 120),
          '타깃 수': targets.length,
          설명: r.Description || null,
          '관리 주체': r.ManagedBy ?? null,
          _ruleName: r.Name,
        },
        refs: [...refs],
      });
    }),
  );
}

async function stepFunctions(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]) {
  const client = ctx.clients.get(SFNClient);
  const machines = await collect(paginateListStateMachines({ client }, {}), (p) => p.stateMachines);
  await Promise.all(
    machines.map(async (m) => {
      if (!m.name || !m.stateMachineArn) return;
      const detail = await attempt(ctx, `sfn describe ${m.name}`, () => client.send(new DescribeStateMachineCommand({ stateMachineArn: m.stateMachineArn })));
      const refs = new Set(refsFromDefinition(detail?.definition));
      if (detail?.roleArn) refs.add(detail.roleArn);
      const status = detail?.status ?? 'ACTIVE';
      nodes.push({
        id: nid('step-function', m.name),
        type: 'step-function',
        category: 'integration',
        name: m.name,
        nativeId: m.name,
        arn: m.stateMachineArn,
        region: ctx.region,
        status: status === 'ACTIVE' ? 'healthy' : status === 'DELETING' ? 'warning' : 'unknown',
        statusLabel: status,
        props: {
          유형: m.type ?? detail?.type ?? null,
          상태: status,
          생성일: iso(m.creationDate),
          설명: detail?.description || null,
          '참조 리소스': refs.size,
        },
        refs: [...refs],
      });
      if (detail?.roleArn) edges.push(edge('assumes', nid('step-function', m.name), nid('iam-role', arnName(detail.roleArn))));
    }),
  );
}

async function run(ctx: CollectorContext) {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];
  const parts = [sqs, sns, eventbridge, stepFunctions];
  const results = await Promise.allSettled(parts.map((p) => p(ctx, nodes, edges)));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${parts[i].name}: ${errMsg(r.reason)}`] : []));
  if (failed.length === results.length) throw new Error(failed.join('; '));
  for (const f of failed) ctx.log(`[messaging] ${f}`);
  return { nodes, edges };
}

export const messagingCollector: Collector = { name: 'messaging', label: 'SQS·SNS·EventBridge·Step Functions', run };
