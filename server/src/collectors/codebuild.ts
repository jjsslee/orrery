/**
 * CodeBuild projects: ListProjects + BatchGetProjects.
 *   project → IAM role (assumes), project → sg (attached) when VPC-attached.
 * Env var values, artifact/cache locations and the encryption key go to refs.
 */
import { CodeBuildClient, BatchGetProjectsCommand, paginateListProjects, type Project } from '@aws-sdk/client-codebuild';
import type { ResourceEdge, ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { arnName, edge, iso, nid } from './ids.ts';
import { attempt, chunk, collect, lowerTags } from './util.ts';

async function run(ctx: CollectorContext) {
  const cb = ctx.clients.get(CodeBuildClient);
  const nodes: ResourceNode[] = [];
  const edges: ResourceEdge[] = [];

  const names = await collect(paginateListProjects({ client: cb }, {}), (p) => p.projects);
  // CodeBuild has no GetProject: details (and tags) come from BatchGetProjects. An explicit
  // deny on one project fails the whole batch, so retry those one by one; projects that
  // still cannot be read become name-only nodes.
  const detailed = new Map<string, Project>();
  await Promise.all(
    chunk(names, 100).map(async (batch) => {
      const res = await attempt(ctx, 'codebuild BatchGetProjects', () => cb.send(new BatchGetProjectsCommand({ names: batch })));
      if (res) {
        for (const p of res.projects ?? []) if (p.name) detailed.set(p.name, p);
        return;
      }
      await Promise.all(
        batch.map(async (name) => {
          const one = await attempt(ctx, `codebuild project ${name}`, () => cb.send(new BatchGetProjectsCommand({ names: [name] })));
          for (const p of one?.projects ?? []) if (p.name) detailed.set(p.name, p);
        }),
      );
    }),
  );
  for (const name of names) {
    const p: Project = detailed.get(name) ?? { name };
    const known = detailed.has(name);
    const env = p.environment;
    const refs = [
      ...(env?.environmentVariables ?? []).map((v) => v.value),
      p.encryptionKey,
      p.serviceRole,
      p.artifacts?.location,
      p.cache?.location,
      p.source?.location,
      ...(env?.image?.includes('.dkr.ecr.') ? [env.image] : []),
    ].filter((r): r is string => Boolean(r));
    nodes.push({
      id: nid('codebuild-project', name),
      type: 'codebuild-project',
      category: 'integration',
      name,
      nativeId: name,
      arn: p.arn ?? `arn:aws:codebuild:${ctx.region}:${ctx.account}:project/${name}`,
      region: ctx.region,
      parentId: p.vpcConfig?.vpcId ? nid('vpc', p.vpcConfig.vpcId) : undefined,
      status: known ? 'healthy' : 'unknown',
      statusLabel: known ? undefined : '상세 미수집',
      props: {
        '배치 근거': !known ? '위치 미확인 · 상세 조회 실패' : p.vpcConfig?.vpcId ? '빌드의 VPC 연결 설정' : '사용자 VPC 연결 없음',
        '소스 유형': p.source?.type ?? null,
        '소스 위치': p.source?.location ?? null,
        '환경 이미지': env?.image ?? null,
        '컴퓨트 유형': env?.computeType ?? null,
        '환경 유형': env?.type ?? null,
        '마지막 수정': iso(p.lastModified),
        '빌드 타임아웃': p.timeoutInMinutes != null ? `${p.timeoutInMinutes}분` : null,
        아티팩트: p.artifacts?.type ?? null,
        설명: p.description || null,
      },
      tags: lowerTags(p.tags),
      refs,
    });
    if (p.serviceRole) edges.push(edge('assumes', nid('codebuild-project', name), nid('iam-role', arnName(p.serviceRole))));
    for (const sg of p.vpcConfig?.securityGroupIds ?? []) edges.push(edge('attached', nid('codebuild-project', name), nid('security-group', sg)));
  }

  return { nodes, edges };
}

export const codebuildCollector: Collector = { name: 'codebuild', label: 'CodeBuild', run };
