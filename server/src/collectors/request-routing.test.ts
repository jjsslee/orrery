import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DistributionSummary } from '@aws-sdk/client-cloudfront';
import { cloudfrontRouting, integrationArn, restRequestRoute } from './request-routing.ts';

test('CloudFront keeps ordered behaviors, origin paths and code association boundaries',()=>{
 const routing=cloudfrontRouting({Id:'D',DomainName:'d.example.com',Enabled:true,Status:'InProgress',Aliases:{Items:['app.example.com']},Origins:{Items:[{Id:'s3',DomainName:'bucket.s3.amazonaws.com',OriginPath:'/site'}]},CacheBehaviors:{Items:[{PathPattern:'/api/*',TargetOriginId:'api',AllowedMethods:{Items:['GET','POST']},FunctionAssociations:{Quantity:1}}]},DefaultCacheBehavior:{TargetOriginId:'s3',AllowedMethods:{Items:['GET','HEAD']}}} as DistributionSummary);
 assert.equal(routing.kind,'cloudfront');if(routing.kind!=='cloudfront')return;
 assert.deepEqual(routing.behaviors.map(b=>b.pattern),['/api/*','*']);assert.equal(routing.behaviors[0].dynamic,true);assert.equal(routing.origins[0].path,'/site');assert.equal(routing.deployed,false);
});
test('only explicit Lambda integration ARNs survive and qualifier identity is retained',()=>{
 const arn='arn:aws:lambda:us-east-1:000000000000:function:handler:live';
 assert.equal(integrationArn(`arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${arn}/invocations`),arn);
 assert.equal(integrationArn('arn:aws:lambda:us-east-1:000000000000:function:${stageVariables.fn}'),undefined);
 assert.equal(integrationArn('https://lambda.example.com'),undefined);
});
test('REST preserves method/path and invocation overrides never become synchronous assumptions',()=>{
 const route=restRequestRoute('/orders','POST',{type:'AWS',uri:'arn:aws:lambda:us-east-1:000000000000:function:handler',requestParameters:{'integration.request.header.X-Amz-Invocation-Type':"'Event'"}});
 assert.equal(route.async,true);assert.equal(route.path,'/orders');assert.equal(route.method,'POST');
});
