import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2';
import type { CollectEvent, MetricsBundle, ResourceGraph, StatusBundle } from '@orrery/shared';
import { ClientFactory } from './aws/clients.ts';
import { defaultRegionFor, describeSource, listProfiles, resolveCredentials, sourceFromQuery } from './aws/credentials.ts';
import { collectorLabels, runCollectors } from './collectors/index.ts';
import { assembleGraph } from './graph/assemble.ts';
import { Cache } from './cache.ts';
import { metricsForGraph } from './metrics/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
// Deliberately not the generic PORT: dev-server launchers set PORT for the web app.
const PORT = Number(process.env.ORRERY_PORT ?? 4820);
const GRAPH_TTL = Number(process.env.ORRERY_GRAPH_TTL_MS ?? 10 * 60_000);
const METRICS_TTL = Number(process.env.ORRERY_METRICS_TTL_MS ?? 60_000);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });
const cache = new Cache(join(here, '..', '..', '.orrery-cache'));

interface Session {
  spec: ReturnType<typeof sourceFromQuery>;
  source: string;
  region: string;
  clients: ClientFactory;
  account: string;
  arn: string;
}

const sessions = new Map<string, Promise<Session>>();

async function session(query: Record<string, unknown>): Promise<Session> {
  const spec = sourceFromQuery(query);
  const region = typeof query.region === 'string' && query.region ? query.region : await defaultRegionFor(spec);
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw Object.assign(new Error(`리전이 올바르지 않습니다: ${region}`), { statusCode: 400 });
  const source = describeSource(spec);
  const key = `${source}@${region}`;
  let pending = sessions.get(key);
  if (!pending) {
    pending = (async () => {
      const clients = new ClientFactory(region, resolveCredentials(spec));
      const sts = clients.get(STSClient);
      const id = await sts.send(new GetCallerIdentityCommand({}));
      return { spec, source, region, clients, account: id.Account ?? 'unknown', arn: id.Arn ?? '' };
    })();
    sessions.set(key, pending);
    pending.catch(() => sessions.delete(key));
  }
  return pending;
}

const graphKey = (s: Session) => `graph_${s.source}_${s.region}`;

async function collectGraph(s: Session, onEvent?: (e: CollectEvent) => void): Promise<ResourceGraph> {
  onEvent?.({ type: 'start', collectors: Object.keys(collectorLabels()), account: s.account, region: s.region });
  const { outputs, reports } = await runCollectors(
    { region: s.region, account: s.account, clients: s.clients, log: (m) => app.log.warn(m) },
    (report) => onEvent?.({ type: 'collector', report }),
  );
  const graph = assembleGraph(outputs, reports, { account: s.account, region: s.region, source: s.source });
  await cache.set(graphKey(s), graph);
  return graph;
}

app.get('/api/health', async () => ({ ok: true, readOnly: true }));

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
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
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
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(ping);
    raw.end();
  }
});

/** Collectors that carry runtime state; the live status pass re-runs only these (all free API calls). */
const STATUS_COLLECTORS = ['ec2', 'elb', 'rds', 'ecs', 'alarms', 'network', 'elasticache'];
const STATUS_PROPS = ['상태 검사', '희망/실행 작업', '실행 작업', '정상/전체', '현재 인스턴스', '배포 상태'];

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
  const fresh = assembleGraph(outputs, reports, { account: s.account, region: s.region, source: s.source });
  const bundle: StatusBundle = { collectedAt: fresh.collectedAt, checked: 0, nodes: {}, edges: {}, durationMs: 0, reports };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of fresh.nodes) {
    const old = byId.get(n.id);
    if (!old) continue;
    bundle.checked++;
    const props: Record<string, string | number | boolean | null> = {};
    for (const k of STATUS_PROPS) if (k in n.props) props[k] = n.props[k];
    bundle.nodes[n.id] = { status: n.status, statusLabel: n.statusLabel, alarms: n.alarms, props };
    old.status = n.status;
    old.statusLabel = n.statusLabel;
    old.alarms = n.alarms;
    Object.assign(old.props, props);
  }
  const oldEdges = new Map(graph.edges.map((e) => [e.id, e]));
  for (const e of fresh.edges) {
    const old = oldEdges.get(e.id);
    if (!old || !e.status) continue;
    bundle.edges[e.id] = e.status;
    old.status = e.status;
  }
  await cache.set(graphKey(s), graph);
  bundle.durationMs = Date.now() - started;
  return bundle;
});

app.get<{ Querystring: Record<string, string> }>('/api/metrics', async (req) => {
  const s = await session(req.query);
  const key = `metrics_${s.source}_${s.region}`;
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

// Production: serve the built web app
const dist = join(here, '..', '..', 'web', 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: '127.0.0.1' });

// Release the port promptly on restart (tsx watch sends SIGTERM); in-flight SSE
// streams would otherwise keep the old process alive and the new one fails with EADDRINUSE.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    const hardExit = setTimeout(() => process.exit(0), 1500);
    hardExit.unref();
    void app.close().finally(() => process.exit(0));
  });
}
