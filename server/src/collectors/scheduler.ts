import { SchedulerClient, GetScheduleCommand, paginateListSchedules } from '@aws-sdk/client-scheduler';
import type { Collector } from './types.ts';
import type { ResourceNode } from '@orrery/shared';
import { nid } from './ids.ts';
import { attempt, collect } from './util.ts';

export const schedulerCollector: Collector = {
  name: 'scheduler', label: 'EventBridge Scheduler',
  async run(ctx) {
    const client = ctx.clients.get(SchedulerClient);
    const schedules = await collect(paginateListSchedules({ client }, {}), (p) => p.Schedules);
    const nodes: ResourceNode[] = [];
    await Promise.all(schedules.map(async (s) => {
      if (!s.Name || !s.GroupName || !s.Arn) return;
      const d = await attempt(ctx, `scheduler ${s.GroupName}/${s.Name}`, () => client.send(new GetScheduleCommand({ Name: s.Name, GroupName: s.GroupName })));
      const target = d?.Target ?? s.Target;
      nodes.push({ id: nid('scheduler', s.Arn), type: 'scheduler', category: 'integration', name: s.Name,
        nativeId: `${s.GroupName}/${s.Name}`, arn: s.Arn, region: ctx.region,
        status: !d ? 'unknown' : d.State === 'DISABLED' ? 'inactive' : d.State === 'ENABLED' ? 'healthy' : 'unknown',
        statusLabel: d ? d.State : '상세 미수집',
        props: { 그룹: s.GroupName, 일정: d?.ScheduleExpression ?? null, 시간대: d?.ScheduleExpressionTimezone ?? null, 대상: target?.Arn ?? null },
        refs: [target?.Arn, d?.Target?.RoleArn, d?.Target?.DeadLetterConfig?.Arn, d?.KmsKeyArn].filter((v): v is string => Boolean(v)),
      });
    }));
    return { nodes, edges: [] };
  },
};
