/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitoringRefresh } from './monitoring-refresh';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fakeTimer() { let id = 0; const jobs = new Map<number, { callback: () => void; ms: number }>(); return { jobs, schedule(callback: () => void, ms: number) { jobs.set(++id, { callback, ms }); return id as unknown as ReturnType<typeof setTimeout>; }, cancel(timer: ReturnType<typeof setTimeout>) { jobs.delete(timer as unknown as number); }, fire() { const first = jobs.entries().next().value!; jobs.delete(first[0]); first[1].callback(); } }; }
test('refresh starts after interval, schedules after completion and stops during an in-flight request', async () => {
  const timer = fakeTimer(); let calls = 0; let resolve!: (success: boolean) => void;
  const scheduler = createMonitoringRefresh({ interval: 60000, run: () => { calls++; return new Promise((r) => { resolve = r; }); }, ...timer });
  scheduler.start(); scheduler.start(); assert.equal(calls, 0); assert.equal(timer.jobs.size, 1); timer.fire(); assert.equal(calls, 1); assert.equal(timer.jobs.size, 0); scheduler.stop(); resolve(true); await flush(); assert.equal(timer.jobs.size, 0);
});
test('temporary failures apply bounded backoff and resume only one timer after pause', async () => {
  const timer = fakeTimer(); let success = false;
  const scheduler = createMonitoringRefresh({ interval: 300000, run: async () => success, ...timer });
  scheduler.start(); timer.fire(); await flush(); assert.equal([...timer.jobs.values()][0].ms, 600000); timer.fire(); await flush(); assert.equal([...timer.jobs.values()][0].ms, 1200000); scheduler.stop(); assert.equal(timer.jobs.size, 0); success = true; scheduler.start(); timer.fire(); await flush(); assert.equal(timer.jobs.size, 1); assert.equal([...timer.jobs.values()][0].ms, 300000); scheduler.stop();
});

test('returning after lunch refreshes immediately instead of waiting another full interval', async () => {
  const timer = fakeTimer(); let now = 0, calls = 0;
  const scheduler = createMonitoringRefresh({ interval: 300000, now: () => now, run: async () => { calls++; return true; }, ...timer });
  scheduler.start(); now = 60000; scheduler.stop();
  now = 3600000; scheduler.start();
  assert.equal([...timer.jobs.values()][0].ms, 0);
  timer.fire(); await flush();
  assert.equal(calls, 1);
  assert.equal([...timer.jobs.values()][0].ms, 300000);
  scheduler.stop();
});

test('short repeated pauses retain the original refresh deadline', () => {
  const timer = fakeTimer(); let now = 0;
  const scheduler = createMonitoringRefresh({ interval: 300000, now: () => now, run: async () => true, ...timer });
  scheduler.start(); now = 60000; scheduler.stop(); now = 120000; scheduler.start();
  assert.equal([...timer.jobs.values()][0].ms, 180000);
  scheduler.stop(); now = 240000; scheduler.start(); scheduler.start();
  assert.equal(timer.jobs.size, 1);
  assert.equal([...timer.jobs.values()][0].ms, 60000);
  scheduler.stop();
});

test('focus after sleep replaces an overdue timer without duplicate requests', async () => {
  const timer = fakeTimer(); let now = 0, calls = 0;
  const scheduler = createMonitoringRefresh({ interval: 300000, now: () => now, run: async () => { calls++; return true; }, ...timer });
  scheduler.start(); now = 3600000; scheduler.start(); scheduler.start();
  assert.equal(timer.jobs.size, 1);
  assert.equal([...timer.jobs.values()][0].ms, 0);
  timer.fire(); scheduler.start(); await flush();
  assert.equal(calls, 1);
  assert.equal(timer.jobs.size, 1);
  assert.equal([...timer.jobs.values()][0].ms, 300000);
  scheduler.stop();
});
