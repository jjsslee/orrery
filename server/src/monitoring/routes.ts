import { buildMonitoringPath, pathOptions } from './paths.ts';
import { MonitoringGraphRepository, relatedCandidates, type MonitoringGraphProvider } from './related.ts';
import { MetricsRepository } from './metrics.ts';
import type { FastifyInstance } from 'fastify';
import type { MonitoringResourceType } from '@orrery/shared';
import { AlarmRepository, alarmHistory, mapAlarms, type MonitoringSession } from './alarms.ts';
import { ResourceRepository, MONITORING_TYPES } from './resources.ts';

export function registerMonitoringRoutes(app: FastifyInstance, session: (query: Record<string, unknown>) => Promise<MonitoringSession>, alarms: AlarmRepository, resources = new ResourceRepository(), graphProvider?: MonitoringGraphProvider) {
  const metrics = new MetricsRepository();
  const graphs = new MonitoringGraphRepository(graphProvider);
  const scope = (s: MonitoringSession) => ({ source: s.source, account: s.account, region: s.region });
  const validateKeys = (s: MonitoringSession, input: unknown): string[] => {
    if (!Array.isArray(input) || input.length < 1 || input.length > 100 || input.some((key) => typeof key !== 'string' || key.length > 2048) || new Set(input).size !== input.length) throw Object.assign(new Error('복원할 자원 키는 중복 없이 1~100개여야 합니다.'), { statusCode: 400 });
    for (const key of input) {
      let parts: unknown;
      try { parts = JSON.parse(key); } catch { throw Object.assign(new Error('저장된 자원 키를 해석하지 못했습니다.'), { statusCode: 400 }); }
      if (!Array.isArray(parts) || parts.length !== 4 || parts.some((part) => typeof part !== 'string') || !parts[2] || !parts[3]) throw Object.assign(new Error('저장된 자원 키 형식이 올바르지 않습니다.'), { statusCode: 400 });
      if (parts[0] !== s.account || parts[1] !== s.region) throw Object.assign(new Error('다른 계정·리전의 자원 키는 복원할 수 없습니다.'), { statusCode: 409 });
    }
    return input;
  };
  app.get<{ Querystring: Record<string, string> }>('/api/monitoring/related', async (req) => {
    const s = await session(req.query);
    const [key] = validateKeys(s, [req.query.resourceKey]);
    const options = pathOptions(req.query);
    if (req.query.refresh === '1') graphs.retry(s);
    const graph = await graphs.read(s, req.query.connections === '1');
    if (graph.graph) resources.includeGraph(s, graph.graph);
    const known = resources.known(s);
    const base = known.find((resource) => resource.key === key);
    if (!base) return { scope: scope(s), resourceKey: key, connected: [], sameTags: [], graph: graph.state, tagCoverage: resources.coverage(s), error: '기준 자원을 아직 확인하지 못했습니다. 자원 목록을 갱신하세요.' };
    const historicalGraph = graph.graph ? { ...graph.graph, nodes: [...graph.graph.nodes, ...(graph.graph.historicalNodes ?? [])], edges: graph.graph.relationshipHistory ?? [] } : undefined;
    return { scope: scope(s), resourceKey: key, ...relatedCandidates(base, known, graph.graph), historical: relatedCandidates(base, known, historicalGraph).connected,
      collectionBudget: graph.graph?.collectionBudget, historyPersistenceError:graph.graph?.historyPersistenceError, coverage:graph.graph?.coverage,
      path: graph.graph ? buildMonitoringPath(graph.graph, base.nodeId, options) : undefined,
      changes: graph.graph?.relationshipChanges?.filter(c => c.source === base.nodeId || c.target === base.nodeId), graph: graph.state, tagCoverage: resources.coverage(s) };
  });
  app.post<{ Querystring: Record<string, string>; Body: { resourceKeys?: unknown } }>('/api/monitoring/resources/resolve', async (req) => {
    const s = await session(req.query);
    const keys = validateKeys(s, req.body?.resourceKeys);
    const types = [...new Set(keys.map((key) => JSON.parse(key)[2] as MonitoringResourceType))].filter((type) => MONITORING_TYPES.includes(type));
    await Promise.all(types.map((type) => resources.get(s, type)));
    const before = resources.known(s);
    const needsGraph = keys.some((key) => !before.some((resource) => resource.key === key) && !MONITORING_TYPES.includes(JSON.parse(key)[2]));
    const graph = await graphs.read(s, needsGraph);
    if (graph.graph) resources.includeGraph(s, graph.graph);
    const known = resources.known(s);
    return { scope: scope(s), resources: keys.flatMap((key) => { const found = known.find((resource) => resource.key === key); return found ? [found] : []; }), unresolvedKeys: keys.filter((key) => !known.some((resource) => resource.key === key)), graph: graph.state };
  });

  app.post<{ Querystring: Record<string, string>; Body: unknown }>('/api/monitoring/metrics', async (req) => {
    const s = await session(req.query);
    return metrics.get(s, req.body, resources.known(s));
  });
  app.get<{ Querystring: Record<string, string> }>('/api/monitoring/alarms', async (req) => {
    const s = await session(req.query);
    const snapshot = await alarms.get(s, req.query.refresh === '1');
    return { ...snapshot, alarms: mapAlarms(snapshot.alarms, resources.known(s)) };
  });
  app.get<{ Querystring: Record<string, string> }>('/api/monitoring/resources', async (req) => {
    if (!MONITORING_TYPES.includes(req.query.type as MonitoringResourceType)) throw Object.assign(new Error('지원하는 자원 유형을 선택하세요.'), { statusCode: 400 });
    const s = await session(req.query);
    return resources.get(s, req.query.type as MonitoringResourceType, req.query.refresh === '1');
  });
  app.get<{ Querystring: Record<string, string> }>('/api/monitoring/alarms/history', async (req) => alarmHistory(await session(req.query), req.query));
}
