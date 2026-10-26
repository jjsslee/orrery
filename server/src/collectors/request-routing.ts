import type { RequestRoute, RequestRouting } from '@orrery/shared';
import type { DistributionSummary } from '@aws-sdk/client-cloudfront';
import type { Integration } from '@aws-sdk/client-api-gateway';

export function cloudfrontRouting(d: DistributionSummary): RequestRouting {
  const behaviors = [...(d.CacheBehaviors?.Items ?? []).map((b) => ({ ...b, pattern: b.PathPattern ?? '' })), ...(d.DefaultCacheBehavior ? [{ ...d.DefaultCacheBehavior, pattern: '*' }] : [])];
  return {
    kind: 'cloudfront', hosts: [d.DomainName, ...(d.Aliases?.Items ?? [])].filter((v): v is string => Boolean(v)), enabled: Boolean(d.Enabled), deployed: d.Status === 'Deployed',
    origins: (d.Origins?.Items ?? []).map((o) => ({ id: o.Id ?? '', host: o.DomainName ?? '', path: o.OriginPath ?? '' })),
    behaviors: behaviors.map((b) => ({ pattern: b.pattern, originId: b.TargetOriginId ?? '', methods: b.AllowedMethods?.Items ?? ['GET', 'HEAD'], dynamic: Boolean(b.FunctionAssociations?.Quantity || b.LambdaFunctionAssociations?.Quantity) })),
  };
}

export function integrationArn(uri?: string): string | undefined {
  const arn = uri?.match(/\/functions\/(arn:[^/]+)\/invocations$/)?.[1] ?? uri;
  return arn && /^arn:[^:]+:lambda:[^:]+:\d{12}:function:[\w-]+(?::[\w$-]+)?$/.test(arn) ? arn : undefined;
}

export function restRequestRoute(path: string, method: string, integration: Integration): RequestRoute {
  return { path, method, targetArn: integrationArn(integration.uri), integrationType: integration.type,
    // Any explicit invocation override or template prevents assuming synchronous invocation.
    async: Object.keys(integration.requestParameters ?? {}).some((key) => key.toLowerCase().includes('x-amz-invocation-type')) || Object.values(integration.requestTemplates ?? {}).some((v) => /InvocationType|invocation-type/.test(v)),
  };
}
