import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import Fastify from 'fastify';
import { SsoLoginManager, registerSsoLoginRoutes } from './sso-login.ts';
import { rejectNonLocal } from '../http/local-only.ts';
function processMock() {
  const child = new EventEmitter() as ChildProcess;
  let killed = 0;
  child.kill = () => { killed++; return true; };
  return { child, killed: () => killed };
}

test('login is single-flight and cancelled child exit cannot turn cancellation into success', () => {
  const mock = processMock(); let starts = 0;
  const manager = new SsoLoginManager(() => { starts++; return mock.child; });
  const a = manager.start('dev');
  assert.equal(manager.start('dev').id, a.id);
  assert.equal(starts, 1);
  assert.throws(() => manager.start('prod'), /진행 중/);
  manager.cancel(a.id); mock.child.emit('exit', 0);
  assert.equal(manager.get(a.id).state, 'cancelled');
  assert.equal(mock.killed(), 1);
});

test('CLI absence and failure do not expose process messages or authentication material', () => {
  const mock = processMock(); const manager = new SsoLoginManager(() => mock.child);
  const a = manager.start('dev');
  mock.child.emit('error', Object.assign(new Error('secret verification URL'), { code: 'ENOENT' }));
  assert.equal(manager.get(a.id).state, 'failed');
  assert.match(manager.get(a.id).message!, /AWS CLI v2/);
  assert.ok(!JSON.stringify(manager.get(a.id)).includes('secret'));
  manager.close();
});

test('login times out and terminates its child', async () => {
  const mock = processMock(); const manager = new SsoLoginManager(() => mock.child, 10);
  const a = manager.start('dev');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(manager.get(a.id).state, 'failed');
  assert.equal(mock.killed(), 1);
});

test('routes reject cross-site, form, non-SSO and injected profiles before spawning', async () => {
  let starts = 0; const mock = processMock();
  const manager = new SsoLoginManager(() => { starts++; return mock.child; });
  const app = Fastify();
  app.addHook('onRequest', async (req, reply) => { if (rejectNonLocal(req.url, req.headers)) return reply.code(403).send(); });
  registerSsoLoginRoutes(app, manager, async () => [{ name: 'dev', method: 'sso', isDefault: false }, { name: 'keys', method: 'static', isDefault: false }]);
  try {
    for (const profile of ['keys', 'missing', 'dev;touch /tmp/bad']) assert.equal((await app.inject({ method: 'POST', url: '/api/sso/login', payload: { profile } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sso/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { profile: 'dev' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sso/login', headers: { 'content-type': 'text/plain' }, payload: 'dev' })).statusCode, 415);
    assert.equal(starts, 0);
    const response = await app.inject({ method: 'POST', url: '/api/sso/login', payload: { profile: 'dev' } });
    assert.equal(response.statusCode, 200);
    const status = response.json();
    mock.child.emit('exit', 0);
    assert.equal((await app.inject(`/api/sso/login/${status.id}`)).json().state, 'succeeded');
    assert.equal((await app.inject('/api/sso/login/invalid')).statusCode, 404);
  } finally { await app.close(); }
});
