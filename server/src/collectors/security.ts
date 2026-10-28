/**
 * Security plane: security groups (with SG → SG 'allows' edges), IAM roles,
 * KMS keys, Secrets Manager secrets and Cognito user pools.
 */
import { EC2Client, paginateDescribeSecurityGroups, type IpPermission } from '@aws-sdk/client-ec2';
import { IAMClient, paginateListRoleTags, paginateListRoles } from '@aws-sdk/client-iam';
import { KMSClient, DescribeKeyCommand, paginateListAliases, paginateListKeys, paginateListResourceTags } from '@aws-sdk/client-kms';
import { SecretsManagerClient, paginateListSecrets } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, paginateListUserPools } from '@aws-sdk/client-cognito-identity-provider';
import type { ResourceEdge, ResourceNode, Status } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { edge, iso, nameFromTags, nid, tagsToRecord } from './ids.ts';
import { attempt, collect, errMsg, keyValueTags, truncate } from './util.ts';

/** 'TCP 443', 'UDP 53-54', '모든 트래픽', 'ICMP' */
export function portLabel(p: IpPermission): string {
  const proto = p.IpProtocol ?? '-1';
  if (proto === '-1') return '모든 트래픽';
  const from = p.FromPort;
  const to = p.ToPort;
  const range = from == null ? '' : from === to || to == null ? ` ${from}` : from === 0 && to === 65535 ? ' 모든 포트' : ` ${from}-${to}`;
  if (proto === 'icmp' || proto === 'icmpv6') return proto.toUpperCase();
  return `${proto.toUpperCase()}${range}`;
}

/** Principals of an assume-role policy document: services, account ids, federated providers */
export function trustSummary(encodedDocument?: string | null): string | null {
  if (!encodedDocument) return null;
  try {
    const doc = JSON.parse(decodeURIComponent(encodedDocument)) as { Statement?: unknown };
    const statements = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    const out = new Set<string>();
    for (const s of statements as Array<{ Effect?: string; Principal?: unknown }>) {
      if (s.Effect !== 'Allow' || !s.Principal) continue;
      if (s.Principal === '*') { out.add('*'); continue; }
      for (const [kind, raw] of Object.entries(s.Principal as Record<string, string | string[]>)) {
        for (const v of Array.isArray(raw) ? raw : [raw]) {
          if (kind === 'AWS') {
            const m = v.match(/^arn:aws:iam::(\d+):(.+)$/);
            out.add(m ? (m[2] === 'root' ? `계정 ${m[1]}` : m[2]) : v);
          } else out.add(v);
        }
      }
    }
    return truncate([...out].join(', '), 100);
  } catch {
    return null;
  }
}

async function securityGroups(ctx: CollectorContext, nodes: ResourceNode[], edges: ResourceEdge[]) {
  const ec2 = ctx.clients.get(EC2Client);
  const groups = await collect(paginateDescribeSecurityGroups({ client: ec2 }, {}), (p) => p.SecurityGroups);
  for (const g of groups) {
    if (!g.GroupId) continue;
    const id = g.GroupId;
    const tags = tagsToRecord(g.Tags);
    const ingress = g.IpPermissions ?? [];
    const sources = new Set<string>();
    const ports = new Set<string>();
    let open = false;
    for (const p of ingress) {
      ports.add(portLabel(p));
      if ((p.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0') || (p.Ipv6Ranges ?? []).some((r) => r.CidrIpv6 === '::/0')) open = true;
      for (const pair of p.UserIdGroupPairs ?? []) {
        if (!pair.GroupId) continue;
        sources.add(pair.GroupId);
        edges.push(edge('allows', nid('security-group', pair.GroupId), nid('security-group', id), { label: portLabel(p) }));
      }
    }
    nodes.push({
      id: nid('security-group', id),
      type: 'security-group',
      parentId: g.VpcId ? nid('vpc', g.VpcId) : undefined,
      category: 'security',
      name: g.GroupName && g.GroupName !== 'default' ? g.GroupName : nameFromTags(tags, g.GroupName ?? id),
      nativeId: id,
      arn: `arn:aws:ec2:${ctx.region}:${ctx.account}:security-group/${id}`,
      region: ctx.region,
      status: 'healthy',
      statusLabel: open ? '인터넷 개방' : undefined,
      props: {
        설명: g.Description ?? null,
        VPC: g.VpcId ?? null,
        '인바운드 규칙 수': ingress.length,
        '아웃바운드 규칙 수': g.IpPermissionsEgress?.length ?? 0,
        '인바운드 포트': truncate([...ports].join(', '), 120),
        '인터넷 개방': open,
        '그룹 이름': g.GroupName ?? null,
        _ingressFrom: [...sources].join(',') || null,
      },
      tags,
    });
  }
}

async function iamRoles(ctx: CollectorContext, nodes: ResourceNode[]) {
  const iam = ctx.clients.get(IAMClient);
  const roles = await collect(paginateListRoles({ client: iam }, { MaxItems: 1000 }), (p) => p.Roles);
  // ListRoles omits tags; ListRoleTags per role, skipping service-linked roles (never tagged).
  const tagsByRole = new Map<string, Record<string, string> | undefined>();
  await Promise.all(
    roles.map(async (r) => {
      const name = r.RoleName;
      if (!name || (r.Path ?? '').startsWith('/aws-service-role/')) return;
      const tags = await attempt(ctx, `iam role tags ${name}`, () => collect(paginateListRoleTags({ client: iam }, { RoleName: name }), (p) => p.Tags));
      tagsByRole.set(name, tagsToRecord(tags));
    }),
  );
  for (const r of roles) {
    if (!r.RoleName) continue;
    const serviceLinked = (r.Path ?? '').startsWith('/aws-service-role/');
    nodes.push({
      id: nid('iam-role', r.RoleName),
      type: 'iam-role',
      category: 'security',
      name: r.RoleName,
      nativeId: r.RoleName,
      arn: r.Arn,
      region: 'global',
      status: 'healthy',
      props: {
        경로: r.Path ?? null,
        생성일: iso(r.CreateDate),
        '마지막 사용': iso(r.RoleLastUsed?.LastUsedDate),
        '신뢰 주체': trustSummary(r.AssumeRolePolicyDocument),
        '최대 세션': r.MaxSessionDuration ? `${Math.round((r.MaxSessionDuration / 3600) * 10) / 10}h` : null,
        '서비스 연결': serviceLinked,
        설명: r.Description || null,
      },
      tags: tagsByRole.get(r.RoleName) ?? tagsToRecord(r.Tags),
    });
  }
}

async function kmsKeys(ctx: CollectorContext, nodes: ResourceNode[]) {
  const kms = ctx.clients.get(KMSClient);
  const [keys, aliases] = await Promise.all([
    collect(paginateListKeys({ client: kms }, {}), (p) => p.Keys),
    collect(paginateListAliases({ client: kms }, {}), (p) => p.Aliases).catch((err) => {
      ctx.log(`[security] KMS ListAliases 실패: ${errMsg(err)}`);
      return [];
    }),
  ]);
  const aliasesByKey = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.TargetKeyId || !a.AliasName) continue;
    (aliasesByKey.get(a.TargetKeyId) ?? aliasesByKey.set(a.TargetKeyId, []).get(a.TargetKeyId)!).push(a.AliasName);
  }
  await Promise.all(
    keys.map(async (k) => {
      if (!k.KeyId) return;
      const res = await attempt(ctx, `kms describe ${k.KeyId}`, () => kms.send(new DescribeKeyCommand({ KeyId: k.KeyId })));
      const m = res?.KeyMetadata;
      // AWS-managed keys reject ListResourceTags: only customer-managed keys are asked.
      const tags = m?.KeyManager === 'CUSTOMER'
        ? await attempt(ctx, `kms tags ${k.KeyId}`, () => collect(paginateListResourceTags({ client: kms }, { KeyId: k.KeyId }), (p) => p.Tags))
        : undefined;
      const names = aliasesByKey.get(k.KeyId) ?? [];
      const state = m?.KeyState ?? 'unknown';
      const status: Status = state === 'Enabled' ? 'healthy' : state === 'Disabled' ? 'inactive' : state === 'PendingDeletion' || state === 'PendingReplicaDeletion' ? 'warning' : state === 'Unavailable' ? 'critical' : 'unknown';
      nodes.push({
        id: nid('kms-key', k.KeyId),
        type: 'kms-key',
        category: 'security',
        name: names[0]?.replace(/^alias\//, '') ?? k.KeyId,
        nativeId: k.KeyId,
        arn: m?.Arn ?? k.KeyArn,
        region: ctx.region,
        status,
        statusLabel: state,
        props: {
          별칭: names.map((n) => n.replace(/^alias\//, '')).join(', ') || null,
          상태: state,
          '관리 주체': m?.KeyManager ?? null,
          용도: m?.KeyUsage ?? null,
          '키 사양': m?.KeySpec ?? null,
          생성일: iso(m?.CreationDate),
          '다중 리전': Boolean(m?.MultiRegion),
          설명: m?.Description || null,
          _aliases: names.join(',') || null,
        },
        tags: keyValueTags(tags),
      });
    }),
  );
}

async function secrets(ctx: CollectorContext, nodes: ResourceNode[]) {
  const sm = ctx.clients.get(SecretsManagerClient);
  const list = await collect(paginateListSecrets({ client: sm }, { IncludePlannedDeletion: false }), (p) => p.SecretList);
  for (const s of list) {
    if (!s.Name) continue;
    const refs = [s.KmsKeyId, s.RotationLambdaARN].filter((r): r is string => Boolean(r));
    nodes.push({
      id: nid('secret', s.Name),
      type: 'secret',
      category: 'security',
      name: s.Name,
      nativeId: s.Name,
      arn: s.ARN,
      region: ctx.region,
      status: s.DeletedDate ? 'inactive' : 'healthy',
      statusLabel: s.DeletedDate ? '삭제 예정' : undefined,
      props: {
        설명: s.Description || null,
        '마지막 변경': iso(s.LastChangedDate),
        '마지막 접근': iso(s.LastAccessedDate),
        로테이션: Boolean(s.RotationEnabled),
        KMS: s.KmsKeyId ?? 'aws/secretsmanager',
        '소유 서비스': s.OwningService ?? null,
        생성일: iso(s.CreatedDate),
      },
      tags: tagsToRecord(s.Tags),
      refs,
    });
  }
}

async function cognito(ctx: CollectorContext, nodes: ResourceNode[]) {
  const idp = ctx.clients.get(CognitoIdentityProviderClient);
  const pools = await collect(paginateListUserPools({ client: idp }, { MaxResults: 60 }), (p) => p.UserPools);
  await Promise.all(
    pools.map(async (p) => {
      if (!p.Id) return;
      const res = await attempt(ctx, `cognito describe ${p.Name}`, () => idp.send(new DescribeUserPoolCommand({ UserPoolId: p.Id })));
      const u = res?.UserPool;
      const triggers = Object.values(u?.LambdaConfig ?? {}).filter((v): v is string => typeof v === 'string' && v.startsWith('arn:'));
      const domain = u?.CustomDomain ?? (u?.Domain ? `${u.Domain}.auth.${ctx.region}.amazoncognito.com` : null);
      nodes.push({
        id: nid('cognito-user-pool', p.Id),
        type: 'cognito-user-pool',
        category: 'security',
        name: u?.Name ?? p.Name ?? p.Id,
        nativeId: p.Id,
        arn: u?.Arn ?? `arn:aws:cognito-idp:${ctx.region}:${ctx.account}:userpool/${p.Id}`,
        region: ctx.region,
        status: u?.Status === 'Enabled' || !u?.Status ? 'healthy' : 'inactive',
        statusLabel: u?.Status ?? undefined,
        props: {
          상태: u?.Status ?? null,
          '사용자 수': u?.EstimatedNumberOfUsers ?? null,
          MFA: u?.MfaConfiguration ?? null,
          생성일: iso(u?.CreationDate ?? p.CreationDate),
          도메인: domain,
          티어: u?.UserPoolTier ?? null,
          '람다 트리거': triggers.length,
        },
        tags: u?.UserPoolTags && Object.keys(u.UserPoolTags).length ? u.UserPoolTags : undefined,
        refs: triggers,
      });
    }),
  );
}

async function run(ctx: CollectorContext) {
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];
  const parts: Array<[string, () => Promise<void>]> = [
    ['security-groups', () => securityGroups(ctx, nodes, edges)],
    ['iam', () => iamRoles(ctx, nodes)],
    ['kms', () => kmsKeys(ctx, nodes)],
    ['secrets', () => secrets(ctx, nodes)],
    ['cognito', () => cognito(ctx, nodes)],
  ];
  const results = await Promise.allSettled(parts.map(([, fn]) => fn()));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${parts[i][0]}: ${errMsg(r.reason)}`] : []));
  if (failed.length === results.length) throw new Error(failed.join('; '));
  for (const f of failed) ctx.log(`[security] ${f}`);
  return { nodes, edges };
}

export const securityCollector: Collector = { name: 'security', label: 'IAM·KMS·Secrets·Cognito·보안 그룹', run };
