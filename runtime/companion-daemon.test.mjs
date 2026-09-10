import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readdir,readFile,writeFile,realpath} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';import {runCompanion,conversationHistory} from './companion-daemon.mjs';
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
async function fixture(t){const stateDir=await realpath(await mkdtemp(join(tmpdir(),'lanka-daemon-')));t.after(()=>rm(stateDir,{recursive:true,force:true}));return {stateDir,sessionId:randomUUID(),url:'https://example.invalid/mcp/organizations/'+randomUUID(),token:'a'.repeat(64),command:'/trusted/codex',codexHome:stateDir,cwd:stateDir,model:'test-explicit'};}
test('foreground daemon handles sequential tasks with prior chat context and removes transient credentials',async t=>{
 const config=await fixture(t),abort=new AbortController(),events=[],histories=[],nativeIds=[];let index=0;
 const messages=[{id:randomUUID(),sequence:'1',text:'First',role:'user',task:{mode:'discuss'}},{id:randomUUID(),sequence:'2',text:'Second',role:'user',task:{mode:'discuss'}}];
 const client={initialize:async()=>{},call:async(name,a)=>{events.push(name);if(name==='lanka_receive_message')return result({message:messages[index]});if(name==='lanka_read_conversation')return result({messages:index?[messages[0],messages[1],{id:randomUUID(),sequence:'3',role:'assistant',replyTo:messages[0].id,text:'Answer'}]:[messages[0]],hasMore:false});if(name==='lanka_claim_execution')return result({execution:{id:a.executionId,state:'claimed'},replayed:false});if(name==='lanka_report_execution')return result({execution:{state:a.status},stopRequested:false});if(name==='lanka_reply_message'){index++;return result({id:a.requestId});}throw Error(name);}};
 await runCompanion(config,{client,signal:abort.signal,checkAccount:async()=>{},onStatus:s=>{if(s.state==='answered'&&index===2)abort.abort();},makeAdapter:options=>{histories.push(options.history);nativeIds.push(options.nativeThreadId);return {prepare:async()=>({threadId:'t',turn:async o=>{await o.onStarted('turn');o.onTerminal({threadId:'t',turnId:'turn',status:'completed'});return 'Answer';},close:async()=>{}})};}});
 assert.deepEqual(nativeIds,[undefined,'t']);assert.deepEqual(histories.map(h=>h.length),[0,2]);assert.equal(histories[1][1].text,'Answer');assert.equal(events.filter(e=>e==='lanka_reply_message').length,2);
 const files=await readdir(config.stateDir);assert.equal(files.some(f=>f.endsWith('.mcp.json')||f.endsWith('.lock')),false);for(const file of files.filter(f=>f.endsWith('.checkpoint.json')))assert.equal(JSON.parse(await readFile(join(config.stateDir,file),'utf8')).phase,'terminal');
});
test('missing account stops before receiving or claiming a task',async t=>{const c=await fixture(t);let calls=0;await assert.rejects(runCompanion(c,{client:{initialize:async()=>{},call:async()=>{calls++;}},checkAccount:async()=>{throw Error('Sign in');}}),/Sign in/);assert.equal(calls,0);});
test('unresolved checkpoint blocks startup before account access or polling',async t=>{const c=await fixture(t);await writeFile(join(c.stateDir,'old.checkpoint.json'),JSON.stringify({phase:'unknown'}),{mode:0o600});await assert.rejects(runCompanion(c,{client:{initialize:()=>assert.fail('No network')},checkAccount:()=>assert.fail('No account access')}),/reconciliation/);});
test('history pagination keeps preceding messages and refuses a missing current message',async()=>{
 const message={id:randomUUID(),sequence:'3'},seen=[];const client={call:async(name,a)=>{seen.push(a.after);return result(a.after==='0'?{messages:[{sequence:'1',id:'first',role:'user',text:'Previous'}],hasMore:true,nextCursor:'1'}:{messages:[{sequence:'2',id:'answer',role:'assistant',text:'Response'},message],hasMore:false});}};
 assert.equal((await conversationHistory(client,randomUUID(),message)).length,2);assert.deepEqual(seen,['0','1']);await assert.rejects(conversationHistory({call:async()=>result({messages:[],hasMore:false})},randomUUID(),message),/not found/);
});

test('restart reconciles a confirmed saved reply before connecting and never dispatches it again',async t=>{
 const {openCompanionJournal}=await import('./companion-journal.mjs'),c=await fixture(t),messageId=randomUUID(),journal=await openCompanionJournal(join(c.stateDir,messageId+'.checkpoint.json'),{sessionId:c.sessionId,messageId});await journal.advance('claim_pending');await journal.advance('claimed');await journal.advance('start_pending');await journal.advance('running',{nativeThreadId:'thread',nativeTurnId:'turn'});await journal.advance('answer_pending',{reply:'Answer',replyRequestId:randomUUID()});await journal.advance('unknown');const state=journal.snapshot();await journal.close();
 const abort=new AbortController(),events=[];await runCompanion(c,{signal:abort.signal,checkAccount:async()=>{},makeAdapter:()=>assert.fail('No model restart'),client:{initialize:async()=>{},call:async name=>{assert.equal(name,'lanka_read_conversation');return result({sessionId:c.sessionId,messages:[{id:messageId,role:'user',delivery:'completed',execution:{id:state.executionId,state:'stopped',reportedBy:'external_mcp_client'}},{id:state.replyRequestId,role:'assistant',replyTo:messageId,text:'Answer'}],hasMore:false});}},onStatus:s=>{events.push(s.state);if(s.state==='connected')abort.abort();}});
 assert.deepEqual(events,['reconciled','connected']);assert.equal(JSON.parse(await readFile(join(c.stateDir,messageId+'.checkpoint.json'),'utf8')).phase,'terminal');
});

test('native mapping requires a matching completed checkpoint and model change uses fresh context',async t=>{
 const {previousNativeSession}=await import('./companion-daemon.mjs'),c=await fixture(t),messageId=randomUUID(),executionId=randomUUID(),mapping={sessionId:c.sessionId,messageId,executionId,nativeThreadId:'thread',nativeTurnId:'turn',model:c.model},checkpoint={version:1,sessionId:c.sessionId,messageId,executionId,nativeThreadId:'thread',nativeTurnId:'turn',phase:'terminal'};
 await writeFile(join(c.stateDir,'native-session.json'),JSON.stringify(mapping),{mode:0o600});const path=join(c.stateDir,messageId+'.checkpoint.json');await writeFile(path,JSON.stringify(checkpoint),{mode:0o600});assert.deepEqual(await previousNativeSession(c),{nativeThreadId:'thread',nativeTurnId:'turn'});assert.deepEqual(await previousNativeSession({...c,model:'another-explicit-model'}),{});await writeFile(path,JSON.stringify({...checkpoint,sessionId:randomUUID()}));await assert.rejects(previousNativeSession(c),/reconciliation/);
});

test('restart repairs a mapping lost after durable reply without repeating the finished turn',async t=>{
 const {executeBridgeTask}=await import('./companion-worker.mjs');const c=await fixture(t),abort=new AbortController();let index=0,turns=0,replies=0;const resumed=[],states=[];
 const messages=[1,2].map(n=>({id:randomUUID(),sequence:String(n),role:'user',text:'Task '+n,task:{mode:'discuss'}}));
 const client={initialize:async()=>{},call:async(name,a)=>{
  if(name==='lanka_receive_message')return result({message:messages[index]});
  if(name==='lanka_read_conversation')return result({messages,hasMore:false});
  if(name==='lanka_claim_execution')return result({execution:{id:a.executionId,state:'claimed'},replayed:false});
  if(name==='lanka_report_execution')return result({execution:{state:a.status},stopRequested:false});
  if(name==='lanka_reply_message'){index++;replies++;return result({id:a.requestId});}throw Error(name);
 }};
 const makeAdapter=o=>{resumed.push(o.nativeThreadId);return {prepare:async()=>({threadId:'saved-thread',turn:async callbacks=>{turns++;await callbacks.onStarted('turn-'+turns);callbacks.onTerminal({threadId:'saved-thread',turnId:'turn-'+turns,status:'completed'});return 'Saved answer';},close:async()=>{}})};};
 await assert.rejects(runCompanion(c,{client,checkAccount:async()=>{},makeAdapter,execute:async options=>{await executeBridgeTask(options);throw Error('Interrupted before mapping commit');}}),/before mapping commit/);
 assert.equal(index,1);assert.ok((await readdir(c.stateDir)).includes('native-session-pending.json'));assert.equal((await readdir(c.stateDir)).includes('native-session.json'),false);
 await runCompanion(c,{client,signal:abort.signal,checkAccount:async()=>{},makeAdapter,onStatus:s=>{states.push(s.state);if(s.state==='answered')abort.abort();}});
 assert.deepEqual(resumed,[undefined,'saved-thread']);assert.equal(turns,2);assert.equal(replies,2);assert.equal(states[0],'session_recovered');assert.equal((await readdir(c.stateDir)).includes('native-session-pending.json'),false);
});
test('mapping recovery requires exact dispatch evidence and preserves the recorded model',async t=>{
 const {recoverNativeMapping,previousNativeSession}=await import('./companion-daemon.mjs'),c=await fixture(t),messageId=randomUUID(),executionId=randomUUID(),pending={sessionId:c.sessionId,messageId,executionId,model:'previous-explicit-model'},base={version:1,sessionId:c.sessionId,messageId,executionId,nativeThreadId:'thread',nativeTurnId:'turn',reply:'Answer',replyRequestId:randomUUID()};
 const pendingPath=join(c.stateDir,'native-session-pending.json'),checkpointPath=join(c.stateDir,messageId+'.checkpoint.json');
 await writeFile(pendingPath,JSON.stringify(pending),{mode:0o600});
 for(const state of [{...base,phase:'unknown'},{...base,phase:'terminal',executionId:randomUUID()},{...base,phase:'terminal',replyRequestId:undefined}]){await writeFile(checkpointPath,JSON.stringify(state),{mode:0o600});await assert.rejects(recoverNativeMapping(c));}
 await writeFile(checkpointPath,JSON.stringify({...base,phase:'terminal'}));assert.equal(await recoverNativeMapping(c),true);assert.deepEqual(await previousNativeSession(c),{});assert.deepEqual(await previousNativeSession({...c,model:pending.model}),{nativeThreadId:'thread',nativeTurnId:'turn'});
 assert.equal(await recoverNativeMapping(c),false);
});
