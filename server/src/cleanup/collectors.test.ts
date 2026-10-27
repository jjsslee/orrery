import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EC2Client } from '@aws-sdk/client-ec2';
import { AutoScalingClient } from '@aws-sdk/client-auto-scaling';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { Route53Client } from '@aws-sdk/client-route-53';
import type { CollectorContext } from '../collectors/types.ts';
import { ec2Collector } from '../collectors/ec2.ts';
import { elbCollector } from '../collectors/elb.ts';
import { edgeCollector } from '../collectors/edge.ts';
import { assembleGraph } from '../graph/assemble.ts';
const scope={source:'profile:test',account:'000000000000',region:'us-east-1'};
function context(reply:(name:string,input:Record<string,unknown>)=>unknown){
 const calls:string[]=[];
 const clients=new Map();
 for(const C of [EC2Client,AutoScalingClient,ElasticLoadBalancingV2Client,CloudFrontClient,APIGatewayClient,ApiGatewayV2Client,Route53Client]){
  const client=new C({region:scope.region});
  client.send=(async(command:{constructor:{name:string};input:Record<string,unknown>})=>{calls.push(command.constructor.name);return reply(command.constructor.name,command.input)}) as typeof client.send;
  clients.set(C,client);
 }
 const ctx={region:scope.region,account:scope.account,clients:{get:(C:unknown)=>clients.get(C)},limit:<T>(fn:()=>Promise<T>)=>fn(),log:()=>{}} as unknown as CollectorContext;
 return {ctx,calls};
}
test('EC2 keeps available volume and stopped facts; volume denial is not an empty successful scan; no new calls',async()=>{
 for(const denied of [false,true]){
 const {ctx,calls}=context(name=>{
  if(name==='DescribeInstancesCommand')return {Reservations:[{Instances:[{InstanceId:'i-test',State:{Name:'stopped'}}]}]};
  if(name==='DescribeVolumesCommand'){if(denied)throw Object.assign(new Error('denied'),{name:'AccessDeniedException'});return {Volumes:[{VolumeId:'vol-test',State:'available',Attachments:[],Size:100}]};}
  return {};
 });
 const out=await ec2Collector.run(ctx);const graph=assembleGraph([out],[],scope);
 assert.deepEqual(calls.sort(),['DescribeAutoScalingGroupsCommand','DescribeInstanceStatusCommand','DescribeInstancesCommand','DescribeVolumesCommand']);
 assert.equal(graph.cleanup!.findings.length,denied?1:2);
 assert.equal(graph.cleanup!.coverage.find(c=>c.ruleId==='detached-ebs')!.state,denied?'error':'complete');
 }
});
test('TG draining and unhealthy entries are not empty; failed detail cannot hide successful empty result',async()=>{
 const {ctx,calls}=context((name,input)=>{
  if(name==='DescribeTargetGroupsCommand')return {TargetGroups:['empty','draining','unhealthy','denied'].map(id=>({TargetGroupArn:id,TargetGroupName:id,TargetType:'ip',LoadBalancerArns:[]}))};
  if(name==='DescribeTargetHealthCommand'){
   const id=input.TargetGroupArn;if(id==='denied')throw new Error('denied');
   return {TargetHealthDescriptions:id==='empty'?[]:[{Target:{Id:'192.0.2.1'},TargetHealth:{State:id}}]};
  }return {};
 });
 const out=await elbCollector.run(ctx);const graph=assembleGraph([out],[],scope);
 assert.deepEqual(graph.cleanup!.findings.map(f=>f.resourceId),['target-group:empty']);
 assert.equal(graph.cleanup!.coverage.filter(c=>c.state==='error').length,1);
 assert.equal(calls.length,7); // lists x2, tags x1, existing health queries x4
});
test('CloudFront undefined Enabled stays unknown; CF list failure survives an otherwise successful edge collector',async()=>{
 for(const denied of [false,true]){
 const {ctx,calls}=context(name=>{
  if(name==='ListDistributionsCommand'){if(denied)throw new Error('denied');return {DistributionList:{Items:[{Id:'disabled',Enabled:false},{Id:'missing'}],IsTruncated:false}};}
  return {};
 });
 const graph=assembleGraph([await edgeCollector.run(ctx)],[],scope);
 assert.equal(graph.cleanup!.findings.length,denied?0:1);
 assert.ok(graph.cleanup!.coverage.some(c=>c.ruleId==='disabled-cloudfront'&&c.state==='error'));
 assert.equal(calls.length,4);
 }
});
