import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectNonLocal } from './local-only.ts';

test('accepts loopback hosts from the app itself, a typed URL, or a non-browser client', () => {
  for (const host of ['127.0.0.1:4820', 'localhost:4820', '[::1]:4820', 'LOCALHOST:5173', '127.0.0.1']) {
    assert.equal(rejectNonLocal('/api/graph', { host, 'sec-fetch-site': 'same-origin' }), undefined, host);
  }
  assert.equal(rejectNonLocal('/api/graph', { host: '127.0.0.1:4820', 'sec-fetch-site': 'none' }), undefined);
  assert.equal(rejectNonLocal('/api/graph', { host: '127.0.0.1:4820' }), undefined);
});

test('rejects a rebound DNS name pointing at loopback, for the page and the API alike', () => {
  for (const host of ['attacker.example:4820', 'attacker.example', '127.0.0.1.attacker.example:4820', undefined]) {
    assert.ok(rejectNonLocal('/api/graph', { host, 'sec-fetch-site': 'same-origin' }), String(host));
    assert.ok(rejectNonLocal('/', { host, 'sec-fetch-site': 'same-origin' }), String(host));
  }
});

test('rejects API requests another site makes from the same browser', () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.ok(rejectNonLocal('/api/metrics?refresh=1', { host: '127.0.0.1:4820', 'sec-fetch-site': site }), site);
  }
});

test('lets a link on another site open the app page itself', () => {
  assert.equal(rejectNonLocal('/', { host: '127.0.0.1:4820', 'sec-fetch-site': 'cross-site' }), undefined);
  assert.equal(rejectNonLocal('/assets/index.js', { host: '127.0.0.1:4820', 'sec-fetch-site': 'same-origin' }), undefined);
});
