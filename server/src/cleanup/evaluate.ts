import type { CleanupDiscovery, CleanupFact, CleanupRule, CleanupSnapshot, CollectorReport, ResourceNode } from '@orrery/shared';

const rules: Record<CleanupRule, { collector: string; api: string; type: ResourceNode['type'] }> = {
  'detached-ebs': { collector: 'ec2', api: 'DescribeVolumes', type: 'ebs-volume' },
  'empty-target-group': { collector: 'elb', api: 'DescribeTargetGroups', type: 'target-group' },
  'stopped-ec2': { collector: 'ec2', api: 'DescribeInstances', type: 'ec2-instance' },
  'disabled-cloudfront': { collector: 'edge', api: 'ListDistributions', type: 'cloudfront' },
};
function matches(fact: CleanupFact): boolean {
  switch (fact.ruleId) {
    case 'detached-ebs': return fact.state === 'available' && fact.attachments === 0;
    case 'empty-target-group': return fact.registeredTargets === 0;
    case 'stopped-ec2': return fact.state === 'stopped';
    case 'disabled-cloudfront': return fact.enabled === false;
  }
}

export function evaluateCleanup(inputs: CleanupDiscovery[], nodes: ResourceNode[], reports: CollectorReport[], scope: CleanupSnapshot['scope'], observedAt: string): CleanupSnapshot {
  const coverage = inputs.flatMap((input) => input.coverage).map((entry) => ({ ...entry }));
  for (const [ruleId, rule] of Object.entries(rules) as Array<[CleanupRule, typeof rules[CleanupRule]]>) {
    if (!coverage.some((c) => c.ruleId === ruleId && !c.resourceId)) {
      coverage.push({ ruleId, api: rule.api, state: reports.some((r) => r.collector === rule.collector && !r.ok) ? 'error' : 'not-collected', attemptedAt: observedAt });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const findings = new Map<string, CleanupSnapshot['findings'][number]>();
  for (const fact of inputs.flatMap((input) => input.facts)) {
    const node = byId.get(fact.resourceId);
    if (!node || node.type !== rules[fact.ruleId].type) continue;
    const list = coverage.find((c) => c.ruleId === fact.ruleId && !c.resourceId);
    const detail = coverage.find((c) => c.ruleId === fact.ruleId && c.resourceId === fact.resourceId);
    if (list?.state !== 'complete' || (fact.ruleId === 'empty-target-group' && detail?.state !== 'complete')) continue;
    if ((fact.ruleId === 'disabled-cloudfront' && typeof fact.enabled !== 'boolean') || (fact.ruleId === 'stopped-ec2' && !fact.state) || (fact.ruleId === 'detached-ebs' && !fact.state)) {
      coverage.push({ ruleId: fact.ruleId, resourceId: fact.resourceId, api: list.api, state: 'error', attemptedAt: list.attemptedAt, errorCode: 'MissingField' });
      continue;
    }
    if (!matches(fact)) continue;
    const id = JSON.stringify([scope.source, scope.account, scope.region, fact.ruleId, node.arn ?? node.id]);
    findings.set(id, { id, ruleId: fact.ruleId, resourceId: fact.resourceId, reviewClass: fact.ruleId === 'detached-ebs' || fact.ruleId === 'empty-target-group' ? 'connections' : 'inactive', fact, observedAt: detail?.succeededAt ?? list.succeededAt ?? observedAt });
  }
  return { schemaVersion: 1, scope: { ...scope }, observedAt, findings: [...findings.values()].sort((a, b) => a.id.localeCompare(b.id)), coverage };
}
