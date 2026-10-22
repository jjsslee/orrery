/**
 * CloudWatch alarms. Emits no nodes; the assembler attaches alarms to nodes
 * by metric dimensions and lifts the status of nodes in ALARM.
 */
import { CloudWatchClient, paginateDescribeAlarms, type MetricAlarm } from '@aws-sdk/client-cloudwatch';
import type { AlarmInfo } from '@orrery/shared';
import type { Collector, CollectorContext } from './types.ts';

export function alarmInfo(a: MetricAlarm): AlarmInfo | undefined {
  if (!a.AlarmName) return undefined;
  // Math-expression alarms carry their metric inside Metrics[].MetricStat
  const stat = a.Metrics?.find((m) => m.MetricStat?.Metric)?.MetricStat?.Metric;
  const dims: Record<string, string> = {};
  for (const d of a.Dimensions ?? stat?.Dimensions ?? []) if (d.Name && d.Value) dims[d.Name] = d.Value;
  const state = a.StateValue === 'ALARM' || a.StateValue === 'OK' ? a.StateValue : 'INSUFFICIENT_DATA';
  return { name: a.AlarmName, state, namespace: a.Namespace ?? stat?.Namespace, metric: a.MetricName ?? stat?.MetricName, dimensions: dims };
}

async function run(ctx: CollectorContext) {
  const cw = ctx.clients.get(CloudWatchClient);
  const alarms: AlarmInfo[] = [];
  for await (const page of paginateDescribeAlarms({ client: cw }, { AlarmTypes: ['MetricAlarm', 'CompositeAlarm'] })) {
    for (const a of page.MetricAlarms ?? []) {
      const info = alarmInfo(a);
      if (info) alarms.push(info);
    }
    for (const c of page.CompositeAlarms ?? []) {
      if (!c.AlarmName) continue;
      const state = c.StateValue === 'ALARM' || c.StateValue === 'OK' ? c.StateValue : 'INSUFFICIENT_DATA';
      alarms.push({ name: c.AlarmName, state, dimensions: {} });
    }
  }
  return { nodes: [], edges: [], alarms };
}

export const alarmsCollector: Collector = { name: 'alarms', label: 'CloudWatch 경보', run };
