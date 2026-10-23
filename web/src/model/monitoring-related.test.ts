/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {sameTagCandidates,mergeRelatedCandidates} from './monitoring-related';
import type {MonitoringResource}from '@orrery/shared';
const resource=(key:string,tags:Record<string,string>,tagsStatus:MonitoringResource['tagsStatus']='complete'):MonitoringResource=>({key,nodeId:key,type:'lambda',nativeId:key,name:key,region:'r',props:{},tags,tagsStatus});
test('same-tag evidence is immediate and exact; graph evidence merges without duplicated targets or reasons',()=>{
 const base=resource('a',{Service:'wiki',Env:'dev'}),peer=resource('b',{Service:'wiki'});const candidates=sameTagCandidates(base,[base,peer,resource('c',{Service:'other'}),resource('d',{Service:'wiki'},'unavailable')]);assert.equal(candidates.length,1);assert.deepEqual(candidates[0].reasons,[{kind:'tag',key:'Service',value:'wiki'}]);assert.equal(mergeRelatedCandidates(candidates,candidates).length,1);assert.equal(mergeRelatedCandidates(candidates,candidates)[0].reasons.length,1);
});
