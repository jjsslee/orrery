import { EC2Client, paginateDescribeTransitGateways, paginateDescribeTransitGatewayAttachments } from '@aws-sdk/client-ec2';
import type { Collector } from './types.ts';
import type { ResourceNode, ResourceEdge } from '@orrery/shared';
import { nid, edge, nameFromTags, tagsToRecord, statusFromState } from './ids.ts';
import { attempt, collect } from './util.ts';

export const transitCollector: Collector = {
  name: 'transit', label: 'Transit Gateway',
  async run(ctx) {
    const client = ctx.clients.get(EC2Client);
    const gateways = await collect(paginateDescribeTransitGateways({ client }, {}), (p) => p.TransitGateways);
    const attachments = await attempt(ctx, 'transit attachments', () => collect(paginateDescribeTransitGatewayAttachments({ client }, {}), (p) => p.TransitGatewayAttachments));
    const nodes: ResourceNode[] = gateways.flatMap((g) => {
      if (!g.TransitGatewayId) return [];
      const tags = tagsToRecord(g.Tags);
      return [{ id: nid('transit-gateway', g.TransitGatewayId), type: 'transit-gateway', category: 'network',
        nativeId: g.TransitGatewayId, arn: g.TransitGatewayArn, name: nameFromTags(tags, g.TransitGatewayId), region: ctx.region,
        status: statusFromState(g.State), statusLabel: g.State, tags,
        props: { 설명: g.Description ?? null, ASN: g.Options?.AmazonSideAsn ?? null, '연결 수': attachments ? attachments.filter((a) => a.TransitGatewayId === g.TransitGatewayId).length : null },
      }];
    });
    const edges: ResourceEdge[] = [];
    for (const a of attachments ?? []) {
      if (a.ResourceType !== 'vpc' || !a.ResourceId || !a.TransitGatewayId || a.State !== 'available') continue;
      edges.push(edge('attached', nid('vpc', a.ResourceId), nid('transit-gateway', a.TransitGatewayId), { label: a.TransitGatewayAttachmentId }));
    }
    return { nodes, edges };
  },
};
