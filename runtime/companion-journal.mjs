import {acquireCompanionLock} from './companion-locks.mjs';
import {open,rename,unlink,lstat,readFile} from 'node:fs/promises';
import {isAbsolute,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const phases={received:['claim_pending'],claim_pending:['received','claimed','terminal','unknown'],claimed:['start_pending','terminal'],start_pending:['running','terminal','unknown'],running:['answered','answer_pending','terminal','unknown'],answered:['answer_pending','terminal','unknown'],answer_pending:['replied','terminal','unknown'],replied:['terminal'],unknown:['received','terminal'],terminal:[]};
/** One private file per received task. No automatic stale-lock takeover or native restart. */
export async function openCompanionJournal(path,initial){
 if(!isAbsolute(path))throw Error('Absolute checkpoint path required');
 const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077))throw Error('Private checkpoint directory required');
 const lock=await acquireCompanionLock(path+'.lock');let state,closed=false,uncertain=false;
 async function persist(next){
  const temp=join(dirname(path),'.checkpoint-'+randomUUID());let file;
  try{file=await open(temp,'wx',0o600);await file.writeFile(JSON.stringify(next)+'\n');await file.sync();await file.close();file=null;await rename(temp,path);const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}}
  finally{await file?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 }
 try{
  try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>1000000)throw Error('Invalid private checkpoint');state=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;
   if(!initial||!['sessionId','messageId'].every(k=>/^[a-f0-9-]{36}$/.test(initial[k]??'')))throw Error('Task identity required');
   state={version:1,sessionId:initial.sessionId,messageId:initial.messageId,executionId:randomUUID(),phase:'received',sequence:0};await persist(state);
  }
  if(state.version!==1||!Object.hasOwn(phases,state.phase)||!Number.isSafeInteger(state.sequence)||state.sequence<0||!['sessionId','messageId','executionId'].every(k=>/^[a-f0-9-]{36}$/.test(state[k]??'')))throw Error('Invalid checkpoint');
  if(initial&&(initial.sessionId!==state.sessionId||initial.messageId!==state.messageId))throw Error('Checkpoint task mismatch');
 }catch(e){await lock.close();throw e;}
 let pending=Promise.resolve();
 return {
  snapshot:()=>structuredClone(state),
  // Synchronous queueing preserves order even when the caller does not await immediately.
  advance(phase,details={}){
   if(closed)return Promise.reject(Error('Checkpoint closed'));
   const operation=pending.then(async()=>{
    if(uncertain)throw Error('Checkpoint write outcome unknown; reopen and reconcile');
    if(!phases[state.phase].includes(phase))throw Error('Invalid execution transition');
    const allowed=['nativeThreadId','nativeTurnId','reply','replyRequestId','reportRequestId','reason','results','capturedResults'];
    if(!details||typeof details!=='object'||Array.isArray(details)||Object.keys(details).some(k=>!allowed.includes(k)))throw Error('Invalid checkpoint details');
    for(const key of ['nativeThreadId','nativeTurnId','reply','replyRequestId','results','capturedResults'])if(state[key]!==undefined&&key in details&&JSON.stringify(details[key])!==JSON.stringify(state[key]))throw Error('Execution evidence is immutable');
    if(phase==='received'&&!(state.phase==='claim_pending'||state.phase==='unknown'&&state.unknownFrom==='claim_pending'))throw Error('Native startup cannot be retried');
    const next={...state,...structuredClone(details),...(phase==='unknown'?{unknownFrom:state.phase}:{}),phase,sequence:state.sequence+1};
    if(phase==='running'&&![next.nativeThreadId,next.nativeTurnId].every(v=>typeof v==='string'&&v.length>0&&v.length<=200))throw Error('Native identity required');
    if(['answered','answer_pending'].includes(phase)&&(typeof next.reply!=='string'||!next.reply.trim()||next.reply.length>100000||!/^[a-f0-9-]{36}$/.test(next.replyRequestId??'')))throw Error('Durable reply required');
    if(Buffer.byteLength(JSON.stringify(next))>1000000)throw Error('Checkpoint too large');
    try{await persist(next);}catch(e){uncertain=true;throw e;}state=next;return structuredClone(state);
   });pending=operation.catch(()=>{});return operation;
  },
  async close(){if(closed)return;closed=true;await pending;await lock.close();},
 };
}
