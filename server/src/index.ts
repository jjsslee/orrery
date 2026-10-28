import { registerSsoLoginRoutes } from './aws/sso-login.ts';
import { registerCleanupRoutes } from './cleanup/routes.ts';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import type { CollectEvent, MetricsBundle, ResourceGraph, StatusBundle } from '@orrery/shared';
import { SessionRegistry, scopeKey } from './aws/sessions.ts';
import { ClientFactory } from './aws/clients.ts';
import { defaultRegionFor, describeSource, listProfiles, resolveCredentials, sourceFromQuery } from './aws/credentials.ts';
import { collectorLabels, runCollectors } from './collectors/index.ts';
import { mergeStatus, preserveAlarmSnapshot } from './graph/status.ts';
import { AlarmRepository, graphAlarmInfos } from './monitoring/alarms.ts';
import { registerMonitoringRoutes } from './monitoring/routes.ts';
import { assembleGraph } from './graph/assemble.ts';
import { Cache } from './cache.ts';
import { metricsForGraph } from './metrics/index.ts';
import { createApiToken, registerLocalSecurity, SECURITY_HEADERS } from './http/security.ts';
import { privateDirectory, readPrivateFile, writePrivateFile } from './private-files.ts';
import { BUILD, orreryAt, packaged, portFree, replaceOrrery, showWindow, userDataDir, webFiles } from './runtime.ts';
import { readFileSync } from 'node:fs';

/** Minimal .env loader (KEY=VALUE lines, # comments); never overrides variables already set. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Turns SDK credential failures into something a person can act on. */
function describeCredentialError(err: unknown, source: string): string {
  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  const profile = source.startsWith('profile:') ? source.slice('profile:'.length) : source;
  if (/InvalidClientTokenId|UnrecognizedClientException|InvalidSignature|SignatureDoesNotMatch|AuthFailure/.test(name + message)) {
    return `프로필 '${profile}'의 액세스 키가 유효하지 않습니다 (${name || 'InvalidClientTokenId'}). 상단에서 다른 프로필을 고르거나 'aws configure --profile ${profile}'로 키를 갱신하세요.`;
  }
  if (/ExpiredToken|TokenRefreshRequired|expired/i.test(name + message)) {
    return `프로필 '${profile}'의 임시 자격증명이 만료되었습니다. 'aws sso login --profile ${profile}' 또는 자격증명 갱신 후 다시 시도하세요.`;
  }
  if (/CredentialsProviderError|Could not load credentials|ProfileNotFound|Profile .* not found/i.test(name + message)) {
    return `프로필 '${profile}'의 자격증명을 찾을 수 없습니다. ~/.aws/credentials 또는 ~/.aws/config 설정을 확인하세요. (${message})`;
  }
  if (/AccessDenied/.test(name + message)) {
    return `프로필 '${profile}'로 호출자 확인(sts:GetCallerIdentity)이 거부되었습니다. 읽기 권한이 있는 프로필을 선택하세요.`;
  }
  return `프로필 '${profile}'로 AWS에 연결하지 못했습니다: ${message}`;
}

async function main(): Promise<void> {
const here = dirname(fileURLToPath(import.meta.url));
// The packaged app is configured by environment variables only; there is no repo next to it.
if (!packaged) loadDotEnv(join(here, '..', '..', '.env'));
// Deliberately not the generic PORT: dev-server launchers set PORT for the web app.
const PORT = Number(process.env.ORRERY_PORT ?? 4820);
const GRAPH_TTL = Number(process.env.ORRERY_GRAPH_TTL_MS ?? 10 * 60_000);
const METRICS_TTL = Number(process.env.ORRERY_METRICS_TTL_MS ?? 60_000);

// The desktop app has no console to read: warnings and errors go to orrery.log in the data folder.
if (packaged) await privateDirectory(userDataDir());
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? (packaged ? 'warn' : 'info'), redact: ['req.headers.authorization'], ...(packaged ? { file: join(userDataDir(), 'orrery.log') } : {}) },
});
const apiToken = createApiToken();
registerLocalSecurity(app, apiToken);
registerSsoLoginRoutes(app);
const cache = new Cache(packaged ? join(userDataDir(), 'cache') : join(here, '..', '..', '.orrery-cache'));

interface Session {
  spec: ReturnType<typeof sourceFromQuery>;
  source: string;
  region: string;
  clients: ClientFactory;
  account: string;
  arn: string;
  credentialsExpireAt?: number;
}

const sessions = new SessionRegistry<Session>(5 * 60_000, (s) => s.credentialsExpireAt);

async function session(query: Record<string, unknown>): Promise<Session> {
  const spec = sourceFromQuery(query);
  const region = typeof query.region === 'string' && query.region ? query.region : await defaultRegionFor(spec);
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw Object.assign(new Error(`리전이 올바르지 않습니다: ${region}`), { statusCode: 400 });
  const source = describeSource(spec);
  const key = `${source}@${region}`;
  return sessions.get(key, async () => {
      const clients = new ClientFactory(region, resolveCredentials(spec));
      const sts = clients.get(STSClient);
      let id;
      try {
        id = await sts.send(new GetCallerIdentityCommand({}));
      } catch (err) {
        clients.destroy();
        throw Object.assign(new Error(describeCredentialError(err, source)), { statusCode: 401 });
      }
      return { spec, source, region, clients, account: id.Account ?? 'unknown', arn: id.Arn ?? '', credentialsExpireAt: clients.credentialsExpireAt };
    }, query.reconnect === '1');
}

const alarmRepository = new AlarmRepository();
registerMonitoringRoutes(app, session, alarmRepository, undefined, { getCached: (s) => cache.get<ResourceGraph>(scopeKey('graph-v8', s.source, s.account, s.region), Infinity), collect: (s) => collectGraph(s as Session) });

async function alarmOutput(s: Session) {
  const started = Date.now();
  const snapshot = await alarmRepository.get(s);
  return { observation: snapshot.observation, output: { nodes: [], edges: [], alarms: graphAlarmInfos(snapshot.alarms) }, report: { collector: 'alarms', ok: snapshot.complete, durationMs: Date.now() - started, nodes: 0, edges: 0, error: snapshot.observation.error } };
}

const graphKey = (s: Pick<Session, 'source' | 'account' | 'region'>) => scopeKey('graph-v8', s.source, s.account, s.region);
registerCleanupRoutes(app, session, (s) => cache.get<ResourceGraph>(graphKey(s), GRAPH_TTL));

async function collectGraph(s: Session, onEvent?: (e: CollectEvent) => void): Promise<ResourceGraph> {
  const previous = await cache.get<ResourceGraph>(graphKey(s), Infinity);
  onEvent?.({ type: 'start', collectors: Object.keys(collectorLabels()), account: s.account, region: s.region });
  const { outputs, reports } = await runCollectors(
    { region: s.region, account: s.account, clients: s.clients, log: (m) => app.log.warn(m) },
    (report) => onEvent?.({ type: 'collector', report }),
    Object.keys(collectorLabels()).filter((name) => name !== 'alarms'),
  );
  const alarm = await alarmOutput(s);
  outputs.push(alarm.output);
  reports.push(alarm.report);
  onEvent?.({ type: 'collector', report: alarm.report });
  const graph = assembleGraph(outputs, reports, { account: s.account, region: s.region, source: s.source });
  const alarmReport = reports.find((r) => r.collector === 'alarms');
  graph.alarmObservation = alarm.observation;
  if (!alarmReport?.ok) preserveAlarmSnapshot(graph, previous);
  await cache.set(graphKey(s), graph);
  return graph;
}

app.get('/api/health', async () => ({ ok: true, readOnly: true, build: BUILD }));

// Packaged only: a newer build quits the one still running on its port to take over (replaceOrrery).
if (packaged) {
  app.post('/api/quit', async () => {
    setTimeout(shutdown, 100);
    return { ok: true };
  });
}

app.get('/api/profiles', async () => {
  const profiles = await listProfiles();
  const wanted = process.env.ORRERY_DEFAULT_PROFILE ?? process.env.AWS_PROFILE;
  const defaultProfile = profiles.find((p) => p.name === wanted)?.name ?? profiles.find((p) => p.isDefault)?.name ?? profiles[0]?.name ?? 'default';
  return { profiles, defaultProfile, env: Boolean(process.env.AWS_ACCESS_KEY_ID) };
});

app.get('/api/collectors', async () => collectorLabels());

app.get<{ Querystring: Record<string, string> }>('/api/identity', async (req) => {
  const s = await session(req.query);
  return { account: s.account, arn: s.arn, region: s.region, source: s.source };
});

app.get<{ Querystring: Record<string, string> }>('/api/regions', async (req) => {
  const s = await session(req.query);
  const ec2 = s.clients.get(EC2Client);
  const res = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  return { regions: (res.Regions ?? []).map((r) => r.RegionName ?? '').filter(Boolean).sort() };
});

app.get<{ Querystring: Record<string, string> }>('/api/graph', async (req) => {
  const s = await session(req.query);
  if (req.query.refresh !== '1') {
    const cached = await cache.get<ResourceGraph>(graphKey(s), GRAPH_TTL);
    if (cached) return cached;
  }
  return collectGraph(s);
});

/** Server-sent events: progress per collector, then the full graph. */
app.get<{ Querystring: Record<string, string> }>('/api/graph/stream', async (req, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
  });
  const send = (e: CollectEvent) => raw.write(`data: ${JSON.stringify(e)}\n\n`);
  // A real event (not an SSE comment) so the client can detect a dead stream.
  const ping = setInterval(() => send({ type: 'ping' }), 15_000);
  try {
    const s = await session(req.query);
    if (req.query.refresh !== '1') {
      const cached = await cache.get<ResourceGraph>(graphKey(s), GRAPH_TTL);
      if (cached) {
        send({ type: 'start', collectors: [], account: s.account, region: s.region });
        send({ type: 'done', graph: cached });
        return;
      }
    }
    const graph = await collectGraph(s, send);
    send({ type: 'done', graph });
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : String(err), status: (err as { statusCode?: number }).statusCode });
  } finally {
    clearInterval(ping);
    raw.end();
  }
});

/** Collectors that carry runtime state; the live status pass re-runs only these (all free API calls). */
const STATUS_COLLECTORS = ['ec2', 'elb', 'rds', 'ecs', 'network', 'elasticache'];

/**
 * Status-only refresh: re-reads instance state, target health, ECS task counts,
 * RDS status and alarms, merges them into the cached graph and returns the
 * fresh status fields. Never touches CloudWatch metrics (the only metered call).
 */
app.get<{ Querystring: Record<string, string> }>('/api/status', async (req) => {
  const s = await session(req.query);
  const started = Date.now();
  const graph = (await cache.get<ResourceGraph>(graphKey(s), GRAPH_TTL)) ?? (await collectGraph(s));
  const { outputs, reports } = await runCollectors(
    { region: s.region, account: s.account, clients: s.clients, log: (m) => app.log.warn(m) },
    undefined,
    STATUS_COLLECTORS,
  );
  const alarm = await alarmOutput(s);
  outputs.push(alarm.output);
  reports.push(alarm.report);
  const bundle = mergeStatus(graph, outputs, reports);
  graph.alarmObservation = { ...alarm.observation, succeededAt: alarm.observation.succeededAt ?? graph.alarmObservation?.succeededAt };
  bundle.alarmObservation = graph.alarmObservation;
  await cache.update(graphKey(s), graph, graph);
  bundle.durationMs = Date.now() - started;
  return bundle;
});

app.get<{ Querystring: Record<string, string> }>('/api/metrics', async (req) => {
  const s = await session(req.query);
  const key = scopeKey('metrics-v3', s.source, s.account, s.region);
  if (req.query.refresh !== '1') {
    const cached = await cache.get<MetricsBundle>(key, METRICS_TTL);
    if (cached) return cached;
  }
  const graph = (await cache.get<ResourceGraph>(graphKey(s), GRAPH_TTL)) ?? (await collectGraph(s));
  const bundle = await metricsForGraph(graph, s.clients);
  await cache.set(key, bundle, false);
  return bundle;
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.error(err);
  reply.status(err.statusCode ?? 500).send({ error: err.message || '알 수 없는 오류' });
});

// Production: serve the built web app, shipped next to the packaged server or from web/dist after `npm run build`
const dist = join(here, '..', '..', 'web', 'dist');
if (packaged) {
  const files = webFiles(join(here, 'web'));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
    const file = files.get(req.url.split('?')[0]) ?? files.get('/index.html');
    if (!file) return reply.status(404).send({ error: 'not found' });
    return reply.type(file.type).send(file.body);
  });
} else if (existsSync(dist)) {
  app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

/**
 * The packaged app keeps its usual port when it can (the window remembers
 * profile and region per origin): it replaces a different packaged build still
 * running there (an update), and otherwise takes any free port. A second copy
 * of the same build never gets here: the desktop app runs only once.
 */
async function start(): Promise<void> {
  await cache.initialize();
  let port = PORT;
  if (packaged && !(await portFree(PORT))) {
    const running = await orreryAt(PORT);
    if (!running || !(await replaceOrrery(PORT))) port = 0;
  }
  app.addHook('onClose', async () => {
    // A new instance may have replaced the file; never remove its credentials.
    try {
      if (await readPrivateFile(tokenFile) === apiToken) {
        await rm(tokenFile, { force: true });
        await rm(launcher, { force: true });
      }
    } catch { /* already removed */ }
  });
  await app.listen({ port, host: '127.0.0.1' });
  const actualPort = (app.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${actualPort}/#orrery-token=${apiToken}`;
  const authDir = packaged ? join(userDataDir(), 'private') : join(here, '..', '..', '.orrery-cache', 'private');
  const tokenFile = join(authDir, `${actualPort}.token`);
  await writePrivateFile(tokenFile, apiToken);
  const launcher = join(authDir, `open-${actualPort}.html`);
  if (packaged) showWindow(url);
  else {
    await writePrivateFile(launcher, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Orrery 접속</title><h1>Orrery 접속</h1><p>이 파일을 공유하지 마세요. 서버를 다시 시작하면 파일도 갱신됩니다.</p><p><a href="${url}" rel="noreferrer">빌드된 화면 열기</a></p><p><a href="http://localhost:5173/#orrery-token=${apiToken}" rel="noreferrer">개발 화면 열기 (npm run dev)</a></p>`);
    console.info(`Orrery 접속 안내 파일을 브라우저로 여세요: ${launcher}`);
  }

}

start().catch((err: unknown) => {
  app.log.error(err);
  console.error(`Orrery를 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Release the port promptly on restart (tsx watch sends SIGTERM) or quit; in-flight SSE
// streams would otherwise keep the old process alive and the new one fails with EADDRINUSE.
function shutdown(): void {
  const hardExit = setTimeout(() => process.exit(0), 1500);
  hardExit.unref();
  void app.close().finally(() => process.exit(0));
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, shutdown);

}
void main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
