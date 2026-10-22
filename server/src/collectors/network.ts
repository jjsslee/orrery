/**
 * VPC fabric: VPCs, subnets (public/private via route tables), internet
 * gateways, NAT gateways and VPC endpoints. This collector defines the
 * containment skeleton every other collector hangs resources on:
 *   vpc:<id>  ⊃  subnet:<id>  ⊃  (instances, databases, ...)
 */
import {
  EC2Client,
  paginateDescribeVpcs,
  paginateDescribeSubnets,
  paginateDescribeRouteTables,
  paginateDescribeInternetGateways,
  paginateDescribeNatGateways,
  paginateDescribeVpcEndpoints,
  type RouteTable,
} from '@aws-sdk/client-ec2';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, nameFromTags, nid, statusFromState, tagsToRecord } from './ids.ts';

interface SubnetRouting {
  routeTableId?: string;
  public: boolean;
  natGatewayIds: string[];
}

function classifyRoutes(subnetId: string, vpcId: string, tables: RouteTable[]): SubnetRouting {
  const explicit = tables.find((t) => t.Associations?.some((a) => a.SubnetId === subnetId));
  const main = tables.find((t) => t.VpcId === vpcId && t.Associations?.some((a) => a.Main));
  const table = explicit ?? main;
  const routes = table?.Routes ?? [];
  return {
    routeTableId: table?.RouteTableId,
    public: routes.some((r) => r.GatewayId?.startsWith('igw-') && r.State !== 'blackhole'),
    natGatewayIds: routes.flatMap((r) => (r.NatGatewayId ? [r.NatGatewayId] : [])),
  };
}

async function run(ctx: CollectorContext) {
  const ec2 = ctx.clients.get(EC2Client);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [vpcs, subnets, routeTables, igws, nats, endpoints] = await Promise.all([
    collect(paginateDescribeVpcs({ client: ec2 }, {}), (p) => p.Vpcs),
    collect(paginateDescribeSubnets({ client: ec2 }, {}), (p) => p.Subnets),
    collect(paginateDescribeRouteTables({ client: ec2 }, {}), (p) => p.RouteTables),
    collect(paginateDescribeInternetGateways({ client: ec2 }, {}), (p) => p.InternetGateways),
    collect(paginateDescribeNatGateways({ client: ec2 }, {}), (p) => p.NatGateways),
    collect(paginateDescribeVpcEndpoints({ client: ec2 }, {}), (p) => p.VpcEndpoints),
  ]);

  for (const v of vpcs) {
    if (!v.VpcId) continue;
    const tags = tagsToRecord(v.Tags);
    nodes.push({
      id: nid('vpc', v.VpcId),
      type: 'vpc',
      category: 'network',
      name: nameFromTags(tags, v.VpcId),
      nativeId: v.VpcId,
      region: ctx.region,
      status: statusFromState(v.State),
      statusLabel: v.State,
      props: {
        CIDR: v.CidrBlock ?? null,
        '추가 CIDR': (v.CidrBlockAssociationSet ?? []).map((c) => c.CidrBlock).filter((c) => c && c !== v.CidrBlock).join(', ') || null,
        '기본 VPC': Boolean(v.IsDefault),
        테넌시: v.InstanceTenancy ?? null,
      },
      tags,
    });
  }

  for (const s of subnets) {
    if (!s.SubnetId || !s.VpcId) continue;
    const tags = tagsToRecord(s.Tags);
    const routing = classifyRoutes(s.SubnetId, s.VpcId, routeTables);
    nodes.push({
      id: nid('subnet', s.SubnetId),
      type: 'subnet',
      category: 'network',
      name: nameFromTags(tags, s.SubnetId),
      nativeId: s.SubnetId,
      region: ctx.region,
      parentId: nid('vpc', s.VpcId),
      az: s.AvailabilityZone,
      status: statusFromState(s.State),
      statusLabel: routing.public ? '퍼블릭' : '프라이빗',
      props: {
        CIDR: s.CidrBlock ?? null,
        가용영역: s.AvailabilityZone ?? null,
        '남은 IP': s.AvailableIpAddressCount ?? null,
        퍼블릭: routing.public,
        '퍼블릭 IP 자동 할당': Boolean(s.MapPublicIpOnLaunch),
        '라우트 테이블': routing.routeTableId ?? null,
      },
      tags,
    });
    for (const natId of routing.natGatewayIds) {
      edges.push(edge('routes', nid('subnet', s.SubnetId), nid('nat-gateway', natId), { label: '0.0.0.0/0' }));
    }
  }

  for (const g of igws) {
    if (!g.InternetGatewayId) continue;
    const tags = tagsToRecord(g.Tags);
    const attachment = g.Attachments?.[0];
    nodes.push({
      id: nid('internet-gateway', g.InternetGatewayId),
      type: 'internet-gateway',
      category: 'network',
      name: nameFromTags(tags, g.InternetGatewayId),
      nativeId: g.InternetGatewayId,
      region: ctx.region,
      parentId: attachment?.VpcId ? nid('vpc', attachment.VpcId) : undefined,
      status: attachment ? statusFromState(attachment.State) : 'inactive',
      statusLabel: attachment?.State ?? 'detached',
      props: { 연결: attachment?.VpcId ?? null },
      tags,
    });
  }

  for (const n of nats) {
    if (!n.NatGatewayId) continue;
    const tags = tagsToRecord(n.Tags);
    const addr = n.NatGatewayAddresses?.[0];
    nodes.push({
      id: nid('nat-gateway', n.NatGatewayId),
      type: 'nat-gateway',
      category: 'network',
      name: nameFromTags(tags, n.NatGatewayId),
      nativeId: n.NatGatewayId,
      region: ctx.region,
      parentId: n.SubnetId ? nid('subnet', n.SubnetId) : n.VpcId ? nid('vpc', n.VpcId) : undefined,
      status: statusFromState(n.State),
      statusLabel: n.State,
      props: {
        유형: n.ConnectivityType ?? 'public',
        '퍼블릭 IP': addr?.PublicIp ?? null,
        '프라이빗 IP': addr?.PrivateIp ?? null,
        생성: n.CreateTime?.toISOString() ?? null,
      },
      tags,
    });
  }

  for (const e of endpoints) {
    if (!e.VpcEndpointId) continue;
    const tags = tagsToRecord(e.Tags);
    const short = (e.ServiceName ?? '').split('.').slice(3).join('.') || e.ServiceName || '';
    nodes.push({
      id: nid('vpc-endpoint', e.VpcEndpointId),
      type: 'vpc-endpoint',
      category: 'network',
      name: nameFromTags(tags, short || e.VpcEndpointId),
      nativeId: e.VpcEndpointId,
      region: ctx.region,
      parentId: e.VpcId ? nid('vpc', e.VpcId) : undefined,
      status: statusFromState(e.State),
      statusLabel: e.State,
      props: {
        서비스: e.ServiceName ?? null,
        유형: e.VpcEndpointType ?? null,
        서브넷: e.SubnetIds?.length ?? 0,
        '프라이빗 DNS': Boolean(e.PrivateDnsEnabled),
      },
      tags,
    });
    for (const sg of e.Groups ?? []) {
      if (sg.GroupId) edges.push(edge('attached', nid('vpc-endpoint', e.VpcEndpointId), nid('security-group', sg.GroupId)));
    }
  }

  return { nodes, edges };
}

async function collect<P, T>(pages: AsyncIterable<P>, pick: (page: P) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(...(pick(page) ?? []));
  return out;
}

export const networkCollector: Collector = { name: 'network', label: 'VPC·서브넷·게이트웨이', run };
