import {acquireCompanionLock} from './companion-locks.mjs';
import {companionReadSession} from './companion-read-session.mjs';
import {requireCompanionModel} from './companion-models.mjs';
import {CompanionFault,companionDiagnostic} from './companion-faults.mjs';
import {companionConnection} from '../lib/project/companion-connection.mjs';
import {reconcileFinishedExecution} from './companion-recovery.mjs';
import {readFile,writeFile,lstat,realpath,mkdir,open,rename,unlink,readdir} from 'node:fs/promises';
import {resolve,isAbsolute,join,dirname} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {CorporateMcpClient} from './corporate-mcp-client.mjs';import {openCompanionJournal} from './companion-journal.mjs';import {bridgeCall,executeBridgeTask} from './companion-worker.mjs';import {createCompanionCodexAdapter} from './companion-codex.mjs';
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
async function privateJson(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)||s.size>1000000)throw Error('Private configuration required');return JSON.parse(await readFile(path,'utf8'));}
export async function loadCompanionConfig(path){
 if(!isAbsolute(path))throw Error('Absolute configuration required');let c=await privateJson(path);
 if(c.connectionPath!==undefined){
  if(typeof c.connectionPath!=='string'||!isAbsolute(c.connectionPath)||['url','token','sessionId'].some(k=>k in c))throw Error('Use one explicit connection file');
  const connection=companionConnection(await privateJson(c.connectionPath));c={...c,url:connection.url,token:connection.token,sessionId:connection.sessionId};
 }
 if(!uuid(c.sessionId)||!['stateDir','command','codexHome','cwd'].every(k=>typeof c[k]==='string'&&isAbsolute(c[k]))||typeof c.model!=='string'||!c.model.trim())throw Error('Explicit companion configuration required');
 new CorporateMcpClient({url:c.url,token:c.token});return c;
}
async function atomicJson(path,data){const temp=path+'.'+randomUUID();let f;try{f=await open(temp,'wx',0o600);await f.writeFile(JSON.stringify(data)+'\n');await f.sync();await f.close();f=null;await rename(temp,path);const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}finally{await f?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
export async function checkCompanionAccount(c,options={}){
 return companionReadSession(c,async server=>{await server.initialize();const effective=(await server.request('config/read',{includeLayers:false})).config;if(effective.sqlite_home!==c.codexHome)throw new CompanionFault('CONFIGURATION');if(!(await server.request('account/read',{refreshToken:false})).account)throw new CompanionFault('AUTH_REQUIRED');await requireCompanionModel(server,c.model);},options);
}
export async function checkCompanionConnection(c,{client=new CorporateMcpClient({url:c.url,token:c.token,runtime:true}),checkAccount=checkCompanionAccount,onContext=()=>{},signal}={}){
 await client.initialize(signal);
 const conversation=await bridgeCall(client,'lanka_read_conversation',{sessionId:c.sessionId,after:'0'},signal);
 if(conversation?.sessionId!==c.sessionId||!conversation.binding?.active||!conversation.binding.taskBound)throw new CompanionFault('BINDING_REQUIRED');
 if(typeof conversation.session?.title==='string'&&conversation.session.title.trim())onContext({sessionId:c.sessionId,title:conversation.session.title.slice(0,200)});
 await checkAccount(c,{signal});return {state:'connection_checked',message:'Подключение, вход и наличие модели в каталоге проверены. Модель не запускалась.'};
}
export async function conversationHistory(client,sessionId,message,signal){
 let after='0',history=[],bytes=0,found=false;const seen=new Set(),priorUsers=new Set();
 for(let page=0;page<100;page++){
  const r=await bridgeCall(client,'lanka_read_conversation',{sessionId,after},signal);if(!Array.isArray(r.messages))throw Error('Conversation unavailable');
  for(const m of r.messages){
   if(!/^\d{1,18}$/.test(m.sequence))throw Error('Invalid conversation order');
   if(m.id===message.id){found=true;continue;}
   const earlier=BigInt(m.sequence)<BigInt(message.sequence);
   if(earlier&&m.role==='user')priorUsers.add(m.id);
   // A response to a previous request can be saved after this already-queued user message.
   if(!earlier&&!(m.role==='assistant'&&priorUsers.has(m.replyTo)))continue;
   const item={role:m.role,text:m.text,delivery:m.delivery,results:m.results};bytes+=Buffer.byteLength(JSON.stringify(item));if(bytes>300000)throw Error('Conversation needs a reviewed summary before continuing');history.push(item);
  }
  if(!r.hasMore){if(!found)throw Error('Current message not found in conversation');return history;}
  if(!r.nextCursor||seen.has(r.nextCursor))throw Error('Invalid conversation cursor');seen.add(r.nextCursor);after=r.nextCursor;
 }throw Error('Conversation pagination limit exceeded');
}
/** Finish only a recorded successful dispatch; never infer order from file dates. */
export async function recoverNativeMapping(c){
 const path=join(c.stateDir,'native-session-pending.json');let pending;
 try{pending=await privateJson(path);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(pending.sessionId!==c.sessionId||!uuid(pending.messageId)||!uuid(pending.executionId)||typeof pending.model!=='string'||!pending.model.trim())throw Error('Invalid pending native session');
 const checkpoint=await privateJson(join(c.stateDir,pending.messageId+'.checkpoint.json'));
 if(checkpoint.version!==1||checkpoint.sessionId!==pending.sessionId||checkpoint.messageId!==pending.messageId||checkpoint.executionId!==pending.executionId)throw Error('Pending native session requires reconciliation');
 if(checkpoint.phase==='received'&&!checkpoint.nativeThreadId&&!checkpoint.nativeTurnId)return false;
 if(checkpoint.phase!=='terminal'||!uuid(checkpoint.replyRequestId)||typeof checkpoint.reply!=='string'||!checkpoint.reply.trim()||![checkpoint.nativeThreadId,checkpoint.nativeTurnId].every(v=>typeof v==='string'&&v.length>0&&v.length<=200))throw Error('Pending native session requires confirmed completion');
 await atomicJson(join(c.stateDir,'native-session.json'),{sessionId:pending.sessionId,messageId:pending.messageId,executionId:pending.executionId,model:pending.model,nativeThreadId:checkpoint.nativeThreadId,nativeTurnId:checkpoint.nativeTurnId});
 await unlink(path);return true;
}
export async function previousNativeSession(c){
 let saved;try{saved=await privateJson(join(c.stateDir,'native-session.json'));}catch(e){if(e.code==='ENOENT')return {};throw e;}
 if(saved.sessionId!==c.sessionId||!uuid(saved.messageId)||!uuid(saved.executionId)||typeof saved.nativeThreadId!=='string'||!saved.nativeThreadId||typeof saved.nativeTurnId!=='string'||!saved.nativeTurnId||saved.nativeThreadId.length>200||saved.nativeTurnId.length>200||typeof saved.model!=='string'||!saved.model)throw Error('Invalid native session mapping');
 const checkpoint=await privateJson(join(c.stateDir,saved.messageId+'.checkpoint.json'));
 if(checkpoint.version!==1||checkpoint.sessionId!==c.sessionId||checkpoint.messageId!==saved.messageId||checkpoint.phase!=='terminal'||checkpoint.executionId!==saved.executionId||checkpoint.nativeThreadId!==saved.nativeThreadId||checkpoint.nativeTurnId!==saved.nativeTurnId)throw Error('Native session mapping requires reconciliation');
 return saved.model===c.model?{nativeThreadId:saved.nativeThreadId,nativeTurnId:saved.nativeTurnId}:{};
}
/** One explicitly bound conversation. Foreground daemon; no installation or credential copying. */
export async function runCompanion(c,{signal,onStatus=()=>{},client=new CorporateMcpClient({url:c.url,token:c.token,runtime:true}),checkAccount=checkCompanionAccount,makeAdapter=createCompanionCodexAdapter,execute=executeBridgeTask,pollMs=2000}={}){
 if(!uuid(c.sessionId)||!Number.isInteger(pollMs)||pollMs<10||pollMs>30000)throw Error('Invalid companion configuration');
 await mkdir(c.stateDir,{recursive:true,mode:0o700});const stat=await lstat(c.stateDir);if(!stat.isDirectory()||(stat.mode&0o077)||await realpath(c.stateDir)!==c.stateDir)throw Error('Private real state directory required');
 let lock;try{lock=await acquireCompanionLock(join(c.stateDir,'companion.lock'));}catch(e){if(e.code==='EEXIST')throw new CompanionFault('INSTANCE_LOCKED');throw e;}
 try{
  const scope=createHash('sha256').update(JSON.stringify([c.url,c.sessionId,c.codexHome])).digest('hex'),scopePath=join(c.stateDir,'scope.json');
  try{if((await privateJson(scopePath)).scope!==scope)throw Error('State directory belongs to another connection');}catch(e){if(e.code!=='ENOENT')throw e;await atomicJson(scopePath,{scope});}
  const unfinished=[];
  for(const file of await readdir(c.stateDir))if(file.endsWith('.checkpoint.json')){
   const state=await privateJson(join(c.stateDir,file));
   if(!['received','terminal'].includes(state.phase)){
    if(state.version!==1||state.sessionId!==c.sessionId||!uuid(state.messageId)||!uuid(state.executionId)||file!==state.messageId+'.checkpoint.json')throw Error('Previous execution requires reconciliation');
    unfinished.push({file,state});
   }
  }
  await client.initialize(signal);
  for(const {file,state} of unfinished){const journal=await openCompanionJournal(join(c.stateDir,file),{sessionId:c.sessionId,messageId:state.messageId});try{onStatus(await reconcileFinishedExecution(client,journal,signal));}finally{await journal.close();}}
  if(await recoverNativeMapping(c))onStatus({state:'session_recovered'});
  await checkAccount(c,{signal});onStatus({state:'connected'});
  while(!signal?.aborted){
   const r=await bridgeCall(client,'lanka_receive_message',{sessionId:c.sessionId},signal);
   if(!r.message){try{await delay(pollMs,undefined,{signal});}catch{if(!signal?.aborted)throw Error('Polling interrupted');}continue;}
   const message=r.message;if(!uuid(message.id)||!/^\d{1,18}$/.test(message.sequence))throw Error('Invalid received message');
   const journal=await openCompanionJournal(join(c.stateDir,message.id+'.checkpoint.json'),{sessionId:c.sessionId,messageId:message.id});
   const configPath=join(c.stateDir,message.id+'.mcp.json'),readyPath=join(c.stateDir,message.id+'.ready.json'),resultsPath=join(c.stateDir,message.id+'.results.jsonl');
   try{
    const state=journal.snapshot();if(state.phase!=='received')throw Error('Received task requires reconciliation');
    const history=await conversationHistory(client,c.sessionId,message,signal);
    try{await writeFile(resultsPath,'',{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;const previous=await lstat(resultsPath);if(!previous.isFile()||previous.isSymbolicLink()||(previous.mode&0o077)||previous.size!==0)throw Error('Previous result ledger requires reconciliation');}
    await atomicJson(configPath,{url:c.url,token:c.token,task:{sessionId:c.sessionId,messageId:message.id,executionId:state.executionId},mode:message.task?.mode,documentId:message.task?.documentId,readyPath,resultsPath});
    const previous=await previousNativeSession(c);
    const adapter=makeAdapter({...previous,command:c.command,codexHome:c.codexHome,cwd:c.cwd,model:c.model,configPath,history});
    await atomicJson(join(c.stateDir,'native-session-pending.json'),{sessionId:c.sessionId,messageId:message.id,executionId:state.executionId,model:c.model});
    onStatus({state:'working',messageId:message.id});
    await execute({client,journal,message,adapter,signal,setReady:marker=>atomicJson(readyPath,marker)});
    const finished=journal.snapshot();
    if(finished.phase!=='terminal'||!finished.nativeThreadId||!finished.nativeTurnId)throw Error('Native session did not finish');
    await recoverNativeMapping(c);
    onStatus({state:'answered',messageId:message.id});
   }finally{try{await atomicJson(readyPath,{executionId:journal.snapshot().executionId,state:'stopped'});}finally{try{await journal.close();}finally{await unlink(configPath).catch(e=>{if(e.code!=='ENOENT')throw e;});}}}
  }
 }finally{await lock.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
 try{
  const checking=process.argv[2]==='--check',offset=checking?3:2;
  if(process.argv.length!==offset+2||process.argv[offset]!=='--config')throw new CompanionFault('CONFIGURATION');
  let config;try{config=await loadCompanionConfig(process.argv[offset+1]);}catch{throw new CompanionFault('CONFIGURATION');}
  if(checking)process.stdout.write(JSON.stringify(await checkCompanionConnection(config,{signal:abort.signal}))+'\n');
  else await runCompanion(config,{signal:abort.signal,onStatus:s=>process.stdout.write(JSON.stringify(s)+'\n')});
 }catch(error){process.stderr.write(JSON.stringify(companionDiagnostic(error,{interrupted:abort.signal.aborted}))+'\n');process.exitCode=1;}
}
