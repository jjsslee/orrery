/** Approval-gated live comparison. Default mode never resolves credentials or calls AWS. */
import assert from 'node:assert/strict';
import { CloudWatchClient, GetMetricDataCommand, type GetMetricDataCommandInput, type GetMetricDataCommandOutput, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import type { MonitoringResource } from '@orrery/shared';
import type { ClientFactory } from '../server/src/aws/clients.ts';
import { attachReadOnlyGuard } from '../server/src/aws/readonly-guard.ts';
import { MetricsRepository } from '../server/src/monitoring/metrics.ts';
import { resourceKey } from '../server/src/monitoring/resources.ts';

const PROFILE = 'demo-profile';
const REGION = 'ap-northeast-2';
const FUNCTIONS = ['example-worker-a', 'example-worker-b'];
const METRICS = [{ name: 'Invocations', stat: 'Sum' }, { name: 'Errors', stat: 'Sum' }, { name: 'Duration', stat: 'Average' }];
const PERIOD = 60;
const SEND_LIMIT = 2;

async function main() {
  const approved = process.argv.includes('--execute-approved');
  const account = process.argv.find((argument) => argument.startsWith('--account='))?.slice('--account='.length);
  const end = Math.floor(Date.now() / 60_000) * 60_000;
  const range = { startTime: new Date(end - 3 * 3600_000).toISOString(), endTime: new Date(end).toISOString() };
  const scope = { profile: PROFILE, region: REGION, account: account ?? '(execution requires --account)', functions: FUNCTIONS, metrics: METRICS, range, period: PERIOD, maxMetricQueriesPerCall: 6, maxCloudWatchSends: SEND_LIMIT, maxIdentitySends: 1, maxAttempts: 1, paginationIncludedInLimit: true };
  if (!approved) { console.log(JSON.stringify({ mode: 'dry-run', awsCalls: 0, scope }, null, 2)); return; }
  assert.match(account ?? '', /^\d{12}$/, '승인된 프로필의 계정 번호를 --account=로 지정하세요. 유료 조회 전에 STS 1회로 일치를 확인합니다.');
  const accountId = account!;
  const resources: MonitoringResource[] = FUNCTIONS.map((nativeId) => ({ key: resourceKey(accountId, REGION, 'lambda', nativeId), nodeId: `lambda:${nativeId}`, nativeId, name: nativeId, type: 'lambda', region: REGION, props: {}, tagsStatus: 'complete' }));
  const expectedQueries: MetricDataQuery[] = FUNCTIONS.flatMap((name) => METRICS.map((metric) => ({ MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: metric.name, Dimensions: [{ Name: 'FunctionName', Value: name }] }, Period: PERIOD, Stat: metric.stat }, ReturnData: true }))).map((query, index) => ({ ...query, Id: `q${index}` }));
  // Resolve once so the identity check and both paid calls use the same credential snapshot.
  const credentials = await fromIni({ profile: PROFILE, ignoreCache: true })();
  const sts = attachReadOnlyGuard(new STSClient({ region: REGION, credentials, maxAttempts: 1, retryMode: 'standard' }));
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    assert.equal(identity.Account, accountId, '승인된 계정과 실행 직전 프로필 계정이 달라 유료 조회를 차단했습니다.');
  } finally { sts.destroy(); }
  const client = attachReadOnlyGuard(new CloudWatchClient({ region: REGION, credentials, maxAttempts: 1, retryMode: 'standard' }));
  let sends = 0;
  const sent: Array<{ startTime?: string; endTime?: string; queries: number; pagination: boolean }> = [];
  const boundedSend = async (command: GetMetricDataCommand): Promise<GetMetricDataCommandOutput> => {
    assert.ok(command instanceof GetMetricDataCommand, 'GetMetricData 외 모든 명령 차단');
    const input = command.input;
    assert.deepEqual(input.MetricDataQueries, expectedQueries, '승인된 6개 지표의 namespace/dimension/stat/period만 허용');
    assert.equal(input.StartTime?.toISOString(), range.startTime);
    assert.equal(input.EndTime?.toISOString(), range.endTime);
    assert.equal(input.ScanBy, 'TimestampAscending');
    if (sends >= SEND_LIMIT) throw new Error('승인된 AWS 전송 상한 2회 도달: 추가 pagination/비교 호출을 차단했습니다.');
    sends++;
    sent.push({ startTime: input.StartTime?.toISOString(), endTime: input.EndTime?.toISOString(), queries: input.MetricDataQueries?.length ?? 0, pagination: Boolean(input.NextToken) });
    return client.send(command);
  };
  const clients = { get: (Ctor: unknown, region?: string) => { assert.equal(Ctor, CloudWatchClient); assert.ok(region === undefined || region === REGION); return { send: boundedSend }; } } as unknown as ClientFactory;
  try {
    const app = await new MetricsRepository().get({ source: `profile:${PROFILE}`, account: accountId, region: REGION, clients }, { resourceKeys: resources.map((resource) => resource.key), range, metricIds: METRICS.map((metric) => `${metric.name}:${metric.stat}`), refresh: true }, resources);
    assert.equal(app.queryCount, 6);
    const baselineInput: GetMetricDataCommandInput = { MetricDataQueries: expectedQueries, StartTime: new Date(range.startTime), EndTime: new Date(range.endTime), ScanBy: 'TimestampAscending', MaxDatapoints: 100800 };
    const baseline = await boundedSend(new GetMetricDataCommand(baselineInput));
    if (baseline.NextToken) throw new Error('직접 조회 결과가 추가 페이지를 요구합니다. 상한 때문에 계속 조회하지 않았습니다.');
    const results = new Map((baseline.MetricDataResults ?? []).map((result) => [result.Id, result]));
    const comparisons = resources.flatMap((resource, resourceIndex) => METRICS.map((metric, metricIndex) => {
      const result = results.get(`q${resourceIndex * 3 + metricIndex}`);
      const actual = app.series[resource.key].find((series) => series.id === `${metric.name}:${metric.stat}`)!;
      const points = [...new Map((result?.Timestamps ?? []).flatMap((timestamp, index) => {
        const value = result?.Values?.[index];
        return value !== undefined && Number.isFinite(value) && timestamp.getTime() >= end - 3 * 3600_000 && timestamp.getTime() < end ? [[timestamp.getTime(), { t: timestamp.getTime(), v: value }] as const] : [];
      })).values()].sort((a, b) => a.t - b.t);
      const status = !result || result.StatusCode === 'Forbidden' || result.StatusCode === 'InternalError' ? 'error' : result.StatusCode !== 'Complete' ? 'partial' : points.length ? 'complete' : 'empty';
      assert.equal(actual.period, PERIOD); assert.equal(actual.region, REGION); assert.equal(actual.startTime, range.startTime); assert.equal(actual.endTime, range.endTime);
      assert.equal(actual.status, status, `${resource.nativeId}/${metric.name} 결과 상태`);
      assert.deepEqual(actual.points, points, `${resource.nativeId}/${metric.name} 두 호출 사이 데이터 게시/수정 여부도 확인 필요`);
      assert.equal(actual.lastDataAt, points.length ? new Date(points.at(-1)!.t).toISOString() : undefined);
      return { resource: resource.nativeId, metric: metric.name, stat: metric.stat, period: actual.period, status, points: points.length, lastDataAt: actual.lastDataAt };
    }));
    console.log(JSON.stringify({ mode: 'executed', comparison: 'passed', scope, identitySends: 1, cloudWatchSends: sends, sent, comparisons, caveat: comparisons.every((item) => item.status === 'empty') ? '모든 지표가 비어 있어 실제 값 렌더링은 검증하지 못했습니다.' : 'AWS 직접 SDK와 앱 함수 비교입니다. AWS 콘솔 화면 대조는 별도입니다.' }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ mode: 'executed', comparison: 'not_completed', scope, identitySends: 1, cloudWatchSends: sends, sent, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, null, 2));
    process.exitCode = 1;
  } finally { client.destroy(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
