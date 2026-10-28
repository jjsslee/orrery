import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand, attachReadOnlyGuard, ReadOnlyViolationError } from './readonly-guard.ts';
import { EC2Client, DescribeVpcsCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';

test('sensitive and unused read-shaped commands are denied', () => {
  for (const name of ['GetSecretValueCommand', 'GetSessionTokenCommand', 'GetObjectCommand', 'ListAccessKeysCommand', 'GetFutureSensitiveCommand']) {
    assert.equal(isReadOnlyCommand(name), false, name);
  }
});

test('explicit policy accepts current operations and rejects mutations', () => {
  for (const ok of ['DescribeInstancesCommand', 'ListFunctionsCommand', 'GetMetricDataCommand', 'GetBucketLocationCommand', 'LookupEventsCommand', 'BatchGetProjectsCommand']) {
    assert.equal(isReadOnlyCommand(ok), true, ok);
  }
  for (const bad of ['TerminateInstancesCommand', 'PutObjectCommand', 'DeleteTableCommand', 'UpdateFunctionCodeCommand', 'CreateBucketCommand', 'StartInstancesCommand', 'InvokeCommand', 'RunInstancesCommand', 'BatchWriteItemCommand', 'BatchDeleteBuildsCommand']) {
    assert.equal(isReadOnlyCommand(bad), false, bad);
  }
});

test('service scope is enforced even when a command name is shared', () => {
  assert.equal(isReadOnlyCommand('ListServicesCommand', 'ECSClient'), true);
  assert.equal(isReadOnlyCommand('GetSecretValueCommand', 'SecretsManagerClient'), false);
  assert.equal(isReadOnlyCommand('ListServicesCommand', 'UnknownClient'), false);
  assert.equal(isReadOnlyCommand('GetMetricDataCommand', 'EC2Client'), false);
});

test('guard rejects a mutating command before any request is made', async () => {
  const client = attachReadOnlyGuard(
    new EC2Client({ region: 'ap-northeast-2', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example' } }),
  );
  await assert.rejects(
    () => client.send(new TerminateInstancesCommand({ InstanceIds: ['i-00000000000000000'] })),
    (err: unknown) => err instanceof ReadOnlyViolationError && err.commandName === 'TerminateInstancesCommand',
  );
});

test('guard lets a Describe command through to the next step', async () => {
  const client = attachReadOnlyGuard(
    new EC2Client({
      region: 'ap-northeast-2',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example' },
      // Short-circuit the network: a handler that returns an empty response.
      requestHandler: { handle: async () => ({ response: { statusCode: 200, headers: {}, body: '<DescribeVpcsResponse><vpcSet/></DescribeVpcsResponse>' } }) } as never,
      maxAttempts: 1,
    }),
  );
  // We only assert it is not a ReadOnlyViolationError; parsing may still fail on the stub body.
  try {
    await client.send(new DescribeVpcsCommand({}));
  } catch (err) {
    assert.ok(!(err instanceof ReadOnlyViolationError));
  }
});
