import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ResourceGraph} from '@orrery/shared';
import {CleanupWorkspace} from './Cleanup';
const scope={source:'profile:test',account:'000000000000',region:'us-east-1'};
const graph:ResourceGraph={...scope,collectedAt:'2026-10-27T00:00:00Z',nodes:[{id:'v',nativeId:'vol-test',name:'archive-volume',type:'ebs-volume',category:'storage',region:scope.region,status:'inactive',props:{}}],edges:[],reports:[],cleanup:{schemaVersion:1,scope,observedAt:'2026-10-27T00:00:00Z',findings:[{id:'f',resourceId:'v',ruleId:'detached-ebs',reviewClass:'connections',observedAt:'2026-10-27T00:00:00Z',fact:{resourceId:'v',ruleId:'detached-ebs',state:'available',attachments:0,sizeGiB:100}}],coverage:[]}};
test('list and selected detail require explicit historical analysis and do not equate current state with cleanup eligibility',()=>{
 const html=renderToStaticMarkup(createElement(CleanupWorkspace,{graph,generation:0}));
 assert.match(html,/archive-volume/);assert.match(html,/aria-label="점검 자원 목록"/);assert.match(html,/aria-controls="cleanup-detail"/);assert.equal((html.match(/<article/g)??[]).length,1);assert.match(html,/이력 분석 전/);assert.match(html,/최근 30일/);assert.match(html,/최대 90일/);assert.match(html,/100 GiB/);assert.doesNotMatch(html,/보관 제외|사유 입력|localStorage/);
});
test('legacy snapshots and query failures remain distinct from zero eligible resources',()=>{
 const legacy=renderToStaticMarkup(createElement(CleanupWorkspace,{graph:{...graph,cleanup:undefined},generation:0}));assert.match(legacy,/점검 근거가 없거나/);
 const partial=renderToStaticMarkup(createElement(CleanupWorkspace,{graph:{...graph,cleanup:{...graph.cleanup!,findings:[],coverage:[{ruleId:'detached-ebs',state:'error',api:'DescribeVolumes',attemptedAt:graph.collectedAt}]}},generation:0}));assert.match(partial,/점검 불가/);assert.match(partial,/목록 전체/);
});
