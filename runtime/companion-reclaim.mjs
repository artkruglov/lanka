import {lstat,readFile,readdir,realpath,unlink,open} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {acquireCompanionLock,inspectCompanionLock} from './companion-locks.mjs';import {assessFinishedExecution} from './companion-recovery.mjs';import {inspectNativeExecution} from './companion-native-state.mjs';import {CorporateMcpClient} from './corporate-mcp-client.mjs';import {loadCompanionConfig} from './companion-daemon.mjs';
async function snapshot(path,max=1000000){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>max)throw Error('Invalid private state');return {path,dev:stat.dev,ino:stat.ino,text:await readFile(path,'utf8')};}
async function unchanged(saved){const current=await snapshot(saved.path);if(current.dev!==saved.dev||current.ino!==saved.ino||current.text!==saved.text)throw Error('State changed during recovery');}
/** Release only confirmed stale locks. Never dispatches, resumes or interrupts a model. */
export async function reclaimCompanion(c,{client=new CorporateMcpClient({url:c.url,token:c.token,runtime:true}),readNative=inspectNativeExecution,signal}={}){
 const stat=await lstat(c.stateDir);if(!stat.isDirectory()||(stat.mode&0o077)||await realpath(c.stateDir)!==c.stateDir)throw Error('Private state directory required');
 const guard=await acquireCompanionLock(join(c.stateDir,'recovery.lock'));
 try{
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
  const global=await snapshot(join(c.stateDir,'companion.lock'),2048),scope=await snapshot(join(c.stateDir,'scope.json'));
  const expected=createHash('sha256').update(JSON.stringify([c.url,c.sessionId,c.codexHome])).digest('hex');if(JSON.parse(scope.text).scope!==expected)throw Error('Connection scope mismatch');
  const names=(await readdir(c.stateDir)).sort(),locks=[global],checkpoints=[];
  if(names.filter(n=>n.endsWith('.checkpoint.json')).length>100)throw Error('Recovery requires a smaller reviewed state directory');
  for(const name of names){
   if(name.endsWith('.lock')&&!['companion.lock','recovery.lock'].includes(name)){
    if(!/^[a-f0-9-]{36}\.checkpoint\.json\.lock$/.test(name)||!names.includes(name.slice(0,-5)))throw Error('Unrecognized lock');locks.push(await snapshot(join(c.stateDir,name),2048));
   }
   if(name.endsWith('.checkpoint.json')){const saved=await snapshot(join(c.stateDir,name)),state=JSON.parse(saved.text);if(!['received','claim_pending','claimed','start_pending','running','answered','answer_pending','replied','unknown','terminal'].includes(state.phase)||state.version!==1||state.sessionId!==c.sessionId||name!==state.messageId+'.checkpoint.json'||!['messageId','executionId'].every(k=>/^[a-f0-9-]{36}$/.test(state[k]??''))||!Number.isSafeInteger(state.sequence)||state.sequence<0)throw Error('Checkpoint mismatch');checkpoints.push({...saved,state});}
  }
  for(const saved of locks)if((await inspectCompanionLock(saved.path)).owner!=='process_absent')throw Error('Lock owner is not confirmed absent');
  let pending;try{pending=await snapshot(join(c.stateDir,'native-session-pending.json'));const value=JSON.parse(pending.text);if(value.sessionId!==c.sessionId||!checkpoints.some(s=>s.state.messageId===value.messageId&&s.state.executionId===value.executionId))throw Error('Unmatched native startup');}catch(e){if(e.code!=='ENOENT')throw e;}
  await client.initialize(signal);
  for(const saved of checkpoints){
   const state=saved.state;
   if(state.phase==='received'&&!state.nativeThreadId&&!state.nativeTurnId&&!state.replyRequestId)continue;
   const assessment=await assessFinishedExecution(client,state,signal);
   if(assessment.phase==='terminal'){
    if((await readNative(c,state,{signal})).native!=='terminal_snapshot')throw Error('Native termination unconfirmed');
   }else if(assessment.state!=='ready_to_claim')throw Error('Execution unconfirmed');
  }
  // No local or remote writes above. Revalidate everything before releasing checkpoint locks.
  for(const saved of [scope,...checkpoints,...(pending?[pending]:[]),...locks])await unchanged(saved);
  if(JSON.stringify((await readdir(c.stateDir)).sort())!==JSON.stringify(names))throw Error('State directory changed');
  for(const saved of locks)if((await inspectCompanionLock(saved.path)).owner!=='process_absent')throw Error('Owner state changed');
  signal.throwIfAborted();
  for(const saved of locks.slice(1)){await unchanged(saved);await unlink(saved.path);}
  // Keep the global lock until the very end: a daemon cannot enter midway through recovery.
  await unchanged(global);await unlink(global.path);const directory=await open(c.stateDir,'r');try{await directory.sync();}finally{await directory.close();}
  return {state:'locks_released',locks:locks.length,checkpoints:checkpoints.length,modelStarted:false};
 }finally{await guard.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 try{if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Arguments');console.log(JSON.stringify(await reclaimCompanion(await loadCompanionConfig(resolve(process.argv[3])))));console.log('Подтверждённые блокировки сняты. Исполнитель не запущен. Теперь можно выполнить обычную проверку и запуск панели.');}catch{console.error('Восстановление не подтверждено. Состояние исполнений или владельцев блокировок требует проверки; не удаляйте оставшиеся блокировки вручную.');process.exitCode=1;}
}
