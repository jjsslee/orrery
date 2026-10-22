import type { CollectEvent, MetricsBundle, ProfileInfo, ResourceGraph } from '@orrery/shared';

const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => Boolean(e[1]))).toString();

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* ignore */ }
    throw new Error(message);
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

  /** Streams collection progress; resolves with the graph. */
  streamGraph(profile: string, region: string, refresh: boolean, onEvent: (e: CollectEvent) => void, signal?: AbortSignal): Promise<ResourceGraph> {
    return new Promise((resolve, reject) => {
      const es = new EventSource(`/api/graph/stream?${q({ profile, region, refresh: refresh ? '1' : undefined })}`);
      const close = () => es.close();
      signal?.addEventListener('abort', () => { close(); reject(new DOMException('aborted', 'AbortError')); });
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as CollectEvent;
        onEvent(e);
        if (e.type === 'done') { close(); resolve(e.graph); }
        if (e.type === 'error') { close(); reject(new Error(e.message)); }
      };
      es.onerror = () => { close(); reject(new Error('서버와 연결이 끊겼습니다. 서버가 실행 중인지 확인하세요.')); };
    });
  },
};
