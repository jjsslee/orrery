import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MONITORING_TYPES, ResourceRepository } from './resources.ts';
import { monitoringQueries, planMetrics } from './metrics.ts';
import type { MonitoringSession } from './alarms.ts';

const account='000000000000', region='ap-northeast-2';
const alb=`arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/dummy/1`;
const tg=`arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/dummy/1`;
const fixtures = [
  {type:'appsync-api', responses:{ListGraphqlApisCommand:{graphqlApis:[{apiId:'graphql',tags:{}}]},ListApisCommand:{apis:[{apiId:'events',tags:{}}]}}},
  {type:'api-gateway', responses:{GetRestApisCommand:{items:[{id:'rest',name:'rest',tags:{}}]},GetApisCommand:{Items:[{ApiId:'http',ProtocolType:'HTTP',Tags:{}},{ApiId:'ws',ProtocolType:'WEBSOCKET',Tags:{}}]}}},
  {type:'cloudfront',responses:{ListDistributionsCommand:{DistributionList:{Items:[{Id:'dist',ARN:'arn:dummy',DomainName:'dummy.test'}]}},ListTagsForResourceCommand:{Tags:{Items:[]}}}},
  {type:'dynamodb-table',responses:{ListTablesCommand:{TableNames:['table']},DescribeTableCommand:{Table:{TableArn:'arn:dummy'}},ListTagsOfResourceCommand:{Tags:[]}}},
  {type:'s3-bucket',responses:{ListBucketsCommand:{Buckets:[{Name:'bucket',BucketRegion:region},{Name:'foreign',BucketRegion:'us-west-2'}]},GetBucketTaggingCommand:{TagSet:[]}}},
  {type:'sns-topic',responses:{ListTopicsCommand:{Topics:[{TopicArn:`arn:aws:sns:${region}:${account}:topic`}]},ListTagsForResourceCommand:{Tags:[]}}},
  {type:'rds-cluster',responses:{DescribeDBClustersCommand:{DBClusters:[{DBClusterIdentifier:'db',TagList:[]}]}}},
  {type:'ecs-cluster',responses:{ListClustersCommand:{clusterArns:[`arn:aws:ecs:${region}:${account}:cluster/cluster`]},DescribeClustersCommand:{clusters:[{tags:[]}]}}},
  {type:'elasticache',responses:{DescribeCacheClustersCommand:{CacheClusters:[{CacheClusterId:'standalone',ARN:'arn:dummy'},{CacheClusterId:'member',ReplicationGroupId:'replica'}]},DescribeReplicationGroupsCommand:{ReplicationGroups:[{ReplicationGroupId:'replica',MemberClusters:['member'],ARN:'arn:dummy'}]},ListTagsForResourceCommand:{TagList:[]}}},
  {type:'efs',responses:{DescribeFileSystemsCommand:{FileSystems:[{FileSystemId:'fs-dummy',Tags:[]}]}}},
  {type:'nat-gateway',responses:{DescribeNatGatewaysCommand:{NatGateways:[{NatGatewayId:'nat-dummy',Tags:[]}]}}},
  {type:'eventbridge-rule',responses:{ListEventBusesCommand:{EventBuses:[{Name:'default'},{Name:'custom'}]},ListRulesCommand:{Rules:[{Name:'rule',Arn:'arn:dummy'}]},ListTagsForResourceCommand:{Tags:[]}}},
  {type:'step-function',responses:{ListStateMachinesCommand:{stateMachines:[{name:'state',stateMachineArn:`arn:aws:states:${region}:${account}:stateMachine:state`}]},ListTagsForResourceCommand:{tags:[]}}},
  {type:'autoscaling-group',responses:{DescribeAutoScalingGroupsCommand:{AutoScalingGroups:[{AutoScalingGroupName:'asg',Tags:[]}]}}},
  {type:'target-group',responses:{DescribeTargetGroupsCommand:{TargetGroups:[{TargetGroupArn:tg,LoadBalancerArns:[alb]}]},DescribeTagsCommand:{TagDescriptions:[{Tags:[]}]}}},
  {type:'load-balancer',responses:{DescribeLoadBalancersCommand:{LoadBalancers:[{Type:'network',LoadBalancerArn:alb.replace('/app/','/net/')}]},DescribeTagsCommand:{TagDescriptions:[{Tags:[]}]}}},
] as const;

test('every metric catalogue type is selectable; service discovery retains metric dimensions and tags', async () => {
  const source = readFileSync(new URL('../metrics/cloudwatch.ts',import.meta.url),'utf8');
  const catalogue = [...source.matchAll(/case '([^']+)':/g)].map(m=>m[1]);
  assert.deepEqual([...MONITORING_TYPES].sort(),catalogue.sort());
  for(const f of fixtures) {
    const calls: string[]=[];
    const s={source:'profile:dummy',account,region,clients:{get:()=>({send:async(command:any)=>{
      const name=command.constructor.name;calls.push(name);
      assert.ok(name in f.responses, `${f.type}: unexpected ${name}`);
      return (f.responses as Record<string,unknown>)[name];
    }})}} as unknown as MonitoringSession;
    const repo=new ResourceRepository();
    const result=await repo.get(s,f.type);
    assert.equal(result.complete,true,`${f.type}: ${result.observation.error}`);
    assert.ok(result.resources.length > 0,f.type);
    assert.ok(result.resources.every(r=>r.tagsStatus === 'complete'),f.type);
    assert.ok(result.resources.every(r=>r.metricsSupported),f.type);
    assert.ok(!calls.includes('GetMetricDataCommand'));
    for(const r of repo.known(s)) {
      const range={startTime:new Date(Date.now()-3600000).toISOString(),endTime:new Date(Date.now()-1000).toISOString()};
      const plans=planMetrics({resourceKeys:[r.key],range,contexts:r.metricContexts?.length ? {[r.key]:r.metricContexts[0].id} : undefined},repo.known(s));
      assert.ok(plans.length > 0,r.type);
      if(r.type==='cloudfront')assert.ok(plans.every(p=>p.query.region==='us-east-1'));
      if(r.type==='s3-bucket') {assert.equal(result.resources.length,1);assert.ok(plans.every(p=>p.period===86400));}
      if(r.type==='eventbridge-rule')assert.ok(['rule','custom/rule'].includes(r.nativeId));
      if(r.nativeId==='replica')assert.deepEqual(plans[0].query.dims,[{Name:'CacheClusterId',Value:'member'}]);
      if(r.type==='appsync-api')assert.equal(plans[0].query.dims[0].Name,r.props._apiKind==='events' ? 'EventAPIId' : 'GraphQLAPIId');
    }
  }
});

test('target groups without ALB context remain explicitly unsupported after repository merge',async()=>{
  const s={source:'profile:dummy',account,region,clients:{get:()=>({send:async(command:any)=>command.constructor.name==='DescribeTargetGroupsCommand' ? {TargetGroups:[{TargetGroupArn:tg,LoadBalancerArns:[]}]} : {TagDescriptions:[{Tags:[]}]}})}} as unknown as MonitoringSession;
  const repo=new ResourceRepository();await repo.get(s,'target-group');
  assert.equal(repo.known(s)[0].metricsSupported,false);
  assert.deepEqual(monitoringQueries(repo.known(s)[0]),[]);
});
