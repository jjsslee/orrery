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
  registerPipelineRoutes(app, async () => ({ clients: { get: () => client } as unknown as ClientFactory, account: '111111111111', region: 'ap-northeast-2', arn: 'arn:aws:iam::111111111111:user/demo' }));
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

test('pipeline catalog returns tags from the authenticated partition and isolates tag denial', async () => {
  const requests: any[] = []; let active = 0, peak = 0;
  const client = { send: async (command: any) => {
    requests.push(command.input);
    if (command.constructor.name === 'ListPipelinesCommand') return { pipelines: ['api', 'denied', 'web', 'worker'].map(name => ({ name })), nextToken: 'next-page' };
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (command.input.resourceArn.endsWith(':denied')) throw new Error('AccessDenied');
    return { tags: [{ key: 'Environment', value: 'Prod' }, { key: 'Empty', value: '' }] };
  } };
  const app = Fastify();
  registerPipelineRoutes(app, async () => ({ clients: { get: () => client } as unknown as ClientFactory, account: '111111111111', region: 'cn-north-1', arn: 'arn:aws-cn:iam::111111111111:user/demo' }));
  const response = await app.inject('/api/pipelines?nextToken=previous-page');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.nextToken, 'next-page'); assert.equal(requests[0].nextToken, 'previous-page');
  assert.equal(requests[1].resourceArn, 'arn:aws-cn:codepipeline:cn-north-1:111111111111:api');
  assert.deepEqual(body.tags.api.tags, [{ key: 'Environment', value: 'Prod' }, { key: 'Empty', value: '' }]);
  assert.equal(body.tags.denied.error, 'AccessDenied'); assert.ok(body.names.includes('denied'));
  assert.equal(peak, 3);
  await app.close();
});
