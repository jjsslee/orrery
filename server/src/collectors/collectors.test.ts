import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, keyValueTags, lambdaNameFromArn, lowerTags, roleNameFromArn } from './util.ts';
import { tagsToRecord } from './ids.ts';
import { hostFromIntegrationUri, lambdaFromIntegrationUri, summariseRecords } from './edge.ts';
import { eventSourceNodeId } from './lambda.ts';
import { refsFromDefinition, targetNodeId } from './messaging.ts';
import { portLabel, trustSummary } from './security.ts';
import { regionFromLocation } from './s3.ts';
import { serviceStatus } from './ecs.ts';
import { splitVolumes, volumeLabel, volumeNode } from './ec2.ts';

test('ARN helpers', () => {
  assert.equal(lambdaNameFromArn('arn:aws:lambda:ap-northeast-2:000000000000:function:orders:live'), 'orders');
  assert.equal(lambdaNameFromArn('arn:aws:lambda:ap-northeast-2:000000000000:function:orders'), 'orders');
  assert.equal(roleNameFromArn('arn:aws:iam::000000000000:instance-profile/web-profile'), 'web-profile');
  assert.equal(roleNameFromArn('arn:aws:iam::000000000000:role/service-role/my-role'), 'my-role');
  assert.equal(hostOf('https://api.example.com/v1/{proxy}'), 'api.example.com');
  assert.equal(hostOf('api.example.com'), 'api.example.com');
});

test('tag converters build {key: value} records and omit empty sets', () => {
  assert.deepEqual(tagsToRecord([{ Key: 'env', Value: 'dev' }, { Key: 'team' }]), { env: 'dev', team: '' });
  assert.deepEqual(tagsToRecord({ env: 'dev' }), { env: 'dev' });
  assert.equal(tagsToRecord([]), undefined);
  assert.equal(tagsToRecord({}), undefined);
  assert.equal(tagsToRecord(undefined), undefined);
  assert.deepEqual(lowerTags([{ key: 'env', value: 'dev' }, { value: 'orphan' }]), { env: 'dev' });
  assert.equal(lowerTags([]), undefined);
  assert.deepEqual(keyValueTags([{ TagKey: 'env', TagValue: 'dev' }, { TagKey: 'owner' }]), { env: 'dev', owner: '' });
  assert.equal(keyValueTags([{ TagValue: 'x' }]), undefined);
  assert.equal(keyValueTags(undefined), undefined);
});

test('API Gateway integration URIs', () => {
  const v1 = 'arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-northeast-2:000000000000:function:orders:prod/invocations';
  assert.equal(lambdaFromIntegrationUri(v1), 'orders');
  assert.equal(lambdaFromIntegrationUri('arn:aws:lambda:ap-northeast-2:000000000000:function:hello'), 'hello');
  assert.equal(lambdaFromIntegrationUri('arn:aws:apigateway:ap-northeast-2:lambda:path/2015-03-31/functions/arn:aws:lambda:ap-northeast-2:000000000000:function:${stageVariables.fn}/invocations'), undefined);
  assert.equal(lambdaFromIntegrationUri('https://api.example.com'), undefined);
  assert.equal(hostFromIntegrationUri('https://api.example.com/v1'), 'api.example.com');
  assert.equal(hostFromIntegrationUri(v1), undefined);
});

test('Route 53 record summary pushes alias and CNAME targets', () => {
  const s = summariseRecords(
    [
      { Name: 'www.example.com.', Type: 'A', AliasTarget: { DNSName: 'dualstack.web-123.ap-northeast-2.elb.amazonaws.com.', HostedZoneId: 'Z', EvaluateTargetHealth: false } },
      { Name: 'cdn.example.com.', Type: 'CNAME', ResourceRecords: [{ Value: 'd123.cloudfront.net' }] },
      { Name: 'site.example.com.', Type: 'A', AliasTarget: { DNSName: 's3-website.ap-northeast-2.amazonaws.com.', HostedZoneId: 'Z', EvaluateTargetHealth: false } },
      { Name: 'example.com.', Type: 'NS', ResourceRecords: [{ Value: 'ns-1.awsdns.com.' }] },
    ],
    'ap-northeast-2',
  );
  assert.deepEqual(s.refs, ['web-123.ap-northeast-2.elb.amazonaws.com', 'd123.cloudfront.net', 'site.example.com.s3-website.ap-northeast-2.amazonaws.com']);
  assert.deepEqual(s.byType, { A: 2, CNAME: 1, NS: 1 });
  assert.equal(s.names.length, 4);
});

test('event sources and EventBridge targets resolve to node ids', () => {
  assert.equal(eventSourceNodeId('arn:aws:sqs:ap-northeast-2:000000000000:orders'), 'sqs-queue:orders');
  assert.equal(eventSourceNodeId('arn:aws:dynamodb:ap-northeast-2:000000000000:table/orders/stream/2024-01-01T00:00:00.000'), 'dynamodb-table:orders');
  assert.equal(eventSourceNodeId('arn:aws:kinesis:ap-northeast-2:000000000000:stream/x'), undefined);
  assert.equal(targetNodeId('arn:aws:lambda:ap-northeast-2:000000000000:function:nightly'), 'lambda:nightly');
  assert.equal(targetNodeId('arn:aws:states:ap-northeast-2:000000000000:stateMachine:flow'), 'step-function:flow');
  assert.equal(targetNodeId('arn:aws:ecs:ap-northeast-2:000000000000:cluster/prod'), 'ecs-cluster:prod');
  assert.equal(targetNodeId('arn:aws:events:ap-northeast-2:000000000000:event-bus/other'), undefined);
});

test('state machine definition refs', () => {
  const def = JSON.stringify({
    States: {
      A: { Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: 'orders-fn' } },
      B: { Resource: 'arn:aws:lambda:ap-northeast-2:000000000000:function:other' },
    },
  });
  const refs = refsFromDefinition(def);
  assert.ok(refs.includes('orders-fn'));
  assert.ok(refs.includes('arn:aws:lambda:ap-northeast-2:000000000000:function:other'));
  assert.ok(refs.includes('arn:aws:states:::lambda:invoke'));
});

test('security helpers', () => {
  assert.equal(portLabel({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }), 'TCP 443');
  assert.equal(portLabel({ IpProtocol: 'udp', FromPort: 53, ToPort: 54 }), 'UDP 53-54');
  assert.equal(portLabel({ IpProtocol: '-1' }), '모든 트래픽');
  assert.equal(portLabel({ IpProtocol: 'tcp', FromPort: 0, ToPort: 65535 }), 'TCP 모든 포트');
  const doc = encodeURIComponent(JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: { Service: ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com'], AWS: 'arn:aws:iam::000000000000:root' } }] }));
  assert.equal(trustSummary(doc), 'lambda.amazonaws.com, ecs-tasks.amazonaws.com, 계정 000000000000');
  assert.equal(trustSummary('not json'), null);
});

test('misc', () => {
  assert.equal(regionFromLocation(''), 'us-east-1');
  assert.equal(regionFromLocation('EU'), 'eu-west-1');
  assert.equal(regionFromLocation('ap-northeast-2'), 'ap-northeast-2');
  assert.equal(serviceStatus(2, 2, 1, 'ACTIVE'), 'healthy');
  assert.equal(serviceStatus(2, 1, 1, 'ACTIVE'), 'warning');
  assert.equal(serviceStatus(2, 2, 2, 'ACTIVE'), 'warning');
  assert.equal(serviceStatus(2, 0, 1, 'ACTIVE'), 'critical');
  assert.equal(serviceStatus(0, 0, 1, 'ACTIVE'), 'healthy');
});

test('EBS volumes: attached ones summarise on the instance, detached ones become nodes', () => {
  const { byInstance, detached } = splitVolumes([
    { VolumeId: 'vol-root', Size: 30, VolumeType: 'gp3', Encrypted: true, Attachments: [{ InstanceId: 'i-web', State: 'attached' }] },
    { VolumeId: 'vol-data', Size: 70, VolumeType: 'io2', Encrypted: false, Attachments: [{ InstanceId: 'i-web', State: 'attached' }] },
    { VolumeId: 'vol-leaving', Size: 8, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-web', State: 'detaching' }] },
    { VolumeId: 'vol-idle', Size: 100, VolumeType: 'gp2', State: 'available', Attachments: [] },
    { VolumeId: 'vol-new', Size: 10, State: 'creating' },
  ]);
  assert.deepEqual(detached.map((v) => v.VolumeId), ['vol-idle', 'vol-new']);
  const web = byInstance.get('i-web')!;
  assert.equal(volumeLabel(web), '2개, 100 GiB (gp3, io2, 암호화 1/2)');
  assert.equal(volumeLabel({ count: 1, gib: 8, types: new Set(['gp3']), encrypted: 1 }), '1개, 8 GiB (gp3, 암호화)');
  assert.equal(volumeLabel({ count: 1, gib: 8, types: new Set(), encrypted: 0 }), '1개, 8 GiB (미암호화)');

  const idle = volumeNode('vol-idle', { ...detached[0], KmsKeyId: 'arn:aws:kms:ap-northeast-2:000000000000:key/test' }, 'ap-northeast-2', '000000000000');
  assert.equal(idle.id, 'ebs-volume:vol-idle');
  assert.equal(idle.parentId, undefined);
  assert.equal(idle.status, 'inactive');
  assert.equal(idle.statusLabel, '미연결');
  assert.equal(idle.props['크기'], '100 GiB');
  assert.deepEqual(idle.refs, ['arn:aws:kms:ap-northeast-2:000000000000:key/test']);
  assert.equal(volumeNode('vol-new', detached[1], 'ap-northeast-2', '000000000000').status, 'warning');
});
