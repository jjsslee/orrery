import { WAFV2Client, GetWebACLCommand, ListResourcesForWebACLCommand, ListWebACLsCommand, ListTagsForResourceCommand, type WebACLSummary, type Tag, type ListWebACLsCommandOutput, type ListTagsForResourceCommandOutput } from '@aws-sdk/client-wafv2';
import type { Collector } from './types.ts';
import type { ResourceNode, ResourceEdge } from '@orrery/shared';
import { nid, edge, tagsToRecord } from './ids.ts';
import { attempt } from './util.ts';

export function wafCollector(scope: 'REGIONAL' | 'CLOUDFRONT'): Collector {
  return { name: scope === 'REGIONAL' ? 'waf' : 'waf-edge', label: scope === 'REGIONAL' ? 'WAF' : 'WAF (CloudFront)',
    async run(ctx) {
      const client = ctx.clients.get(WAFV2Client, scope === 'CLOUDFRONT' ? 'us-east-1' : ctx.region);
      const summaries: WebACLSummary[] = [];
      let marker: string | undefined;
      do {
        const page: ListWebACLsCommandOutput = await client.send(new ListWebACLsCommand({ Scope: scope, NextMarker: marker, Limit: 100 }));
        summaries.push(...(page.WebACLs ?? []));
        marker = page.NextMarker;
      } while (marker);
      const nodes: ResourceNode[] = [];
      const edges: ResourceEdge[] = [];
      await Promise.all(summaries.map(async (s) => {
        if (!s.ARN || !s.Id || !s.Name) return;
        const arn = s.ARN;
        const [detail, tags] = await Promise.all([
          attempt(ctx, `waf ${s.Name}`, () => client.send(new GetWebACLCommand({ Scope: scope, Id: s.Id!, Name: s.Name! }))),
          attempt(ctx, `waf tags ${s.Name}`, async () => {
            const all: Tag[] = [];
            let next: string | undefined;
            do {
              const page: ListTagsForResourceCommandOutput = await client.send(new ListTagsForResourceCommand({ ResourceARN: arn, NextMarker: next, Limit: 100 }));
              all.push(...(page.TagInfoForResource?.TagList ?? []));
              next = page.NextMarker;
            } while (next);
            return all;
          }),
        ]);
        const d = detail?.WebACL;
        nodes.push({ id: nid('waf-acl', arn), type: 'waf-acl', category: 'security', name: s.Name, nativeId: arn, arn,
          region: scope === 'CLOUDFRONT' ? 'global' : ctx.region, status: 'unknown', statusLabel: d ? undefined : '상세 미수집',
          props: { 범위: scope, '규칙 수': d?.Rules?.length ?? null, '기본 동작': d?.DefaultAction?.Allow ? 'ALLOW' : d?.DefaultAction?.Block ? 'BLOCK' : null }, tags: tagsToRecord(tags) });
        if (scope === 'REGIONAL') {
          await Promise.all((['APPLICATION_LOAD_BALANCER', 'API_GATEWAY', 'APPSYNC'] as const).map(async (ResourceType) => {
            const resources = await attempt(ctx, `waf associations ${s.Name} ${ResourceType}`, () => client.send(new ListResourcesForWebACLCommand({ WebACLArn: arn, ResourceType })));
            for (const resource of resources?.ResourceArns ?? []) {
              const api = resource.match(/\/restapis\/([^/]+)\/stages\//);
              const app = resource.match(/:apis\/([^/]+)/);
              const source = ResourceType === 'APPLICATION_LOAD_BALANCER' ? nid('load-balancer', resource)
                : api ? nid('api-gateway', api[1]) : app ? nid('appsync-api', app[1]) : undefined;
              if (source) edges.push(edge('attached', source, nid('waf-acl', arn)));
            }
          }));
        }
      }));
      return { nodes, edges };
    },
  };
}
