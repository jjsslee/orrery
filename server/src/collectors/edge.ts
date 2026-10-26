/**
 * Edge services: CloudFront distributions, API Gateway (REST + HTTP/WebSocket)
 * and Route 53 hosted zones. Origins, alias targets and HTTP integration hosts
 * go to refs; Lambda integrations become explicit 'invokes' edges.
 */
import { CloudFrontClient, ListTagsForResourceCommand as ListDistributionTagsCommand, paginateListDistributions } from '@aws-sdk/client-cloudfront';
import { APIGatewayClient, GetIntegrationCommand, GetStagesCommand, paginateGetResources, paginateGetRestApis, type Integration } from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayV2Client,
  GetApisCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  type Route,
  GetStagesCommand as GetStagesV2Command,
  type Api,
  type Integration as IntegrationV2,
} from '@aws-sdk/client-apigatewayv2';
import {
  Route53Client,
  ListResourceRecordSetsCommand,
  ListTagsForResourcesCommand,
  paginateListHostedZones,
  type ListResourceRecordSetsCommandOutput,
  type ResourceRecordSet,
} from '@aws-sdk/client-route-53';
import type { FrontendDiscovery, RequestRoute, ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, iso, nid, tagsToRecord } from './ids.ts';
import { attempt, chunk, collect, countSummary, errMsg, hostOf, lambdaNameFromArn } from './util.ts';
import { cloudfrontRouting, integrationArn, restRequestRoute } from './request-routing.ts';
import { httpCors, restCors } from './cors.ts';

const MAX_V1_INTEGRATION_CALLS = 200;
const MAX_RECORDS_PER_ZONE = 2000;

/**
 * API Gateway integration URI → Lambda function name.
 *   arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<lambdaArn>/invocations
 *   arn:aws:lambda:<region>:<acct>:function:<name>[:<alias>]   (HTTP API shorthand)
 */
export function lambdaFromIntegrationUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const m = uri.match(/functions\/(arn:aws:lambda:[^/]+)\/invocations/);
  const arn = m?.[1] ?? (uri.startsWith('arn:aws:lambda:') ? uri : undefined);
  const name = lambdaNameFromArn(arn);
  return name && !name.includes('$') ? name : undefined;
}

/** HTTP(_PROXY) integration URI → host for refs (undefined for AWS service URIs) */
export function hostFromIntegrationUri(uri?: string | null): string | undefined {
  if (!uri || !/^https?:\/\//i.test(uri)) return undefined;
  return hostOf(uri);
}

interface RecordSummary { refs: string[]; names: string[]; byType: Record<string, number>; count: number }

export function summariseRecords(records: ResourceRecordSet[], region: string): RecordSummary {
  const refs = new Set<string>();
  const names: string[] = [];
  const byType: Record<string, number> = {};
  for (const r of records) {
    const type = r.Type ?? '?';
    byType[type] = (byType[type] ?? 0) + 1;
    const name = (r.Name ?? '').replace(/\\052/g, '*').replace(/\.$/, '');
    if (name && !names.includes(name) && names.length < 30) names.push(name);
    if (!['A', 'AAAA', 'CNAME'].includes(type)) continue;
    const alias = r.AliasTarget?.DNSName?.toLowerCase().replace(/\.$/, '').replace(/^dualstack\./, '');
    if (alias) {
      if (/^s3-website[.-]/.test(alias)) refs.add(`${name}.${alias}`);
      else refs.add(alias);
    }
    if (type === 'CNAME') for (const v of r.ResourceRecords ?? []) if (v.Value) refs.add(v.Value.toLowerCase().replace(/\.$/, ''));
  }
  return { refs: [...refs], names, byType, count: records.length };
}

async function cloudfront(ctx: CollectorContext, nodes: ResourceNode[], discovery: FrontendDiscovery) {
  const cf = ctx.clients.get(CloudFrontClient);
  const items = await collect(paginateListDistributions({ client: cf }, {}), (p) => p.DistributionList?.Items);
  const tagsByArn = new Map<string, Record<string, string> | undefined>();
  await Promise.all(
    items.map(async (d) => {
      if (!d.ARN) return;
      const res = await attempt(ctx, `cloudfront tags ${d.Id}`, () => cf.send(new ListDistributionTagsCommand({ Resource: d.ARN })));
      tagsByArn.set(d.ARN, tagsToRecord(res?.Tags?.Items));
    }),
  );
  for (const d of items) {
    if (!d.Id) continue;
    const origins = d.Origins?.Items ?? [];
    const aliases = d.Aliases?.Items ?? [];
    const defaultOrigin = origins.find((o) => o.Id === d.DefaultCacheBehavior?.TargetOriginId)?.DomainName ?? origins[0]?.DomainName ?? null;
    const deployed = d.Status === 'Deployed';
    discovery.hosting.push({ resourceId: nid('cloudfront', d.Id), hosts: [...new Set([d.DomainName, ...aliases].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()))], enabled: Boolean(d.Enabled), deployed });
    nodes.push({
      id: nid('cloudfront', d.Id),
      type: 'cloudfront',
      requestRouting: cloudfrontRouting(d),
      category: 'network',
      name: aliases[0] ?? d.DomainName ?? d.Id,
      nativeId: d.Id,
      arn: d.ARN,
      region: 'global',
      status: !d.Enabled ? 'inactive' : deployed ? 'healthy' : 'warning',
      statusLabel: d.Enabled ? d.Status : 'disabled',
      props: {
        도메인: d.DomainName ?? null,
        상태: d.Status ?? null,
        활성화: Boolean(d.Enabled),
        '대체 도메인': aliases.join(', ') || null,
        '오리진 수': origins.length,
        '기본 오리진': defaultOrigin,
        '가격 클래스': d.PriceClass ?? null,
        '마지막 수정': iso(d.LastModifiedTime),
        'HTTP 버전': d.HttpVersion ?? null,
        WAF: Boolean(d.WebACLId),
        설명: d.Comment || null,
      },
      tags: d.ARN ? tagsByArn.get(d.ARN) : undefined,
      refs: origins.map((o) => o.DomainName).filter((o): o is string => Boolean(o)),
    });
  }
}

async function apiGatewayV1(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[], discovery: FrontendDiscovery) {
  const apigw = ctx.clients.get(APIGatewayClient);
  const apis = await collect(paginateGetRestApis({ client: apigw }, { limit: 500 }), (p) => p.items);
  let integrationCalls = 0;
  await Promise.all(
    apis.map(async (api) => {
      if (!api.id) return;
      const id = api.id;
      const apiNodeId = nid('api-gateway', id);
      const [stages, resources] = await Promise.all([
        attempt(ctx, `apigw stages ${api.name}`, () => apigw.send(new GetStagesCommand({ restApiId: id }))),
        attempt(ctx, `apigw resources ${api.name}`, () => collect(paginateGetResources({ client: apigw }, { restApiId: id, embed: ['methods'], limit: 500 }), (p) => p.items)),
      ]);
      const missing = (path: string, method: string, issue: 'lookup-failed' | 'lookup-limit') => {
        discovery.cors.push({ targetId: apiNodeId, source: 'rest-integration-response', deployment: 'editable-config', path, method, responseType: method === 'OPTIONS' ? 'preflight' : 'actual-response', origins: [], issues: [issue] });
      };
      if (!resources) missing('*', '*', 'lookup-failed');
      const refs = new Set<string>();
      const lambdaRoutes = new Map<string, string[]>();
      const requestRoutes: RequestRoute[] = [];
      const kinds: Record<string, number> = {};
      const pending: Array<{ path: string; method: string }> = [];
      const consume = (path: string, method: string, integration?: Integration) => {
        if (!integration) return;
        discovery.cors.push(...restCors(apiNodeId, path, method, integration));
        requestRoutes.push(restRequestRoute(path, method, integration));
        kinds[integration.type ?? '?'] = (kinds[integration.type ?? '?'] ?? 0) + 1;
        const fn = lambdaFromIntegrationUri(integration.uri);
        if (fn) (lambdaRoutes.get(fn) ?? lambdaRoutes.set(fn, []).get(fn)!).push(`${method} ${path}`);
        const host = hostFromIntegrationUri(integration.uri);
        if (host) refs.add(host);
      };
      for (const r of resources ?? []) {
        for (const [method, m] of Object.entries(r.resourceMethods ?? {})) {
          if (m?.methodIntegration) consume(r.path ?? '/', method, m.methodIntegration);
          else if (r.id) pending.push({ path: r.path ?? '/', method });
          else missing(r.path ?? '/', method, 'lookup-failed');
        }
      }
      // Methods whose integration was not embedded: fetch individually, capped account-wide.
      await Promise.all(
        pending.map(async ({ path, method }) => {
          if (integrationCalls >= MAX_V1_INTEGRATION_CALLS) { missing(path, method, 'lookup-limit'); return; }
          integrationCalls += 1;
          const resourceId = (resources ?? []).find((r) => (r.path ?? '/') === path)?.id;
          if (!resourceId) return;
          const res = await attempt(ctx, `apigw integration ${api.name} ${method} ${path}`, () => apigw.send(new GetIntegrationCommand({ restApiId: id, resourceId, httpMethod: method })));
          if (res) consume(path, method, res);
          else missing(path, method, 'lookup-failed');
        }),
      );
      nodes.push({
        id: apiNodeId,
        type: 'api-gateway',
        category: 'network',
        name: api.name ?? id,
        nativeId: id,
        arn: `arn:aws:apigateway:${ctx.region}::/restapis/${id}`,
        region: ctx.region,
        status: stages?.item?.length ? 'healthy' : 'warning',
        statusLabel: stages?.item?.length ? `스테이지 ${stages.item.length}개` : '배포된 스테이지 없음',
        props: {
          유형: 'REST',
          엔드포인트: `${id}.execute-api.${ctx.region}.amazonaws.com`,
          생성일: iso(api.createdDate),
          스테이지: (stages?.item ?? []).map((s) => s.stageName).filter(Boolean).join(', ') || null,
          '엔드포인트 유형': (api.endpointConfiguration?.types ?? []).join(', ') || null,
          '리소스 수': resources?.length ?? null,
          통합: countSummary(kinds),
          설명: api.description || null,
          _apiKind: 'rest',
        },
        requestRouting: { kind: 'api', protocol: 'rest', routes: requestRoutes, stages: (stages?.item ?? []).flatMap((s) => s.stageName ? [s.stageName] : []), complete: Boolean(resources && stages) && !discovery.cors.some((r) => r.targetId === apiNodeId && r.issues.some((i) => i === 'lookup-failed' || i === 'lookup-limit')), deployment: 'editable-config' },
        tags: tagsToRecord(api.tags),
        refs: [...refs],
      });
      for (const [fn, routes] of lambdaRoutes) {
        edges.push(edge('invokes', apiNodeId, nid('lambda', fn), { label: routes.length === 1 ? routes[0] : `${routes.length}개 라우트` }));
      }
    }),
  );
}

async function apiGatewayV2(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[], discovery: FrontendDiscovery) {
  const v2 = ctx.clients.get(ApiGatewayV2Client);
  const apis: Api[] = [];
  let token: string | undefined;
  do {
    const res = await v2.send(new GetApisCommand({ MaxResults: '100', NextToken: token }));
    apis.push(...(res.Items ?? []));
    token = res.NextToken;
  } while (token);

  await Promise.all(
    apis.map(async (api) => {
      if (!api.ApiId) return;
      const id = api.ApiId;
      const apiNodeId = nid('api-gateway', id);
      const [stages, integrations, routes] = await Promise.all([
        attempt(ctx, `apigw v2 stages ${api.Name}`, () => v2.send(new GetStagesV2Command({ ApiId: id, MaxResults: '100' }))),
        attempt(ctx, `apigw v2 integrations ${api.Name}`, async () => {
          const items: IntegrationV2[] = [];
          let next: string | undefined;
          do {
            const res = await v2.send(new GetIntegrationsCommand({ ApiId: id, MaxResults: '100', NextToken: next }));
            items.push(...(res.Items ?? []));
            next = res.NextToken;
          } while (next);
          return items;
        }),
        attempt(ctx, `apigw routes ${api.Name}`, async () => {
          const items: Route[] = [];
          let next: string | undefined;
          do {
            const res = await v2.send(new GetRoutesCommand({ ApiId: id, MaxResults: '100', NextToken: next }));
            items.push(...(res.Items ?? []));
            next = res.NextToken;
          } while (next);
          return items;
        }),
      ]);
      const refs = new Set<string>();
      const lambdas = new Map<string, number>();
      const kinds: Record<string, number> = {};
      for (const i of integrations ?? []) {
        const kind = i.IntegrationSubtype ?? i.IntegrationType ?? '?';
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        const fn = lambdaFromIntegrationUri(i.IntegrationUri);
        if (fn) lambdas.set(fn, (lambdas.get(fn) ?? 0) + 1);
        const host = hostFromIntegrationUri(i.IntegrationUri);
        if (host) refs.add(host);
        for (const v of Object.values(i.RequestParameters ?? {})) if (v && (v.startsWith('arn:') || v.startsWith('https://'))) refs.add(v);
      }
      const kind = (api.ProtocolType ?? 'HTTP').toLowerCase();
      if (kind === 'http') discovery.cors.push(httpCors(apiNodeId, api.CorsConfiguration));
      nodes.push({
        id: apiNodeId,
        type: 'api-gateway',
        category: 'network',
        name: api.Name ?? id,
        nativeId: id,
        arn: `arn:aws:apigateway:${ctx.region}::/apis/${id}`,
        region: ctx.region,
        status: stages?.Items?.length ? 'healthy' : 'warning',
        statusLabel: stages?.Items?.length ? `스테이지 ${stages.Items.length}개` : '배포된 스테이지 없음',
        props: {
          유형: api.ProtocolType ?? 'HTTP',
          엔드포인트: hostOf(api.ApiEndpoint) ?? `${id}.execute-api.${ctx.region}.amazonaws.com`,
          생성일: iso(api.CreatedDate),
          스테이지: (stages?.Items ?? []).map((s) => s.StageName).filter(Boolean).join(', ') || null,
          '통합 수': integrations?.length ?? null,
          통합: countSummary(kinds),
          설명: api.Description || null,
          _apiKind: kind,
        },
        requestRouting: {
          kind: 'api', protocol: kind === 'http' ? 'http' : 'websocket', deployment: 'unverified',
          complete: Boolean(stages && integrations && routes && !stages.NextToken),
          stages: (stages?.Items ?? []).flatMap((s) => s.StageName ? [s.StageName] : []),
          routes: (routes ?? []).map((route) => {
            const integration = integrations?.find((i) => `integrations/${i.IntegrationId}` === route.Target);
            const key = route.RouteKey ?? '';
            const space = key.indexOf(' ');
            return { method: space < 0 ? 'ANY' : key.slice(0, space), path: space < 0 ? key : key.slice(space + 1), targetArn: integrationArn(integration?.IntegrationUri), integrationType: integration?.IntegrationType, async: Boolean(integration?.IntegrationSubtype) };
          }),
        },
        tags: api.Tags && Object.keys(api.Tags).length ? api.Tags : undefined,
        refs: [...refs],
      });
      for (const [fn, n] of lambdas) edges.push(edge('invokes', apiNodeId, nid('lambda', fn), { label: n > 1 ? `${n}개 통합` : undefined }));
    }),
  );
}

async function route53(ctx: CollectorContext, nodes: ResourceNode[]) {
  const r53 = ctx.clients.get(Route53Client);
  const zones = await collect(paginateListHostedZones({ client: r53 }, {}), (p) => p.HostedZones);
  const zoneIds = zones.map((z) => z.Id?.replace(/^\/hostedzone\//, '')).filter((id): id is string => Boolean(id));
  const tagsByZone = new Map<string, Record<string, string> | undefined>();
  await Promise.all(
    chunk(zoneIds, 10).map(async (batch) => {
      const res = await attempt(ctx, 'route53 tags', () => r53.send(new ListTagsForResourcesCommand({ ResourceType: 'hostedzone', ResourceIds: batch })));
      for (const set of res?.ResourceTagSets ?? []) if (set.ResourceId) tagsByZone.set(set.ResourceId, tagsToRecord(set.Tags));
    }),
  );
  await Promise.all(
    zones.map(async (z) => {
      if (!z.Id) return;
      const zoneId = z.Id.replace(/^\/hostedzone\//, '');
      const records = (await attempt(ctx, `route53 records ${z.Name}`, async () => {
        const out: ResourceRecordSet[] = [];
        let next: { name?: string; type?: string; identifier?: string } | undefined = {};
        while (next && out.length < MAX_RECORDS_PER_ZONE) {
          const res: ListResourceRecordSetsCommandOutput = await r53.send(
            new ListResourceRecordSetsCommand({
              HostedZoneId: zoneId,
              MaxItems: 300,
              StartRecordName: next.name,
              StartRecordType: next.type as never,
              StartRecordIdentifier: next.identifier,
            }),
          );
          out.push(...(res.ResourceRecordSets ?? []));
          next = res.IsTruncated ? { name: res.NextRecordName, type: res.NextRecordType, identifier: res.NextRecordIdentifier } : undefined;
        }
        return out;
      })) ?? [];
      const summary = summariseRecords(records, ctx.region);
      const domain = (z.Name ?? '').replace(/\.$/, '');
      nodes.push({
        id: nid('route53-zone', zoneId),
        type: 'route53-zone',
        category: 'network',
        name: domain || zoneId,
        nativeId: zoneId,
        arn: `arn:aws:route53:::hostedzone/${zoneId}`,
        region: 'global',
        status: 'healthy',
        props: {
          도메인: domain || null,
          프라이빗: Boolean(z.Config?.PrivateZone),
          '레코드 수': z.ResourceRecordSetCount ?? summary.count,
          '레코드 유형': countSummary(summary.byType),
          레코드: summary.names.join(', ') || null,
          설명: z.Config?.Comment || null,
        },
        tags: tagsByZone.get(zoneId),
        refs: summary.refs,
      });
    }),
  );
}

async function run(ctx: CollectorContext) {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];
  const frontendDiscovery: FrontendDiscovery = { hosting: [], cors: [], coverage: [] };
  const results = await Promise.allSettled([cloudfront(ctx, nodes, frontendDiscovery), apiGatewayV1(ctx, nodes, edges, frontendDiscovery), apiGatewayV2(ctx, nodes, edges, frontendDiscovery), route53(ctx, nodes)]);
  const services = ['cloudfront', 'rest-api', 'http-api'] as const;
  services.forEach((service, index) => {
    const incomplete = service === 'rest-api' && frontendDiscovery.cors.some((rule) => rule.issues.some((issue) => issue === 'lookup-failed' || issue === 'lookup-limit'));
    frontendDiscovery.coverage.push({ service, state: results[index].status === 'rejected' ? 'unavailable' : incomplete ? 'partial' : 'complete' });
  });
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${['cloudfront', 'apigw-v1', 'apigw-v2', 'route53'][i]}: ${errMsg(r.reason)}`] : []));
  if (failed.length === results.length) throw new Error(failed.join('; '));
  for (const f of failed) ctx.log(`[edge] ${f}`);
  return { nodes, edges, frontendDiscovery };
}

export const edgeCollector: Collector = { name: 'edge', label: 'CloudFront·API Gateway·Route 53', run };
