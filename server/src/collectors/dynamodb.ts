/**
 * DynamoDB tables: ListTables + DescribeTable per table (no tag calls).
 * The KMS key goes to refs so the assembler draws the encrypts edge.
 */
import { DynamoDBClient, DescribeTableCommand, paginateListTables } from '@aws-sdk/client-dynamodb';
import type { ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { fmtBytes, iso, nid, statusFromState } from './ids.ts';
import { attempt, collect } from './util.ts';

async function run(ctx: CollectorContext) {
  const ddb = ctx.clients.get(DynamoDBClient);
  const nodes: ResourceNode[] = [];

  const names = await collect(paginateListTables({ client: ddb }, {}), (p) => p.TableNames);
  await Promise.all(
    names.map(async (name) => {
      const res = await attempt(ctx, `dynamodb describe ${name}`, () => ddb.send(new DescribeTableCommand({ TableName: name })));
      const t = res?.Table;
      if (!t?.TableName) return;
      const billing = t.BillingModeSummary?.BillingMode ?? ((t.ProvisionedThroughput?.ReadCapacityUnits ?? 0) > 0 ? 'PROVISIONED' : 'PAY_PER_REQUEST');
      const rcu = t.ProvisionedThroughput?.ReadCapacityUnits ?? 0;
      const wcu = t.ProvisionedThroughput?.WriteCapacityUnits ?? 0;
      const refs = [t.SSEDescription?.KMSMasterKeyArn].filter((r): r is string => Boolean(r));
      nodes.push({
        id: nid('dynamodb-table', t.TableName),
        type: 'dynamodb-table',
        category: 'database',
        name: t.TableName,
        nativeId: t.TableName,
        arn: t.TableArn,
        region: ctx.region,
        status: statusFromState(t.TableStatus),
        statusLabel: t.TableStatus,
        props: {
          상태: t.TableStatus ?? null,
          '항목 수': t.ItemCount ?? null,
          크기: fmtBytes(t.TableSizeBytes),
          '빌링 모드': billing,
          '읽기/쓰기 용량': billing === 'PROVISIONED' ? `${rcu} / ${wcu}` : '온디맨드',
          스트림: t.StreamSpecification?.StreamEnabled ? t.StreamSpecification.StreamViewType ?? true : false,
          '글로벌 인덱스 수': t.GlobalSecondaryIndexes?.length ?? 0,
          '테이블 클래스': t.TableClassSummary?.TableClass ?? 'STANDARD',
          '삭제 보호': Boolean(t.DeletionProtectionEnabled),
          암호화: t.SSEDescription?.SSEType ?? '기본',
          생성일: iso(t.CreationDateTime),
        },
        refs,
      });
    }),
  );

  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return { nodes, edges: [] };
}

export const dynamodbCollector: Collector = { name: 'dynamodb', label: 'DynamoDB', run };
