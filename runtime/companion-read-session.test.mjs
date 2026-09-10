import test from 'node:test';import assert from 'node:assert/strict';
import {companionReadSession} from './companion-read-session.mjs';
import {listCompanionModels} from './companion-models.mjs';
import {checkCompanionAccount} from './companion-daemon.mjs';
test('already cancelled preflight does not open a native process',async()=>{const abort=new AbortController();abort.abort();await assert.rejects(companionReadSession({},()=>assert.fail(),{signal:abort.signal,openServer:()=>assert.fail()}),e=>e.code==='READ_CANCELLED');});
test('catalog and account checks interrupt an unresponsive native read and close their process',async()=>{
 for(const check of [listCompanionModels,checkCompanionAccount]){
  const abort=new AbortController();let entered,release,closed=0;const ready=new Promise(r=>entered=r),calls=[];
  const task=check({codexHome:'/dedicated',model:'chosen'},{signal:abort.signal,openServer:()=>({initialize:async()=>{},close:()=>closed++,request:async method=>{calls.push(method);if(method==='config/read')return {config:{sqlite_home:'/dedicated'}};assert.equal(method,'account/read');entered();return new Promise(r=>release=r);}})});
  await ready;abort.abort();await assert.rejects(task,e=>e.code==='READ_CANCELLED');assert.equal(closed,1);release({account:{}});await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['config/read','account/read']);
 }
});
test('one deadline bounds all read pages without granting model operations',async()=>{
 let closed=0;await assert.rejects(companionReadSession({},async server=>{await server.initialize();await server.request('model/list',{});},{timeoutMs:10,openServer:()=>({initialize:async()=>{},request:()=>new Promise(()=>{}),close:()=>closed++})}),e=>e.code==='READ_TIMEOUT');assert.equal(closed,1);
 await assert.rejects(companionReadSession({},server=>server.request('turn/start',{}),{openServer:()=>({request:()=>assert.fail('No turn'),close:()=>{}})}),e=>e.code==='PROTOCOL');
});
