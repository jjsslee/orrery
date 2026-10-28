import test from 'node:test';
import assert from 'node:assert/strict';
import { allowClipboardWrite } from './permissions';
const origin = 'http://127.0.0.1:4820';
const allowed = (permission = 'clipboard-sanitized-write', current: string | undefined = origin, requesting: string | undefined = origin, main = true) => allowClipboardWrite(permission, origin, current, requesting, main);
test('own main-frame clipboard writes are allowed', () => {
  assert.equal(allowed(), true);
  assert.equal(allowed('clipboard-sanitized-write', `${origin}/`, `${origin}/?view=topology`), true);
});
test('clipboard reads and unrelated permissions remain denied', () => {
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications', 'unknown']) assert.equal(allowed(permission), false);
});
test('other origins, ports, frames and missing document URLs remain denied', () => {
  for (const url of ['http://127.0.0.1:4821', 'https://example.com', 'http://127.0.0.1.evil.test:4820', 'file:///tmp/index.html', 'invalid']) {
    assert.equal(allowed('clipboard-sanitized-write', origin, url), false);
    assert.equal(allowed('clipboard-sanitized-write', url), false);
  }
  assert.equal(allowed('clipboard-sanitized-write', origin, origin, false), false);
  assert.equal(allowClipboardWrite('clipboard-sanitized-write', origin, undefined, origin, true), false);
  assert.equal(allowClipboardWrite('clipboard-sanitized-write', origin, origin, undefined, true), false);
});
