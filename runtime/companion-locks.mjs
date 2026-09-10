import {open,lstat,readFile,unlink} from 'node:fs/promises';import {hostname} from 'node:os';import {randomUUID} from 'node:crypto';
/** Ownership metadata is diagnostic; it never authorizes stale-lock takeover. */
export async function acquireCompanionLock(path){
 const file=await open(path,'wx',0o600),identity=await file.stat();let closed=false;
 const close=async()=>{if(closed)return;closed=true;await file.close();try{const current=await lstat(path);if(current.dev===identity.dev&&current.ino===identity.ino)await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}};
 try{await file.writeFile(JSON.stringify({version:1,pid:process.pid,host:hostname(),instanceId:randomUUID(),createdAt:new Date().toISOString()})+'\n');await file.sync();return {close};}catch(error){await close();throw error;}
}
export async function inspectCompanionLock(path,{probe=pid=>process.kill(pid,0),host=hostname()}={}){
 let stat;try{stat=await lstat(path);}catch(e){if(e.code==='ENOENT')return {present:false};throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.size>2048)return {present:true,owner:'unknown'};
 let record;try{record=JSON.parse(await readFile(path,'utf8'));}catch{return {present:true,owner:'unknown'};}
 if(record?.version!==1||!Number.isSafeInteger(record.pid)||record.pid<=0||record.pid>2147483647||typeof record.host!=='string'||!Number.isFinite(Date.parse(record.createdAt))||typeof record.instanceId!=='string')return {present:true,owner:'unknown'};
 if(record.host!==host)return {present:true,owner:'another_host'};
 let owner='process_exists';try{probe(record.pid);}catch(e){owner=e.code==='ESRCH'?'process_absent':'unknown';}
 return {present:true,owner,pid:record.pid,createdAt:record.createdAt};
}
