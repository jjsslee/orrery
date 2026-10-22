/**
 * Elastic Load Balancing v2: ALB/NLB/GWLB, target groups and target health.
 *   lb → vpc (containment), lb → security group (attached),
 *   lb → target group (targets), target group → instance/lambda/alb (targets)
 * IP targets are left to the ECS collector, which knows service ↔ target group.
 * Tags come from DescribeTags, 20 ARNs per call.
 */
import {
  ElasticLoadBalancingV2Client,
  DescribeTagsCommand,
  DescribeTargetHealthCommand,
  paginateDescribeListeners,
  paginateDescribeLoadBalancers,
  paginateDescribeTargetGroups,
  type TargetHealthDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, edge, iso, nid, statusFromState, tagsToRecord } from './ids.ts';
import { attempt, chunk, collect } from './util.ts';

interface HealthSummary { healthy: number; total: number }

function targetStatus(state?: string): Status {
  switch (state) {
    case 'healthy': return 'healthy';
    case 'unhealthy': return 'critical';
    case 'draining':
    case 'initial': return 'warning';
    case 'unused':
    case 'unavailable': return 'inactive';
    default: return 'unknown';
  }
}

function summarise(health: TargetHealthDescription[]): HealthSummary {
  const live = health.filter((h) => h.TargetHealth?.State !== 'draining');
  return { healthy: live.filter((h) => h.TargetHealth?.State === 'healthy').length, total: live.length };
}

function statusFromHealth(s: HealthSummary, fallback: Status): Status {
  if (s.total === 0) return fallback;
  if (s.healthy === 0) return 'critical';
  if (s.healthy < s.total) return 'warning';
  return 'healthy';
}

async function run(ctx: CollectorContext) {
  const elb = ctx.clients.get(ElasticLoadBalancingV2Client);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const [lbs, tgs] = await Promise.all([
    collect(paginateDescribeLoadBalancers({ client: elb }, {}), (p) => p.LoadBalancers),
    collect(paginateDescribeTargetGroups({ client: elb }, {}), (p) => p.TargetGroups),
  ]);

  const listenerSummary = new Map<string, string[]>();
  const tgHealth = new Map<string, TargetHealthDescription[]>();
  const tagsByArn = new Map<string, Record<string, string> | undefined>();
  const taggable = [...lbs.map((lb) => lb.LoadBalancerArn), ...tgs.map((tg) => tg.TargetGroupArn)].filter((a): a is string => Boolean(a));
  await Promise.all([
    ...chunk(taggable, 20).map(async (batch) => {
      const res = await attempt(ctx, 'elb tags', () => elb.send(new DescribeTagsCommand({ ResourceArns: batch })));
      for (const d of res?.TagDescriptions ?? []) if (d.ResourceArn) tagsByArn.set(d.ResourceArn, tagsToRecord(d.Tags));
    }),
    ...lbs.map(async (lb) => {
      if (!lb.LoadBalancerArn) return;
      const listeners = await attempt(ctx, `elb listeners ${lb.LoadBalancerName}`, () =>
        collect(paginateDescribeListeners({ client: elb }, { LoadBalancerArn: lb.LoadBalancerArn }), (p) => p.Listeners),
      );
      if (listeners) listenerSummary.set(lb.LoadBalancerArn, listeners.map((l) => `${l.Protocol ?? '?'}:${l.Port ?? '?'}`));
    }),
    ...tgs.map(async (tg) => {
      if (!tg.TargetGroupArn) return;
      const res = await attempt(ctx, `elb target health ${tg.TargetGroupName}`, () =>
        elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn })),
      );
      if (res) tgHealth.set(tg.TargetGroupArn, res.TargetHealthDescriptions ?? []);
    }),
  ]);

  const lbHealth = new Map<string, HealthSummary>();
  for (const tg of tgs) {
    if (!tg.TargetGroupArn) continue;
    const arn = tg.TargetGroupArn;
    const health = tgHealth.get(arn) ?? [];
    const summary = summarise(health);
    const known = tgHealth.has(arn);
    const status: Status = !known ? 'unknown' : summary.total === 0 ? 'inactive' : statusFromHealth(summary, 'unknown');
    const statusLabel = !known ? '헬스 미확인' : summary.total === 0 ? '타깃 없음' : `${summary.healthy}/${summary.total} 정상`;
    nodes.push({
      id: nid('target-group', arn),
      type: 'target-group',
      category: 'network',
      name: tg.TargetGroupName ?? arnName(arn),
      nativeId: arn,
      arn,
      region: ctx.region,
      parentId: tg.VpcId ? nid('vpc', tg.VpcId) : undefined,
      status,
      statusLabel,
      props: {
        '프로토콜/포트': tg.Protocol ? `${tg.Protocol}:${tg.Port ?? '-'}` : null,
        '타깃 유형': tg.TargetType ?? null,
        '헬스체크 경로': tg.HealthCheckPath ?? null,
        헬스체크: tg.HealthCheckProtocol ? `${tg.HealthCheckProtocol}:${tg.HealthCheckPort ?? 'traffic-port'} / ${tg.HealthCheckIntervalSeconds ?? '-'}s` : null,
        '정상/전체': known ? `${summary.healthy}/${summary.total}` : null,
        '로드밸런서 수': tg.LoadBalancerArns?.length ?? 0,
        'IP 유형': tg.IpAddressType ?? null,
      },
      tags: tagsByArn.get(arn),
    });
    for (const lbArn of tg.LoadBalancerArns ?? []) {
      edges.push(edge('targets', nid('load-balancer', lbArn), nid('target-group', arn), { status, label: known ? statusLabel : undefined }));
      const cur = lbHealth.get(lbArn) ?? { healthy: 0, total: 0 };
      cur.healthy += summary.healthy;
      cur.total += summary.total;
      lbHealth.set(lbArn, cur);
    }
    for (const h of health) {
      const id = h.Target?.Id;
      if (!id) continue;
      let targetId: string | undefined;
      if (tg.TargetType === 'instance' || id.startsWith('i-')) targetId = nid('ec2-instance', id);
      else if (tg.TargetType === 'lambda' || id.includes(':lambda:')) targetId = nid('lambda', arnName(id));
      else if (tg.TargetType === 'alb' || id.includes(':loadbalancer/')) targetId = nid('load-balancer', id);
      if (!targetId) continue; // ip targets: resolved by the ECS collector
      edges.push(
        edge('targets', nid('target-group', arn), targetId, {
          label: h.Target?.Port != null ? String(h.Target.Port) : undefined,
          status: targetStatus(h.TargetHealth?.State),
          props: { 상태: h.TargetHealth?.State ?? null, 사유: h.TargetHealth?.Reason ?? null },
        }),
      );
    }
  }

  for (const lb of lbs) {
    if (!lb.LoadBalancerArn) continue;
    const arn = lb.LoadBalancerArn;
    const state = lb.State?.Code ?? 'unknown';
    const base: Status = state === 'active' ? 'healthy' : state === 'active_impaired' ? 'warning' : statusFromState(state);
    const agg = lbHealth.get(arn);
    const status: Status = agg && base === 'healthy' ? statusFromHealth(agg, base) : base;
    const listeners = listenerSummary.get(arn);
    nodes.push({
      id: nid('load-balancer', arn),
      type: 'load-balancer',
      category: 'network',
      name: lb.LoadBalancerName ?? arnName(arn),
      nativeId: arn,
      arn,
      region: ctx.region,
      parentId: lb.VpcId ? nid('vpc', lb.VpcId) : undefined,
      status,
      statusLabel: agg && agg.total > 0 ? `${agg.healthy}/${agg.total} 정상` : state,
      props: {
        유형: lb.Type ?? null,
        스킴: lb.Scheme ?? null,
        DNS: lb.DNSName ?? null,
        상태: state,
        가용영역: (lb.AvailabilityZones ?? []).map((z) => z.ZoneName).filter(Boolean).join(', ') || null,
        리스너: listeners ? `${listeners.length}개${listeners.length ? ` (${listeners.join(', ')})` : ''}` : null,
        'IP 유형': lb.IpAddressType ?? null,
        생성: iso(lb.CreatedTime),
        _lbType: lb.Type ?? 'application',
      },
      tags: tagsByArn.get(arn),
    });
    for (const sg of lb.SecurityGroups ?? []) edges.push(edge('attached', nid('load-balancer', arn), nid('security-group', sg)));
  }

  return { nodes, edges };
}

export const elbCollector: Collector = { name: 'elb', label: 'ELB·타깃 그룹', run };
