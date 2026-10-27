import { ACMClient, DescribeCertificateCommand, ListTagsForCertificateCommand, paginateListCertificates } from '@aws-sdk/client-acm';
import type { Collector } from './types.ts';
import type { ResourceNode, Status } from '@orrery/shared';
import { nid, iso, tagsToRecord } from './ids.ts';
import { attempt, collect } from './util.ts';

export function certificateStatus(status?: string, notAfter?: Date, now = Date.now()): Status {
  if (status === 'EXPIRED' || status === 'REVOKED' || status === 'FAILED') return 'critical';
  if (status !== 'ISSUED') return status ? 'warning' : 'unknown';
  if (notAfter && notAfter.getTime() <= now) return 'critical';
  if (notAfter && notAfter.getTime() - now <= 30 * 86400000) return 'warning';
  return 'healthy';
}

export function certificatesCollector(regionOverride?: string): Collector {
  return { name: regionOverride ? 'certificates-edge' : 'certificates', label: regionOverride ? 'ACM (CloudFront 리전)' : 'ACM',
    async run(ctx) {
      if (regionOverride === ctx.region) return { nodes: [], edges: [] };
      const region = regionOverride ?? ctx.region;
      const client = ctx.clients.get(ACMClient, region);
      const summaries = await collect(paginateListCertificates({ client }, { Includes: { keyTypes: ['RSA_1024', 'RSA_2048', 'RSA_3072', 'RSA_4096', 'EC_prime256v1', 'EC_secp384r1', 'EC_secp521r1'] } }), (p) => p.CertificateSummaryList);
      const nodes: ResourceNode[] = [];
      await Promise.all(summaries.map(async (s) => {
        if (!s.CertificateArn) return;
        const arn = s.CertificateArn;
        const [detail, tags] = await Promise.all([
          attempt(ctx, `acm ${arn}`, () => client.send(new DescribeCertificateCommand({ CertificateArn: arn }))),
          attempt(ctx, `acm tags ${arn}`, () => client.send(new ListTagsForCertificateCommand({ CertificateArn: arn }))),
        ]);
        const d = detail?.Certificate;
        nodes.push({ id: nid('acm-certificate', arn), type: 'acm-certificate', category: 'security', name: d?.DomainName ?? s.DomainName ?? arn,
          nativeId: arn, arn, region, status: d ? certificateStatus(d.Status, d.NotAfter) : 'unknown', statusLabel: d ? d.Status : '상세 미수집',
          props: { '인증서 도메인': d?.DomainName ?? s.DomainName ?? null, 만료: iso(d?.NotAfter), 유형: d?.Type ?? null, '사용 중': d ? Boolean(d.InUseBy?.length) : null },
          tags: tagsToRecord(tags?.Tags),
        });
      }));
      return { nodes, edges: [] };
    },
  };
}
