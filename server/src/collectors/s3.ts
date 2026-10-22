/**
 * S3 buckets in the selected region. ListBuckets is filtered server-side by
 * BucketRegion; buckets the API reports without a region fall back to
 * GetBucketLocation. Versioning and public-access-block are best effort.
 */
import {
  S3Client,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  paginateListBuckets,
  type Bucket,
} from '@aws-sdk/client-s3';
import type { ResourceNode } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';
import { iso, nid } from './ids.ts';
import { attempt, collect, errMsg } from './util.ts';

/** LocationConstraint → region name ('' / null → us-east-1, 'EU' → eu-west-1) */
export function regionFromLocation(constraint?: string | null): string {
  if (!constraint) return 'us-east-1';
  if (constraint === 'EU') return 'eu-west-1';
  return constraint;
}

export function s3Hosts(name: string, region: string): string {
  return [
    `${name}.s3.amazonaws.com`,
    `${name}.s3.${region}.amazonaws.com`,
    `${name}.s3-website.${region}.amazonaws.com`,
    `${name}.s3-website-${region}.amazonaws.com`,
  ].join(',');
}

async function run(ctx: CollectorContext) {
  const s3 = ctx.clients.get(S3Client);
  const nodes: ResourceNode[] = [];

  let buckets: Bucket[];
  try {
    buckets = await collect(paginateListBuckets({ client: s3 }, { BucketRegion: ctx.region }), (p) => p.Buckets);
  } catch (err) {
    ctx.log(`[s3] 리전 필터 ListBuckets 실패, 전체 목록으로 재시도: ${errMsg(err)}`);
    buckets = await collect(paginateListBuckets({ client: s3 }, {}), (p) => p.Buckets);
  }

  await Promise.all(
    buckets.map(async (b) => {
      if (!b.Name) return;
      const name = b.Name;
      let region = b.BucketRegion;
      if (!region) {
        const loc = await attempt(ctx, `s3 location ${name}`, () => s3.send(new GetBucketLocationCommand({ Bucket: name })));
        if (!loc) return;
        region = regionFromLocation(loc.LocationConstraint);
      }
      if (region !== ctx.region) return;

      const [versioning, pab] = await Promise.all([
        attempt(ctx, `s3 versioning ${name}`, () => s3.send(new GetBucketVersioningCommand({ Bucket: name }))),
        ctx.limit(() => s3.send(new GetPublicAccessBlockCommand({ Bucket: name }))).then(
          (r) => r.PublicAccessBlockConfiguration,
          (err: unknown) => {
            const code = err instanceof Error ? err.name : '';
            if (code !== 'NoSuchPublicAccessBlockConfiguration') ctx.log(`[s3 public access block ${name}] ${errMsg(err)}`);
            return undefined;
          },
        ),
      ]);
      const blocked = Boolean(pab?.BlockPublicAcls && pab.BlockPublicPolicy && pab.IgnorePublicAcls && pab.RestrictPublicBuckets);
      nodes.push({
        id: nid('s3-bucket', name),
        type: 's3-bucket',
        category: 'storage',
        name,
        nativeId: name,
        arn: `arn:aws:s3:::${name}`,
        region,
        status: 'healthy',
        props: {
          생성일: iso(b.CreationDate),
          리전: region,
          '버전 관리': versioning ? versioning.Status ?? '비활성' : null,
          '퍼블릭 액세스 차단': blocked,
          _hosts: s3Hosts(name, region),
        },
      });
    }),
  );

  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return { nodes, edges: [] };
}

export const s3Collector: Collector = { name: 's3', label: 'S3', run };
