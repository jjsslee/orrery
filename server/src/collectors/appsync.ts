/**
 * AppSync: Events APIs (ListApis) and GraphQL APIs (ListGraphqlApis), with
 * their data sources resolved into relationships (DynamoDB tables, Lambda
 * functions, service roles, HTTP endpoints) through `refs`.
 */
import {
  AppSyncClient,
  GetApiCommand,
  paginateListApis,
  paginateListChannelNamespaces,
  paginateListDataSources,
  paginateListGraphqlApis,
  type Api,
  type DataSource,
  type GraphqlApi,
} from '@aws-sdk/client-appsync';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { iso, nid, tagsToRecord } from './ids.ts';

const DS_LABEL: Record<string, string> = {
  AMAZON_DYNAMODB: 'DynamoDB',
  AWS_LAMBDA: 'Lambda',
  HTTP: 'HTTP',
  RELATIONAL_DATABASE: 'RDS',
  AMAZON_OPENSEARCH_SERVICE: 'OpenSearch',
  AMAZON_ELASTICSEARCH: 'OpenSearch',
  AMAZON_EVENTBRIDGE: 'EventBridge',
  AMAZON_BEDROCK_RUNTIME: 'Bedrock',
  NONE: '없음',
};

/** Identifiers a data source points at; the assembler turns them into edges. */
export function dataSourceRefs(ds: DataSource, account?: string): string[] {
  const refs = [
    account && ds.dynamodbConfig?.awsRegion && ds.dynamodbConfig.tableName ? `arn:aws:dynamodb:${ds.dynamodbConfig.awsRegion}:${account}:table/${ds.dynamodbConfig.tableName}` : ds.dynamodbConfig?.tableName,
    ds.lambdaConfig?.lambdaFunctionArn,
    ds.serviceRoleArn,
    ds.httpConfig?.endpoint,
    ds.relationalDatabaseConfig?.rdsHttpEndpointConfig?.dbClusterIdentifier,
    ds.eventBridgeConfig?.eventBusArn,
    ds.openSearchServiceConfig?.endpoint,
    ds.elasticsearchConfig?.endpoint,
  ];
  return refs.filter((r): r is string => typeof r === 'string' && r.length > 0);
}

/** "DynamoDB 2, Lambda 1" style summary. */
export function summarizeDataSources(list: DataSource[]): string | null {
  if (!list.length) return null;
  const counts = new Map<string, number>();
  for (const ds of list) {
    const label = DS_LABEL[ds.type ?? ''] ?? ds.type ?? '기타';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(', ');
}

const host = (url?: string): string | null => (url ? url.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').split('/')[0] : null);

async function drain<P, T>(pages: AsyncIterable<P>, pick: (page: P) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(...(pick(page) ?? []));
  return out;
}

async function run(ctx: CollectorContext) {
  const client = ctx.clients.get(AppSyncClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [eventApis, graphqlApis] = await Promise.all([
    drain(paginateListApis({ client }, {}), (p) => p.apis).catch((err) => { ctx.log(`[appsync list-apis] ${String(err)}`); return [] as Api[]; }),
    drain(paginateListGraphqlApis({ client }, {}), (p) => p.graphqlApis).catch((err) => { ctx.log(`[appsync list-graphql-apis] ${String(err)}`); return [] as GraphqlApi[]; }),
  ]);

  const dataSourcesFor = (apiId: string) =>
    ctx.limit(() => drain(paginateListDataSources({ client }, { apiId }), (p) => p.dataSources)).catch((err) => { ctx.log(`[appsync data sources ${apiId}] ${String(err)}`); return [] as DataSource[]; });

  await Promise.all([
    ...eventApis.map(async (listed) => {
      if (!listed.apiId) return;
      const apiId = listed.apiId;
      // ListApis omits dns / eventConfig; GetApi returns the full object (one call per API).
      const [detail, dataSources, namespaces] = await Promise.all([
        ctx.limit(() => client.send(new GetApiCommand({ apiId }))).then((r) => r.api).catch((err) => { ctx.log(`[appsync get-api ${apiId}] ${String(err)}`); return undefined; }),
        dataSourcesFor(apiId),
        ctx.limit(() => drain(paginateListChannelNamespaces({ client }, { apiId }), (p) => p.channelNamespaces)).catch((err) => { ctx.log(`[appsync namespaces ${apiId}] ${String(err)}`); return []; }),
      ]);
      const api = { ...listed, ...detail };
      const cfg = api.eventConfig;
      const providers = cfg?.authProviders ?? [];
      const refs = [
        ...dataSources.flatMap(ds => dataSourceRefs(ds, ctx.account)),
        ...providers.map((p) => p.lambdaAuthorizerConfig?.authorizerUri),
        ...providers.map((p) => p.cognitoConfig?.userPoolId),
        cfg?.logConfig?.cloudWatchLogsRoleArn,
      ].filter((r): r is string => Boolean(r));
      const http = api.dns?.HTTP ?? null;
      const realtime = api.dns?.REALTIME ?? null;
      nodes.push({
        id: nid('appsync-api', apiId),
        type: 'appsync-api',
        category: 'network',
        name: api.name ?? apiId,
        nativeId: apiId,
        arn: api.apiArn,
        region: ctx.region,
        status: 'unknown',
        statusLabel: 'Events',
        props: {
          유형: 'Events',
          엔드포인트: http,
          '실시간 엔드포인트': realtime,
          인증: providers.map((p) => p.authType).filter(Boolean).join(', ') || null,
          '연결 인증': (cfg?.connectionAuthModes ?? []).map((m) => m.authType).filter(Boolean).join(', ') || null,
          '채널 네임스페이스': namespaces.length,
          네임스페이스: namespaces.map((n) => n.name).filter(Boolean).slice(0, 8).join(', ') || null,
          '데이터 소스': summarizeDataSources(dataSources),
          로그: cfg?.logConfig?.logLevel ?? '꺼짐',
          'X-Ray': Boolean(api.xrayEnabled),
          소유자: api.ownerContact || null,
          생성: iso(api.created),
          _apiKind: 'events',
          _hosts: [http, realtime].filter(Boolean).join(','),
        },
        tags: tagsToRecord(api.tags),
        refs,
      });
    }),
    ...graphqlApis.map(async (api) => {
      if (!api.apiId) return;
      const apiId = api.apiId;
      const dataSources = await dataSourcesFor(apiId);
      const extra = api.additionalAuthenticationProviders ?? [];
      const refs = [
        ...dataSources.flatMap(ds => dataSourceRefs(ds, ctx.account)),
        api.userPoolConfig?.userPoolId,
        api.lambdaAuthorizerConfig?.authorizerUri,
        api.logConfig?.cloudWatchLogsRoleArn,
        ...extra.map((p) => p.userPoolConfig?.userPoolId),
        ...extra.map((p) => p.lambdaAuthorizerConfig?.authorizerUri),
      ].filter((r): r is string => Boolean(r));
      const graphql = host(api.uris?.GRAPHQL);
      const realtime = host(api.uris?.REALTIME);
      nodes.push({
        id: nid('appsync-api', apiId),
        type: 'appsync-api',
        category: 'network',
        name: api.name ?? apiId,
        nativeId: apiId,
        arn: api.arn,
        region: ctx.region,
        status: 'unknown',
        statusLabel: api.apiType === 'MERGED' ? 'GraphQL 병합' : 'GraphQL',
        props: {
          유형: api.apiType === 'MERGED' ? 'GraphQL (병합)' : 'GraphQL',
          엔드포인트: graphql,
          '실시간 엔드포인트': realtime,
          인증: [api.authenticationType, ...extra.map((p) => p.authenticationType)].filter(Boolean).join(', ') || null,
          가시성: api.visibility ?? null,
          '데이터 소스': summarizeDataSources(dataSources),
          로그: api.logConfig?.fieldLogLevel ?? '꺼짐',
          'X-Ray': Boolean(api.xrayEnabled),
          소유자: api.owner ?? null,
          _apiKind: 'graphql',
          _hosts: [graphql, realtime].filter(Boolean).join(','),
        },
        tags: tagsToRecord(api.tags),
        refs,
      });
    }),
  ]);

  return { nodes, edges };
}

export const appsyncCollector: Collector = { name: 'appsync', label: 'AppSync', run };
