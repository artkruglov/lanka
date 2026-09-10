import {createHash,randomUUID} from 'node:crypto';
import {open,rename,unlink,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {z} from 'zod';
import {LibraryStore} from './library';
import {ChatDatabase,fingerprint,type DbTx} from '../../lib/adapters/postgres/chat-database';
import {canonicalJson} from '../../lib/domain/canonical-json';
import {validateDoc,validateReferences,type DeckDoc} from '../../lib/domain/model';
import {materialPath} from '../../lib/project/package';
import {migrationMarker,readMigration} from '../../lib/project/local-migration';
import {verifyExportManifest} from '../../lib/project/verify-export';
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const timestamp=z.string().refine(v=>Number.isFinite(Date.parse(v)),'Invalid timestamp');
const historySchema=z.array(z.object({revision:z.number().int().positive(),createdAt:timestamp,action:z.string(),hash,dependenciesHash:hash.optional()}));
const receiptsSchema=z.array(z.object({id:uuid,hash,result:z.unknown()}));
const totalLimit=250_000_000;

type Blueprint=Awaited<ReturnType<typeof collect>>;
async function collect(root:string){
 const library=new LibraryStore(root,true),data=await library.read();
 const seen=new Set<string>(),aliases=new Set<string>(),receipts=new Set<string>(),files:{path:string;sha256:string;bytes:number}[]=[];
 let total=0;
 const remembered=new Map<string,string>();
 const remember=(path:string,bytes:Buffer)=>{const digest=sha(bytes),prior=remembered.get(path);if(prior){if(prior!==digest)throw Error('Файл изменился во время проверки переноса.');return;}remembered.set(path,digest);total+=bytes.length;if(total>totalLimit)throw Error('Перенос превышает лимит 250 МБ. Разделите библиотеку перед переносом.');files.push({path,sha256:sha(bytes),bytes:bytes.length});};
 if(new Set(data.folders.map(f=>f.id)).size!==data.folders.length)throw Error('Повторяются ID папок.');
 if(new Set(data.receipts.map(r=>r.id)).size!==data.receipts.length)throw Error('Повторяются ключи операций библиотеки.');
 for(const r of data.receipts)JSON.parse(r.payload);
 const documents=[];
 for(const entry of [...data.documents].sort((a,b)=>a.id.localeCompare(b.id))){
  if(aliases.has(entry.id))throw Error('Повторяется ID документа в библиотеке.');aliases.add(entry.id);timestamp.parse(entry.createdAt);
  if(entry.folderId&&!data.folders.some(f=>f.id===entry.folderId))throw Error('Документ ссылается на отсутствующую папку.');
  const store=await library.project(entry.id,true),raw=await store.readFile('project.json',1_500_000);remember(`${entry.id}/project.json`,raw);
  const p=await store.read();if(!p)throw Error('В библиотеке есть ещё не созданный документ.');uuid.parse(p.state.doc.id);
  if(seen.has(p.state.doc.id))throw Error('Два файловых документа имеют один внутренний ID. Требуется явное решение о копиях.');seen.add(p.state.doc.id);
  if(p.state.grants.length||p.state.approvedRevision!==null||p.state.approvedBy!==null)throw Error('Права или согласование файлового документа требуют отдельного решения; перенос не выдаёт полномочия.');
  receiptsSchema.parse(p.receipts);
  for(const r of p.receipts){if(receipts.has(r.id))throw Error('Повторяются ключи операций разных документов.');receipts.add(r.id);}
  for(const proposal of p.state.proposals)for(const change of proposal.changes)for(const slide of [change.before,change.after])if(slide){const doc=validateDoc({...p.state.doc,slides:[slide]});validateReferences({...p.state,doc});}
  const archives=[];
  const revisions:{dependenciesHash?:string;revision:number;doc:DeckDoc;sourceHash:string;hash:string;action:string;createdAt:string}[]=[];
  for(const h of historySchema.parse(p.history??[])){
   if(revisions.some(r=>r.revision===h.revision)||h.revision>p.state.revision)throw Error('Неверная история версий.');
   const bytes=await store.readFile(`revisions/${h.hash}.json`,1_500_000);remember(`${entry.id}/revisions/${h.hash}.json`,bytes);
   const doc=await store.readSnapshot(h.hash);if(doc.id!==p.state.doc.id)throw Error('История относится к другому документу.');
   if(h.dependenciesHash){
    const archive=await store.readRevisionDependencies(h.revision),blobs=[];
    remember(`${entry.id}/revision-sources/${archive.hash}.json`,archive.bytes);
    for(const file of archive.snapshot.files){const bytes=await archive.read(file.sha256);remember(`${entry.id}/revision-files/${file.sha256}.bin`,bytes);blobs.push({hash:file.sha256,bytes});}
    archives.push({snapshot:archive.snapshot,bytes:archive.bytes,hash:archive.hash,blobs});
   }else validateReferences({...p.state,doc});
   revisions.push({...h,doc,sourceHash:h.hash,hash:fingerprint(doc)});
  }
  const current=revisions.find(r=>r.revision===p.state.revision);
  if(current&&current.hash!==fingerprint(p.state.doc))throw Error('Текущая версия расходится с историей.');
  if(!current)revisions.push({revision:p.state.revision,doc:p.state.doc,sourceHash:sha(JSON.stringify(p.state.doc)),hash:fingerprint(p.state.doc),createdAt:entry.createdAt,action:'Импортирована существующая версия'});
  const materials=[];
  for(const s of p.state.sources){const bytes=await store.readFile(materialPath(s.sha256));if(sha(bytes)!==s.sha256)throw Error('Повреждён исходный материал.');remember(`${entry.id}/${materialPath(s.sha256)}`,bytes);materials.push({key:materialPath(s.sha256),bytes});}
  const artifacts=[];let cursor:string|undefined;
  do{const page=await store.listExportArtifacts(cursor);for(const item of page.items){const manifest=verifyExportManifest(await store.readExportManifest(item.id),p.state.doc.id,item.id),bytes=await store.readExportArtifact(item.id);if(!revisions.some(r=>r.revision===manifest.revision&&r.hash===manifest.documentHash))throw Error('Исходная версия экспорта отсутствует в истории.');remember(`${entry.id}/exports/${item.id}/manifest.json`,Buffer.from(JSON.stringify(manifest)));remember(`${entry.id}/exports/${item.id}/presentation.${manifest.output.format}`,bytes);artifacts.push({manifest,bytes});}cursor=page.nextCursor??undefined;}while(cursor);
  const legacyExports=[];
  for(const name of ['presentation.pdf','presentation.pptx','lanka-handoff.json']){
   const dir=join(store.root,'exports'),path=join(dir,name);let f;
   try{if(await realpath(dir)!==dir)throw Error('Linked exports are not allowed');f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   try{const stat=await f.stat();if(!stat.isFile()||stat.size>40_000_000)throw Error('Старый экспорт превышает лимит.');const bytes=await f.readFile();remember(`${entry.id}/exports/${name}`,bytes);legacyExports.push({name,bytes});}finally{await f.close();}
  }
  documents.push({entry,project:p,revisions,materials,artifacts,legacyExports,archives});
 }
 for(const d of documents)if(d.entry.id!==d.project.state.doc.id&&seen.has(d.entry.id))throw Error('Адрес одного документа совпадает с внутренним ID другого.');
 const sourceHash=sha(canonicalJson({catalog:data,files}));
 return {data,documents,sourceHash,total,files};
}
function report(b:Blueprint){return {format:'lanka-library-migration-report/v1',sourceHash:b.sourceHash,bytes:b.total,folders:b.data.folders.length,documents:b.documents.map(d=>({libraryId:d.entry.id,documentId:d.project.state.doc.id,title:d.project.title,revision:d.project.state.revision,history:d.revisions.length,archivedRevisions:d.archives.length,revisionMapping:d.revisions.map(r=>({revision:r.revision,sourceHash:r.sourceHash,targetHash:r.hash})),comments:d.project.state.comments.length,proposals:d.project.state.proposals.length,sources:d.materials.length,exports:d.artifacts.length,legacyExports:d.legacyExports.length,trashed:d.entry.trashed})),permissions:'owner-only; no grants or approval imported'};}
async function checkTarget(db:ChatDatabase,b:Blueprint,c:DbTx|typeof db.pool=db.pool){
 const ids=[...new Set(b.documents.flatMap(d=>[d.entry.id,d.project.state.doc.id]))];
 if(ids.length){const conflicts=await c.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=ANY($2::uuid[]) UNION ALL SELECT 1 FROM lanka.material_aliases WHERE tenant_id=$1 AND alias_id=ANY($2::uuid[]) LIMIT 1',[db.tenant,ids]);if(conflicts.rowCount)throw Error('ID импортируемого документа уже существует в целевой базе.');}
 const folderIds=b.data.folders.map(f=>f.id);
 const dangling=await c.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND folder_id IS NOT NULL AND NOT(folder_id=ANY($3::uuid[])) LIMIT 1',[db.tenant,db.owner,folderIds]);if(dangling.rowCount)throw Error('Существующий серверный документ ссылается на неизвестную папку.');
 const keys=b.documents.flatMap(d=>d.project.receipts.map(r=>r.id));
 const used=await c.query('SELECT request_id FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=ANY($3::uuid[])',[db.tenant,db.owner,[...keys,...b.data.receipts.map(r=>r.id)]]);if(used.rowCount)throw Error('Ключ операции файловой библиотеки уже использован на сервере.');
}
export async function inspectLibraryMigration(db:ChatDatabase,root:string){
 const b=await collect(root),existing=await db.catalogInfo();
 if(existing){if(existing.source_root!==root||existing.source_hash!==b.sourceHash)throw Error('Серверный каталог уже относится к другому переносу.');return {...existing.report,status:'committed'};}
 await checkTarget(db,b);return {...report(b),status:'ready'};
}
async function writeMarker(root:string,value:unknown){
 const tmp=join(root,`migration-${randomUUID()}.tmp`),f=await open(tmp,'wx',0o600);
 try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
 try{await rename(tmp,join(root,migrationMarker));const dir=await open(root,'r');try{await dir.sync();}finally{await dir.close();}}finally{await unlink(tmp).catch(()=>{});}
}
export async function migrateLibrary(db:ChatDatabase,root:string,expectedHash:string,options:{afterCommit?:()=>Promise<void>}={}){
 const targetHash=sha(canonicalJson({host:db.options.connection.host,port:db.options.connection.port,database:db.options.connection.database,tenantId:db.tenant,ownerId:db.owner}));
 hash.parse(expectedHash);const library=new LibraryStore(root,true);await library.init();
 const locks:{file:Awaited<ReturnType<typeof open>>;path:string}[]=[];let frozen=false;
 const markerAtStart=await readMigration(root);
 if(markerAtStart&&(markerAtStart.targetHash!==targetHash||markerAtStart.sourceHash!==expectedHash||markerAtStart.tenantId!==db.tenant||markerAtStart.ownerId!==db.owner))throw Error('Перенос зафиксирован для другой базы или версии.');
 frozen=!!markerAtStart;
 const lock=async(path:string)=>{
  let file;try{file=await open(path,'wx',0o600);}catch(error){
   if((error as NodeJS.ErrnoException).code==='EEXIST'&&path!==join(root,'migration.lock')&&markerAtStart){
    const held=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if((await held.stat()).size<2000){const record=JSON.parse(await held.readFile('utf8'));if(record.purpose==='library-migration-barrier'&&record.targetHash===targetHash&&record.sourceHash===expectedHash&&record.tenantId===db.tenant&&record.ownerId===db.owner)return;}}finally{await held.close();}
   }
   throw Error('Библиотека или документ занят. Перенос не начат; существующие lock-файлы не удаляются.');
  }
  locks.push({file,path});await file.writeFile(JSON.stringify({pid:process.pid,purpose:'library-migration'}));await file.sync();const parent=await open(dirname(path),'r');try{await parent.sync();}finally{await parent.close();}
 };
 try{
  await lock(join(root,'migration.lock'));
  await lock(join(root,'library.lock'));
  const data=await library.read();
  for(const entry of [...data.documents].sort((a,b)=>a.id.localeCompare(b.id))){const store=await library.project(entry.id,true);await lock(join(store.root,'write.lock'));}
  const previous=await db.catalogInfo();
  if(previous){if(previous.source_hash!==expectedHash||previous.source_root!==root)throw Error('Серверный каталог уже относится к другому переносу.');frozen=true;await writeMarker(root,{format:'lanka-library-migration/v1',phase:'committed',sourceHash:expectedHash,targetHash,migrationId:previous.migration_id,tenantId:db.tenant,ownerId:db.owner});return {...previous.report,status:'committed',replayed:true};}
  const b=await collect(root);if(b.sourceHash!==expectedHash)throw Error('Исходная библиотека изменилась. Повторите предварительную проверку.');
  const marker=markerAtStart;
  const migrationId=marker?.migrationId??randomUUID();const result={...report(b),migrationId,legacyExportMapping:[] as {documentId:string;sourcePath:string;key:string}[]};
  await db.tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[db.tenant+':material-ids']);
   await checkTarget(db,b,c);
   const jobs=await c.query("SELECT 1 FROM lanka.jobs j JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id WHERE j.tenant_id=$1 AND s.owner_id=$2 AND j.status IN ('queued','running','unknown') LIMIT 1",[db.tenant,db.owner]);if(jobs.rowCount)throw Error('На сервере есть незавершённое поручение. Дождитесь его результата перед переносом.');
   frozen=true;await writeMarker(root,{format:'lanka-library-migration/v1',phase:'frozen',sourceHash:expectedHash,targetHash,migrationId,tenantId:db.tenant,ownerId:db.owner});
   await c.query('INSERT INTO lanka.workspace_catalogs(tenant_id,owner_id,source_root,migration_id,source_hash,report) VALUES($1,$2,$3,$4,$5,$6)',[db.tenant,db.owner,root,migrationId,expectedHash,JSON.stringify(result)]);
   for(const f of b.data.folders)await c.query('INSERT INTO lanka.catalog_folders(tenant_id,owner_id,id,name) VALUES($1,$2,$3,$4)',[db.tenant,db.owner,f.id,f.name]);
   for(const d of b.documents){
    const p=structuredClone(d.project),id=p.state.doc.id;p.receipts=[];p.history=d.revisions.sort((a,b)=>a.revision-b.revision).map(({doc,sourceHash,...h})=>h);
    await c.query('INSERT INTO lanka.materials(tenant_id,id,owner_id,project,folder_id,trashed,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[db.tenant,id,db.owner,JSON.stringify(p),d.entry.folderId,d.entry.trashed,d.entry.createdAt]);
    for(const r of d.revisions)await c.query('INSERT INTO lanka.material_revisions(tenant_id,material_id,revision,hash,doc,action,created_at,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[db.tenant,id,r.revision,r.hash,JSON.stringify(r.doc),r.action,r.createdAt,r.sourceHash]);
    for(const archive of d.archives){
     for(const b of archive.blobs)await c.query('INSERT INTO lanka.revision_dependency_blobs(tenant_id,material_id,hash,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[db.tenant,id,b.hash,b.bytes]);
     await c.query('INSERT INTO lanka.revision_dependency_snapshots(tenant_id,material_id,revision,document_hash,payload,bytes,hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[db.tenant,id,archive.snapshot.revision,archive.snapshot.documentHash,JSON.stringify(archive.snapshot),archive.bytes,archive.hash]);
    }
    for(const m of d.materials)await c.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[db.tenant,id,m.key,m.bytes]);
    for(const a of d.artifacts)await c.query('INSERT INTO lanka.export_artifacts(tenant_id,material_id,id,created_at,manifest,bytes) VALUES($1,$2,$3,$4,$5,$6)',[db.tenant,id,a.manifest.id,a.manifest.createdAt,JSON.stringify(a.manifest),a.bytes]);
    for(const a of d.legacyExports){const key=`exports/${randomUUID()}/${a.name}`;await c.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4)',[db.tenant,id,key,a.bytes]);result.legacyExportMapping.push({documentId:id,sourcePath:`documents/${d.entry.id}/exports/${a.name}`,key});}
    if(d.entry.id!==id)await c.query('INSERT INTO lanka.material_aliases(tenant_id,owner_id,alias_id,material_id) VALUES($1,$2,$3,$4)',[db.tenant,db.owner,d.entry.id,id]);
    for(const r of d.project.receipts)await c.query('INSERT INTO lanka.imported_project_receipts(tenant_id,owner_id,material_id,request_id,source_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[db.tenant,db.owner,id,r.id,r.hash,JSON.stringify(r.result??null)]);
   }
   for(const r of b.data.receipts)await c.query('INSERT INTO lanka.catalog_receipts(tenant_id,owner_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[db.tenant,db.owner,r.id,fingerprint(JSON.parse(r.payload)),JSON.stringify(r.result??null)]);
   await c.query('UPDATE lanka.workspace_catalogs SET report=$3 WHERE tenant_id=$1 AND owner_id=$2',[db.tenant,db.owner,JSON.stringify(result)]);
  });
  await options.afterCommit?.();
  await writeMarker(root,{format:'lanka-library-migration/v1',phase:'committed',sourceHash:expectedHash,targetHash,migrationId,tenantId:db.tenant,ownerId:db.owner});
  return {...result,status:'committed',replayed:false};
 }finally{for(const {file,path} of locks.reverse()){
   if(frozen&&path!==join(root,'migration.lock')){
    const bytes=Buffer.from(JSON.stringify({purpose:'library-migration-barrier',sourceHash:expectedHash,targetHash,tenantId:db.tenant,ownerId:db.owner}));
    try{await file.write(bytes,0,bytes.length,0);await file.truncate(bytes.length);await file.sync();}finally{await file.close();}
   }else{await file.close();await unlink(path);}
  }}
}
