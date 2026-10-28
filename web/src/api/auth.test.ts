import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptAuthFragment } from './auth';
import { api } from './client';
import { streamGraph } from './stream';

test('launch token is removed from the URL and retained only in tab storage', () => {
  const token = 'a'.repeat(64);
  const values = new Map<string, string>();
  let address = '';
  acceptAuthFragment({ hash: `#orrery-token=${token}`, pathname: '/', search: '?test=1' }, { replaceState: (_s, _u, url) => { address = String(url); } }, { setItem: (k, v) => { values.set(k, v); } });
  assert.equal(address, '/?test=1');
  assert.equal(values.get('orrery-api-token'), token);
});

test('JSON GET/POST and chunked SSE use the same header without credentials in URLs', async () => {
  const original = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const token = 'b'.repeat(64);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => token } });
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.ok(!String(url).includes(token));
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).includes('/stream')) {
      const bytes = new TextEncoder().encode('data: {"type":"ping"}\n\ndata: {"type":"done","graph":{"account":"더미"}}\n\n');
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    }
    return Response.json({});
  };
  try {
    await api.profiles();
    await api.ssoLogin('dummy');
    const events: string[] = [];
    const graph = await api.streamGraph('dummy', 'ap-northeast-2', false, e => events.push(e.type));
    assert.equal(graph.account, '더미');
    assert.deepEqual(events, ['done']);
    assert.ok(calls.some(c => c.startsWith('POST /api/sso/login')));
  } finally {
    globalThis.fetch = original;
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('SSE preserves authentication errors and server error events', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ error: 'dummy authentication required' }, { status: 401 });
    await assert.rejects(streamGraph('/api/stream', () => {}), (e: any) => e.status === 401);
    globalThis.fetch = async () => new Response('data: {"type":"error","message":"dummy expired","status":401}\n\n');
    await assert.rejects(streamGraph('/api/stream', () => {}), (e: any) => e.status === 401 && e.message === 'dummy expired');
    globalThis.fetch = async () => new Response('data: {"type":"ping"}\n\n');
    await assert.rejects(streamGraph('/api/stream', () => {}), /연결이 끊겼/);
  } finally { globalThis.fetch = original; }
});

test('SSE abort and watchdog stop the pending fetch', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = streamGraph('/api/stream', () => {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, (e: any) => e.name === 'AbortError');
    await assert.rejects(streamGraph('/api/stream', () => {}, undefined, 5), /60초/);
  } finally { globalThis.fetch = original; }
});
