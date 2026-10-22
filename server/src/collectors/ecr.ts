/**
 * ECR repositories. Image URIs referenced by Lambda/ECS/CodeBuild are matched
 * by the assembler on repository name.
 */
import { ECRClient, ListTagsForResourceCommand, paginateDescribeRepositories } from '@aws-sdk/client-ecr';
import type { ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { iso, nid, tagsToRecord } from './ids.ts';
import { attempt, collect } from './util.ts';

async function run(ctx: CollectorContext) {
  const ecr = ctx.clients.get(ECRClient);
  const nodes: ResourceNode[] = [];
  const repos = await collect(paginateDescribeRepositories({ client: ecr }, {}), (p) => p.repositories);
  const tagsByArn = new Map<string, Record<string, string> | undefined>();
  await Promise.all(
    repos.map(async (r) => {
      if (!r.repositoryArn) return;
      const res = await attempt(ctx, `ecr tags ${r.repositoryName}`, () => ecr.send(new ListTagsForResourceCommand({ resourceArn: r.repositoryArn })));
      tagsByArn.set(r.repositoryArn, tagsToRecord(res?.tags));
    }),
  );
  for (const r of repos) {
    if (!r.repositoryName) continue;
    nodes.push({
      id: nid('ecr-repository', r.repositoryName),
      type: 'ecr-repository',
      category: 'storage',
      name: r.repositoryName,
      nativeId: r.repositoryName,
      arn: r.repositoryArn,
      region: ctx.region,
      status: 'healthy',
      props: {
        URI: r.repositoryUri ?? null,
        생성일: iso(r.createdAt),
        '태그 불변성': r.imageTagMutability ?? null,
        '스캔 설정': r.imageScanningConfiguration?.scanOnPush ? '푸시 시 스캔' : '수동',
        암호화: r.encryptionConfiguration?.encryptionType ?? null,
      },
      tags: r.repositoryArn ? tagsByArn.get(r.repositoryArn) : undefined,
      refs: r.encryptionConfiguration?.kmsKey ? [r.encryptionConfiguration.kmsKey] : undefined,
    });
  }
  return { nodes, edges: [] };
}

export const ecrCollector: Collector = { name: 'ecr', label: 'ECR', run };
