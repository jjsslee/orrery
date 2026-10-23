import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientFactory } from './clients.ts';
import type { CredentialProvider } from './credentials.ts';

class MockClient {
  middlewareStack = { add() {} };
  constructor(public config: { credentials: CredentialProvider }) {}
}
class OtherClient extends MockClient {}

test('one session binds STS and every SDK client to one credential snapshot during profile A to B change', async () => {
  let key = 'DUMMY_ACCOUNT_A';
  let calls = 0;
  const factory = new ClientFactory('ap-northeast-2', async () => { calls++; return { accessKeyId: key, secretAccessKey: 'dummy-only' }; });
  const stsCredentials = await factory.get(MockClient).config.credentials();
  key = 'DUMMY_ACCOUNT_B';
  const resourceCredentials = await factory.get(OtherClient).config.credentials();
  assert.equal(resourceCredentials.accessKeyId, stsCredentials.accessKeyId);
  assert.equal(calls, 1);
});

test('credential expiry fails closed rather than silently changing account within the same factory', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const factory = new ClientFactory('ap-northeast-2', async () => ({ accessKeyId: 'DUMMY_ACCOUNT_A', secretAccessKey: 'dummy-only', expiration: new Date(now + 1000) }));
    await factory.get(MockClient).config.credentials();
    now += 2000;
    await assert.rejects(factory.get(OtherClient).config.credentials(), /만료/);
  } finally { Date.now = realNow; }
});
