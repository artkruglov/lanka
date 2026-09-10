import {refreshCapturedResults} from './companion-results.mjs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
/** Fail closed on both JSON-RPC and MCP tool failures. Never expose raw tool errors. */
export async function bridgeCall(client,name,args,signal){
 const result=await client.call(name,args,signal);
 if(result?.isError)throw Error('Lanka rejected worker operation');
 const text=result?.content?.find(c=>c.type==='text')?.text;
 let data;try{data=JSON.parse(text);}catch{throw Error('Invalid worker response');}
 return data;
}
/** Execute one durably received task. The server claim atomically reserves the shared daily quota.
 * No implicit account, automatic retry or native restart. Caller owns the journal lock.
 */
export async function executeBridgeTask({client,journal,message,adapter,setReady,signal,heartbeatMs=20000}){
 if(typeof setReady!=='function'||typeof adapter?.prepare!=='function'||heartbeatMs<10||heartbeatMs>20000)throw Error('Worker dependencies required');
 const initial=journal.snapshot();
 if(initial.phase!=='received'||message?.id!==initial.messageId||message.task?.available===false||!['discuss','propose','create','comment','organize'].includes(message.task?.mode))throw Error('Task requires reconciliation or valid scope');
 const address={sessionId:initial.sessionId,messageId:initial.messageId,executionId:initial.executionId};
 const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 let native,terminal,heartbeat,heartbeatFailure,monitoring=false;const monitorStop=new AbortController();
 const check=()=>{if(abort.signal.aborted)throw Error('Worker interrupted');};
 const report=async status=>bridgeCall(client,'lanka_report_execution',{...address,requestId:randomUUID(),status,...(journal.snapshot().nativeTurnId?{nativeThreadId:journal.snapshot().nativeThreadId,nativeTurnId:journal.snapshot().nativeTurnId}:{})});
 const closeGate=()=>setReady({executionId:address.executionId,state:'stopped'});
 const stopMonitor=async()=>{monitoring=false;monitorStop.abort();await heartbeat;};
 try{
  await closeGate();check();
  await journal.advance('claim_pending');
  const claim=await bridgeCall(client,'lanka_claim_execution',address,abort.signal);
  if(claim?.execution?.id!==address.executionId||claim.execution.state!=='claimed'||claim.replayed)throw Error('Execution claim requires reconciliation');
  await journal.advance('claimed');check();
  native=await adapter.prepare({task:address,message:structuredClone(message),signal:abort.signal});check();
  if(typeof native?.threadId!=='string'||!native.threadId||typeof native.turn!=='function')throw Error('Invalid native adapter');
  await journal.advance('start_pending');check();
  const answer=await native.turn({signal:abort.signal,onTerminal:event=>{
   const state=journal.snapshot();if(event.threadId===native.threadId&&event.turnId===state.nativeTurnId&&['completed','interrupted','failed'].includes(event.status))terminal=event;
  },onStarted:async turnId=>{
   await journal.advance('running',{nativeThreadId:native.threadId,nativeTurnId:turnId});check();
   const r=await report('running');if(r?.stopRequested||r?.execution?.state!=='running')throw Error('Execution cannot continue');check();
   await setReady({executionId:address.executionId,state:'running'});check();
   monitoring=true;
   heartbeat=(async()=>{while(monitoring){try{await delay(heartbeatMs,undefined,{signal:monitorStop.signal});}catch{break;}if(!monitoring)break;try{const r=await report('running');if(r?.stopRequested||r?.execution?.state!=='running')throw Error('Execution must stop');}catch(e){heartbeatFailure=e;monitoring=false;abort.abort();await closeGate().catch(()=>{});}}})();
  }});
  await stopMonitor();await closeGate();check();if(heartbeatFailure)throw heartbeatFailure;
  if(terminal?.status!=='completed'||typeof answer!=='string'||!answer.trim()||answer.length>12000)throw Error('No confirmed native answer');
  await journal.advance('answered',{reply:answer,replyRequestId:randomUUID()});
  const capturedResults=await native.results?.()??[];
  const results=await refreshCapturedResults(capturedResults,id=>bridgeCall(client,'lanka_get_document_view',{documentId:id},abort.signal));
  await journal.advance('answer_pending',{capturedResults,...(results.length?{results}:{})});
  const state=journal.snapshot();
  await bridgeCall(client,'lanka_reply_message',{sessionId:address.sessionId,replyTo:address.messageId,executionId:address.executionId,requestId:state.replyRequestId,text:state.reply,...(state.results?{results:state.results}:{})},abort.signal);
  await journal.advance('replied');
  await report('stopped');await journal.advance('terminal');return journal.snapshot();
 }catch(error){
  abort.abort();await stopMonitor().catch(()=>{});await closeGate().catch(()=>{});
  const phase=journal.snapshot().phase;
  // Do not infer native termination from an exception or an interrupt RPC acknowledgement.
  if(terminal&&['running','start_pending','answered','answer_pending'].includes(phase)){
   try{await report(terminal.status==='failed'?'failed':'stopped');await journal.advance(['answered','answer_pending'].includes(phase)?'unknown':'terminal',{reason:['answered','answer_pending'].includes(phase)?'Reply publication requires reconciliation':'Native termination observed'});}catch{if(journal.snapshot().phase!=='terminal')await journal.advance('unknown',{reason:'Terminal report requires reconciliation'}).catch(()=>{});}
  }else if(['claim_pending','start_pending','running','answer_pending'].includes(phase))await journal.advance('unknown',{reason:'Outcome requires reconciliation'}).catch(()=>{});
  else if(phase==='claimed'){try{await report('stopped');await journal.advance('terminal',{reason:'Native turn was not dispatched'});}catch{ /* Leave claimed for reconciliation; never start it implicitly. */ }}
  throw error;
 }finally{signal?.removeEventListener('abort',cancel);await native?.close?.();}
}
