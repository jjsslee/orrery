import type { MetricSeries } from '@orrery/shared';
export type RefreshDisposition = 'success' | 'retry' | 'stop';
const AUTH = /access.?denied|forbidden|unauthori[sz]ed|expired.?token|invalid.?client.?token|unrecognized.?client|credential|sso|인증|권한/i;
const TEMPORARY = /throttl|too.?many.?request|internal.?error|service.?unavailable|temporar|timeout|network|fetch failed|PartialData/i;
export function classifyMonitoringError(error: unknown): { disposition: RefreshDisposition; message: string } {
  const item = error as { message?: string; status?: number; name?: string; code?: string };
  const message = item.message ?? String(error);
  const description = `${item.name ?? ''} ${item.code ?? ''} ${message}`;
  if (item.status === 401 || item.status === 403 || AUTH.test(description)) return { disposition: 'stop', message: `인증·권한 확인이 필요합니다. 다시 연결하세요. ${message}` };
  if (item.status === 429 || (item.status != null && item.status >= 500) || TEMPORARY.test(description)) return { disposition: 'retry', message };
  return { disposition: 'stop', message: `자동 갱신을 중지했습니다. 조회 조건을 확인한 뒤 다시 시도하세요. ${message}` };
}
export function metricQuality(series: MetricSeries[]): { disposition: RefreshDisposition; message?: string } {
  const failures = series.filter((item) => item.status === 'error' || item.status === 'partial');
  if (!failures.length) return { disposition: 'success' };
  const results = failures.map((item) => {
    const message = [item.errorCode, item.awsStatus, ...(item.messages ?? [])].filter(Boolean).join(' · ') || (item.status === 'partial' ? 'PartialData' : '지표 조회 실패');
    return classifyMonitoringError(new Error(message));
  });
  const fatal = results.find((result) => result.disposition === 'stop');
  return { disposition: fatal ? 'stop' : 'retry', message: results.map((result) => result.message).join(' / ') };
}
