import type { Rule } from '@aws-sdk/client-elastic-load-balancing-v2';
/** Keep all condition details, including regex/query/header variants. */
export function ruleLabel(rule: Rule): string {
  return `${rule.IsDefault ? '기본' : `우선순위 ${rule.Priority ?? '?'}`} · ${rule.Conditions?.length ? JSON.stringify(rule.Conditions) : '모든 요청'}`;
}
export function matchesCollection(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(`collection/${name}`);
}
