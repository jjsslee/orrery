import type { CollectEvent, MetricsBundle, ProfileInfo, ResourceGraph, StatusBundle } from '@orrery/shared';

const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* ignore */ }
    throw Object.assign(new Error(message), { status: res.status });
  }
  return (await res.json()) as T;
}

export const api = {
  profiles: () => json<{ profiles: ProfileInfo[]; defaultProfile: string; env: boolean }>('/api/profiles'),
  regions: (profile: string) => json<{ regions: string[] }>(`/api/regions?${q({ profile })}`),
  identity: (profile: string, region: string) => json<{ account: string; arn: string; region: string; source: string }>(`/api/identity?${q({ profile, region })}`),
  graph: (profile: string, region: string, refresh?: boolean) => json<ResourceGraph>(`/api/graph?${q({ profile, region, refresh: refresh ? '1' : undefined })}`),
  metrics: (profile: string, region: string, refresh?: boolean) => json<MetricsBundle>(`/api/metrics?${q({ profile, region, refresh: refresh ? '1' : undefined })}`),
  collectors: () => json<Record<string, string>>('/api/collectors'),
  status: (profile: string, region: string) => json<StatusBundle>(`/api/status?${q({ profile, region })}`),

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
