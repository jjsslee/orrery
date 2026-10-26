import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FrontendDiscovery } from '@orrery/shared';
import { httpCors, restCors, classifyOrigin } from '../collectors/cors.ts';
import { buildFrontendRelations } from './frontend-relations.ts';
import { assembleGraph } from './assemble.ts';

const scope = { source: 'profile:dummy', account: '000000000000', region: 'us-east-1' };
const ids = new Set(['cloudfront:web', 'api-gateway:api']);
function fixture(): FrontendDiscovery {
  return { hosting: [{ resourceId: 'cloudfront:web', hosts: ['app.example.com', 'd123.cloudfront.net'], enabled: true, deployed: true }], cors: [httpCors('api-gateway:api', { AllowOrigins: ['https://app.example.com'], AllowMethods: ['GET'], AllowCredentials: true })], coverage: [{ service: 'cloudfront', state: 'complete' }] };
}

test('exact alias matching retains origin scheme/port, several APIs, and merges evidence only for the same relation', () => {
  const input = fixture();
  input.cors.push(httpCors('api-gateway:api', { AllowOrigins: ['http://app.example.com', 'https://app.example.com:8443', 'https://APP.example.com:443'] }));
  input.cors.push(httpCors('api-gateway:second', { AllowOrigins: ['https://app.example.com'] }));
  const result = buildFrontendRelations([input], scope, 'now', new Set([...ids, 'api-gateway:second']));
  assert.equal(result.relations.length, 4);
  assert.equal(result.relations.find((v) => v.origin === 'https://app.example.com' && v.targetId === 'api-gateway:api')?.evidenceIndexes.length, 2);
  assert.equal(result.cors[0].credentials, true);
  assert.equal(result.cors[0].deployment, 'unverified');
  assert.deepEqual(result.scope, scope);
});

test('wildcard, null, local and secret-bearing invalid origins never produce links or persist raw values', () => {
  const input = fixture();
  input.cors = [httpCors('api-gateway:api', { AllowOrigins: ['*', 'https://*', 'null', 'http://localhost:3000', 'http://127.0.0.1', 'https://user:dummy-secret@app.example.com', 'https://app.example.com/?token=dummy-secret', 'https://app.example.com/path', 'https://app.example.com/'] })];
  const result = buildFrontendRelations([input], scope, 'now', ids);
  assert.equal(result.relations.length, 0);
  assert.equal(JSON.stringify(result).includes('dummy-secret'), false);
  assert.deepEqual(input.cors[0].issues, ['wildcard', 'null-origin', 'local-origin', 'invalid-origin']);
  assert.equal(classifyOrigin('https://app.example.com.evil.example').origin, 'https://app.example.com.evil.example');
});

test('missing, disabled, external and partial hosts remain unresolved instead of borrowing another graph', () => {
  const input = fixture();
  input.cors[0].origins.push('https://other.example.com', 'https://app.example.com.evil.example');
  const result = buildFrontendRelations([input], scope, 'now', ids);
  assert.equal(result.relations.length, 1);
  assert.deepEqual(result.unresolved.map((v) => v.reason), ['no-matching-host', 'no-matching-host']);
  input.hosting[0].enabled = false;
  assert.equal(buildFrontendRelations([input], scope, 'now', ids).unresolved[0].reason, 'hosting-disabled');
  input.hosting = [];
  input.coverage[0].state = 'unavailable';
  assert.equal(buildFrontendRelations([input], scope, 'now', ids).unresolved[0].reason, 'hosting-unavailable');
  input.coverage = [];
  assert.equal(buildFrontendRelations([input], scope, 'now', ids).unresolved[0].reason, 'hosting-not-collected');
  assert.equal(buildFrontendRelations([fixture()], scope, 'now', new Set(['cloudfront:web'])).unresolved[0].reason, 'target-not-collected');
});

test('same names across account, region and source get separate IDs and no persistent host index', () => {
  const first = buildFrontendRelations([fixture()], scope, 'now', ids);
  for (const changed of [{ account: '111111111111' }, { region: 'eu-west-1' }, { source: 'profile:another' }]) {
    const second = buildFrontendRelations([fixture()], { ...scope, ...changed }, 'now', ids);
    assert.notEqual(first.relations[0].id, second.relations[0].id);
  }
  const next = fixture(); next.hosting = [];
  assert.equal(buildFrontendRelations([next], { ...scope, account: '111111111111' }, 'now', ids).relations.length, 0);
});

test('REST static response preserves method/path/status and separates preflight from actual responses', () => {
  const integration = { type: 'MOCK' as const, integrationResponses: { '200': { statusCode: '200', responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'https://app.example.com'", 'method.response.header.Access-Control-Allow-Methods': "'GET, POST'" } } } };
  const preflight = restCors('api-gateway:api', '/orders', 'OPTIONS', integration)[0];
  assert.deepEqual(preflight.origins, ['https://app.example.com']);
  assert.equal(preflight.path, '/orders'); assert.equal(preflight.statusCode, '200');
  assert.equal(preflight.responseType, 'preflight'); assert.equal(preflight.deployment, 'editable-config');
  assert.deepEqual(preflight.methods, ['GET', 'POST']);
  assert.equal(restCors('api-gateway:api', '/orders', 'GET', integration)[0].responseType, 'actual-response');
});

test('REST proxy, dynamic mapping and template overrides never claim a literal allowed origin', () => {
  assert.deepEqual(restCors('api', '/', 'GET', { type: 'AWS_PROXY' })[0].issues, ['backend-managed']);
  const dynamic = restCors('api', '/', 'GET', { type: 'AWS', integrationResponses: { '200': { responseParameters: { 'method.response.header.Access-Control-Allow-Origin': 'integration.response.header.origin' } } } });
  assert.deepEqual(dynamic[0].issues, ['dynamic-response']);
  const templated = restCors('api', '/', 'GET', { type: 'MOCK', integrationResponses: { '200': { responseParameters: { 'method.response.header.Access-Control-Allow-Origin': "'https://app.example.com'" }, responseTemplates: { 'application/json': '#set($context.responseOverride.header.x = "y")' } } } });
  assert.equal(templated[0].origins.length, 0);
  assert.deepEqual(templated[0].issues, ['dynamic-response']);
});

test('legacy graph without evidence is distinct from newly collected snapshot and existing edges are unchanged', () => {
  const legacy = { account: scope.account, region: scope.region, source: scope.source, collectedAt: '', nodes: [], edges: [], reports: [] };
  assert.equal('frontendRelations' in legacy, false);
  const graph = assembleGraph([], [], scope);
  assert.equal(graph.frontendRelations?.schemaVersion, 1);
  assert.deepEqual(graph.frontendRelations?.coverage, []);
  assert.deepEqual(graph.edges, []);
});


test('a fully failed edge collector is unavailable rather than successful empty evidence', () => {
  const graph = assembleGraph([], [{ collector: 'edge', ok: false, durationMs: 0, nodes: 0, edges: 0, error: 'AccessDenied' }], scope);
  assert.equal(graph.frontendRelations?.coverage.length, 3);
  assert.ok(graph.frontendRelations?.coverage.every((v) => v.state === 'unavailable'));
});
