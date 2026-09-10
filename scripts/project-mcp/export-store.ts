import {mkdir,open,realpath,rename,rm,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {canonicalJson} from '../../lib/domain/canonical-json';
import {exportId,exportSummary,type ExportManifest} from '../../lib/project/export-artifact';
import {verifyExportManifest,verifyExportBytes,exportHash} from '../../lib/project/verify-export';
import type {ProjectStore} from './store';

async function directory(store:ProjectStore,create=false){
 await store.checkRoot();const dir=join(store.root,'exports');
 if(create)await mkdir(dir,{recursive:true});
 if(await realpath(dir)!==dir)throw Error('Linked exports are not allowed');return dir;
}
async function readPart(store:ProjectStore,id:string,name:string,max:number){
 const dir=join(await directory(store),exportId(id));
 if(await realpath(dir)!==dir)throw Error('Linked exports are not allowed');
 const file=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>max)throw Error('Export file exceeds limit');return await file.readFile();}finally{await file.close();}
}
export async function readManifest(store:ProjectStore,id:string){
 const p=await store.read();if(!p)throw Error('Project is empty');
 return verifyExportManifest(JSON.parse((await readPart(store,id,'manifest.json',3_000_000)).toString('utf8')),p.state.doc.id,id);
}
export async function readArtifact(store:ProjectStore,id:string){
 const m=await readManifest(store,id),bytes=await readPart(store,id,`presentation.${m.output.format}`,40_000_000);
 verifyExportBytes(m,bytes);return bytes;
}
export async function listArtifacts(store:ProjectStore,cursor?:string){
 if(!await store.read())throw Error('Project is empty');if(cursor)exportId(cursor);
 let names:string[];try{names=await readdir(await directory(store));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {items:[],nextCursor:null};throw e;}
 const entries=[];
 for(const name of names)if(/^[a-f0-9-]{36}$/.test(name))entries.push(exportSummary(await readManifest(store,name)));
 entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const start=cursor?entries.findIndex(e=>e.id===cursor)+1:0;
 if(cursor&&!start)return {items:[],nextCursor:null};
 const items=entries.slice(start,start+25);return {items,nextCursor:start+25<entries.length?items.at(-1)!.id:null};
}
export async function saveArtifact(store:ProjectStore,value:ExportManifest,bytes:Uint8Array){
 return store.exclusiveWrite(()=>saveLocked(store,value,bytes));
}
async function saveLocked(store:ProjectStore,value:ExportManifest,bytes:Uint8Array){
 const p=await store.read();if(!p)throw Error('Project is empty');
 const m=verifyExportManifest(value,p.state.doc.id);verifyExportBytes(m,bytes);
 const entry=p.history?.find(e=>e.revision===m.revision);
 const snapshot=entry?await store.readSnapshot(entry.hash):p.state.revision===m.revision?p.state.doc:null;
 if(!snapshot||exportHash(canonicalJson(snapshot))!==m.documentHash)throw Error('Исходная версия экспорта недоступна.');
 const dir=await directory(store,true),pending=join(dir,`pending-${m.id}`),target=join(dir,m.id);
 await mkdir(pending,{mode:0o700});
 try{
  for(const [name,data] of [['manifest.json',Buffer.from(JSON.stringify(m))],[`presentation.${m.output.format}`,bytes]] as const){
   const file=await open(join(pending,name),'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}
  }
  const contents=await open(pending,'r');try{await contents.sync();}finally{await contents.close();}
  // A non-empty existing artifact directory makes rename fail; committed versions are never replaced.
  await rename(pending,target);
  const parent=await open(dir,'r');try{await parent.sync();}finally{await parent.close();}
  return join(target,`presentation.${m.output.format}`);
 }finally{await rm(pending,{recursive:true,force:true});}
}
