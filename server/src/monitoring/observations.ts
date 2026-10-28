import { createHash } from 'node:crypto';
import type { ResourceGraph, ResourceEdge, RelationChange, RelationEvidence } from '@orrery/shared';
const RETENTION = 7 * 86400_000;
const MAX_HISTORY = 5000;
function canonical(value: unknown): unknown {
  if (typeof value === 'string' && /^[{[]/.test(value.trim())) { try { return canonical(JSON.parse(value)); } catch { return value; } }
  if (Array.isArray(value)) return value.map(canonical); // Ordered action arrays remain ordered.
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
function signature(e: ResourceEdge): string {
  // Health changes are observations, not configuration changes.
  return JSON.stringify(canonical([e.source, e.configurationId ? undefined : e.target, e.kind, e.label ?? '', Object.fromEntries(Object.entries(e.props ?? {}).filter(([k]) => !['상태', '사유'].includes(k)))]));
}
export function reconcileGraph(next: ResourceGraph, previous?: ResourceGraph): ResourceGraph {
  if (previous && ['source', 'account', 'region'].some(k => next[k as 'source'] !== previous[k as 'source'])) throw new Error('관계 관측 범위가 일치하지 않습니다.');
  if (previous && Date.parse(next.collectedAt) <= Date.parse(previous.collectedAt)) return previous;
  if (next.revision) return next; // Already reconciled by the collection owner or restored from disk.
  const coverage = new Map(next.coverage?.map(c => [c.key, c]));
  const completed = (e:RelationEvidence) => coverage.get(e.partition)?.state === 'complete' || (!coverage.has(e.partition) && coverage.get(`collector:${e.collector}`)?.state === 'complete');
  const old = new Map([...(previous?.relationshipHistory ?? []), ...(previous?.edges ?? [])].map(e => [e.id, e]));
  const current = new Map<string, ResourceEdge>();
  const history = new Map<string, ResourceEdge>();
  const changes: RelationChange[] = [];
  const record = (e: ResourceEdge, kind: RelationChange['kind'], from?: string) => changes.push({ id: `${next.collectedAt}|${e.id}|${kind}`, relationId: e.id, source: e.source, target: e.target, kind, from, to: next.collectedAt, label: e.label });
  for (const edge of next.edges) {
    const prior = old.get(edge.id);
    const freshEvidence = (edge.evidence ?? []).map(e => ({ ...e, confirmedAt: next.collectedAt }));
    const evidence = [...freshEvidence, ...(prior?.evidence ?? []).filter(e => !freshEvidence.some(n => n.partition === e.partition) && !completed(e))];
    const observation = { state: evidence.length ? 'current' as const : 'legacy' as const, firstSeenAt: prior?.observation?.firstSeenAt ?? next.collectedAt, lastConfirmedAt: evidence.length ? next.collectedAt : prior?.observation?.lastConfirmedAt, lastAttemptAt: next.collectedAt };
    current.set(edge.id, { ...edge, evidence, observation });
    if (previous && evidence.length) {
      if (!prior || prior.observation?.state === 'absent') record(edge, 'added', previous.collectedAt);
      else if (prior.observation?.lastConfirmedAt && signature(edge) !== signature(prior)) record(edge, 'changed', prior.observation.lastConfirmedAt);
    }
  }
  for (const prior of old.values()) {
    if (current.has(prior.id)) continue;
    const sources = prior.evidence ?? [];
    const absent = !(next.unresolvedEdges ?? []).some(e => e.id === prior.id) && sources.length > 0 && sources.every(completed);
    const wasAbsent = prior.observation?.state === 'absent';
    const observation = { ...prior.observation, firstSeenAt: prior.observation?.firstSeenAt ?? previous?.collectedAt, state: absent || wasAbsent ? 'absent' as const : 'unverified' as const, lastAttemptAt: next.collectedAt };
    history.set(prior.id, { ...prior, observation });
    if (absent && !wasAbsent && prior.observation?.lastConfirmedAt) record(prior, 'removed', prior.observation.lastConfirmedAt);
  }
  const cutoff = Date.parse(next.collectedAt) - RETENTION;
  const retained = [...history.values()].filter(e => Date.parse(e.observation?.lastConfirmedAt ?? e.observation?.firstSeenAt ?? '') >= cutoff).slice(-MAX_HISTORY);
  const needed = new Set(retained.flatMap(e => [e.source, e.target]));
  const presentNodes = new Set(next.nodes.map(n => n.id));
  const historicalNodes = [...new Map([...(previous?.historicalNodes ?? []), ...(previous?.nodes ?? [])].filter(n => needed.has(n.id) && !presentNodes.has(n.id)).map(n => [n.id, {...n, props:{}, refs:undefined, relations:undefined, tags:undefined}])).values()];
  const retainedChanges = [...(previous?.relationshipChanges ?? []), ...changes].filter(c => Date.parse(c.to) >= cutoff);
  const times = [...new Set(retainedChanges.map(c => c.to))].slice(-100);
  const revision = createHash('sha256').update(JSON.stringify([next.source, next.account, next.region, next.collectedAt, [...current.keys()]])).digest('hex').slice(0, 24);
  return { ...next, revision, edges: [...current.values()], relationshipHistory: retained, historicalNodes,
    relationshipChanges: retainedChanges.filter(c => times.includes(c.to)).slice(-MAX_HISTORY) };
}
