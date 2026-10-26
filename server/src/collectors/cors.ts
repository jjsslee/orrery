import type { CorsRule } from '@orrery/shared';
import type { Integration } from '@aws-sdk/client-api-gateway';
import type { Cors } from '@aws-sdk/client-apigatewayv2';

/** Only a serialized origin is retained; paths, credentials and query secrets are discarded. */
export function classifyOrigin(value: string): { origin?: string; issue?: CorsRule['issues'][number] } {
  if (/[\s\\]/.test(value)) return { issue: 'invalid-origin' };
  if (value.includes('*')) return { issue: 'wildcard' };
  if (value === 'null') return { issue: 'null-origin' };
  if (!/^https?:\/\/[^/?#]+$/i.test(value)) return { issue: 'invalid-origin' };
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hostname.endsWith('.')) return { issue: 'invalid-origin' };
    const host = url.hostname;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0') return { issue: 'local-origin' };
    return { origin: url.origin };
  } catch { return { issue: 'invalid-origin' }; }
}

function origins(rule: CorsRule, values: string[]) {
  for (const value of values) {
    const result = classifyOrigin(value);
    if (result.origin && !rule.origins.includes(result.origin)) rule.origins.push(result.origin);
    if (result.issue && !rule.issues.includes(result.issue)) rule.issues.push(result.issue);
  }
}

export function httpCors(targetId: string, cors?: Cors): CorsRule {
  const rule: CorsRule = { targetId, source: 'http-api-cors', deployment: 'unverified', responseType: 'api-policy', origins: [], issues: [] };
  if (!cors?.AllowOrigins?.length) rule.issues.push('not-configured');
  origins(rule, cors?.AllowOrigins ?? []);
  rule.methods = cors?.AllowMethods;
  rule.headers = cors?.AllowHeaders;
  rule.credentials = cors?.AllowCredentials;
  return rule;
}

/** REST response parameters are mapping expressions; only quoted static literals are used. */
export function restCors(targetId: string, path: string, method: string, integration: Integration): CorsRule[] {
  const base: CorsRule = { targetId, source: 'rest-integration-response', deployment: 'editable-config', path, method, responseType: method === 'OPTIONS' ? 'preflight' : 'actual-response', origins: [], issues: [] };
  if (integration.type === 'AWS_PROXY' || integration.type === 'HTTP_PROXY') return [{ ...base, issues: ['backend-managed'] }];
  const responses = Object.entries(integration.integrationResponses ?? {});
  if (!responses.length) return [{ ...base, issues: ['not-configured'] }];
  return responses.map(([status, response]) => {
    const rule: CorsRule = { ...base, statusCode: response.statusCode ?? status, origins: [], issues: [] };
    const parameter = (name: string) => Object.entries(response.responseParameters ?? {}).find(([key]) => key.toLowerCase() === `method.response.header.${name}`)?.[1];
    const literal = (name: string) => {
      const value = parameter(name);
      return value?.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : undefined;
    };
    // Response templates may override headers, even if responseParameters are literal.
    if (Object.values(response.responseTemplates ?? {}).some(Boolean)) {
      rule.issues.push('dynamic-response');
      return rule;
    }
    const origin = literal('access-control-allow-origin');
    if (origin !== undefined) origins(rule, [origin]);
    else rule.issues.push(parameter('access-control-allow-origin') === undefined ? 'not-configured' : 'dynamic-response');
    const list = (name: string) => literal(name)?.split(',').map((v) => v.trim()).filter(Boolean);
    rule.methods = list('access-control-allow-methods');
    rule.headers = list('access-control-allow-headers');
    const credentials = literal('access-control-allow-credentials');
    if (credentials === 'true' || credentials === 'false') rule.credentials = credentials === 'true';
    return rule;
  });
}
