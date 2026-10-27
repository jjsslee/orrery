import type { SsoLoginStatus, CleanupHistory, CollectEvent, MetricsBundle, ProfileInfo, ResourceGraph, StatusBundle, MonitoringAlarmSnapshot, MonitoringResourceIndex, MonitoringResourceType, AlarmHistorySnapshot, MonitoringMetricsSnapshot, MonitoringRelatedSnapshot, MonitoringResourceResolution } from '@orrery/shared';

const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();

async function json<T>(url: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const res = await fetch(url, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* ignore */ }
    throw Object.assign(new Error(message), { status: res.status });
  }
  return (await res.json()) as T;
}

export const api = {
  ssoLogin: (profile: string) => json<SsoLoginStatus>('/api/sso/login', undefined, { profile }),
  ssoLoginStatus: (id: string) => json<SsoLoginStatus>(`/api/sso/login/${encodeURIComponent(id)}`),
  ssoLoginCancel: (id: string) => json<SsoLoginStatus>(`/api/sso/login/${encodeURIComponent(id)}/cancel`, undefined, {}),
  cleanupHistory: (profile: string, region: string, findingId: string, collectedAt: string, signal?: AbortSignal) => json<CleanupHistory>(`/api/cleanup/history?${q({ profile, region })}`, signal, { findingId, collectedAt }),
  profiles: () => json<{ profiles: ProfileInfo[]; defaultProfile: string; env: boolean }>('/api/profiles'),
  regions: (profile: string, signal?: AbortSignal) => json<{ regions: string[] }>(`/api/regions?${q({ profile })}`, signal),
  identity: (profile: string, region: string, signal?: AbortSignal, reconnect = false) => json<{ account: string; arn: string; region: string; source: string }>(`/api/identity?${q({ profile, region, reconnect: reconnect ? '1' : undefined })}`, signal),
  graph: (profile: string, region: string, refresh?: boolean) => json<ResourceGraph>(`/api/graph?${q({ profile, region, refresh: refresh ? '1' : undefined })}`),
  metrics: (profile: string, region: string, refresh?: boolean, signal?: AbortSignal) => json<MetricsBundle>(`/api/metrics?${q({ profile, region, refresh: refresh ? '1' : undefined })}`, signal),
  collectors: () => json<Record<string, string>>('/api/collectors'),
  status: (profile: string, region: string, signal?: AbortSignal) => json<StatusBundle>(`/api/status?${q({ profile, region })}`, signal),

  monitoringAlarms: (profile: string, region: string, refresh = false, signal?: AbortSignal) => json<MonitoringAlarmSnapshot>(`/api/monitoring/alarms?${q({ profile, region, refresh: refresh ? '1' : undefined })}`, signal),
  monitoringResources: (profile: string, region: string, type: MonitoringResourceType, signal?: AbortSignal, refresh = false) => json<MonitoringResourceIndex>(`/api/monitoring/resources?${q({ profile, region, type, refresh: refresh ? '1' : undefined })}`, signal),
  monitoringRelated: (profile: string, region: string, resourceKey: string, signal?: AbortSignal, refresh = false) => json<MonitoringRelatedSnapshot>(`/api/monitoring/related?${q({ profile, region, resourceKey, connections: '1', refresh: refresh ? '1' : undefined })}`, signal),
  monitoringResolve: (profile: string, region: string, resourceKeys: string[], signal?: AbortSignal) => json<MonitoringResourceResolution>(`/api/monitoring/resources/resolve?${q({ profile, region })}`, signal, { resourceKeys }),
  monitoringMetrics: (profile: string, region: string, resourceKeys: string[], range: { startTime: string; endTime: string }, refresh = false, signal?: AbortSignal) => json<MonitoringMetricsSnapshot>(`/api/monitoring/metrics?${q({ profile, region })}`, signal, { resourceKeys, range, refresh }),
  monitoringHistory: (profile: string, region: string, name: string, type: 'metric' | 'composite', window: { start: string; end: string }, nextToken?: string, signal?: AbortSignal) => json<AlarmHistorySnapshot>(`/api/monitoring/alarms/history?${q({ profile, region, name, type, ...window, nextToken })}`, signal),

  /** Streams collection progress; resolves with the graph. */
  streamGraph(profile: string, region: string, refresh: boolean, onEvent: (e: CollectEvent) => void, signal?: AbortSignal): Promise<ResourceGraph> {
    return new Promise((resolve, reject) => {
      const es = new EventSource(`/api/graph/stream?${q({ profile, region, refresh: refresh ? '1' : undefined })}`);
      // The server sends a ping every 15 s; a long silence means the stream died (e.g. server restart).
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const close = () => { es.close(); if (watchdog) clearTimeout(watchdog); };
      const fail = (message: string, status?: number) => { close(); reject(Object.assign(new Error(message), { status })); };
      const arm = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => fail('서버 응답이 60초 동안 없습니다. 서버가 재시작됐을 수 있으니 다시 시도하세요.'), 60_000); };
      arm();
      signal?.addEventListener('abort', () => { close(); reject(new DOMException('aborted', 'AbortError')); });
      es.onmessage = (m) => {
        arm();
        const e = JSON.parse(m.data) as CollectEvent;
        if (e.type === 'ping') return;
        onEvent(e);
        if (e.type === 'done') { close(); resolve(e.graph); }
        if (e.type === 'error') fail(e.message, e.status);
      };
      es.onerror = () => fail('서버와 연결이 끊겼습니다. 서버가 실행 중인지 확인하세요.');
    });
  },
};
