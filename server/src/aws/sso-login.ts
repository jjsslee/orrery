import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ProfileInfo, SsoLoginStatus } from '@orrery/shared';
import { listProfiles } from './credentials.ts';

// Authentication is deliberately separate from the read-only AWS resource clients.
// The CLI owns its standard SSO cache; no tokens, URLs or CLI output enter the API/logs.
function launch(profile: string): ChildProcess {
  const candidates = process.platform === 'win32'
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Amazon', 'AWSCLIV2', 'aws.exe')]
    : ['/usr/local/bin/aws', '/opt/homebrew/bin/aws'];
  const executable = candidates.find(existsSync) ?? 'aws';
  return spawn(executable, ['sso', 'login', '--profile', profile, '--no-cli-pager'], { shell: false, stdio: 'ignore', windowsHide: true });
}

export class SsoLoginManager {
  private job?: { status: SsoLoginStatus; child: ChildProcess; timer?: ReturnType<typeof setTimeout> };
  constructor(private readonly startProcess = launch, private readonly timeoutMs = 10 * 60_000) {}

  start(profile: string): SsoLoginStatus {
    if (this.job?.status.state === 'pending') {
      if (this.job.status.profile === profile) return { ...this.job.status };
      throw Object.assign(new Error('다른 프로필의 SSO 로그인이 진행 중입니다. 먼저 취소해 주세요.'), { statusCode: 409 });
    }
    const child = this.startProcess(profile);
    const job = { status: { id: randomUUID(), profile, state: 'pending' } as SsoLoginStatus, child, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    this.job = job;
    const finish = (state: SsoLoginStatus['state'], message?: string) => {
      if (job.status.state !== 'pending') return;
      clearTimeout(job.timer);
      job.status = { ...job.status, state, message };
    };
    child.once('error', (err: NodeJS.ErrnoException) => finish('failed', err.code === 'ENOENT'
      ? 'AWS CLI v2를 설치한 뒤 다시 시도하세요. Orrery는 설치된 AWS CLI로 SSO 로그인을 시작합니다.'
      : 'AWS SSO 로그인 프로세스를 시작하지 못했습니다. AWS CLI 설치 상태를 확인하세요.'));
    child.once('exit', (code) => finish(code === 0 ? 'succeeded' : 'failed', code === 0 ? undefined : 'SSO 로그인이 완료되지 않았습니다. 브라우저 인증과 프로필 설정을 확인하고 다시 시도하세요.'));
    job.timer = setTimeout(() => { finish('failed', 'SSO 로그인 대기 시간이 지났습니다. 다시 로그인하세요.'); child.kill(); }, this.timeoutMs);
    job.timer.unref();
    return { ...job.status };
  }

  get(id: string): SsoLoginStatus {
    if (!this.job || this.job.status.id !== id) throw Object.assign(new Error('로그인 요청을 찾을 수 없습니다. 다시 시도하세요.'), { statusCode: 404 });
    return { ...this.job.status };
  }

  cancel(id: string): SsoLoginStatus {
    this.get(id);
    const job = this.job!;
    if (job.status.state === 'pending') {
      job.status = { ...job.status, state: 'cancelled' };
      clearTimeout(job.timer);
      job.child.kill();
    }
    return { ...job.status };
  }

  close(): void { if (this.job) this.cancel(this.job.status.id); }
}

export function registerSsoLoginRoutes(app: FastifyInstance, manager = new SsoLoginManager(), profiles: () => Promise<ProfileInfo[]> = listProfiles): void {
  app.post<{ Body: { profile?: unknown } }>('/api/sso/login', async (req, reply) => {
    // Require JSON, so a cross-origin form cannot start a browser/login process.
    if (!req.headers['content-type']?.startsWith('application/json')) return reply.code(415).send({ error: 'JSON 요청만 허용합니다.' });
    const profile = req.body?.profile;
    if (typeof profile !== 'string' || !/^[A-Za-z0-9_.@:+=,-]{1,128}$/.test(profile)) return reply.code(400).send({ error: '프로필 이름이 올바르지 않습니다.' });
    if (!(await profiles()).some((p) => p.name === profile && p.method === 'sso')) return reply.code(400).send({ error: '설정된 SSO 프로필만 로그인할 수 있습니다.' });
    return manager.start(profile);
  });
  app.get<{ Params: { id: string } }>('/api/sso/login/:id', async (req) => manager.get(req.params.id));
  app.post<{ Params: { id: string } }>('/api/sso/login/:id/cancel', async (req, reply) => {
    if (!req.headers['content-type']?.startsWith('application/json')) return reply.code(415).send({ error: 'JSON 요청만 허용합니다.' });
    return manager.cancel(req.params.id);
  });
  app.addHook('onClose', async () => manager.close());
}
