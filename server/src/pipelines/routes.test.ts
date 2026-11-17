import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerPipelineRoutes } from './routes.ts';
import type { ClientFactory } from '../aws/clients.ts';

test('execution detail uses the selected execution and version, paginates actions, omits variables', async () => {
  const calls: { name: string; input: any }[] = [];
  const client = { send: async (command: any) => {
    calls.push({ name: command.constructor.name, input: command.input });
    switch (command.constructor.name) {
      case 'GetPipelineExecutionCommand': return { pipelineExecution: { status: 'Failed', pipelineVersion: 4, variables: [{ resolvedValue: 'private' }] } };
      case 'GetPipelineCommand': return { pipeline: { stages: [{ name: 'Build' }, { name: 'Deploy' }] } };
      case 'ListActionExecutionsCommand': return command.input.nextToken ? { actionExecutionDetails: [] } : { nextToken: 'page2', actionExecutionDetails: [{ stageName: 'Build', actionName: 'Compile', status: 'Failed', input: { actionTypeId: { category: 'Build' }, configuration: { Secret: 'private' } }, output: { outputVariables: { Secret: 'private' }, executionResult: { errorDetails: { message: 'build failed' } } } }] };
    }
  } };
  const app = Fastify();
  registerPipelineRoutes(app, async () => ({ clients: { get: () => client } as unknown as ClientFactory }));
  const id = '11111111-1111-1111-1111-111111111111';
  const result = await app.inject(`/api/pipelines?name=demo&execution=${id}`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().actions[0].error, 'build failed');
  assert.equal(result.json().actions[0].category, 'Build');
  assert.deepEqual(result.json().stageActions, { Build: [], Deploy: [] });
  assert.deepEqual(result.json().stages, ['Build', 'Deploy']);
  assert.equal(calls[1].input.version, 4);
  for (const call of calls.filter(c => c.name === 'ListActionExecutionsCommand')) assert.equal(call.input.filter.pipelineExecutionId, id);
  assert.equal(calls[3].input.nextToken, 'page2');
  assert.ok(!result.body.includes('private'));
  await app.close();
});

test('invalid queries cannot reach credentials; AWS errors are not empty successes', async () => {
  const app = Fastify(); let sessions = 0;
  registerPipelineRoutes(app, async () => { sessions++; throw new Error('AccessDenied'); });
  assert.equal((await app.inject('/api/pipelines?name=bad/name')).statusCode, 400);
  assert.equal((await app.inject('/api/pipelines?execution=invalid')).statusCode, 400);
  assert.equal(sessions, 0);
  const denied = await app.inject('/api/pipelines');
  assert.equal(denied.statusCode, 500);
  assert.match(denied.body, /AccessDenied/);
  await app.close();
});
