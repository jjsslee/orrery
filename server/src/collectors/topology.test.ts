import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCollectors } from './index.ts';
const meta = { account: '000000000000', region: 'ap-northeast-2' };
async function run(only: string, responses: Record<string, any>) {
  const clients = new Map();
  return runCollectors({ ...meta, clients: { get(C: any) {
    if (!clients.has(C)) {
      const c = new C({ region: meta.region, credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' } });
      c.send = async (cmd: any) => { const r = responses[cmd.constructor.name] ?? {}; if (r instanceof Error) throw r; return typeof r === 'function' ? r(cmd.input) : r; };
      clients.set(C, c);
    }
    return clients.get(C);
  } } as any }, undefined, [only]);
}
test('network preserves successful inventory and reports partial failure', async () => {
  const r = await run('network', { DescribeVpcsCommand: { Vpcs: [{ VpcId: 'vpc-one' }] }, DescribeNatGatewaysCommand: new Error('AccessDenied fixture') });
  assert.equal(r.outputs[0]?.nodes[0]?.id, 'vpc:vpc-one');
  assert.equal(r.reports[0].ok, false);
});
test('routes retain exact destination and blackhole state', async () => {
  const r = await run('network', { DescribeSubnetsCommand: { Subnets: [{ SubnetId: 'subnet-one', VpcId: 'vpc-one' }] }, DescribeRouteTablesCommand: { RouteTables: [{ VpcId: 'vpc-one', Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: '192.0.2.1/32', NatGatewayId: 'nat-one', State: 'blackhole' }] }] } });
  assert.equal(r.outputs[0].edges[0].label, '192.0.2.1/32');
  assert.equal(r.outputs[0].edges[0].status, 'critical');
});
test('security groups belong to their VPC', async () => {
  const r = await run('security', { DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-one', VpcId: 'vpc-one' }] } });
  assert.equal(r.outputs[0].nodes[0].parentId, 'vpc:vpc-one');
});
test('EFS unavailable mount detail is a partial collection', async () => {
  const r = await run('efs', { DescribeFileSystemsCommand: { FileSystems: [{ FileSystemId: 'fs-one' }] }, DescribeMountTargetsCommand: new Error('AccessDenied fixture') });
  assert.equal(r.reports[0].ok, false);
  assert.equal(r.outputs[0].nodes.length, 1);
});
test('RDS does not choose an arbitrary same-AZ subnet', async () => {
  const r = await run('rds', { DescribeDBInstancesCommand: { DBInstances: [{ DBInstanceIdentifier: 'db-one', AvailabilityZone: 'az-a', DBSubnetGroup: { VpcId: 'vpc-one', Subnets: ['first', 'second'].map(s => ({ SubnetIdentifier: s, SubnetAvailabilityZone: { Name: 'az-a' } })) } }] } });
  assert.equal(r.outputs[0].nodes[0].parentId, 'vpc:vpc-one');
});
test('ASG with no instances retains configured VPC', async () => {
  const r = await run('ec2', { DescribeAutoScalingGroupsCommand: { AutoScalingGroups: [{ AutoScalingGroupName: 'empty', VPCZoneIdentifier: 'subnet-one', Instances: [] }] }, DescribeSubnetsCommand: { Subnets: [{ SubnetId: 'subnet-one', VpcId: 'vpc-one' }] } });
  assert.equal(r.outputs[0].nodes[0].parentId, 'vpc:vpc-one');
});
test('ECS recovers readable service from failed batch and resolves host placement', async () => {
  const arn = 'arn:aws:ecs:ap-northeast-2:000000000000:service/cluster/good';
  const r = await run('ecs', {
    ListClustersCommand: { clusterArns: ['cluster'] }, DescribeClustersCommand: { clusters: [{ clusterArn: 'cluster', clusterName: 'cluster', status: 'ACTIVE' }] },
    ListServicesCommand: { serviceArns: [arn, 'bad'] },
    DescribeServicesCommand: (input: any) => { if (input.services.length > 1 || input.services[0] === 'bad') throw new Error('AccessDenied fixture'); return { services: [{ serviceName: 'good', serviceArn: arn, status: 'ACTIVE', taskDefinition: 'td', runningCount: 1, desiredCount: 1 }] }; },
    DescribeTaskDefinitionCommand: { taskDefinition: { networkMode: 'host' } },
    ListTasksCommand: { taskArns: ['task'] }, DescribeTasksCommand: { tasks: [{ taskArn: 'task', group: 'service:good', containerInstanceArn: 'ci' }] },
    DescribeContainerInstancesCommand: { containerInstances: [{ containerInstanceArn: 'ci', ec2InstanceId: 'i-one' }] },
    DescribeInstancesCommand: { Reservations: [{ Instances: [{ InstanceId: 'i-one', VpcId: 'vpc-one', SubnetId: 'subnet-one' }] }] },
  });
  const good = r.outputs[0].nodes.find(n => n.name === 'good')!;
  assert.equal(good.parentId, 'vpc:vpc-one');
  assert.ok(r.outputs[0].edges.some(e => e.source === good.id && e.target === 'ec2-instance:i-one'));
  assert.equal(r.reports[0].ok, false);
});

test('ALB retains listener conditions and weighted destinations from later pages', async () => {
  const lb = 'arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:loadbalancer/app/demo/1';
  const r = await run('elb', {
    DescribeLoadBalancersCommand: { LoadBalancers: [{ LoadBalancerArn: lb, Type: 'application' }] },
    DescribeListenersCommand: { Listeners: [{ ListenerArn: 'listener', Protocol: 'HTTPS', Port: 443 }] },
    DescribeRulesCommand: (input: any) => input.Marker ? { Rules: [{ Priority: '2', Conditions: [{ Field: 'path-pattern', Values: ['/api/*'] }], Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: 'tg', Weight: 30 }] } }] }] } : { Rules: [], NextMarker: 'next' },
  });
  assert.ok(r.outputs[0].edges.some(e => e.target === 'target-group:tg' && e.label?.includes('/api/*') && e.label.includes('weight=30')));
});
test('CloudFront paths and private Route53 VPCs retain typed relationships', async () => {
  const r = await run('edge', {
    ListDistributionsCommand: { DistributionList: { Items: [{ Id: 'cdn', Origins: { Items: [{ Id: 'origin', DomainName: 'api.example.test' }] }, DefaultCacheBehavior: { TargetOriginId: 'origin' }, CacheBehaviors: { Items: [{ PathPattern: '/api/*', TargetOriginId: 'origin', ViewerProtocolPolicy: 'https-only' }] } }] } },
    ListHostedZonesCommand: { HostedZones: [{ Id: '/hostedzone/zone', Config: { PrivateZone: true } }] },
    GetHostedZoneCommand: { VPCs: [{ VPCId: 'vpc-one', VPCRegion: 'ap-northeast-2' }, { VPCId: 'vpc-two', VPCRegion: 'us-west-2' }] },
  });
  const nodes = r.outputs[0].nodes;
  assert.ok(nodes.find(n => n.type === 'cloudfront')?.relations?.some(x => x.ref === 'api.example.test' && x.label.includes('/api/*')));
  const zone = nodes.find(n => n.type === 'route53-zone')!;
  assert.equal(zone.relations?.[0].ref, 'vpc:vpc-one');
  assert.match(zone.relations?.[1].ref ?? '', /us-west-2/);
});
test('Lambda resolves EFS access point and ECR image without retaining code download URL', async () => {
  const r = await run('lambda', {
    ListFunctionsCommand: { Functions: [{ FunctionName: 'fn', PackageType: 'Image', FileSystemConfigs: [{ Arn: 'arn:aws:elasticfilesystem:ap-northeast-2:000000000000:access-point/fsap-one', LocalMountPath: '/mnt/data' }] }] },
    DescribeAccessPointsCommand: { AccessPoints: [{ FileSystemId: 'fs-one' }] },
    GetFunctionCommand: { Code: { Location: 'https://example.test/secret-download', ResolvedImageUri: '000000000000.dkr.ecr.ap-northeast-2.amazonaws.com/team/image@sha256:dummy' } },
  });
  const n = r.outputs[0].nodes[0];
  assert.ok(n.relations?.some(x => x.ref === 'efs:fs-one' && x.label.includes('/mnt/data')));
  assert.ok(n.relations?.some(x => x.ref === 'arn:aws:ecr:ap-northeast-2:000000000000:repository/team/image'));
  assert.equal(JSON.stringify(r).includes('secret-download'), false);
});
test('Cloud Map registration pagination is collected', async () => {
  const r = await run('discovery', { ListServicesCommand: { Services: [{ Id: 'srv' }] }, GetServiceCommand: { Service: { Id: 'srv' } }, ListInstancesCommand: (input: any) => input.NextToken ? { Instances: [{ Id: 'second', Attributes: { AWS_INSTANCE_IPV4: '192.0.2.2', AWS_INSTANCE_PORT: '80' } }] } : { Instances: [{ Id: 'first', Attributes: { AWS_EC2_INSTANCE_ID: 'i-one' } }], NextToken: 'next' } });
  assert.equal(r.outputs[0].nodes[0].relations?.length, 2);
});
test('OpenSearch network and data policies connect matching collections and endpoints', async () => {
  const r = await run('opensearch', {
    ListCollectionsCommand: { collectionSummaries: [{ id: 'col', name: 'orders-prod' }] }, BatchGetCollectionCommand: { collectionDetails: [{ id: 'col', name: 'orders-prod', status: 'ACTIVE' }] },
    ListVpcEndpointsCommand: { vpcEndpointSummaries: [{ id: 'vpce-one' }] }, BatchGetVpcEndpointCommand: { vpcEndpointDetails: [{ id: 'vpce-one', vpcId: 'vpc-one', subnetIds: ['subnet-one'], securityGroupIds: ['sg-one'] }] },
    ListSecurityPoliciesCommand: { securityPolicySummaries: [{ name: 'network' }] }, GetSecurityPolicyCommand: { securityPolicyDetail: { policy: [{ Rules: [{ ResourceType: 'collection', Resource: ['collection/orders-*'] }], AllowFromPublic: false, SourceVPCEs: ['vpce-one'] }] } },
    ListAccessPoliciesCommand: { accessPolicySummaries: [{ name: 'access' }] }, GetAccessPolicyCommand: { accessPolicyDetail: { policy: [{ Rules: [{ ResourceType: 'index', Resource: ['index/orders-*/*'], Permission: ['aoss:ReadDocument'] }], Principal: ['arn:aws:iam::000000000000:role/reader'] }] } },
  });
  assert.equal(r.outputs[0].edges.filter(e => e.target === 'opensearch-collection:col').length, 2);
  assert.equal(r.outputs[0].nodes.find(n => n.id === 'vpc-endpoint:vpce-one')?.parentId, 'vpc:vpc-one');
});
test('denied additional relationship reads remain visible as partial collection', async () => {
  const r = await run('discovery', { ListServicesCommand: { Services: [{ Id: 'srv' }] }, GetServiceCommand: { Service: { Id: 'srv' } }, ListInstancesCommand: new Error('AccessDenied fixture') });
  assert.equal(r.reports[0].ok, false);
  assert.equal(r.outputs[0].nodes[0].props['등록 대상 조회'], '미확인');
});
