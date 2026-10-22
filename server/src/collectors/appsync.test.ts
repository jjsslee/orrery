import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataSourceRefs, summarizeDataSources } from './appsync.ts';

test('dataSourceRefs collects the identifiers a data source points at', () => {
  const refs = dataSourceRefs({
    name: 'orders',
    type: 'AMAZON_DYNAMODB',
    serviceRoleArn: 'arn:aws:iam::000000000000:role/appsync-ds-role',
    dynamodbConfig: { tableName: 'orders', awsRegion: 'ap-northeast-2' },
  });
  assert.deepEqual(refs, ['orders', 'arn:aws:iam::000000000000:role/appsync-ds-role']);
  assert.deepEqual(dataSourceRefs({ name: 'none', type: 'NONE' }), []);
  assert.deepEqual(
    dataSourceRefs({ name: 'fn', type: 'AWS_LAMBDA', lambdaConfig: { lambdaFunctionArn: 'arn:aws:lambda:ap-northeast-2:000000000000:function:resolver' } }),
    ['arn:aws:lambda:ap-northeast-2:000000000000:function:resolver'],
  );
});

test('summarizeDataSources groups by friendly type', () => {
  assert.equal(summarizeDataSources([]), null);
  assert.equal(
    summarizeDataSources([
      { name: 'a', type: 'AMAZON_DYNAMODB' },
      { name: 'b', type: 'AMAZON_DYNAMODB' },
      { name: 'c', type: 'AWS_LAMBDA' },
      { name: 'd', type: 'SOMETHING_NEW' as never },
    ]),
    'DynamoDB 2, Lambda 1, SOMETHING_NEW 1',
  );
});
