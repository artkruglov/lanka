import {inspectNativeExecution} from './companion-native-state.mjs';
import {assessFinishedExecution} from './companion-recovery.mjs';
import {CorporateMcpClient} from './corporate-mcp-client.mjs';
import {resolve,join} from 'node:path';import {lstat,readdir,realpath,readFile} from 'node:fs/promises';
import {loadCompanionConfig} from './companion-daemon.mjs';import {inspectCompanionLock} from './companion-locks.mjs';
export async function inspectCompanion(c,{remote=false,native=false,client,signal,readNative=inspectNativeExecution}={}){
 try{const stat=await lstat(c.stateDir);if(!stat.isDirectory()||(stat.mode&0o077)||await realpath(c.stateDir)!==c.stateDir)throw Error('Private state directory required');}catch(e){if(e.code==='ENOENT')return {stateExists:false,locks:[],nativeExecution:'not_checked'};throw e;}
 const names=(await readdir(c.stateDir)).filter(n=>n==='companion.lock'||/^[a-f0-9-]{36}\.checkpoint\.json\.lock$/.test(n)).sort();if(names.length>1000)throw Error('Too many locks');
 const locks=[];for(const name of names)locks.push({name,...await inspectCompanionLock(join(c.stateDir,name))});
 const result={stateExists:true,locks,nativeExecution:'not_checked'};
 if(!remote)return result;
 signal=signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000);
 client??=new CorporateMcpClient({url:c.url,token:c.token,runtime:true});await client.initialize(signal);
 const files=(await readdir(c.stateDir)).filter(n=>/^[a-f0-9-]{36}\.checkpoint\.json$/.test(n)).sort();const assessments=[];
 // This is a bounded report, never permission to remove a lock or restart an execution.
 for(const name of files.slice(0,20)){
  const path=join(c.stateDir,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>1000000)throw Error('Invalid checkpoint');
  const original=await readFile(path,'utf8'),state=JSON.parse(original);
  if(!['received','claim_pending','claimed','start_pending','running','answered','answer_pending','replied','unknown','terminal'].includes(state.phase)||state.version!==1||state.sessionId!==c.sessionId||name!==state.messageId+'.checkpoint.json'||!Number.isSafeInteger(state.sequence)||state.sequence<0||!['sessionId','messageId','executionId'].every(k=>/^[a-f0-9-]{36}$/.test(state[k]??'')))throw Error('Checkpoint mismatch');
  let assessment='unconfirmed';try{assessment=(await assessFinishedExecution(client,state,signal)).state;}catch{if(signal?.aborted)throw Error('Interrupted');}
  const nativeReport=native?await readNative(c,state,{signal}):undefined;
  if(await readFile(path,'utf8')!==original){assessment='checkpoint_changed';if(nativeReport)nativeReport.native='unconfirmed';}
  assessments.push({messageId:state.messageId,localPhase:state.phase,assessment,...nativeReport});
 }
 return {...result,assessments,truncated:files.length>20,nativeExecution:native?'read_snapshots_only':'server_report_only'};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 try{if(![4,5,6].includes(process.argv.length)||process.argv[2]!=='--config'||process.argv.length>=5&&process.argv[4]!=='--server'||process.argv.length===6&&process.argv[5]!=='--native')throw Error('Arguments');const result=await inspectCompanion(await loadCompanionConfig(resolve(process.argv[3])),{remote:process.argv[4]==='--server',native:process.argv[5]==='--native'});console.log(JSON.stringify(result,null,2));console.log('process_exists означает только наличие PID: он мог использоваться повторно. process_absent не подтверждает остановку модели. Диагностика не удаляет блокировки и не запускает поручения.');}catch{console.error('Не удалось проверить состояние. Проверьте конфигурацию, права приватного каталога и доступ к Lanka при --server.');process.exitCode=1;}
}
