import type { ResourceGraph, ResourceNode } from '@orrery/shared';

export interface TagFilter {
  key: string;
  /** Undefined means "has this key with any value" */
  value?: string;
}

export interface TagValueEntry { value: string; count: number }
export interface TagKeyEntry { key: string; count: number; values: TagValueEntry[]; system: boolean }

export interface TagIndex {
  keys: TagKeyEntry[];
  /** Nodes that carry at least one tag */
  tagged: number;
}

/** Keys that are machine-managed or effectively unique per resource; listed last. */
export const isSystemTagKey = (key: string): boolean => key.startsWith('aws:') || key === 'Name' || key.startsWith('elasticbeanstalk:') || key.startsWith('eks:') || key.startsWith('kubernetes.io/');

export function buildTagIndex(graph: ResourceGraph | undefined): TagIndex {
  if (!graph) return { keys: [], tagged: 0 };
  const keys = new Map<string, Map<string, number>>();
  let tagged = 0;
  for (const n of graph.nodes) {
    if (!n.tags) continue;
    const entries = Object.entries(n.tags);
    if (!entries.length) continue;
    tagged++;
    for (const [k, v] of entries) {
      const values = keys.get(k) ?? new Map<string, number>();
      values.set(v, (values.get(v) ?? 0) + 1);
      keys.set(k, values);
    }
  }
  const out: TagKeyEntry[] = [...keys.entries()].map(([key, values]) => ({
    key,
    system: isSystemTagKey(key),
    count: [...values.values()].reduce((a, b) => a + b, 0),
    values: [...values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  }));
  out.sort((a, b) => Number(a.system) - Number(b.system) || b.count - a.count || a.key.localeCompare(b.key));
  return { keys: out, tagged };
}

/**
 * Filters on the same key are alternatives (Service = a OR Service = b);
 * different keys must all hold (Service = a AND Phase = prod).
 */
export function matchesTags(node: ResourceNode, filters: TagFilter[]): boolean {
  if (!filters.length) return true;
  const tags = node.tags;
  if (!tags) return false;
  const byKey = new Map<string, Array<string | undefined>>();
  for (const f of filters) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f.value]);
  for (const [key, values] of byKey) {
    const v = tags[key];
    if (v === undefined) return false;
    if (!values.some((want) => want === undefined || want === v)) return false;
  }
  return true;
}

export const tagFilterLabel = (f: TagFilter): string => (f.value === undefined ? `${f.key} (모든 값)` : `${f.key} = ${f.value}`);
export const sameTagFilter = (a: TagFilter, b: TagFilter): boolean => a.key === b.key && a.value === b.value;
