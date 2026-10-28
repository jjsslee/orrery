/**
 * Assembles collector outputs into one ResourceGraph:
 *  - merges duplicate nodes (first collector wins identity, props are merged)
 *  - drops edges whose endpoints were never collected
 *  - resolves free-text `refs` (env vars, image URIs, key ids, DNS names)
 *    into typed edges
 *  - attaches CloudWatch alarms to nodes and lifts their status
 */
import type { AlarmInfo, CollectorReport, EdgeKind, ResourceEdge, ResourceGraph, ResourceNode, ResourceType } from '@orrery/shared';
import type { CollectorOutput } from '../collectors/types.ts';
import { edge, nid } from '../collectors/ids.ts';

import { evaluateCleanup } from '../cleanup/evaluate.ts';

const STATUS_RANK = { unknown: 0, inactive: 1, healthy: 2, warning: 3, critical: 4 } as const;

export function assembleGraph(
  outputs: CollectorOutput[],
  reports: CollectorReport[],
  meta: { account: string; region: string; source: string },
): ResourceGraph {
  const nodes = new Map<string, ResourceNode>();
  for (const out of outputs) {
    for (const n of out.nodes) {
      const existing = nodes.get(n.id);
      if (!existing) {
        nodes.set(n.id, { ...n, props: { ...n.props } });
        continue;
      }
      existing.props = { ...existing.props, ...n.props };
      existing.parentId ??= n.parentId;
      existing.arn ??= n.arn;
      existing.az ??= n.az;
      existing.tags = existing.tags || n.tags ? { ...n.tags, ...existing.tags } : undefined;
      if (n.relations?.length) existing.relations = [...(existing.relations ?? []), ...n.relations];
      if (n.refs?.length) existing.refs = [...new Set([...(existing.refs ?? []), ...n.refs])];
      if (STATUS_RANK[n.status] > STATUS_RANK[existing.status]) {
        existing.status = n.status;
        existing.statusLabel = n.statusLabel ?? existing.statusLabel;
      }
    }
  }

  // Drop parents that do not exist (keeps the client-side tree consistent)
  let missingParents = 0;
  for (const n of nodes.values()) if (n.parentId && !nodes.has(n.parentId)) {
    missingParents++;
    n.props['소속 조회'] = `부모 자원 미수집: ${n.parentId}`;
  }

  const edges = new Map<string, ResourceEdge>();
  let dropped = 0;
  const addEdge = (e: ResourceEdge) => {
    if (e.source === e.target) return;
    if (!nodes.has(e.source) || !nodes.has(e.target)) { dropped++; return; }
    if (!edges.has(e.id)) edges.set(e.id, e);
  };
  for (const out of outputs) for (const e of out.edges) addEdge(e);

  for (const e of resolveRefs(nodes, meta)) addEdge(e);
  applyAlarms(nodes, outputs.flatMap((o) => o.alarms ?? []));

  const all = [...nodes.values()];
  for (const n of all) { delete n.refs; delete n.relations; } // internal only

  const collectedAt = new Date().toISOString();
  return {
    cleanup: evaluateCleanup(outputs.flatMap((o) => o.cleanup ? [o.cleanup] : []), all, reports, meta, collectedAt),
    account: meta.account,
    region: meta.region,
    source: meta.source,
    collectedAt,
    nodes: all,
    edges: [...edges.values()],
    reports: [...reports, { collector: 'assemble', ok: true, durationMs: 0, nodes: all.length, edges: edges.size, error: dropped || missingParents ? `미수집 연결 대상 ${dropped}개 · 미수집 소속 ${missingParents}개` : undefined }],
  };
}

/* ---------------------------------------------------------------- refs */

interface RefIndex {
  byArn: Map<string, ResourceNode>;
  byName: Map<string, ResourceNode>; // `${type}:${name}` for name-addressable types
  byDns: Map<string, ResourceNode>;
  byUrl: Map<string, ResourceNode>;
  names: Array<{ name: string; node: ResourceNode }>;
}

const NAME_ADDRESSABLE: ResourceType[] = [
  'dynamodb-table', 's3-bucket', 'sqs-queue', 'sns-topic', 'lambda', 'secret', 'ecr-repository', 'kms-key', 'iam-role',
  'elasticache', 'rds-instance', 'rds-cluster', 'efs', 'step-function', 'eventbridge-rule', 'cognito-user-pool', 'ecs-cluster',
];

function buildIndex(nodes: Map<string, ResourceNode>): RefIndex {
  const idx: RefIndex = { byArn: new Map(), byName: new Map(), byDns: new Map(), byUrl: new Map(), names: [] };
  for (const n of nodes.values()) {
    if (n.arn) idx.byArn.set(n.arn, n);
    if (NAME_ADDRESSABLE.includes(n.type)) {
      idx.byName.set(`${n.type}:${n.nativeId}`, n);
      if (n.nativeId.length >= 4) idx.names.push({ name: n.nativeId, node: n });
    }
    if (n.type === 'kms-key' && typeof n.props['_aliases'] === 'string') {
      for (const alias of n.props['_aliases'].split(',')) if (alias) idx.byName.set(`kms-key:${alias.trim()}`, n);
    }
    for (const key of ['DNS', 'dnsName', '도메인', '엔드포인트', '호스트']) {
      const v = n.props[key];
      if (typeof v === 'string' && v.includes('.')) idx.byDns.set(v.toLowerCase().replace(/\.$/, ''), n);
    }
    const url = n.props['URL'];
    if (typeof url === 'string' && url.startsWith('http')) idx.byUrl.set(url, n);
    const extraHosts = n.props['_hosts'];
    if (typeof extraHosts === 'string') for (const h of extraHosts.split(',')) if (h) idx.byDns.set(h.toLowerCase(), n);
  }
  return idx;
}

function kindFor(source: ResourceNode, target: ResourceNode): EdgeKind {
  if (source.type === 'cloudfront' && ['acm-certificate', 'waf-acl'].includes(target.type)) return 'attached';
  if (source.type === 'cloudfront') return 'origin';
  if (source.type === 'route53-zone') return 'resolves';
  return 'references';
}

function resolveRefs(nodes: Map<string, ResourceNode>, meta: { account: string; region: string }): ResourceEdge[] {
  const idx = buildIndex(nodes);
  const out: ResourceEdge[] = [];
  const link = (source: ResourceNode, target: ResourceNode | undefined, label?: string) => {
    if (!target || target.id === source.id) return;
    const kind = kindFor(source, target);
    // KMS edges point from key to the resource it protects
    if (kind === 'encrypts') out.push(edge('encrypts', target.id, source.id, { label }));
    else out.push(edge(kind, source.id, target.id, { label }));
  };

  for (const n of nodes.values()) {
    if (!n.refs?.length) continue;
    for (const raw of n.refs) {
      const ref = raw.trim();
      if (!ref) continue;
      if (ref.startsWith('arn:')) { const exact = idx.byArn.get(ref); const fallback = exact ? undefined : matchArnByName(ref, idx, meta); link(n, exact ?? (fallback && (!fallback.arn || ref.startsWith(fallback.arn + ':') || ref.startsWith(fallback.arn + '/') || String(fallback.props['_listenerArns'] ?? '').split(',').includes(ref)) ? fallback : undefined)); continue; }
      if (/^https?:\/\/sqs\./.test(ref)) { link(n, idx.byUrl.get(ref)); continue; }
      if (/^https?:\/\//.test(ref)) {
        const host = ref.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        link(n, idx.byDns.get(host) ?? matchHostSuffix(host, idx));
        continue;
      }
      if (idx.byDns.has(ref.toLowerCase().replace(/\.$/, ''))) { link(n, idx.byDns.get(ref.toLowerCase().replace(/\.$/, ''))); continue; }
      if (/\.amazonaws\.com$/i.test(ref) || /\.cloudfront\.net$/i.test(ref)) { link(n, idx.byDns.get(ref.toLowerCase()) ?? matchHostSuffix(ref.toLowerCase(), idx)); continue; }
      if (/\.dkr\.ecr\./.test(ref)) {
        const repo = ref.split('/').slice(1).join('/').split(/[:@]/)[0];
        const registry = ref.match(/^(\d+)\.dkr\.ecr\.([^.]+)\.amazonaws\.com(?:\.cn)?\//);
        if (registry?.[1] === meta.account && registry?.[2] === meta.region) link(n, idx.byName.get(`ecr-repository:${repo}`));
        continue;
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) { link(n, idx.byName.get(`kms-key:${ref}`)); continue; }
      if (ref.startsWith('alias/')) { link(n, idx.byName.get(`kms-key:${ref}`)); continue; }
      // Plain names: exact match on name-addressable types (longest name first to avoid prefixes)
      const exact = idx.names.filter((e) => e.name === ref);
      if (exact.length === 1) link(n, exact[0].node);
      else if (exact.length > 1) n.props['모호한 설정 참조'] = Number(n.props['모호한 설정 참조'] ?? 0) + 1;
    }
  }
  for (const n of [...nodes.values()]) for (const rel of n.relations ?? []) {
    const ref = rel.ref.trim();
    if (!ref) continue;
    const host = ref.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().replace(/\.$/, '');
    let target = idx.byArn.get(ref) ?? nodes.get(ref) ?? idx.byDns.get(host);
    if (!target && !ref.startsWith('arn:')) target = matchHostSuffix(host, idx);
    if (!target) {
      const id = nid('configuration-target', ref);
      target = nodes.get(id) ?? { id, nativeId: ref, name: ref, type: 'configuration-target', category: 'network', region: 'unknown', status: 'unknown', statusLabel: '구성에서 확인 · 자원 상세 미수집', props: { 식별자: ref, '확인 범위': '원본 설정의 연결 대상 · 실제 자원 상세/통신 성공은 미확인' } };
      nodes.set(id, target);
    }
    out.push(edge(rel.kind, n.id, target.id, { label: rel.label }));
  }
  return out;
}

function matchArnByName(arn: string, idx: RefIndex, meta: { account: string; region: string }): ResourceNode | undefined {
  const parts = arn.split(':');
  if (parts[1] !== 'aws' || (parts[3] && parts[3] !== meta.region) || (parts[4] && parts[4] !== meta.account)) return undefined;
  // Resolve only structurally defined subresources, never a foreign same-name ARN.
  const qualified = [...idx.byArn.entries()].filter(([base]) => arn.startsWith(`${base}:`) || arn.startsWith(`${base}/`));
  if (qualified.length === 1 && ['lambda', 'dynamodb-table', 's3-bucket'].includes(qualified[0][1].type)) return qualified[0][1];
  const listener = [...idx.byArn.values()].find(n => typeof n.props['_listenerArns'] === 'string' && n.props['_listenerArns'].split(',').includes(arn));
  if (listener) return listener;
  const service = arn.split(':')[2];
  const resource = arn.split(':').slice(5).join(':');
  const last = resource.split(/[/:]/).pop() ?? resource;
  const typeByService: Record<string, ResourceType> = {
    lambda: 'lambda', sqs: 'sqs-queue', sns: 'sns-topic', dynamodb: 'dynamodb-table', s3: 's3-bucket', kms: 'kms-key',
    secretsmanager: 'secret', iam: 'iam-role', states: 'step-function', ecr: 'ecr-repository', elasticfilesystem: 'efs',
    rds: resource.startsWith('cluster:') ? 'rds-cluster' : 'rds-instance', events: 'eventbridge-rule', 'cognito-idp': 'cognito-user-pool',
  };
  const type = typeByService[service];
  if (!type) return undefined;
  if (type === 's3-bucket') return idx.byName.get(`s3-bucket:${resource.split('/')[0]}`);
  if (type === 'secret') {
    // secret ARNs carry a random suffix: name-AbCdEf
    const name = last.replace(/-[A-Za-z0-9]{6}$/, '');
    return idx.byName.get(`secret:${name}`) ?? idx.byName.get(`secret:${last}`);
  }
  if (type === 'dynamodb-table') return idx.byName.get(`dynamodb-table:${resource.replace(/^table\//, '').split('/')[0]}`);
  return idx.byName.get(`${type}:${last}`) ?? idx.byName.get(`${type}:${resource}`);
}

function matchHostSuffix(host: string, idx: RefIndex): ResourceNode | undefined {
  // S3 website/virtual-host style: bucket.s3.region.amazonaws.com / bucket.s3-website...
  const s3 = host.match(/^(.+?)\.s3[.-]/);
  if (s3) return idx.byName.get(`s3-bucket:${s3[1]}`);
  // API Gateway: <api-id>.execute-api.<region>.amazonaws.com
  const api = host.match(/^([a-z0-9]+)\.execute-api\./);
  if (api) return [...idx.byDns.values()].find((n) => n.type === 'api-gateway' && n.nativeId === api[1] && host.includes(`.execute-api.${n.region}.`));
  return undefined;
}

/* -------------------------------------------------------------- alarms */

export function applyAlarms(nodes: Map<string, ResourceNode>, alarms: AlarmInfo[]): void {
  for (const n of nodes.values()) {
    if (n.baseStatus === undefined) {
      n.baseStatus = n.status;
      n.baseStatusLabel = n.statusLabel;
    }
    n.status = n.baseStatus;
    n.statusLabel = n.baseStatusLabel;
    n.alarms = undefined;
    delete n.props['경보'];
  }
  if (!alarms.length) return;
  const byType = new Map<ResourceType, ResourceNode[]>();
  for (const n of nodes.values()) {
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  const find = (type: ResourceType, pred: (n: ResourceNode) => boolean) => (byType.get(type) ?? []).find(pred);
  const resolve = (a: AlarmInfo): ResourceNode | undefined => {
    const d = a.dimensions;
    if (d.InstanceId) return nodes.get(nid('ec2-instance', d.InstanceId));
    if (d.LoadBalancer) return find('load-balancer', (n) => n.nativeId.endsWith(`loadbalancer/${d.LoadBalancer}`));
    if (d.TargetGroup) return find('target-group', (n) => n.nativeId.endsWith(d.TargetGroup));
    if (d.DBInstanceIdentifier) return nodes.get(nid('rds-instance', d.DBInstanceIdentifier));
    if (d.DBClusterIdentifier) return nodes.get(nid('rds-cluster', d.DBClusterIdentifier));
    if (d.FunctionName) return nodes.get(nid('lambda', d.FunctionName));
    if (d.TableName) return nodes.get(nid('dynamodb-table', d.TableName));
    if (d.QueueName) return nodes.get(nid('sqs-queue', d.QueueName));
    if (d.TopicName) return nodes.get(nid('sns-topic', d.TopicName));
    if (d.ClusterName && d.ServiceName) return nodes.get(nid('ecs-service', `${d.ClusterName}/${d.ServiceName}`));
    if (d.ClusterName) return nodes.get(nid('ecs-cluster', d.ClusterName));
    if (d.ReplicationGroupId) return nodes.get(nid('elasticache', d.ReplicationGroupId));
    if (d.CacheClusterId) return nodes.get(nid('elasticache', d.CacheClusterId)) ?? find('elasticache', (n) => String(n.props['노드'] ?? '').includes(d.CacheClusterId));
    if (d.FileSystemId) return nodes.get(nid('efs', d.FileSystemId));
    if (d.NatGatewayId) return nodes.get(nid('nat-gateway', d.NatGatewayId));
    if (d.DistributionId) return nodes.get(nid('cloudfront', d.DistributionId));
    if (d.ApiId) return nodes.get(nid('api-gateway', d.ApiId));
    if (d.ApiName) return find('api-gateway', (n) => n.name === d.ApiName);
    if (d.GraphQLAPIId) return nodes.get(nid('appsync-api', d.GraphQLAPIId));
    if (d.EventAPIId) return nodes.get(nid('appsync-api', d.EventAPIId));
    if (d.AutoScalingGroupName) return nodes.get(nid('autoscaling-group', d.AutoScalingGroupName));
    if (d.BucketName) return nodes.get(nid('s3-bucket', d.BucketName));
    if (d.StateMachineArn) return find('step-function', (n) => n.arn === d.StateMachineArn);
    if (d.RuleName) return nodes.get(nid('eventbridge-rule', d.RuleName));
    return undefined;
  };
  const attached = new Map<string, Set<string>>();
  for (const a of alarms) {
    const n = resolve(a);
    if (!n) continue;
    const names = attached.get(n.id) ?? new Set<string>();
    if (names.has(a.name)) continue;
    names.add(a.name);
    attached.set(n.id, names);
    const list = n.alarms ?? [];
    if (a.state === 'ALARM') {
      list.push(a.name);
      if (STATUS_RANK[n.status] < STATUS_RANK.critical || n.statusLabel?.startsWith('알람 ')) {
        n.status = 'critical';
        n.statusLabel = `알람 ${list.length}건`;
      }
    }
    n.alarms = list.length ? list : n.alarms;
    n.props['경보'] = `${(n.props['경보'] as number | undefined ?? 0) + 1}`.length ? ((n.props['경보'] as number | undefined) ?? 0) + 1 : 1;
  }
}
