import type { MonitoringRelatedCandidate, MonitoringResource } from '@orrery/shared';
/** Exact tag evidence is immediately available; it never implies causality. */
export function sameTagCandidates(reference: MonitoringResource | undefined, resources: MonitoringResource[]): MonitoringRelatedCandidate[] {
  if (!reference || reference.tagsStatus !== 'complete') return [];
  return resources.filter((resource) => resource.key !== reference.key && resource.tagsStatus === 'complete').flatMap((resource) => {
    const reasons = Object.entries(reference.tags ?? {}).filter(([key, value]) => resource.tags?.[key] === value).map(([key, value]) => ({ kind: 'tag' as const, key, value }));
    return reasons.length ? [{ resource, reasons }] : [];
  });
}
export function mergeRelatedCandidates(...lists: MonitoringRelatedCandidate[][]): MonitoringRelatedCandidate[] {
  const merged = new Map<string, MonitoringRelatedCandidate>();
  for (const candidate of lists.flat()) {
    const old = merged.get(candidate.resource.key);
    const reasons = new Map([...(old?.reasons ?? []), ...candidate.reasons].map((reason) => [JSON.stringify(reason), reason]));
    merged.set(candidate.resource.key, { resource: candidate.resource, reasons: [...reasons.values()] });
  }
  return [...merged.values()];
}
