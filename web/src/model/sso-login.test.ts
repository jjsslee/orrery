import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SsoLoginFlow } from './sso-login';
import type { SsoLoginStatus } from '@orrery/shared';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const status = (id: string, state: SsoLoginStatus['state'] = 'pending'): SsoLoginStatus => ({ id, profile: 'dev', state });

test('successful login reconnects once; failure never reconnects', async () => {
  for (const state of ['succeeded', 'failed'] as const) {
    let connected = 0;
    const flow = new SsoLoginFlow({ ssoLogin: async () => status('1'), ssoLoginStatus: async () => status('1', state), ssoLoginCancel: async () => status('1', 'cancelled') }, 1);
    await flow.start('dev', () => {}, async () => { connected++; }, assert.fail);
    assert.equal(connected, state === 'succeeded' ? 1 : 0);
  }
});

test('late login completion after switching profiles cannot reconnect', async () => {
  const poll = deferred<SsoLoginStatus>(); const polling = deferred<void>(); let connected = 0;
  const flow = new SsoLoginFlow({ ssoLogin: async () => status('1'), ssoLoginStatus: () => { polling.resolve(); return poll.promise; }, ssoLoginCancel: async () => status('1', 'cancelled') }, 1);
  const done = flow.start('dev', () => {}, async () => { connected++; }, assert.fail);
  await polling.promise;
  flow.cancel(); poll.resolve(status('1', 'succeeded'));
  await done;
  assert.equal(connected, 0);
});

test('retry waits for cancelled in-flight start to be cleaned up before starting again', async () => {
  const first = deferred<SsoLoginStatus>(); const started = deferred<void>(); let starts = 0; let cancelled = false;
  const flow = new SsoLoginFlow({
    ssoLogin: () => { starts++; if (starts === 1) { started.resolve(); return first.promise; } assert.ok(cancelled, 'old start must be cancelled before retry'); return Promise.resolve(status('2', 'succeeded')); },
    ssoLoginStatus: async () => status('1'),
    ssoLoginCancel: async () => { cancelled = true; return status('1', 'cancelled'); },
  }, 1);
  const failures: string[] = [];
  const a = flow.start('dev', () => {}, async () => {}, (e) => failures.push(e));
  await started.promise;
  flow.cancel();
  const b = flow.start('dev', () => {}, async () => {}, (e) => failures.push(e));
  first.resolve(status('1'));
  await Promise.all([a, b]);
  assert.deepEqual(failures, []);
});
