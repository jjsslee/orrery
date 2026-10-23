import { MetricsRepository } from './metrics.ts';
import type { FastifyInstance } from 'fastify';
import type { MonitoringResourceType } from '@orrery/shared';
import { AlarmRepository, alarmHistory, mapAlarms, type MonitoringSession } from './alarms.ts';
import { ResourceRepository, MONITORING_TYPES } from './resources.ts';

export function registerMonitoringRoutes(app: FastifyInstance, session: (query: Record<string, unknown>) => Promise<MonitoringSession>, alarms: AlarmRepository, resources = new ResourceRepository()) {
  const metrics = new MetricsRepository();
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
