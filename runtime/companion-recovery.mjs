import {bridgeCall} from './companion-worker.mjs';
/** Read-only remote reconciliation. Never starts, interrupts or replays a model turn. */
export async function assessFinishedExecution(client,state,signal){
 let after='0',request,reply;const seen=new Set();
 for(let page=0;page<100;page++){
  const r=await bridgeCall(client,'lanka_read_conversation',{sessionId:state.sessionId,after},signal);
  if(r?.sessionId!==state.sessionId||!Array.isArray(r.messages))throw Error('Recovery conversation mismatch');
  for(const m of r.messages){if(m.id===state.messageId)request=m;if(state.replyRequestId&&m.id===state.replyRequestId)reply=m;}
  if(!r.hasMore)break;
  if(page===99||!/^\d{1,18}$/.test(r.nextCursor)||seen.has(r.nextCursor))throw Error('Recovery pagination incomplete');seen.add(r.nextCursor);after=r.nextCursor;
 }
 const beforeStartup=state.phase==='claim_pending'||state.phase==='unknown'&&state.unknownFrom==='claim_pending';
 if(beforeStartup&&!state.nativeThreadId&&!state.nativeTurnId&&!state.replyRequestId&&request?.role==='user'&&request.delivery==='received_by_mcp_client'&&request.execution===undefined){
  return {phase:'received',state:'ready_to_claim',messageId:state.messageId,reason:'Server confirms no execution; native startup was never dispatched'};
 }
 if(request?.role!=='user'||request.execution?.id!==state.executionId||!['stopped','failed'].includes(request.execution.state)||request.execution.reportedBy!=='external_mcp_client')throw Error('Native termination still requires reconciliation');
 let reason;
 const cardsMatch=JSON.stringify(state.results??[])===JSON.stringify((reply?.results??[]).map(r=>r.available===false?null:({documentId:r.documentId,revision:r.revision,...(r.proposalId?{proposalId:r.proposalId}:{})})));
 if(request.delivery==='cancelled')reason='Server confirms cancellation and terminal execution';
 else if(request.delivery==='completed'&&typeof state.reply==='string'&&reply?.role==='assistant'&&reply.replyTo===state.messageId&&reply.text===state.reply.trim()&&cardsMatch)reason='Server confirms saved reply and terminal execution';
 else throw Error('Saved reply still requires reconciliation');
 return {phase:'terminal',state:'reconciled',messageId:state.messageId,reason};
}

export async function reconcileFinishedExecution(client,journal,signal){
 const assessment=await assessFinishedExecution(client,journal.snapshot(),signal);
 await journal.advance(assessment.phase,{reason:assessment.reason});return {state:assessment.state,messageId:assessment.messageId};
}
