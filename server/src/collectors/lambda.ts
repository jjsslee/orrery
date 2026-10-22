/**
 * Lambda functions and their event source mappings.
 *   lambda → vpc (containment when VPC-attached), lambda → sg (attached),
 *   lambda → IAM role (assumes), SQS/DynamoDB stream → lambda (invokes),
 *   lambda → DLQ (routes). Env var values, KMS and role ARNs go to refs.
 */
import { LambdaClient, paginateListEventSourceMappings, paginateListFunctions } from '@aws-sdk/client-lambda';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, arnPath, arnService, edge, iso, nid, statusFromState, fmtBytes } from './ids.ts';
import { collect, errMsg, lambdaNameFromArn } from './util.ts';

/** Event source ARN → node id of the source we collect (undefined for kinesis/msk/...) */
export function eventSourceNodeId(arn: string): string | undefined {
  const service = arnService(arn);
  if (service === 'sqs') return nid('sqs-queue', arnName(arn));
  if (service === 'dynamodb') return nid('dynamodb-table', arnPath(arn).split('/')[0]);
  return undefined;
}

async function run(ctx: CollectorContext) {
  const lambda = ctx.clients.get(LambdaClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [functions, mappings] = await Promise.all([
    collect(paginateListFunctions({ client: lambda }, {}), (p) => p.Functions),
    collect(paginateListEventSourceMappings({ client: lambda }, {}), (p) => p.EventSourceMappings).catch((err) => {
      ctx.log(`[lambda] ListEventSourceMappings 실패: ${errMsg(err)}`);
      return [];
    }),
  ]);

  for (const f of functions) {
    if (!f.FunctionName) continue;
    const name = f.FunctionName;
    const vpcId = f.VpcConfig?.VpcId || undefined;
    const roleName = f.Role ? arnName(f.Role) : undefined;
    const envValues = Object.values(f.Environment?.Variables ?? {});
    const refs = [
      ...envValues,
      f.Role,
      f.KMSKeyArn,
      f.DeadLetterConfig?.TargetArn,
      ...(f.FileSystemConfigs ?? []).map((c) => c.Arn),
    ].filter((r): r is string => Boolean(r));
    // ListFunctions omits State (only GetFunctionConfiguration returns it): no state → assume active.
    let status: Status = f.State ? statusFromState(f.State) : 'healthy';
    let statusLabel: string | undefined = f.State;
    if (f.LastUpdateStatus === 'Failed') { status = 'critical'; statusLabel = 'LastUpdate Failed'; }
    nodes.push({
      id: nid('lambda', name),
      type: 'lambda',
      category: 'compute',
      name,
      nativeId: name,
      arn: f.FunctionArn,
      region: ctx.region,
      parentId: vpcId ? nid('vpc', vpcId) : undefined,
      status,
      statusLabel,
      props: {
        런타임: f.Runtime ?? (f.PackageType === 'Image' ? '컨테이너 이미지' : null),
        메모리: f.MemorySize != null ? `${f.MemorySize} MB` : null,
        타임아웃: f.Timeout != null ? `${f.Timeout}s` : null,
        상태: f.State ?? f.LastUpdateStatus ?? null,
        '마지막 수정': iso(f.LastModified),
        아키텍처: (f.Architectures ?? []).join(', ') || null,
        패키지: f.PackageType ?? 'Zip',
        레이어: f.Layers?.length ?? 0,
        VPC: vpcId ?? null,
        핸들러: f.Handler ?? null,
        '코드 크기': f.CodeSize != null ? fmtBytes(f.CodeSize) : null,
        '환경 변수': envValues.length,
      },
      refs,
    });
    for (const sg of f.VpcConfig?.SecurityGroupIds ?? []) edges.push(edge('attached', nid('lambda', name), nid('security-group', sg)));
    if (roleName) edges.push(edge('assumes', nid('lambda', name), nid('iam-role', roleName)));
    const dlq = f.DeadLetterConfig?.TargetArn;
    if (dlq) {
      const svc = arnService(dlq);
      const target = svc === 'sqs' ? nid('sqs-queue', arnName(dlq)) : svc === 'sns' ? nid('sns-topic', arnName(dlq)) : undefined;
      if (target) edges.push(edge('routes', nid('lambda', name), target, { label: 'DLQ' }));
    }
  }

  for (const m of mappings) {
    if (!m.EventSourceArn || !m.FunctionArn) continue;
    const source = eventSourceNodeId(m.EventSourceArn);
    const fn = lambdaNameFromArn(m.FunctionArn);
    if (!source || !fn) continue;
    const state = m.State ?? 'unknown';
    const status: Status = state === 'Enabled' ? 'healthy' : state === 'Disabled' ? 'inactive' : 'warning';
    edges.push(edge('invokes', source, nid('lambda', fn), { label: state, status, props: { '배치 크기': m.BatchSize ?? null } }));
  }

  return { nodes, edges };
}

export const lambdaCollector: Collector = { name: 'lambda', label: 'Lambda', run };
