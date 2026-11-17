import type { FastifyInstance } from 'fastify';
import { CodePipelineClient, ListPipelinesCommand, ListPipelineExecutionsCommand, GetPipelineExecutionCommand, GetPipelineCommand, ListActionExecutionsCommand } from '@aws-sdk/client-codepipeline';
import type { ClientFactory } from '../aws/clients.ts';
import type { PipelineDetail, PipelineHistory, PipelinePage } from '@orrery/shared';

export function registerPipelineRoutes(app: FastifyInstance, session: (query: Record<string, unknown>) => Promise<{ clients: ClientFactory }>) {
  app.get<{ Querystring: Record<string, string> }>('/api/pipelines', async req => {
    const q = req.query;
    if ((q.name && !/^[A-Za-z0-9.@_-]{1,100}$/.test(q.name)) || (q.execution && !/^[a-f0-9-]{36}$/.test(q.execution)) || (q.nextToken && q.nextToken.length > 4096) || (q.execution && !q.name)) {
      throw Object.assign(new Error('Invalid pipeline query'), { statusCode: 400 });
    }
    const client = (await session(q)).clients.get(CodePipelineClient);
    if (!q.name) {
      const result = await client.send(new ListPipelinesCommand({ maxResults: 100, nextToken: q.nextToken }));
      return { names: (result.pipelines ?? []).flatMap(p => p.name ? [p.name] : []), nextToken: result.nextToken } satisfies PipelinePage;
    }
    if (!q.execution) {
      const result = await client.send(new ListPipelineExecutionsCommand({ pipelineName: q.name, maxResults: 20, nextToken: q.nextToken }));
      return { executions: (result.pipelineExecutionSummaries ?? []).map(e => ({ id: e.pipelineExecutionId!, status: e.status ?? 'Unknown', startedAt: e.startTime?.toISOString(), updatedAt: e.lastUpdateTime?.toISOString() })), nextToken: result.nextToken } satisfies PipelineHistory;
    }
    const execution = await client.send(new GetPipelineExecutionCommand({ pipelineName: q.name, pipelineExecutionId: q.execution }));
    const definition = await client.send(new GetPipelineCommand({ name: q.name, version: execution.pipelineExecution?.pipelineVersion }));
    const actions: PipelineDetail['actions'] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const result = await client.send(new ListActionExecutionsCommand({ pipelineName: q.name, filter: { pipelineExecutionId: q.execution }, maxResults: 100, nextToken }));
      for (const a of result.actionExecutionDetails ?? []) actions.push({ id: a.actionExecutionId, stage: a.stageName ?? '', name: a.actionName ?? '', status: a.status ?? 'Unknown', startedAt: a.startTime?.toISOString(), updatedAt: a.lastUpdateTime?.toISOString(), error: a.output?.executionResult?.errorDetails?.message });
      nextToken = result.nextToken;
      if (++pages >= 20 && nextToken) throw new Error('Action history exceeds 20 pages');
    } while (nextToken);
    return { status: execution.pipelineExecution?.status ?? 'Unknown', stages: (definition.pipeline?.stages ?? []).map(s => s.name!), actions, checkedAt: new Date().toISOString() } satisfies PipelineDetail;
  });
}
