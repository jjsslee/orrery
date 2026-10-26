import type { FrontendDiscovery, FrontendRelations } from '@orrery/shared';

/** Pure, per-graph matching: no process-global index or cross-profile state. */
export function buildFrontendRelations(
  inputs: FrontendDiscovery[],
  scope: FrontendRelations['scope'],
  collectedAt: string,
  nodeIds: Set<string>,
): FrontendRelations {
  const hosting = inputs.flatMap((v) => v.hosting);
  const cors = [...new Map(inputs.flatMap((v) => v.cors).map((rule) => [JSON.stringify(rule), rule])).values()];
  const coverage = inputs.flatMap((v) => v.coverage);
  const result: FrontendRelations = { schemaVersion: 1, scope: { ...scope }, collectedAt, hosting, cors, coverage, relations: [], unresolved: [] };
  const relations = new Map<string, FrontendRelations['relations'][number]>();
  cors.forEach((rule, evidenceIndex) => {
    for (const origin of rule.origins) {
      const host = new URL(origin).hostname;
      const matching = hosting.filter((entry) => nodeIds.has(entry.resourceId) && entry.hosts.some((v) => v.toLowerCase() === host));
      const active = matching.filter((entry) => entry.enabled);
      let reason: FrontendRelations['unresolved'][number]['reason'] | undefined;
      if (!nodeIds.has(rule.targetId)) reason = 'target-not-collected';
      else if (!active.length) {
        const state = coverage.find((v) => v.service === 'cloudfront')?.state;
        reason = matching.length ? 'hosting-disabled' : !state ? 'hosting-not-collected' : state !== 'complete' ? 'hosting-unavailable' : 'no-matching-host';
      }
      if (reason) { result.unresolved.push({ evidenceIndex, origin, reason }); continue; }
      for (const entry of active) {
        const id = JSON.stringify([scope.source, scope.account, scope.region, origin, entry.resourceId, rule.targetId]);
        const relation = relations.get(id) ?? { id, origin, hostingResourceId: entry.resourceId, targetId: rule.targetId, evidenceIndexes: [], kind: 'allowed_origin' as const };
        if (!relation.evidenceIndexes.includes(evidenceIndex)) relation.evidenceIndexes.push(evidenceIndex);
        relations.set(id, relation);
      }
    }
  });
  result.relations = [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
