/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitoringWorkspaceRequests } from './monitoring-workspace';
test('workspace debounce combines selection/range changes and ignores search and candidate browsing', async()=>{
 const timers=new Map<number,()=>void>();let next=0,calls=0,key='',ready=false;let notify=()=>{};
 const controller=createMonitoringWorkspaceRequests({key:()=>key,ready:()=>ready,subscribe:(listener)=>{notify=listener;return()=>{};},run:async()=>{calls++;},schedule:(callback)=>{timers.set(++next,callback);return next as unknown as ReturnType<typeof setTimeout>;},cancel:(timer)=>{timers.delete(timer as unknown as number);}});
 controller.start();assert.equal(timers.size,0); // Initial lists do not request metrics.
 ready=true;key='scope:a|3h';notify();key='scope:a,b|3h';notify();key='scope:a,b|1h';notify();assert.equal(timers.size,1);
 const tick=()=>{for(const [id,callback]of[...timers]){timers.delete(id);callback();}};tick();assert.equal(calls,1);
 notify();notify();tick();assert.equal(calls,1); // Search/reference updates preserve observation key.
 key='scope:c|1h';notify();ready=false;notify();tick();assert.equal(calls,1); // Menu/account cancellation.
 ready=true;key='new-scope:a|1h';notify();controller.stop();tick();assert.equal(calls,1);
});
test('visibility recovery does not reload completed observations; cancelled debounce resumes once',()=>{
 const timers=new Map<number,()=>void>();let id=0,calls=0,ready=true;const controller=createMonitoringWorkspaceRequests({key:()=> 'same-observation',ready:()=>ready,subscribe:()=>()=>{},run:async()=>{calls++;},schedule:(callback)=>{timers.set(++id,callback);return id as unknown as ReturnType<typeof setTimeout>;},cancel:(timer)=>{timers.delete(timer as unknown as number);}});
 const tick=()=>{for(const [timer,callback]of[...timers]){timers.delete(timer);callback();}};
 controller.start();tick();assert.equal(calls,1);ready=false;controller.sync();ready=true;controller.sync();tick();assert.equal(calls,1);
 controller.stop();controller.start();ready=false;controller.sync();ready=true;controller.sync();tick();assert.equal(calls,2);controller.stop();
});
test('removing the last target and readding the same resource observes it again',()=>{
 let ready=true,key='selected:a',calls=0,callback:(()=>void)|undefined;
 const controller=createMonitoringWorkspaceRequests({key:()=>key,ready:()=>ready,subscribe:()=>()=>{},run:async()=>{calls++;},schedule:(run)=>{callback=run;return 1 as unknown as ReturnType<typeof setTimeout>;},cancel:()=>{callback=undefined;}});
 controller.start();callback?.();callback=undefined;assert.equal(calls,1);ready=false;key='selected:';controller.sync();ready=true;key='selected:a';controller.sync();(callback as (()=>void)|undefined)?.();assert.equal(calls,2);controller.stop();
});
