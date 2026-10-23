import { CloudWatchClient, DescribeAlarmsCommand, DescribeAlarmHistoryCommand, type MetricAlarm, type CompositeAlarm } from '@aws-sdk/client-cloudwatch';
import type { AlarmRecord, AlarmMetric, AlarmInfo, MonitoringAlarmSnapshot, MonitoringScope, MonitoringResource, AlarmHistorySnapshot } from '@orrery/shared';
import type { ClientFactory } from '../aws/clients.ts';
import { queriesForNode } from '../metrics/cloudwatch.ts';
import { scopeKey } from '../aws/sessions.ts';

export interface MonitoringSession extends MonitoringScope { clients: ClientFactory }
const iso = (date?: Date) => date?.toISOString();
const dims = (items?: Array<{ Name?: string; Value?: string }>) => Object.fromEntries((items ?? []).filter((d) => d.Name && d.Value).map((d) => [d.Name!, d.Value!]));

export function alarmRecord(a: MetricAlarm | CompositeAlarm, region: string): AlarmRecord | undefined {
  if (!a.AlarmName) return;
  const metric = a as MetricAlarm;
  const composite = a as CompositeAlarm;
  const metrics: AlarmMetric[] = metric.MetricName ? [{ namespace: metric.Namespace, metric: metric.MetricName, dimensions: dims(metric.Dimensions), stat: metric.ExtendedStatistic ?? metric.Statistic, period: metric.Period }] : [];
  for (const query of metric.Metrics ?? []) if (query.MetricStat?.Metric) {
    const stat = query.MetricStat;
    metrics.push({ namespace: stat.Metric?.Namespace, metric: stat.Metric?.MetricName, dimensions: dims(stat.Metric?.Dimensions), stat: stat.Stat, period: stat.Period });
  }
  return {
    name: a.AlarmName, arn: a.AlarmArn, region, type: composite.AlarmRule !== undefined ? 'composite' : 'metric',
    state: a.StateValue === 'ALARM' || a.StateValue === 'OK' ? a.StateValue : 'INSUFFICIENT_DATA',
    reason: a.StateReason, stateUpdatedAt: iso(a.StateUpdatedTimestamp), description: a.AlarmDescription,
    threshold: metric.Threshold, comparisonOperator: metric.ComparisonOperator, evaluationPeriods: metric.EvaluationPeriods,
    datapointsToAlarm: metric.DatapointsToAlarm, treatMissingData: metric.TreatMissingData,
    metrics, rule: composite.AlarmRule, expressions: metric.Metrics?.flatMap((m) => m.Expression ? [m.Expression] : []),
    childAlarmNames: composite.AlarmRule ? [...composite.AlarmRule.matchAll(/(?:ALARM|OK|INSUFFICIENT_DATA)\("((?:\\.|[^"\\])*)"\)/g)].flatMap((m) => { try { return [JSON.parse(`"${m[1]}"`) as string]; } catch { return []; } }) : undefined,
    resourceKeys: [], mapping: 'unresolved',
  };
}

/** Keep every alarm. Only exact supported dimension sets establish resource links. */
export function mapAlarms(alarms: AlarmRecord[], resources: MonitoringResource[]): AlarmRecord[] {
  const matches = (m: AlarmMetric, r: MonitoringResource, region: string) => queriesForNode({ id: r.key, type: r.type, nativeId: r.nativeId, name: r.name, arn: r.arn, region: r.region, category: 'compute', status: 'unknown', props: r.props }).some((query) => (query.region ?? r.region) === region && query.spec.namespace === m.namespace && query.dims.length > 0 && query.dims.every((d) => d.Name && d.Value && m.dimensions[d.Name] === d.Value));
  return alarms.map((alarm) => {
    const resourceKeys = resources.filter((r) => alarm.metrics.some((m) => matches(m, r, alarm.region))).map((r) => r.key);
    return { ...alarm, resourceKeys, mapping: resourceKeys.length ? 'matched' : 'unresolved' };
  });
}

export function graphAlarmInfos(alarms: AlarmRecord[]): AlarmInfo[] {
  return alarms.flatMap((a) => a.metrics.map((m) => ({ name: a.name, state: a.state, namespace: m.namespace, metric: m.metric, dimensions: m.dimensions })));
}

/** Shared by topology status and monitoring; consumers never cancel shared AWS work. */
export class AlarmRepository {
  private values = new Map<string, MonitoringAlarmSnapshot>();
  private pending = new Map<string, Promise<MonitoringAlarmSnapshot>>();
  constructor(private ttlMs = 60_000) {}
  get(s: MonitoringSession, refresh = false): Promise<MonitoringAlarmSnapshot> {
    const key = scopeKey('alarms', s.source, s.account, s.region);
    const old = this.values.get(key);
    if (!refresh && old?.complete && Date.now() - Date.parse(old.observation.attemptedAt) < this.ttlMs) return Promise.resolve(old);
    const running = this.pending.get(key);
    if (running) return running;
    const task = this.fetch(s, old).then((value) => { this.values.set(key, value); return value; }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  private async fetch(s: MonitoringSession, old?: MonitoringAlarmSnapshot): Promise<MonitoringAlarmSnapshot> {
    const scope = { source: s.source, account: s.account, region: s.region };
    const attemptedAt = new Date().toISOString();
    const alarms: AlarmRecord[] = [];
    try {
      const client = s.clients.get(CloudWatchClient);
      let NextToken: string | undefined;
      const tokens = new Set<string>();
      let pages = 0;
      do {
        if (++pages > 100) throw new Error('경보 목록 최대 100페이지에 도달했습니다.');
        const page = await client.send(new DescribeAlarmsCommand({ AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], NextToken }));
        for (const a of [...page.MetricAlarms ?? [], ...page.CompositeAlarms ?? []]) { const record = alarmRecord(a, s.region); if (record) alarms.push(record); }
        NextToken = page.NextToken;
        if (NextToken && tokens.has(NextToken)) throw new Error('경보 목록 페이지 토큰이 반복되었습니다.');
        if (NextToken) tokens.add(NextToken);
      } while (NextToken);
      return { scope, alarms, complete: true, observation: { attemptedAt, succeededAt: new Date().toISOString() } };
    } catch (error) {
      return { scope, alarms: old?.alarms ?? alarms, complete: false, observation: { attemptedAt, succeededAt: old?.observation.succeededAt, errorCode: error instanceof Error ? error.name : 'UnknownError', error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

export async function alarmHistory(s: MonitoringSession, query: Record<string, string>): Promise<AlarmHistorySnapshot> {
  const start = Date.parse(query.start), end = Date.parse(query.end);
  if (!query.name || query.name.length > 255 || !['metric', 'composite'].includes(query.type) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 30 * 86400_000 || end > Date.now() + 60_000 || (query.nextToken?.length ?? 0) > 4096) throw Object.assign(new Error('경보 이름·유형과 최대 30일의 조회 기간을 확인하세요.'), { statusCode: 400 });
  const attemptedAt = new Date().toISOString();
  const scope = { source: s.source, account: s.account, region: s.region };
  try {
    const page = await s.clients.get(CloudWatchClient).send(new DescribeAlarmHistoryCommand({ AlarmName: query.name, AlarmTypes: [query.type === 'metric' ? 'MetricAlarm' : 'CompositeAlarm'], HistoryItemType: 'StateUpdate', StartDate: new Date(start), EndDate: new Date(end), MaxRecords: 100, NextToken: query.nextToken, ScanBy: 'TimestampDescending' }));
    return { scope, items: (page.AlarmHistoryItems ?? []).map((i) => ({ timestamp: iso(i.Timestamp), type: i.HistoryItemType, summary: i.HistorySummary, data: i.HistoryData })), nextToken: page.NextToken, observation: { attemptedAt, succeededAt: new Date().toISOString() } };
  } catch (error) { return { scope, items: [], observation: { attemptedAt, errorCode: error instanceof Error ? error.name : 'UnknownError', error: error instanceof Error ? error.message : String(error) } }; }
}
