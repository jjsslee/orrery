import pLimit from 'p-limit';
import { readBudget } from '../aws/read-budget.ts';
import type { CollectorReport, RelationCoverage } from '@orrery/shared';
import type { Collector, CollectorContext, CollectorOutput } from './types.ts';
import type { ClientFactory } from '../aws/clients.ts';
import { networkCollector } from './network.ts';
import { extraCollectors } from './registry.ts';

export const collectors: Collector[] = [networkCollector, ...extraCollectors];

export interface RunResult {
  outputs: CollectorOutput[];
  reports: CollectorReport[];
  budget: ReturnType<ReturnType<typeof readBudget>['summary']>;
}

export async function runCollectors(
  base: { region: string; account: string; clients: ClientFactory; log?: (m: string) => void },
  onReport?: (report: CollectorReport) => void,
  only?: string[],
): Promise<RunResult> {
  const limit = pLimit(12);
  const budget = readBudget(base.clients);
  const ctx: CollectorContext = { ...base, clients: budget.clients, limit, log: base.log ?? (() => {}) };
  const selected = only?.length ? collectors.filter((c) => only.includes(c.name)) : collectors;
  const outputs: CollectorOutput[] = [];
  const reports: CollectorReport[] = [];
  await Promise.all(
    selected.map(async (c) => {
      const started = Date.now();
      let report: CollectorReport;
      const coverage: RelationCoverage[] = [];
      try {
        const warnings: string[] = [];
        const out = await c.run({ ...ctx, observe(value) { const prior = coverage.find(v => v.key === value.key); if (!prior) coverage.push({ ...value, collector: c.name }); else if (value.state !== 'complete') Object.assign(prior,value,{succeededAt:undefined}); }, log(message) {
          ctx.log(message);
          // Recovery notices alone do not make a collection partial.
          if (!message.includes('재시도')) warnings.push(message);
        } });
        out.collector = c.name;
        out.coverage = coverage;
        outputs.push(out);
        report = { collector: c.name, ok: warnings.length === 0, durationMs: Date.now() - started, nodes: out.nodes.length, edges: out.edges.length, error: warnings.length ? `부분 수집: ${warnings.length}건 · ${warnings.slice(0, 3).join(" / ")}` : undefined };
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        ctx.log(`[${c.name}] 실패: ${message}`);
        report = { collector: c.name, ok: false, durationMs: Date.now() - started, nodes: 0, edges: 0, error: message };
      }
      coverage.push({ key: `collector:${c.name}`, collector: c.name, operation: 'collector', state: report.ok ? 'complete' : 'partial', attemptedAt: new Date(started).toISOString(), succeededAt: report.ok ? new Date().toISOString() : undefined });
      if (!outputs.some(o => o.collector === c.name)) outputs.push({ collector: c.name, nodes: [], edges: [], coverage });
      reports.push(report);
      onReport?.(report);
    }),
  );
  budget.dispose();
  return { outputs, reports, budget:budget.summary() };
}

export function collectorLabels(): Record<string, string> {
  return Object.fromEntries(collectors.map((c) => [c.name, c.label]));
}
