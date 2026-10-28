/** Service-scoped inventory only: no full topology or CloudWatch metric requests. */
import { AppSyncClient, ListApisCommand, ListGraphqlApisCommand } from '@aws-sdk/client-appsync';
import { APIGatewayClient, GetRestApisCommand } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import { CloudFrontClient, ListDistributionsCommand, ListTagsForResourceCommand as CloudFrontTags } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand, ListTagsOfResourceCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, ListBucketsCommand, GetBucketLocationCommand, GetBucketTaggingCommand } from '@aws-sdk/client-s3';
import { SNSClient, ListTopicsCommand, ListTagsForResourceCommand as SnsTags } from '@aws-sdk/client-sns';
import { RDSClient, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { ECSClient, ListClustersCommand, DescribeClustersCommand } from '@aws-sdk/client-ecs';
import { ElastiCacheClient, DescribeCacheClustersCommand, DescribeReplicationGroupsCommand, ListTagsForResourceCommand as CacheTags } from '@aws-sdk/client-elasticache';
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs';
import { EC2Client, DescribeNatGatewaysCommand } from '@aws-sdk/client-ec2';
import { EventBridgeClient, ListEventBusesCommand, ListRulesCommand, ListTagsForResourceCommand as EventTags } from '@aws-sdk/client-eventbridge';
import { SFNClient, ListStateMachinesCommand, ListTagsForResourceCommand as StateTags } from '@aws-sdk/client-sfn';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { ElasticLoadBalancingV2Client, DescribeTargetGroupsCommand, DescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import type { MonitoringResource, MonitoringResourceType } from '@orrery/shared';
import type { MonitoringSession } from './alarms.ts';
import { tagsToRecord } from '../collectors/ids.ts';
import { regionFromLocation } from '../collectors/s3.ts';

export type AddResource = (nativeId: string, name?: string, arn?: string, tags?: Record<string, string>, props?: MonitoringResource['props'], tagsStatus?: MonitoringResource['tagsStatus']) => void;

export async function discoverMonitoringResources(s: MonitoringSession, type: MonitoringResourceType, add: AddResource, errors: string[]): Promise<void> {
  // Process each page before fetching the next, retaining discovered resources on failure.
  async function pages<T>(fetch: (token?: string) => Promise<{items: T[]; next?: string}>, visit: (item: T) => Promise<void> | void) {
    let token: string | undefined;
    do { const page = await fetch(token); for (const item of page.items) await visit(item); token = page.next; } while (token);
  }
  async function attempt(fn: () => Promise<void>) {
    try { await fn(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  async function tags(fn: () => Promise<Record<string, string> | undefined>) {
    try { return await fn() ?? {}; } catch { return undefined; }
  }
  const put: AddResource = (id, name, arn, t, props = {}) => add(id, name, arn, t, props, t === undefined ? 'unavailable' : 'complete');
  if (type === 'appsync-api') {
    const client = s.clients.get(AppSyncClient);
    await attempt(() => pages(async nextToken => { const p = await client.send(new ListGraphqlApisCommand({nextToken})); return {items:p.graphqlApis ?? [],next:p.nextToken}; }, api => { if (api.apiId) put(api.apiId, api.name, api.arn, api.tags ?? {}, {_apiKind:'graphql'}); }));
    await attempt(() => pages(async nextToken => { const p = await client.send(new ListApisCommand({nextToken})); return {items:p.apis ?? [],next:p.nextToken}; }, api => { if (api.apiId) put(api.apiId, api.name, api.apiArn, api.tags ?? {}, {_apiKind:'events'}); }));
  } else if (type === 'api-gateway') {
    const rest = s.clients.get(APIGatewayClient), v2 = s.clients.get(ApiGatewayV2Client);
    await attempt(() => pages(async position => { const p = await rest.send(new GetRestApisCommand({position})); return {items:p.items ?? [],next:p.position}; }, api => { if (api.id) put(api.id,api.name,undefined,api.tags ?? {},{_apiKind:'rest'}); }));
    await attempt(() => pages(async NextToken => { const p = await v2.send(new GetApisCommand({NextToken})); return {items:p.Items ?? [],next:p.NextToken}; }, api => { if (api.ApiId) put(api.ApiId,api.Name,undefined,api.Tags ?? {},{_apiKind:api.ProtocolType?.toLowerCase() ?? 'http'}); }));
  } else if (type === 'cloudfront') {
    const client = s.clients.get(CloudFrontClient,'us-east-1');
    await pages(async Marker => { const p = (await client.send(new ListDistributionsCommand({Marker}))).DistributionList; return {items:p?.Items ?? [],next:p?.NextMarker}; }, async d => { if(d.Id) put(d.Id,d.Aliases?.Items?.[0] ?? d.DomainName,d.ARN,await tags(async () => tagsToRecord((await client.send(new CloudFrontTags({Resource:d.ARN!}))).Tags?.Items))); });
  } else if (type === 'dynamodb-table') {
    const client = s.clients.get(DynamoDBClient);
    await pages(async ExclusiveStartTableName => { const p = await client.send(new ListTablesCommand({ExclusiveStartTableName})); return {items:p.TableNames ?? [],next:p.LastEvaluatedTableName}; }, async name => {
      let arn: string | undefined;
      await attempt(async () => { arn = (await client.send(new DescribeTableCommand({TableName:name}))).Table?.TableArn; });
      const t = arn ? await tags(async () => { const all: Record<string,string> = {}; await pages(async NextToken => { const p = await client.send(new ListTagsOfResourceCommand({ResourceArn:arn!,NextToken})); return {items:p.Tags ?? [],next:p.NextToken}; }, tag => {if(tag.Key) all[tag.Key] = tag.Value ?? '';}); return all; }) : undefined;
      put(name,name,arn,t);
    });
  } else if (type === 's3-bucket') {
    const client = s.clients.get(S3Client);
    await pages(async ContinuationToken => { const p = await client.send(new ListBucketsCommand({BucketRegion:s.region,ContinuationToken,MaxBuckets:1000})); return {items:p.Buckets ?? [],next:p.ContinuationToken}; }, async b => {
      if (!b.Name) return;
      await attempt(async () => {
        const region = b.BucketRegion ?? regionFromLocation((await client.send(new GetBucketLocationCommand({Bucket:b.Name}))).LocationConstraint);
        if(region !== s.region) return;
        const t = await tags(async () => {try { return tagsToRecord((await client.send(new GetBucketTaggingCommand({Bucket:b.Name}))).TagSet); } catch(error) {if(error instanceof Error && error.name === 'NoSuchTagSet') return {}; throw error;} });
        put(b.Name!,b.Name,undefined,t);
      });
    });
  } else if (type === 'sns-topic') {
    const client = s.clients.get(SNSClient);
    await pages(async NextToken => { const p = await client.send(new ListTopicsCommand({NextToken})); return {items:p.Topics ?? [],next:p.NextToken}; }, async t => { if(t.TopicArn) {const name=t.TopicArn.split(':').pop()!;put(name,name,t.TopicArn,await tags(async () => tagsToRecord((await client.send(new SnsTags({ResourceArn:t.TopicArn!}))).Tags)));} });
  } else if (type === 'rds-cluster') {
    const client = s.clients.get(RDSClient);
    await pages(async Marker => { const p = await client.send(new DescribeDBClustersCommand({Marker})); return {items:p.DBClusters ?? [],next:p.Marker}; }, db => {if(db.DBClusterIdentifier) put(db.DBClusterIdentifier,db.DBClusterIdentifier,db.DBClusterArn,db.TagList ? tagsToRecord(db.TagList) ?? {} : undefined);});
  } else if (type === 'ecs-cluster') {
    const client = s.clients.get(ECSClient);
    await pages(async nextToken => { const p = await client.send(new ListClustersCommand({nextToken})); return {items:p.clusterArns ?? [],next:p.nextToken}; }, async arn => {
      let t: Record<string,string> | undefined;
      await attempt(async () => {const p=await client.send(new DescribeClustersCommand({clusters:[arn],include:['TAGS']})); if(p.failures?.length) throw new Error(p.failures.map(f=>f.reason).join('; ')); t=p.clusters?.[0]?.tags ? Object.fromEntries(p.clusters[0].tags.filter(t=>t.key).map(t=>[t.key!,t.value ?? ''])) : undefined;});
      put(arn.split('/').pop()!,undefined,arn,t);
    });
  } else if (type === 'elasticache') {
    const client = s.clients.get(ElastiCacheClient);
    await pages(async Marker => { const p=await client.send(new DescribeCacheClustersCommand({Marker}));return {items:p.CacheClusters ?? [],next:p.Marker}; },async c => {if(c.CacheClusterId && !c.ReplicationGroupId) put(c.CacheClusterId,c.CacheClusterId,c.ARN,c.ARN ? await tags(async()=>tagsToRecord((await client.send(new CacheTags({ResourceName:c.ARN!}))).TagList)) : undefined,{_cacheClusterId:c.CacheClusterId});});
    await pages(async Marker => { const p=await client.send(new DescribeReplicationGroupsCommand({Marker}));return {items:p.ReplicationGroups ?? [],next:p.Marker}; },async g => {if(g.ReplicationGroupId) put(g.ReplicationGroupId,g.ReplicationGroupId,g.ARN,g.ARN ? await tags(async()=>tagsToRecord((await client.send(new CacheTags({ResourceName:g.ARN!}))).TagList)) : undefined,{_cacheClusterId:g.MemberClusters?.[0] ?? null});});
  } else if (type === 'efs') {
    const client=s.clients.get(EFSClient);
    await pages(async Marker=>{const p=await client.send(new DescribeFileSystemsCommand({Marker}));return{items:p.FileSystems ?? [],next:p.NextMarker};},fs=>{if(fs.FileSystemId)put(fs.FileSystemId,fs.Name,fs.FileSystemArn,fs.Tags ? tagsToRecord(fs.Tags) ?? {} : undefined);});
  } else if (type === 'nat-gateway') {
    const client=s.clients.get(EC2Client);
    await pages(async NextToken=>{const p=await client.send(new DescribeNatGatewaysCommand({NextToken}));return{items:p.NatGateways ?? [],next:p.NextToken};},nat=>{if(nat.NatGatewayId){const t=tagsToRecord(nat.Tags) ?? {};put(nat.NatGatewayId,t.Name,undefined,t);}});
  } else if (type === 'eventbridge-rule') {
    const client=s.clients.get(EventBridgeClient);
    await pages(async NextToken=>{const p=await client.send(new ListEventBusesCommand({NextToken}));return{items:p.EventBuses ?? [],next:p.NextToken};},async bus=>{
      if(!bus.Name)return;
      await attempt(()=>pages(async NextToken=>{const p=await client.send(new ListRulesCommand({EventBusName:bus.Name,NextToken}));return{items:p.Rules ?? [],next:p.NextToken};},async rule=>{if(rule.Name)put(bus.Name === 'default' ? rule.Name : `${bus.Name}/${rule.Name}`,rule.Name,rule.Arn,rule.Arn ? await tags(async()=>tagsToRecord((await client.send(new EventTags({ResourceARN:rule.Arn!}))).Tags)) : undefined,{_ruleName:rule.Name,_eventBusName:bus.Name!});}));
    });
  } else if (type === 'step-function') {
    const client=s.clients.get(SFNClient);
    await pages(async nextToken=>{const p=await client.send(new ListStateMachinesCommand({nextToken}));return{items:p.stateMachines ?? [],next:p.nextToken};},async sm=>{if(sm.name)put(sm.name,sm.name,sm.stateMachineArn,sm.stateMachineArn ? await tags(async()=>Object.fromEntries(((await client.send(new StateTags({resourceArn:sm.stateMachineArn!}))).tags ?? []).filter(t=>t.key).map(t=>[t.key!,t.value ?? '']))) : undefined);});
  } else if (type === 'autoscaling-group') {
    const client=s.clients.get(AutoScalingClient);
    await pages(async NextToken=>{const p=await client.send(new DescribeAutoScalingGroupsCommand({NextToken}));return{items:p.AutoScalingGroups ?? [],next:p.NextToken};},g=>{if(g.AutoScalingGroupName)put(g.AutoScalingGroupName,g.AutoScalingGroupName,g.AutoScalingGroupARN,tagsToRecord(g.Tags) ?? {});});
  } else if (type === 'target-group') {
    const client=s.clients.get(ElasticLoadBalancingV2Client);
    await pages(async Marker=>{const p=await client.send(new DescribeTargetGroupsCommand({Marker}));return{items:p.TargetGroups ?? [],next:p.NextMarker};},async tg=>{if(tg.TargetGroupArn)put(tg.TargetGroupArn,tg.TargetGroupName,tg.TargetGroupArn,await tags(async()=>tagsToRecord((await client.send(new DescribeTagsCommand({ResourceArns:[tg.TargetGroupArn!]}))).TagDescriptions?.[0]?.Tags)),{_applicationLoadBalancers:JSON.stringify((tg.LoadBalancerArns ?? []).filter(arn=>arn.includes(':loadbalancer/app/')))});});
  }
}
