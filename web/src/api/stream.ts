import type { CollectEvent, ResourceGraph } from '@orrery/shared';
import { authHeaders } from './auth';

/** fetch-based SSE carries Authorization without putting credentials in a URL/cookie. */
export async function streamGraph(url: string, onEvent: (e: CollectEvent) => void, signal?: AbortSignal, timeoutMs = 60_000): Promise<ResourceGraph> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  arm();
  try {
    const response = await fetch(url, { headers: authHeaders(), signal: controller.signal });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try { message = (await response.json()).error ?? message; } catch { /* non-JSON error */ }
      throw Object.assign(new Error(message), { status: response.status });
    }
    if (!response.body) throw new Error('서버의 진행 상황 응답이 비어 있습니다.');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('서버와 연결이 끊겼습니다. 서버가 실행 중인지 확인하세요.');
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as CollectEvent;
        arm();
        if (event.type === 'ping') continue;
        onEvent(event);
        if (event.type === 'done') return event.graph;
        if (event.type === 'error') throw Object.assign(new Error(event.message), { status: event.status });
      }
    }
  } catch (error) {
    if (timedOut) throw new Error('서버 응답이 60초 동안 없습니다. 서버가 재시작됐을 수 있으니 다시 시도하세요.');
    throw error;
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}
