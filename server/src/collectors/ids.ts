import type { EdgeKind, ResourceEdge, ResourceType, Status } from '@orrery/shared';

/** Canonical node id. Every collector MUST build ids through this helper. */
export const nid = (type: ResourceType, nativeId: string): string => `${type}:${nativeId}`;

export function edge(kind: EdgeKind, source: string, target: string, extra: Partial<ResourceEdge> = {}): ResourceEdge {
  return { id: `${kind}|${source}|${target}${extra.label ? `|${extra.label}` : ''}`, source, target, kind, ...extra };
}

/** Last path segment of an ARN resource part: arn:aws:lambda:r:a:function:name → name */
export function arnName(arn: string): string {
  const resource = arn.split(':').slice(5).join(':');
  const parts = resource.split(/[/:]/);
  return parts[parts.length - 1] ?? resource;
}

/** arn:aws:ecs:r:a:service/cluster/name → "cluster/name" (everything after the first slash) */
export function arnPath(arn: string): string {
  const resource = arn.split(':').slice(5).join(':');
  const i = resource.indexOf('/');
  return i >= 0 ? resource.slice(i + 1) : resource;
}

export function arnService(arn: string): string | undefined {
  return arn.startsWith('arn:') ? arn.split(':')[2] : undefined;
}

export function tagsToRecord(tags?: Array<{ Key?: string; Value?: string }> | Record<string, string>): Record<string, string> | undefined {
  if (!tags) return undefined;
  if (!Array.isArray(tags)) return Object.keys(tags).length ? tags : undefined;
  const out: Record<string, string> = {};
  for (const t of tags) if (t.Key) out[t.Key] = t.Value ?? '';
  return Object.keys(out).length ? out : undefined;
}

export function nameFromTags(tags: Record<string, string> | undefined, fallback: string): string {
  return tags?.Name?.trim() || fallback;
}

export function fmtBytes(n?: number | null): string {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function iso(d?: Date | string | null): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

/** Map common AWS lifecycle strings to a Status */
export function statusFromState(state?: string | null): Status {
  const s = (state ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (['running', 'available', 'active', 'inservice', 'in-service', 'healthy', 'enabled', 'deployed', 'ready', 'succeeded'].includes(s)) return 'healthy';
  if (['pending', 'provisioning', 'modifying', 'creating', 'updating', 'backing-up', 'rebooting', 'starting', 'stopping', 'shutting-down', 'configuring-enhanced-monitoring', 'maintenance', 'upgrading', 'degraded', 'draining', 'inprogress', 'in_progress'].includes(s)) return 'warning';
  if (['failed', 'incompatible-network', 'incompatible-parameters', 'storage-full', 'inaccessible-encryption-credentials', 'unhealthy', 'deleting', 'impaired', 'error'].includes(s)) return 'critical';
  if (['stopped', 'terminated', 'inactive', 'disabled', 'deleted', 'paused', 'suspended'].includes(s)) return 'inactive';
  return 'unknown';
}
