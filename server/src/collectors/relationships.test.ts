import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleLabel, matchesCollection } from './relationships.ts';
test('listener condition label preserves priority and all condition forms', () => {
  const label = ruleLabel({ Priority: '10', Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['api.example.test'] } }, { Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/*'] } }, { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Test', Values: ['yes'] } }] });
  assert.match(label, /10/); assert.match(label, /api.example.test/); assert.match(label, /\/v1\/\*/); assert.match(label, /X-Test/);
});
test('collection policy wildcard is anchored and escapes regex characters', () => {
  assert.equal(matchesCollection('collection/orders-*', 'orders-prod'), true);
  assert.equal(matchesCollection('collection/orders', 'preorders'), false);
  assert.equal(matchesCollection('collection/a.b', 'axb'), false);
});
