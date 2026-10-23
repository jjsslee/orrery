import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { MetricPoint, MonitoringMetricRequest, MonitoringMetricSeries, MonitoringMetricsSnapshot, MonitoringResource, ResourceNode } from '@orrery/shared';
import { queriesForNode, type MetricQuery } from '../metrics/cloudwatch.ts';
import type { MonitoringSession } from './alarms.ts';
import { scopeKey } from '../aws/sessions.ts';

const DAY = 86400_000;
const MAX_REQUESTS = 10;
const bad = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export function validateMetricRequest(input: unknown, now = Date.now()): MonitoringMetricRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('지표 조회 요청을 확인하세요.');
  const body = input as MonitoringMetricRequest;
  if (!Array.isArray(body.resourceKeys) || body.resourceKeys.length < 1 || body.resourceKeys.length > 4 || body.resourceKeys.some((k) => typeof k !== 'string' || k.length > 2048) || new Set(body.resourceKeys).size !== body.resourceKeys.length) return bad('비교 자원은 중복 없이 1~4개 선택하세요.');
  const start = Date.parse(body.range?.startTime), end = Date.parse(body.range?.endTime);
  if (typeof body.range?.startTime !== 'string' || typeof body.range?.endTime !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(body.range.startTime) || !/^\d{4}-\d\d-\d\dT/.test(body.range.endTime) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 7 * DAY || end > now || start < now - 455 * DAY) return bad('기간은 과거 455일 이내, 최대 7일이며 종료가 시작보다 늦어야 합니다.');
  if (body.metricIds !== undefined && (!Array.isArray(body.metricIds) || body.metricIds.length < 1 || body.metricIds.length > 100 || body.metricIds.some((id) => typeof id !== 'string' || id.length > 100) || new Set(body.metricIds).size !== body.metricIds.length)) return bad('지표 선택을 확인하세요.');
  if (body.period !== undefined && ![60, 300, 900, 3600, 86400].includes(body.period)) return bad('지원하는 집계 주기를 선택하세요.');
  const allowed = new Set(['resourceKeys', 'range', 'metricIds', 'period', 'refresh']);
  if (Object.keys(body).some((key) => !allowed.has(key)) || (body.refresh !== undefined && typeof body.refresh !== 'boolean')) return bad('지원하지 않는 지표 요청 항목입니다.');
  return body;
}

export function monitoringQueries(resource: MonitoringResource): MetricQuery[] {
  const node: ResourceNode = { id: resource.key, type: resource.type, category: 'compute', name: resource.name, nativeId: resource.nativeId, arn: resource.arn, region: resource.region, status: 'unknown', props: resource.props };
  const queries = queriesForNode(node);
  // Percentiles are supported for these duration metrics; never apply arbitrary stats.
  for (const q of [...queries]) if ((resource.type === 'lambda' && q.spec.metric === 'Duration') || (resource.type === 'load-balancer' && q.spec.namespace === 'AWS/ApplicationELB' && q.spec.metric === 'TargetResponseTime')) queries.push({ ...q, spec: { ...q.spec, stat: 'p95', label: `${q.spec.label} p95` } });
  return queries;
}
const metricId = (q: MetricQuery) => `${q.spec.metric}:${q.spec.stat}`;
export function effectivePeriod(query: MetricQuery, resource: MonitoringResource, start: number, end: number, now: number): number {
  const span = end - start;
  let period = span <= 3 * 3600_000 ? 60 : span <= DAY ? 300 : 900;
  if (resource.type === 'ec2-instance' && resource.props._monitoring !== 'enabled') period = Math.max(300, period);
  const age = now - start;
  if (age >= 63 * DAY) period = Math.ceil(period / 3600) * 3600;
  else if (age >= 15 * DAY) period = Math.ceil(period / 300) * 300;
  return Math.max(period, query.spec.period ?? 60);
}
interface Planned { query: MetricQuery; resource: MonitoringResource; period: number; start: number; end: number }
export function planMetrics(input: MonitoringMetricRequest, known: MonitoringResource[], now = Date.now()): Planned[] {
  validateMetricRequest(input, now);
  const start = Date.parse(input.range.startTime), end = Date.parse(input.range.endTime);
  const plans: Planned[] = [];
  const available = new Set<string>();
  for (const key of input.resourceKeys) {
    const resource = known.find((r) => r.key === key);
    if (!resource) return bad('현재 계정·리전에서 먼저 조회한 자원만 선택할 수 있습니다. 자원 목록을 갱신하세요.');
    const queries = monitoringQueries(resource);
    if (!queries.length) return bad(resource.metricsUnsupportedReason ?? '이 자원의 CloudWatch 지표 프리셋은 아직 지원하지 않습니다.');
    if (resource.type === 'lambda') available.add('ErrorRate:derived');
    for (const query of queries) {
      const id = metricId(query);
      available.add(id);
      const derivedInput = resource.type === 'lambda' && input.metricIds?.includes('ErrorRate:derived') && ['Errors', 'Invocations'].includes(query.spec.metric);
      if (input.metricIds && !input.metricIds.includes(id) && !derivedInput) continue;
      const period = Math.max(effectivePeriod(query, resource, start, end, now), input.period ?? 0);
      plans.push({ query, resource, period, start: Math.floor(start / (period * 1000)) * period * 1000, end: Math.ceil(end / (period * 1000)) * period * 1000 });
    }
  }
  if (input.metricIds?.some((id) => !available.has(id))) return bad('선택한 자원에서 지원하지 않는 지표입니다.');
  if (plans.length > 100) return bad('한 요청은 최대 100개 지표 쿼리만 지원합니다.');
  return plans;
}

interface Collected { points: MetricPoint[]; status?: string; messages: string[] }
export function derivedErrorRate(series: MonitoringMetricSeries[]): MonitoringMetricSeries | undefined {
  const errors = series.find((s) => s.id === 'Errors:Sum'), invocations = series.find((s) => s.id === 'Invocations:Sum');
  if (!errors || !invocations) return;
  const numerator = new Map(errors.points.map((p) => [p.t, p.v]));
  const points = invocations.points.flatMap((p) => p.v > 0 && numerator.has(p.t) ? [{ t: p.t, v: numerator.get(p.t)! / p.v * 100 }] : []);
  const status = [errors.status, invocations.status].includes('error') ? 'error' : [errors.status, invocations.status].includes('partial') ? 'partial' : points.length ? 'complete' : 'empty';
  return { ...errors, id: 'ErrorRate:derived', name: 'ErrorRate', label: '호출 오류율', unit: '%', stat: 'Errors / Invocations × 100', points, status, awsStatus: [errors.awsStatus, invocations.awsStatus].find((value) => value === 'Forbidden' || value === 'InternalError') ?? errors.awsStatus, errorCode: [errors.errorCode, invocations.errorCode].find((code) => code && /AccessDenied|Unauthorized|Expired|InvalidClientToken|UnrecognizedClient/i.test(code)) ?? errors.errorCode ?? invocations.errorCode, latest: points.at(-1)?.v ?? null, lastDataAt: points.length ? new Date(points.at(-1)!.t).toISOString() : undefined, messages: [...errors.messages ?? [], ...invocations.messages ?? [], ...(invocations.points.some((p) => p.v === 0) ? ['호출 0인 구간의 오류율은 계산하지 않습니다.'] : [])] };
}

async function fetchMetrics(s: MonitoringSession, body: MonitoringMetricRequest, plans: Planned[]): Promise<MonitoringMetricsSnapshot> {
  const collectedAt = new Date().toISOString();
  const series: MonitoringMetricsSnapshot['series'] = Object.fromEntries(body.resourceKeys.map((key) => [key, []]));
  const groups = new Map<string, Planned[]>();
  for (const p of plans) {
    const key = JSON.stringify([p.query.region ?? s.region, p.period, p.start, p.end]);
    groups.set(key, [...groups.get(key) ?? [], p]);
  }
  let requestCount = 0;
  for (const batch of groups.values()) {
    const first = batch[0];
    const client = s.clients.get(CloudWatchClient, first.query.region);
    const queries: MetricDataQuery[] = batch.map((p, i) => ({ Id: `q${i}`, MetricStat: { Metric: { Namespace: p.query.spec.namespace, MetricName: p.query.spec.metric, Dimensions: p.query.dims }, Stat: p.query.spec.stat, Period: p.period }, ReturnData: true }));
    const results = new Map<string, Collected>();
    let NextToken: string | undefined, failure: string | undefined, errorCode: string | undefined;
    const tokens = new Set<string>();
    try {
      do {
        if (requestCount >= MAX_REQUESTS) throw new Error('최대 10개 CloudWatch 요청 상한에 도달했습니다.');
        requestCount++;
        const page = await client.send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: new Date(first.start), EndTime: new Date(first.end), ScanBy: 'TimestampAscending', MaxDatapoints: 100800, NextToken }));
        for (const r of page.MetricDataResults ?? []) {
          if (!r.Id) continue;
          const old = results.get(r.Id) ?? { points: [], messages: [] };
          old.status = ['Forbidden', 'InternalError'].includes(old.status ?? '') ? old.status : r.StatusCode;
          old.messages.push(...(r.Messages ?? []).map((m) => `${m.Code ?? ''}: ${m.Value ?? ''}`), ...(page.Messages ?? []).map((m) => `${m.Code ?? ''}: ${m.Value ?? ''}`));
          (r.Timestamps ?? []).forEach((t, i) => { const v = r.Values?.[i]; if (v !== undefined && Number.isFinite(v)) old.points.push({ t: t.getTime(), v }); });
          results.set(r.Id, old);
        }
        NextToken = page.NextToken;
        if (NextToken && tokens.has(NextToken)) throw new Error('CloudWatch 페이지 토큰이 반복되었습니다.');
        if (NextToken) tokens.add(NextToken);
      } while (NextToken);
    } catch (error) { errorCode = error instanceof Error ? error.name : 'UnknownError'; failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    batch.forEach((p, i) => {
      const r = results.get(`q${i}`);
      const points = [...new Map((r?.points ?? []).filter((point) => point.t >= p.start && point.t < p.end).map((point) => [point.t, point])).values()].sort((a, b) => a.t - b.t);
      const status = r?.status === 'Forbidden' || r?.status === 'InternalError' || !r ? 'error' : failure || r.status === 'PartialData' || r.status !== 'Complete' ? 'partial' : points.length ? 'complete' : 'empty';
      series[p.resource.key].push({ id: metricId(p.query), name: p.query.spec.metric, label: p.query.spec.label, unit: p.query.spec.unit, stat: p.query.spec.stat, points, latest: points.at(-1)?.v ?? null, status, awsStatus: r?.status, errorCode, messages: [...r?.messages ?? [], ...failure ? [failure] : [], ...!r && !failure ? ['CloudWatch 응답에서 지표가 누락되었습니다.'] : []], period: p.period, startTime: new Date(p.start).toISOString(), endTime: new Date(p.end).toISOString(), fetchedAt: collectedAt, lastDataAt: points.length ? new Date(points.at(-1)!.t).toISOString() : undefined, region: p.query.region ?? s.region });
    });
  }
  for (const list of Object.values(series)) {
    const rate = derivedErrorRate(list);
    if (rate && (!body.metricIds || body.metricIds.includes(rate.id))) list.push(rate);
    if (body.metricIds) list.splice(0, list.length, ...list.filter((item) => body.metricIds!.includes(item.id)));
  }
  return { scope: { source: s.source, account: s.account, region: s.region }, range: body.range, collectedAt, series, queryCount: plans.length, requestCount, maxRequests: MAX_REQUESTS };
}
export class MetricsRepository {
  private values = new Map<string, { at: number; value: MonitoringMetricsSnapshot }>();
  private pending = new Map<string, Promise<MonitoringMetricsSnapshot>>();
  get(s: MonitoringSession, input: unknown, resources: MonitoringResource[]): Promise<MonitoringMetricsSnapshot> {
    for (const [key, entry] of this.values) if (Date.now() - entry.at >= 60_000) this.values.delete(key);
    const body = validateMetricRequest(input);
    const plans = planMetrics(body, resources);
    const key = JSON.stringify([scopeKey('monitoring-metrics', s.source, s.account, s.region), plans.map((p) => [p.resource.key, p.query.spec.namespace, metricId(p.query), p.query.dims, p.query.region ?? s.region, p.period, p.start, p.end]).sort(), body.metricIds?.slice().sort()]);
    const old = this.values.get(key);
    if (!body.refresh && old && Date.now() - old.at < 60_000) return Promise.resolve({ ...old.value, range: { ...body.range } });
    const running = this.pending.get(key);
    if (running) return running.then((value) => ({ ...value, range: { ...body.range } }));
    const task = fetchMetrics(s, body, plans).then((value) => { this.values.set(key, { value, at: Date.now() }); return value; }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task.then((value) => ({ ...value, range: { ...body.range } }));
  }
}
