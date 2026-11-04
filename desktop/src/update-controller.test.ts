import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { Update } from './updates';

// Run the real controller with native dialogs/quit replaced, without opening windows or touching AWS/user data.
const source = transformSync(readFileSync(new URL('./update-controller.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
type Controller = { start(): void; ready(): Promise<void>; check(manual: boolean): Promise<void> };
const available: Update = { version: '0.10.0', name: 'Orrery-macos-arm64.zip', url: 'https://github.com/jjsslee/orrery/releases/download/v0.10.0/Orrery-macos-arm64.zip', size: 1024, sha256: '0'.repeat(64) };

function harness(options: { update?: Update; answer?: number; failure?: 'check' | 'prepare' | 'helper'; lookup?: () => Promise<Update | undefined>; prepare?: (signal: AbortSignal) => Promise<{ directory: string }> } = {}) {
  const actions: string[] = [], dialogs: Array<{ message: string; detail?: string }> = [];
  const events = new Map<string, (event?: { preventDefault(): void }) => void>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let destroyed = false;
  const item = { label: '', enabled: true };
  const record = async (name: string) => { actions.push(name); if (options.failure === name) throw new Error('dummy failure'); };
  const register = (event: string, callback: (event?: { preventDefault(): void }) => void) => events.set(event, callback);
  const app = {
    isPackaged: true, once: register, on: register,
    getPath: (name: string) => name === 'exe' ? '/dummy/Orrery.app/Contents/MacOS/Orrery' : '/dummy/userData', getVersion: () => '0.9.2',
    quit: () => { actions.push('quit'); let prevented = false; events.get('before-quit')?.({ preventDefault: () => { prevented = true; } }); if (!prevented) destroyed = true; },
  };
  const dependencies = {
    electron: { app, dialog: { showMessageBox: async (dialog: { message: string }) => { dialogs.push(dialog); return { response: options.answer ?? 0 }; } } },
    './updates': { checkUpdate: async () => { await record('check'); return options.lookup ? options.lookup() : options.update; } },
    './update-install': {
      acknowledgeUpdate: async () => { await record('ready'); }, updateNotice: async () => undefined,
      prepareUpdate: async (_update: unknown, _data: unknown, _exe: unknown, _platform: unknown, _arch: unknown, pids: number[], _request: unknown, signal: AbortSignal) => { await record('prepare'); assert.deepEqual([...pids], [123, 42]); return options.prepare ? options.prepare(signal) : { directory: '/dummy/staging' }; },
      startUpdateHelper: async () => { await record('helper'); }, cancelPreparedUpdate: async () => { await record('cancel'); },
    },
  };
  type Constructor = new (window: () => unknown, server: () => number) => Controller & { bindMenu(item: unknown): void };
  const module = { exports: {} as { UpdateController: Constructor } };
  runInNewContext(source, {
    module, exports: module.exports, require: (name: keyof typeof dependencies) => dependencies[name], AbortController,
    process: { pid: 123, argv: ['orrery', '--orrery-update=dummy'], platform: 'darwin', arch: 'arm64' },
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return 1; },
    setInterval: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimeout() {}, clearInterval() {},
  });
  const controller = new module.exports.UpdateController(() => ({ isDestroyed: () => destroyed, setProgressBar: (value: number) => actions.push(`progress:${value}`) }), () => 42);
  controller.bindMenu(item);
  return { controller, app, events, timers, actions, dialogs, item };
}

test('automatic checks stay quiet when current or offline; manual checks explain the result', async () => {
  const current = harness();
  await current.controller.check(false);
  assert.equal(current.dialogs.length, 0);
  await current.controller.check(true);
  assert.match(current.dialogs[0].message, /최신 버전/);
  const offline = harness({ failure: 'check' });
  await offline.controller.check(false);
  assert.equal(offline.dialogs.length, 0);
  await offline.controller.check(true);
  assert.match(offline.dialogs[0].message, /업데이트하지 못/);
});

test('later preserves the app and suppresses repeated automatic prompts, while manual checks remain available', async () => {
  const h = harness({ update: available, answer: 1 });
  await h.controller.check(false);
  await h.controller.check(false);
  assert.equal(h.dialogs.length, 1);
  await h.controller.check(true);
  assert.equal(h.dialogs.length, 2);
  assert.equal(h.actions.includes('prepare'), false);
  assert.equal(h.actions.includes('quit'), false);
});

test('declining an update does not turn later automatic network failures into modal errors', async () => {
  const options: Parameters<typeof harness>[0] = { update: available, answer: 1 };
  const h = harness(options);
  await h.controller.check(false);
  assert.equal(h.dialogs.length, 1);
  options.failure = 'check';
  await h.controller.check(false);
  assert.equal(h.dialogs.length, 1);
});

test('accepting an update quits only after verified preparation and a successful helper handshake', async () => {
  const h = harness({ update: available });
  h.controller.start();
  await h.controller.check(true);
  assert.deepEqual(h.actions, ['check', 'progress:2', 'prepare', 'helper', 'quit']);
  assert.match(h.dialogs[0].detail!, /앱을 종료/);
  assert.equal(h.item.enabled, true);
});

test('verification and helper failures keep the current app running and clean up prepared transactions', async () => {
  for (const failure of ['prepare', 'helper'] as const) {
    const h = harness({ update: available, failure });
    await h.controller.check(true);
    assert.equal(h.actions.includes('quit'), false);
    assert.equal(h.actions.includes('cancel'), failure === 'helper');
    assert.match(h.dialogs.at(-1)!.message, /현재 앱은 계속/);
    assert.equal(h.item.enabled, true);
  }
});

test('concurrent checks never start a second download or dialog', async () => {
  let resolve!: (update: Update) => void;
  const lookup = new Promise<Update>((done) => { resolve = done; });
  const h = harness({ lookup: () => lookup, answer: 1 });
  const first = h.controller.check(true);
  await h.controller.check(true);
  resolve(available);
  await first;
  assert.equal(h.actions.filter((action) => action === 'check').length, 1);
  assert.equal(h.dialogs.length, 1);
});

test('closing the app while checking does not offer an update or prepare an install', async () => {
  let resolve!: (update: Update) => void;
  const lookup = new Promise<Update>((done) => { resolve = done; });
  const h = harness({ lookup: () => lookup });
  h.controller.start();
  const first = h.controller.check(true);
  h.events.get('before-quit')!();
  resolve(available);
  await first;
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.actions.includes('prepare'), false);
});

test('quitting during preparation aborts it and waits for cleanup before allowing exit', async () => {
  let entered!: () => void, finish!: () => void;
  let signal!: AbortSignal;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const h = harness({ update: available, prepare: (value) => {
    signal = value; entered();
    return new Promise((_resolve, reject) => { finish = () => reject(signal.reason); });
  } });
  const checking = h.controller.check(true);
  await preparing;
  h.app.quit();
  assert.equal(signal.aborted, true);
  assert.equal(h.actions.filter((action) => action === 'quit').length, 1);
  finish();
  await checking;
  await Promise.resolve();
  assert.equal(h.actions.filter((action) => action === 'quit').length, 2);
  assert.equal(h.actions.includes('helper'), false);
  assert.equal(h.dialogs.length, 1); // confirmation only; user-requested shutdown has no error modal
});

test('only packaged apps schedule checks, and startup acknowledgement is delegated after the page is ready', async () => {
  const h = harness();
  h.controller.start();
  assert.deepEqual(h.timers.map((timer) => timer.delay), [10_000, 6 * 60 * 60_000]);
  await h.controller.ready();
  assert.ok(h.actions.includes('ready'));
  const development = harness();
  development.app.isPackaged = false;
  development.controller.start();
  await development.controller.check(true);
  assert.equal(development.timers.length, 0);
  assert.match(development.dialogs[0].message, /설치한 Orrery/);
  assert.equal(development.actions.includes('check'), false);
});
