import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,chmod} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {openCompanionJournal} from './companion-journal.mjs';import {executeBridgeTask} from './companion-worker.mjs';
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
async function setup(t,{run,call,reserve}={}){
 const dir=await mkdtemp(join(tmpdir(),'lanka-worker-'));await chmod(dir,0o700);const journal=await openCompanionJournal(join(dir,'task.json'),{sessionId:randomUUID(),messageId:randomUUID()});t.after(async()=>{await journal.close();await rm(dir,{recursive:true,force:true});});
 const events=[],message={id:journal.snapshot().messageId,task:{mode:'discuss'},text:'Hello'};
 const client={call:async(name,args)=>{events.push({name,args});if(name==='lanka_claim_execution'){events.push({name:'quota'});await reserve?.(args);}const override=await call?.(name,args);if(override)return override;return result(name==='lanka_claim_execution'?{execution:{id:args.executionId,state:'claimed'},replayed:false}:name==='lanka_report_execution'?{execution:{state:args.status},stopRequested:false}:{id:args.requestId});}};
 const adapter={prepare:async()=>{events.push({name:'prepare'});return {threadId:'native-thread',turn:async o=>{events.push({name:'native-start',phase:journal.snapshot().phase});await o.onStarted('native-turn');if(run)return run(o);o.onTerminal({threadId:'native-thread',turnId:'native-turn',status:'completed'});return 'Ответ';},close:async()=>events.push({name:'close'})};}};
 const options={client,journal,message,adapter,heartbeatMs:10,setReady:async marker=>events.push({name:'gate',marker})};return {options,events,journal};
}
test('worker persists startup, gates writes, saves reply and reports observed completion',async t=>{
 const {options,events,journal}=await setup(t);await executeBridgeTask(options);assert.equal(journal.snapshot().phase,'terminal');assert.equal(events.find(e=>e.name==='native-start').phase,'start_pending');
 const names=events.map(e=>e.name);assert.ok(names.indexOf('quota')<names.indexOf('prepare'));const reply=events.find(e=>e.name==='lanka_reply_message');assert.equal(reply.args.requestId,journal.snapshot().replyRequestId);assert.equal(reply.args.text,'Ответ');assert.equal(events.filter(e=>e.name==='lanka_report_execution').at(-1).args.status,'stopped');
 await assert.rejects(executeBridgeTask(options),/reconciliation/);assert.equal(events.filter(e=>e.name==='native-start').length,1);
});
test('server quota denial launches no agent',async t=>{const {options,events}=await setup(t,{reserve:()=>{throw Error('Daily limit');}});await assert.rejects(executeBridgeTask(options),/Daily limit/);assert.equal(events.some(e=>e.name==='prepare'),false);});
test('heartbeat cancellation interrupts native turn and never posts late reply',async t=>{
 const {options,events,journal}=await setup(t,{call:(name,args)=>name==='lanka_report_execution'&&args.status==='running'&&events.filter(e=>e.name===name).length>1?result({execution:{state:'running'},stopRequested:true}):null,run:o=>new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>{o.onTerminal({threadId:'native-thread',turnId:'native-turn',status:'interrupted'});reject(Error('Native interrupted'));},{once:true});})});
 await assert.rejects(executeBridgeTask(options),/interrupted/);assert.equal(journal.snapshot().phase,'terminal');assert.equal(events.some(e=>e.name==='lanka_reply_message'),false);assert.equal(events.filter(e=>e.name==='gate').at(-1).marker.state,'stopped');
});
test('native exception without terminal event stays unknown and never claims stopped',async t=>{const {options,events,journal}=await setup(t,{run:()=>{throw Error('Lost native transport');}});await assert.rejects(executeBridgeTask(options),/Lost/);assert.equal(journal.snapshot().phase,'unknown');assert.equal(events.some(e=>e.name==='lanka_report_execution'&&e.args.status==='stopped'),false);});
test('lost claim response cannot dispatch a native turn or silently retry',async t=>{const {options,events,journal}=await setup(t,{call:name=>{if(name==='lanka_claim_execution')throw Error('Network outcome unknown');}});await assert.rejects(executeBridgeTask(options),/unknown/);assert.equal(journal.snapshot().phase,'unknown');assert.equal(events.some(e=>e.name==='prepare'),false);assert.equal(events.filter(e=>e.name==='lanka_claim_execution').length,1);});
test('MCP tool error is rejected before model launch',async t=>{const {options,events}=await setup(t,{call:name=>name==='lanka_claim_execution'?{isError:true,content:[]}:null});await assert.rejects(executeBridgeTask(options),/rejected/);assert.equal(events.some(e=>e.name==='prepare'),false);});

test('lost reply acknowledgement preserves exact answer and does not retry inference or reply',async t=>{
 const {options,events,journal}=await setup(t,{call:name=>{if(name==='lanka_reply_message')throw Error('Reply outcome unknown');}});await assert.rejects(executeBridgeTask(options),/unknown/);assert.equal(journal.snapshot().phase,'unknown');assert.equal(journal.snapshot().reply,'Ответ');assert.ok(journal.snapshot().replyRequestId);assert.equal(events.filter(e=>e.name==='native-start').length,1);assert.equal(events.filter(e=>e.name==='lanka_reply_message').length,1);
});
test('a successful return without the exact terminal event is not a completed agent run',async t=>{
 const {options,events,journal}=await setup(t,{run:o=>{o.onTerminal({threadId:'other',turnId:'native-turn',status:'completed'});return 'Unverified';}});await assert.rejects(executeBridgeTask(options),/confirmed/);assert.equal(journal.snapshot().phase,'unknown');assert.equal(events.some(e=>e.name==='lanka_reply_message'),false);
});

test('failed result refresh keeps the native answer durable without posting an invalid card',async t=>{
 const {options,events,journal}=await setup(t,{call:name=>{if(name==='lanka_get_document_view')throw Error('Access revoked');}});const prepare=options.adapter.prepare;options.adapter.prepare=async(...args)=>({...await prepare(...args),results:async()=>[{documentId:randomUUID(),revision:1}]});await assert.rejects(executeBridgeTask(options),/revoked/);assert.equal(journal.snapshot().reply,'Ответ');assert.equal(journal.snapshot().phase,'unknown');assert.equal(events.some(e=>e.name==='lanka_reply_message'),false);
});
