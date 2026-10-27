import { ServiceDiscoveryClient, GetNamespaceCommand, GetServiceCommand, ListTagsForResourceCommand, paginateListNamespaces, paginateListServices } from '@aws-sdk/client-servicediscovery';
import type { Collector } from './types.ts';
import type { ResourceNode, ResourceEdge } from '@orrery/shared';
import { nid, edge, tagsToRecord } from './ids.ts';
import { attempt, collect } from './util.ts';

export const discoveryCollector: Collector = {
  name: 'discovery', label: 'Cloud Map',
  async run(ctx) {
    const client = ctx.clients.get(ServiceDiscoveryClient);
    const namespaces = await collect(paginateListNamespaces({ client }, {}), (p) => p.Namespaces);
    const nodes: ResourceNode[] = [];
    const edges: ResourceEdge[] = [];
    await Promise.all(namespaces.map(async (s) => {
      if (!s.Id) return;
      const d = await attempt(ctx, `cloudmap namespace ${s.Id}`, () => client.send(new GetNamespaceCommand({ Id: s.Id! })));
      const n = d?.Namespace ?? s;
      const tags = n.Arn ? await attempt(ctx, `cloudmap tags ${s.Id}`, () => client.send(new ListTagsForResourceCommand({ ResourceARN: n.Arn! }))) : undefined;
      nodes.push({ id: nid('cloudmap-namespace', s.Id), type: 'cloudmap-namespace', category: 'network', name: n.Name ?? s.Id, nativeId: s.Id, arn: n.Arn,
        region: ctx.region, status: 'unknown', statusLabel: d?.Namespace ? undefined : '상세 미수집', props: { 유형: n.Type ?? null, '서비스 수': n.ServiceCount ?? null }, tags: tagsToRecord(tags?.Tags) });
      const zone = n.Properties?.DnsProperties?.HostedZoneId;
      if (zone) edges.push(edge('attached', nid('cloudmap-namespace', s.Id), nid('route53-zone', zone.replace(/^\/hostedzone\//, ''))));
    }));
    const services = await collect(paginateListServices({ client }, {}), (p) => p.Services);
    await Promise.all(services.map(async (s) => {
      if (!s.Id) return;
      const d = await attempt(ctx, `cloudmap service ${s.Id}`, () => client.send(new GetServiceCommand({ Id: s.Id! })));
      const n = d?.Service ?? s;
      const tags = n.Arn ? await attempt(ctx, `cloudmap tags ${s.Id}`, () => client.send(new ListTagsForResourceCommand({ ResourceARN: n.Arn! }))) : undefined;
      nodes.push({ id: nid('cloudmap-service', s.Id), type: 'cloudmap-service', category: 'network', name: n.Name ?? s.Id, nativeId: s.Id, arn: n.Arn,
        region: ctx.region, status: 'unknown', statusLabel: d ? undefined : '상세 미수집',
        props: { '등록 인스턴스': n.InstanceCount ?? null, 유형: n.Type ?? null }, tags: tagsToRecord(tags?.Tags) });
      if (d?.Service?.NamespaceId) edges.push(edge('member', nid('cloudmap-namespace', d.Service.NamespaceId), nid('cloudmap-service', s.Id)));
    }));
    return { nodes, edges };
  },
};
