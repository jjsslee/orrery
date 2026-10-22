import pLimit from 'p-limit';
import type { CollectorReport } from '@orrery/shared';
import type { Collector, CollectorContext, CollectorOutput } from './types.ts';
import type { ClientFactory } from '../aws/clients.ts';
import { networkCollector } from './network.ts';
import { extraCollectors } from './registry.ts';

export const collectors: Collector[] = [networkCollector, ...extraCollectors];

export interface RunResult {
  outputs: CollectorOutput[];
  reports: CollectorReport[];
}

export async function runCollectors(
  base: { region: string; account: string; clients: ClientFactory; log?: (m: string) => void },
  onReport?: (report: CollectorReport) => void,
  only?: string[],
): Promise<RunResult> {
  const limit = pLimit(12);
  const ctx: CollectorContext = { ...base, limit, log: base.log ?? (() => {}) };
  const selected = only?.length ? collectors.filter((c) => only.includes(c.name)) : collectors;
  const outputs: CollectorOutput[] = [];
  const reports: CollectorReport[] = [];
  await Promise.all(
    selected.map(async (c) => {
      const started = Date.now();
      let report: CollectorReport;
      try {
        const out = await c.run(ctx);
        outputs.push(out);
        report = { collector: c.name, ok: true, durationMs: Date.now() - started, nodes: out.nodes.length, edges: out.edges.length };
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        ctx.log(`[${c.name}] 실패: ${message}`);
        report = { collector: c.name, ok: false, durationMs: Date.now() - started, nodes: 0, edges: 0, error: message };
      }
      reports.push(report);
      onReport?.(report);
    }),
  );
  return { outputs, reports };
}

export function collectorLabels(): Record<string, string> {
  return Object.fromEntries(collectors.map((c) => [c.name, c.label]));
}
