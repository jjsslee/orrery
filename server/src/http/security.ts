import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { rejectNonLocal } from './local-only.ts';
import { SECURITY_HEADERS } from '../../../shared/src/security-headers.ts';
export { SECURITY_HEADERS } from '../../../shared/src/security-headers.ts';

export function createApiToken(): string { return randomBytes(32).toString('hex'); }

export function registerLocalSecurity(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    const reason = rejectNonLocal(req.url, req.headers);
    if (reason) return reply.code(403).send({ error: reason });
    // Only health is public; neither HTML nor any bootstrap endpoint reveals the token.
    const path = req.routeOptions.url ?? req.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply.code(401).send({ error: '접속 인증이 필요합니다. 앱을 다시 실행하거나 로컬 접속 안내 파일을 열어 주세요.' });
    }
    reply.header('Cache-Control', 'no-store');
  });
}
