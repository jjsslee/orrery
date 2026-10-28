import { OpenSearchServerlessClient, BatchGetCollectionCommand, ListTagsForResourceCommand, paginateListCollections } from '@aws-sdk/client-opensearchserverless';
import type { Collector } from './types.ts';
import { collectOpenSearchNetwork } from './opensearch-network.ts';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import { nid } from './ids.ts';
import { attempt, collect, hostOf, lowerTags } from './util.ts';

export const opensearchCollector: Collector = {
  name: 'opensearch', label: 'OpenSearch Serverless',
  async run(ctx) {
    const client = ctx.clients.get(OpenSearchServerlessClient);
    const summaries = await collect(paginateListCollections({ client }, {}), (p) => p.collectionSummaries);
    const nodes: ResourceNode[] = [];
    await Promise.all(summaries.map(async (s) => {
      if (!s.id) return;
      const result = await attempt(ctx, `aoss ${s.id}`, () => client.send(new BatchGetCollectionCommand({ ids: [s.id!] })));
      const d = result?.collectionDetails?.[0];
      const arn = d?.arn ?? s.arn;
      const tags = arn ? await attempt(ctx, `aoss tags ${s.id}`, () => client.send(new ListTagsForResourceCommand({ resourceArn: arn }))) : undefined;
      const status = d?.status ?? s.status;
      nodes.push({ id: nid('opensearch-collection', s.id), type: 'opensearch-collection', category: 'database', name: d?.name ?? s.name ?? s.id,
        nativeId: s.id, arn, region: ctx.region,
        status: !d ? 'unknown' : status === 'ACTIVE' ? 'healthy' : status === 'FAILED' ? 'critical' : 'warning',
        statusLabel: d ? status : '상세 미수집', props: { 유형: d?.type ?? null, 엔드포인트: hostOf(d?.collectionEndpoint) ?? null },
        tags: lowerTags(tags?.tags), refs: d?.kmsKeyArn ? [d.kmsKeyArn] : [],
      });
    }));
    const edges: ResourceEdge[] = [];
    await collectOpenSearchNetwork(ctx, nodes, edges);
    return { nodes, edges };
  },
};
