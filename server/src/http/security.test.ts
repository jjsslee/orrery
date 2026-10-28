import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerLocalSecurity, createApiToken } from './security.ts';

test('all data/control routes require a token, with no public token bootstrap', async () => {
  const app = Fastify();
  const token = createApiToken();
  registerLocalSecurity(app, token);
  for (const path of ['/api/health', '/api/profiles', '/api/graph/stream', '/api/sso/login', '/api/quit']) {
    app.route({ method: ['GET', 'POST'], url: path, handler: async () => ({ ok: true }) });
  }
  app.get('/', async () => '<html>dummy</html>');
  try {
    const local = { host: '127.0.0.1:4820' };
    for (const url of ['/api/profiles', '/api/graph/stream', '/api/sso/login', '/api/quit']) {
      for (const method of ['GET', 'POST'] as const) {
        for (const authorization of ['', 'Bearer wrong-token', `Bearer ${createApiToken()}`]) {
          assert.equal((await app.inject({ method, url, headers: { ...local, authorization } })).statusCode, 401);
        }
        const res = await app.inject({ method, url, headers: { ...local, authorization: `Bearer ${token}` } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['cache-control'], 'no-store');
      }
    }
    for (const url of ['/', '/api/health']) {
      const res = await app.inject({ url, headers: local });
      assert.equal(res.statusCode, 200);
      assert.ok(!res.body.includes(token));
      assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
    }
    assert.equal((await app.inject({ url: '/api/profiles', headers: { ...local, authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/profiles', headers: { ...local, authorization: `Bearer ${token}`, origin: 'https://example.invalid' } })).statusCode, 403);
  } finally { await app.close(); }
});
