import type { MonitoringGraphState, MonitoringRelatedCandidate, MonitoringResource, ResourceGraph } from '@orrery/shared';
import type { MonitoringSession } from './alarms.ts';
import { scopeKey } from '../aws/sessions.ts';
import { reconcileGraph } from './observations.ts';
import { graphResources } from './resources.ts';

export interface MonitoringGraphProvider {
  getCached(s: MonitoringSession): Promise<ResourceGraph | undefined>;
  collect(s: MonitoringSession): Promise<ResourceGraph>;
}
export function assertGraphScope(s: MonitoringSession, graph: ResourceGraph): void {
  if (graph.source !== s.source || graph.account !== s.account || graph.region !== s.region) throw Object.assign(new Error('관계 그래프의 계정·인증 소스·리전 범위가 일치하지 않습니다. 다시 연결하세요.'), { statusCode: 409 });
}
export function relatedCandidates(base: MonitoringResource, known: MonitoringResource[], graph?: ResourceGraph): { connected: MonitoringRelatedCandidate[]; sameTags: MonitoringRelatedCandidate[] } {
  const candidates = new Map<string, MonitoringResource>(known.map((r) => [r.key, r]));
  if (graph) for (const resource of graphResources(graph)) if (!candidates.has(resource.key)) candidates.set(resource.key, resource);
  const connected = new Map<string, MonitoringRelatedCandidate>();
  if (graph) {
    const byNode = new Map([...candidates.values()].map((r) => [r.nodeId, r]));
    for (const edge of graph.edges) {
      const outgoing = edge.source === base.nodeId, incoming = edge.target === base.nodeId;
      if (!outgoing && !incoming) continue;
      const resource = byNode.get(outgoing ? edge.target : edge.source);
      if (!resource || resource.key === base.key) continue;
      const candidate = connected.get(resource.key) ?? { resource, reasons: [] };
      const reason = { observation: edge.observation, sources: edge.evidence, relationId: edge.id, kind: 'edge' as const, direction: outgoing ? 'outgoing' as const : 'incoming' as const, edgeKind: edge.kind, label: edge.label, evidence: edge.evidence?.[0]?.method ?? 'unknown' as const };
      if (!candidate.reasons.some((r) => JSON.stringify(r) === JSON.stringify(reason))) candidate.reasons.push(reason);
      connected.set(resource.key, candidate);
    }
  }
  const sameTags: MonitoringRelatedCandidate[] = [];
  for (const resource of candidates.values()) {
    if (resource.key === base.key) continue;
    const reasons = Object.entries(base.tags ?? {}).flatMap(([key, value]) => resource.tags?.[key] === value ? [{ kind: 'tag' as const, key, value }] : []);
    if (reasons.length) sameTags.push({ resource, reasons });
  }
  return { connected: [...connected.values()], sameTags };
}

function preservePartial(graph: ResourceGraph, previous?: ResourceGraph): ResourceGraph {
  return reconcileGraph(graph, previous);
}

interface GraphEntry { graph?: ResourceGraph; force?: boolean; succeededAt?: string; pending?: Promise<void>; attemptedAt?: string; error?: string; errorCode?: string }
export class MonitoringGraphRepository {
  private entries = new Map<string, GraphEntry>();
  constructor(private provider?: MonitoringGraphProvider, private ttlMs = 10 * 60_000) {}
  async read(s: MonitoringSession, request = false): Promise<{ graph?: ResourceGraph; state: MonitoringGraphState }> {
    if (!this.provider) return { state: { state: 'not-requested' } };
    const key = scopeKey('monitoring-related', s.source, s.account, s.region);
    const entry = this.entries.get(key) ?? {};
    this.entries.set(key, entry);
    const cached = await this.provider.getCached(s);
    if (cached) {
      assertGraphScope(s, cached);
      if (!entry.graph || Date.parse(cached.collectedAt) > Date.parse(entry.graph.collectedAt)) {
        entry.graph = preservePartial(cached, entry.graph);
        if (!cached.reports.some((r) => !r.ok)) entry.succeededAt = cached.collectedAt;
      }
    }
    const stale = !entry.graph || Date.now() - Date.parse(entry.graph.collectedAt) >= this.ttlMs;
    // An error is shown until an explicit retry, rather than making every poll retry AWS work.
    if (request && (stale || entry.force) && !entry.pending && !entry.error) {
      entry.force = false;
      entry.attemptedAt = new Date().toISOString();
      entry.pending = Promise.resolve().then(() => this.provider!.collect(s)).then((graph) => {
        assertGraphScope(s, graph);
        entry.graph = preservePartial(graph, entry.graph);
        if (!graph.reports.some((r) => !r.ok)) entry.succeededAt = graph.collectedAt;
      }).catch((error: unknown) => { entry.error = error instanceof Error ? error.message : String(error); entry.errorCode = error instanceof Error ? error.name : 'UnknownError';
        if (entry.graph) entry.graph = { ...entry.graph, edges: [], relationshipHistory: [...(entry.graph.relationshipHistory ?? []), ...entry.graph.edges.map(e => ({ ...e, observation: { ...e.observation, state: 'unverified' as const, lastAttemptAt: entry.attemptedAt } }))] }; }).finally(() => { entry.pending = undefined; });
    }
    const partial = entry.graph?.reports.some((r) => !r.ok);
    const errors = entry.graph?.reports.filter((r) => !r.ok).map((r) => `${r.collector}: ${r.error ?? '조회 실패'}`).join('; ');
    return { graph: entry.graph, state: { state: entry.pending ? 'loading' : entry.error ? 'error' : entry.graph ? partial ? 'partial' : 'complete' : 'not-requested', stale: !!entry.graph && (stale || !!entry.error || !!partial), observation: entry.graph || entry.attemptedAt ? { attemptedAt: entry.attemptedAt ?? entry.graph!.collectedAt, succeededAt: entry.succeededAt, error: entry.error ?? (errors || undefined), errorCode: entry.errorCode } : undefined } };
  }
  retry(s: MonitoringSession): void {
    const key = scopeKey('monitoring-related', s.source, s.account, s.region);
    const entry = this.entries.get(key) ?? {};
    entry.error = undefined; entry.errorCode = undefined;
    entry.force = !entry.pending;
    this.entries.set(key, entry);
  }
}
