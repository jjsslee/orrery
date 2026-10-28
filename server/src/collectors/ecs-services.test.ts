import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECSClient } from '@aws-sdk/client-ecs';
import { readEcsServices } from './ecs-services.ts';
test('ECS failed bulk recovers readable siblings and the next batch',async()=>{
 const failures:string[]=[];const calls:string[][]=[];
 const client={send:async(c:{input:{services:string[]}})=>{calls.push(c.input.services);if(c.input.services.length>1 || c.input.services[0]==='denied')throw new Error('AccessDenied');return {services:[{serviceArn:c.input.services[0],serviceName:'dummy'}]};}} as unknown as ECSClient;
 const found=await readEcsServices(client,'dummy',['one','denied','two'],s=>failures.push(s));
 found.push(...await readEcsServices(client,'dummy',['next'],s=>failures.push(s)));
 assert.deepEqual(found.map(s=>s.serviceArn),['one','two','next']);assert.equal(failures.length,1);assert.equal(calls.length,5);
});
