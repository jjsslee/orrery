import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { Route53Client } from '@aws-sdk/client-route-53';
import { edgeCollector } from './edge.ts';
import { assembleGraph } from '../graph/assemble.ts';
import type { CollectorContext } from './types.ts';

async function collectFixture(failResources = false, manyResources = false) {
  const config = { region: 'us-east-1', credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' } };
  const clients = [new CloudFrontClient(config), new APIGatewayClient(config), new ApiGatewayV2Client(config), new Route53Client(config)];
  const calls: string[] = [];
  for (const client of clients) client.send = (async (command: { constructor: { name: string } }) => {
    const name = command.constructor.name; calls.push(name);
    switch (name) {
      case 'ListDistributionsCommand': return { DistributionList: { Items: [{ Id: 'web', DomainName: 'd123.cloudfront.net', Enabled: true, Status: 'Deployed', Aliases: { Items: ['app.example.com'] } }], IsTruncated: false } };
      case 'GetRestApisCommand': return { items: [{ id: 'rest', name: 'unrelated-name' }] };
      case 'GetResourcesCommand':
        if (failResources) throw new Error('AccessDenied');
        if (manyResources) return { items: Array.from({ length: 201 }, (_, i) => ({ id: `resource-${i}`, path: `/path-${i}`, resourceMethods: { GET: {} } })) };
        return { items: [{ id: 'resource', path: '/orders', resourceMethods: { OPTIONS: { methodIntegration: { type: 'MOCK', integrationResponses: { '204': { statusCode: '204', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'https://app.example.com'" } } } } }, GET: {} } }] };
      case 'GetIntegrationCommand': throw new Error('AccessDenied');
      case 'GetStagesCommand': return { item: [], Items: [] };
      case 'GetApisCommand': return { Items: [{ ApiId: 'http', ProtocolType: 'HTTP', CorsConfiguration: { AllowOrigins: ['https://app.example.com'] } }, { ApiId: 'ws', ProtocolType: 'WEBSOCKET' }] };
      case 'GetIntegrationsCommand': return { Items: [] };
      case 'GetRoutesCommand': return { Items: [] };
      case 'ListHostedZonesCommand': return { HostedZones: [], IsTruncated: false };
      default: throw new Error(`Unexpected extra call: ${name}`);
    }
  }) as typeof client.send;
  const ctx: CollectorContext = { account: '000000000000', region: 'us-east-1', clients: { get: (ctor: unknown) => clients.find((client) => client.constructor === ctor) } as unknown as CollectorContext['clients'], limit: (fn) => fn(), log: () => {} };
  return { output: await edgeCollector.run(ctx), calls };
}

test('existing edge collector responses produce CORS evidence through graph assembly with the bounded route read alongside existing CORS reads', async () => {
  const { output, calls } = await collectFixture();
  const graph = assembleGraph([output], [], { source: 'profile:test', account: '000000000000', region: 'us-east-1' });
  assert.equal(graph.frontendRelations?.relations.length, 2);
  assert.equal(graph.frontendRelations?.cors.some((v) => v.targetId === 'api-gateway:ws'), false);
  assert.equal(graph.frontendRelations?.cors.find((v) => v.method === 'OPTIONS')?.statusCode, '204');
  assert.equal(graph.frontendRelations?.cors.find((v) => v.method === 'GET')?.issues[0], 'lookup-failed');
  assert.equal(graph.frontendRelations?.coverage.find((v) => v.service === 'rest-api')?.state, 'partial');
  assert.equal(calls.length, 13);
  assert.equal(calls.filter((v) => v === 'GetApisCommand').length, 1);
});

test('failed REST resource lookup remains partial, while independent HTTP CORS still works', async () => {
  const { output } = await collectFixture(true);
  const graph = assembleGraph([output], [], { source: 'profile:test', account: '000000000000', region: 'us-east-1' });
  assert.equal(graph.frontendRelations?.relations.length, 1);
  assert.equal(graph.frontendRelations?.cors.find((v) => v.targetId === 'api-gateway:rest')?.issues[0], 'lookup-failed');
});


test('REST integration lookup cap leaves explicit unknown evidence rather than missing relationships', async () => {
  const { output, calls } = await collectFixture(false, true);
  assert.equal(calls.filter((v) => v === 'GetIntegrationCommand').length, 200);
  assert.equal(output.frontendDiscovery?.cors.filter((v) => v.issues.includes('lookup-limit')).length, 1);
  assert.equal(output.frontendDiscovery?.coverage.find((v) => v.service === 'rest-api')?.state, 'partial');
});
