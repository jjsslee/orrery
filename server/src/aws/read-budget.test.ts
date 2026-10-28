import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBudget } from './read-budget.ts';
import type { ClientFactory } from './clients.ts';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
test('collection budget shares paginator/fallback counts, keeps session unmodified and cancels deadline',async()=>{
 let calls=0;
 const original={send:async(_command:unknown,options?:{abortSignal?:AbortSignal})=>{calls++;return options?.abortSignal;}};
 const factory={get:()=>original} as unknown as ClientFactory;
 const budget=readBudget(factory,2,1000);const wrapped=budget.clients.get(LambdaClient);
 try {assert.ok(await wrapped.send(new ListFunctionsCommand({})) instanceof AbortSignal); await wrapped.send(new ListFunctionsCommand({})); await assert.rejects(wrapped.send(new ListFunctionsCommand({})),{name:'CollectionBudgetExceeded'});assert.equal(calls,2);assert.equal(factory.get(LambdaClient),original);} finally {budget.dispose();}
 const expired=readBudget(factory,10,1);try {await new Promise(r=>setTimeout(r,5));await assert.rejects(expired.clients.get(LambdaClient).send(new ListFunctionsCommand({})),{name:'CollectionBudgetExceeded'});}finally{expired.dispose();}
});
