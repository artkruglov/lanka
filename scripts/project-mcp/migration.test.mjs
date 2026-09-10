import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import sharp from 'sharp';
import {ProjectClient} from './client.mjs';
await build({stdin:{contents:`export {ChatDatabase} from './lib/adapters/postgres/chat-database'; export {ChatService} from './lib/agents/chat-service'; export {LibraryStore} from './scripts/project-mcp/library'; export {LocalWorkspace} from './scripts/project-mcp/workspace'; export {ProjectStore} from './scripts/project-mcp/store'; export {inspectLibraryMigration,migrateLibrary} from './scripts/project-mcp/migrate-library'; export {humanCommand} from './scripts/project-mcp/human'; export {invokeProjectTool} from './scripts/project-mcp/tools'; export {fromMarkdown} from './lib/domain/intake'; export {renderProjectExport} from './scripts/project-mcp/export';`,resolveDir:process.cwd()},outfile:'.project-runtime/migration-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {ChatDatabase,ChatService,LibraryStore,LocalWorkspace,ProjectStore,inspectLibraryMigration,migrateLibrary,humanCommand,invokeProjectTool,fromMarkdown,renderProjectExport}=await import('../../.project-runtime/migration-test.mjs');
const installed=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
async function fixture(t,{rich=false}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-migration-'))),config={...installed,workspaceRoot:root,runtimeRoot:join(root,'runtime'),tenantId:randomUUID(),ownerId:randomUUID()},configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const db=new ChatDatabase(config);await db.init();
 const clients=[],workers=[];t.after(async()=>{clients.forEach(c=>c.close());workers.forEach(w=>w.kill());for(const table of ['agent_events','agent_runs','jobs','agent_messages','agent_sessions','command_receipts','blobs','material_revisions','materials','agent_connections','catalog_receipts','catalog_folders','workspace_catalogs'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);await db.close();await rm(root,{recursive:true,force:true});});
 const library=new LibraryStore(root);await library.init();const folderId=randomUUID(),alias=randomUUID();
 await library.mutate({requestId:folderId,command:{action:'create_folder',name:'Команда'}});
 const creation={requestId:alias,command:{action:'create_document',title:'Старое название в каталоге',folderId,markdown:'# Рабочая встреча\n\n## Решение команды\nОбсудить план и распределить задачи.'}};await library.mutate(creation);const store=await library.project(alias),p=await store.read(),id=p.state.doc.id;
 const request={requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'save',doc:{...p.state.doc,title:'Обновлённое название'}}};await humanCommand(store,request);
 let exported;
 if(rich){
  await invokeProjectTool(store,'register_source',{requestId:randomUUID(),deckId:id,expectedRevision:2,name:'Исходный план.txt',contentType:'text/plain',base64:Buffer.from('Учебный план командной встречи').toString('base64')});
  const jpeg=await sharp({create:{width:32,height:18,channels:3,background:'#4164da'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  await invokeProjectTool(store,'register_source',{requestId:randomUUID(),deckId:id,expectedRevision:2,name:'Поворот.jpeg',contentType:'image/jpeg',base64:jpeg.toString('base64')});
  const saved=await store.read();await humanCommand(store,{requestId:randomUUID(),deckId:id,expectedRevision:2,command:{action:'comment',slideId:saved.state.doc.slides[0].id,text:'Уточнить порядок обсуждения'}});
  await invokeProjectTool(store,'propose_commands',{requestId:randomUUID(),deckId:id,expectedRevision:2,title:'Более ясный заголовок',commands:[{op:'set_title',slideId:saved.state.doc.slides[0].id,value:'Совместное решение'}]});
  exported=await renderProjectExport(store,await store.read(),'pdf');await store.writeExport('presentation.pdf',exported.bytes);
 }
 const native=fromMarkdown('# Серверный документ\n\n## Его история\nЭтот документ уже хранится в базе.');native.id=randomUUID();await db.create(randomUUID(),native,folderId);
 const service=new ChatService(db);await service.setEnabled(true);const sessionId=await db.ensureSession(native.id);await service.enqueue(sessionId,{requestId:randomUUID(),text:'Проверка истории беседы',mode:'discuss',expectedRevision:1,selection:{slideId:native.slides[0].id,field:null,scope:'slide'}});const view=await service.view(sessionId);await service.cancel(sessionId,(await db.pool.query('SELECT id FROM lanka.jobs WHERE tenant_id=$1',[db.tenant])).rows[0].id,randomUUID());
 const before=await store.read(),raw=await readFile(join(store.root,'project.json'),'utf8');

 return {root,config,configPath,db,library,store,folderId,alias,id,request,creation,before,raw,exported,native,service,sessionId,clients,workers};
}
async function web(f){
 const worker=spawn(process.execPath,[resolve('.project-runtime/web.mjs'),'--workspace',f.root,'--chat-config',f.configPath,'--port','0'],{stdio:['ignore','pipe','pipe']});f.workers.push(worker);
 const origin=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('Editor startup timeout')),10000);worker.once('exit',()=>{clearTimeout(timer);no(Error('Editor stopped'));});worker.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);yes(m[0]);}});});
 const landing=await fetch(origin),headers={Cookie:landing.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
 return {origin,headers,get:async path=>{const r=await fetch(origin+path,{headers});assert.equal(r.status,200);return r.json();}};
}
test('migration preserves file content/history/review/export and existing PG chat, then routes old links to one writable document',async t=>{
 const f=await fixture(t,{rich:true}),chat=await f.service.view(f.sessionId),native=await f.db.repository(f.native.id).read();
 const checked=await inspectLibraryMigration(f.db,f.root);assert.equal(checked.status,'ready');assert.equal(checked.documents[0].history,2);assert.equal((await f.db.listing()).length,1);assert.equal(await readFile(join(f.store.root,'project.json'),'utf8'),f.raw);
 const result=await migrateLibrary(f.db,f.root,checked.sourceHash);assert.equal(result.status,'committed');assert.equal(result.documents[0].documentId,f.id);assert.notEqual(f.alias,f.id);
 await assert.rejects(f.db.create(randomUUID(),{...f.before.state.doc,id:f.alias}),/старой ссылкой/);
 const target=f.db.repository(f.id),saved=await target.read();assert.deepEqual(saved.state,f.before.state);assert.deepEqual(saved.history.map(h=>({revision:h.revision,action:h.action,createdAt:h.createdAt})),f.before.history.map(h=>({revision:h.revision,action:h.action,createdAt:h.createdAt})));
 for(const h of f.before.history)assert.deepEqual(await target.readSnapshot(h.hash),await new ProjectStore(f.store.root,true).readSnapshot(h.hash));
 for(let i=0;i<saved.history.length;i++)assert.deepEqual(await target.readSnapshot(saved.history[i].hash),await new ProjectStore(f.store.root,true).readSnapshot(f.before.history[i].hash));
 for(const source of f.before.state.sources)assert.deepEqual(await target.readFile('materials/'+source.sha256+'.bin'),await readFile(join(f.store.root,'materials',source.sha256+'.bin')));assert.ok(saved.state.sources.some(s=>s.image?.normalizedSourceId));assert.ok(saved.state.sources.some(s=>s.image?.originalSourceId));
 assert.deepEqual(await target.readExportArtifact(f.exported.artifactId),Buffer.from(f.exported.bytes));assert.deepEqual(await target.readExportManifest(f.exported.artifactId),f.exported.manifest);
 assert.deepEqual(await target.readExport(result.legacyExportMapping[0].key),Buffer.from(f.exported.bytes));
 assert.deepEqual(await f.service.view(f.sessionId),chat);assert.deepEqual(await f.db.repository(f.native.id).read(),native);
 assert.equal(JSON.parse(await readFile(join(f.store.root,'write.lock'),'utf8')).purpose,'library-migration-barrier');assert.equal(JSON.parse(await readFile(join(f.root,'library.lock'),'utf8')).purpose,'library-migration-barrier');
 assert.equal(await readFile(join(f.store.root,'project.json'),'utf8'),f.raw);await assert.rejects(f.store.read(),/перенесена/);await assert.rejects(f.library.mutate({requestId:randomUUID(),command:{action:'create_folder',name:'Cannot write'}}),/перенесена/);
 await humanCommand(target,f.request);assert.deepEqual((await target.read()).state,f.before.state); // original receipt replay after cutover
 const workspace=new LocalWorkspace(f.library,f.db);assert.deepEqual(await workspace.mutate(f.creation),{id:f.alias});assert.equal((await workspace.listing()).documents.length,2);
 const c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath});f.clients.push(c);assert.equal((await c.tool('lanka_list_folders')).folders[0].id,f.folderId);
 assert.equal((await c.tool('lanka_get_material',{materialId:f.alias})).state.doc.id,f.id);
 const folder=await c.tool('lanka_create_folder',{requestId:randomUUID(),name:'Новая папка'});await c.tool('lanka_move_material',{requestId:randomUUID(),materialId:f.alias,folderId:folder.id});assert.equal((await f.db.listing()).find(d=>d.id===f.id).folderId,folder.id);
 const app=await web(f),redirect=await fetch(app.origin+`/documents/${f.alias}?chat`,{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),`/documents/${f.id}?chat`);
 assert.equal((await app.get(`/api/project?documentId=${f.alias}`)).state.doc.id,f.id);assert.equal((await app.get('/api/library')).folders.length,2);
 const session=await fetch(app.origin+`/api/v1/materials/${f.alias}/agent-sessions`,{method:'POST',headers:app.headers,body:'{}'});assert.equal(session.status,200);const {sessionId}=await session.json();assert.equal((await f.db.session(f.db.pool,sessionId)).material_id,f.id);assert.equal((await f.service.view(sessionId)).messages.length,0);assert.equal((await f.db.listing()).length,2);
 const fresh=await target.read();await humanCommand(target,{requestId:randomUUID(),deckId:f.id,expectedRevision:2,command:{action:'save',doc:{...fresh.state.doc,title:'После переноса'}}});
 assert.equal((await migrateLibrary(f.db,f.root,checked.sourceHash)).replayed,true);assert.equal((await target.read()).state.doc.title,'После переноса');assert.equal((await f.db.listing()).length,2);
});
test('changed input and occupied source locks fail before freeze; owned locks and data are preserved',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root);await f.library.mutate({requestId:randomUUID(),command:{action:'rename_folder',id:f.folderId,name:'Переименована'}});
 await assert.rejects(migrateLibrary(f.db,f.root,checked.sourceHash),/изменилась/);await assert.rejects(access(join(f.root,'lanka-migration.json')));assert.equal(await f.db.catalogInfo(),null);
 const current=await inspectLibraryMigration(f.db,f.root);await writeFile(join(f.store.root,'write.lock'),'user-owned lock');await assert.rejects(migrateLibrary(f.db,f.root,current.sourceHash),/занят/);assert.equal(await readFile(join(f.store.root,'write.lock'),'utf8'),'user-owned lock');await assert.rejects(access(join(f.root,'library.lock')));
});
test('lost acknowledgement after PG commit leaves source frozen; retry completes the marker without overwriting target edits',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root);
 await assert.rejects(migrateLibrary(f.db,f.root,checked.sourceHash,{afterCommit:async()=>{throw Error('Lost acknowledgement');}}),/Lost acknowledgement/);
 assert.equal(JSON.parse(await readFile(join(f.root,'lanka-migration.json'),'utf8')).phase,'frozen');assert.ok(await f.db.catalogInfo());await assert.rejects(f.store.writeExport('presentation.pdf',Buffer.from('x')),/перенесена/);
 const target=f.db.repository(f.id),p=await target.read();await humanCommand(target,{requestId:randomUUID(),deckId:f.id,expectedRevision:2,command:{action:'save',doc:{...p.state.doc,title:'Сохранено после обрыва'}}});
 assert.equal((await migrateLibrary(f.db,f.root,checked.sourceHash)).replayed,true);assert.equal(JSON.parse(await readFile(join(f.root,'lanka-migration.json'),'utf8')).phase,'committed');assert.equal((await target.read()).state.doc.title,'Сохранено после обрыва');
});
test('server folders validate owner/tenant and reject unavailable folder IDs transactionally',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root);await migrateLibrary(f.db,f.root,checked.sourceHash);
 const args={requestId:randomUUID(),command:{action:'create_folder',name:'Повторяемая папка'}},workspace=new LocalWorkspace(f.library,f.db);
 assert.deepEqual(await workspace.mutate(args),await workspace.mutate(args));await assert.rejects(workspace.mutate({...args,command:{...args.command,name:'Подмена'}}),/Ключ повтора/);
 const before=await f.db.repository(f.id).read();await assert.rejects(f.db.catalogCommand(randomUUID(),f.id,{action:'move_document',folderId:randomUUID()}),/Папка недоступна/);assert.deepEqual(await f.db.repository(f.id).read(),before);
 for(const scope of [{tenantId:randomUUID()},{ownerId:randomUUID()}]){const other=new ChatDatabase({...f.config,...scope});try{assert.deepEqual(await other.catalogFolders(),[]);assert.equal(await other.resolveMaterialId(f.alias),f.alias);await assert.rejects(other.mutateFolder(randomUUID(),{action:'rename_folder',id:f.folderId,name:'Чужое'}),/не настроен/);await assert.rejects(other.repository(f.id).read(),/недоступен/);}finally{await other.close();}}
});

test('transaction failure leaves no partial target and freezes source until an exact retry succeeds',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root),transaction=f.db.tx.bind(f.db);
 f.db.tx=fn=>transaction(async c=>{await fn(c);throw Error('Injected pre-commit failure');});
 await assert.rejects(migrateLibrary(f.db,f.root,checked.sourceHash),/pre-commit/);assert.equal(await f.db.catalogInfo(),null);assert.equal((await f.db.listing()).length,1);await assert.rejects(f.store.read(),/перенесена/);
 f.db.tx=transaction;assert.equal((await migrateLibrary(f.db,f.root,checked.sourceHash)).status,'committed');assert.equal((await f.db.listing()).length,2);assert.equal((await f.db.repository(f.id).read()).state.revision,2);
});
test('missing history/source and live jobs reject transfer before any source freeze',async t=>{
 const f=await fixture(t,{rich:true}),checked=await inspectLibraryMigration(f.db,f.root);
 const source=f.before.state.sources[0],path=join(f.store.root,'materials',source.sha256+'.bin'),bytes=await readFile(path);await writeFile(path,'broken');await assert.rejects(inspectLibraryMigration(f.db,f.root),/Повреждён/);await writeFile(path,bytes);
 const revisionPath=join(f.store.root,'revisions',f.before.history[0].hash+'.json'),snapshot=await readFile(revisionPath);await rm(revisionPath);await assert.rejects(inspectLibraryMigration(f.db,f.root));await writeFile(revisionPath,snapshot);
 await f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Pending',mode:'discuss',expectedRevision:1,selection:{slideId:f.native.slides[0].id,field:null,scope:'slide'}});
 await assert.rejects(migrateLibrary(f.db,f.root,checked.sourceHash),/незавершённое поручение/);await assert.rejects(access(join(f.root,'lanka-migration.json')));assert.equal(await f.db.catalogInfo(),null);assert.equal((await f.store.read()).state.revision,2);
});

test('a duplicate document ID rejects before freezing; trash and restore keep the original document identity',async t=>{
 const f=await fixture(t),clone=structuredClone(f.before.state.doc);await f.db.create(randomUUID(),clone);
 await assert.rejects(inspectLibraryMigration(f.db,f.root),/уже существует/);await assert.rejects(access(join(f.root,'lanka-migration.json')));assert.equal(await f.db.catalogInfo(),null);
 await f.db.pool.query('DELETE FROM lanka.command_receipts WHERE tenant_id=$1 AND material_id=$2',[f.db.tenant,f.id]);await f.db.pool.query('DELETE FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2',[f.db.tenant,f.id]);await f.db.pool.query('DELETE FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.db.tenant,f.id]);
 await f.library.mutate({requestId:randomUUID(),command:{action:'trash_document',id:f.alias,trashed:true}});
 const checked=await inspectLibraryMigration(f.db,f.root);assert.equal(checked.documents[0].trashed,true);await migrateLibrary(f.db,f.root,checked.sourceHash);
 const workspace=new LocalWorkspace(f.library,f.db);assert.equal((await workspace.listing()).documents.find(d=>d.id===f.id).trashed,true);await assert.rejects((await workspace.repository(f.alias)).read(),/недоступен/);
 await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id:f.alias,trashed:false}});assert.equal((await (await workspace.repository(f.alias)).read()).state.doc.id,f.id);
});

test('two initialized server catalogues keep folders and aliases separate',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root);await migrateLibrary(f.db,f.root,checked.sourceHash);
 for(const tenantId of [f.db.tenant,randomUUID()]){
  const root=join(f.root,randomUUID()),other=new ChatDatabase({...f.config,tenantId,ownerId:randomUUID(),runtimeRoot:join(root,'runtime')});await other.init();const library=new LibraryStore(root);await library.init();
  try{
   const empty=await inspectLibraryMigration(other,root);await migrateLibrary(other,root,empty.sourceHash);assert.deepEqual(await other.catalogFolders(),[]);assert.equal(await other.resolveMaterialId(f.alias),f.alias);
   await assert.rejects(other.mutateFolder(randomUUID(),{action:'rename_folder',id:f.folderId,name:'Not ours'}),/Папка недоступна/);
   const foreign=await other.mutateFolder(randomUUID(),{action:'create_folder',name:'Другая область'});await assert.rejects(f.db.catalogCommand(randomUUID(),f.id,{action:'move_document',folderId:foreign.id}),/Папка недоступна/);
   assert.equal((await f.db.catalogFolders()).length,1);assert.equal((await other.catalogFolders()).length,1);
  }finally{for(const table of ['catalog_receipts','catalog_folders','workspace_catalogs','agent_connections'])await other.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1 AND owner_id=$2`,[other.tenant,other.owner]);await other.close();}
 }
});

test('a concurrent create cannot claim an ID being reserved for a migrated legacy link',async t=>{
 const f=await fixture(t),checked=await inspectLibraryMigration(f.db,f.root),other=new ChatDatabase({...f.config,ownerId:randomUUID()});await other.init();t.after(()=>other.close());
 const results=await Promise.allSettled([migrateLibrary(f.db,f.root,checked.sourceHash),other.create(randomUUID(),{...f.before.state.doc,id:f.alias})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 if(results[0].status==='fulfilled'){assert.equal(await f.db.resolveMaterialId(f.alias),f.id);assert.match(String(results[1].reason),/старой ссылкой/);}else{assert.match(String(results[0].reason),/уже существует/);assert.equal(await f.db.catalogInfo(),null);await assert.rejects(access(join(f.root,'lanka-migration.json')));assert.equal((await f.store.read()).state.doc.id,f.id);}
});

test('migration retains archived source bytes absent from the current document and restores them after import',async t=>{
 const f=await fixture(t,{rich:true});
 const old=await f.store.read(),image=old.state.sources.find(s=>s.kind==='image');assert.ok(image);
 const doc=structuredClone(old.state.doc);doc.slides[0].assetId=image.id;
 await humanCommand(f.store,{requestId:randomUUID(),deckId:f.id,expectedRevision:2,command:{action:'save',doc}});
 const archive=await f.store.readRevisionDependencies(3),bytes=await archive.read(image.sha256);
 await f.store.mutate(randomUUID(),{test:'remove sources'},async p=>{delete p.state.doc.slides[0].assetId;p.state.sources=[];p.state.revision++;return {project:p,result:{}};});
 for(const source of archive.snapshot.sources)await rm(join(f.store.root,'materials',source.sha256+'.bin'),{force:true});
 const report=await inspectLibraryMigration(f.db,f.root);assert.equal(report.documents[0].archivedRevisions,4);
 await migrateLibrary(f.db,f.root,report.sourceHash);
 const saved=(await f.db.pool.query('SELECT bytes,hash FROM lanka.revision_dependency_snapshots WHERE tenant_id=$1 AND material_id=$2 AND revision=3',[f.db.tenant,f.id])).rows[0];assert.deepEqual(saved.bytes,archive.bytes);assert.equal(saved.hash,archive.hash);
 const target=f.db.repository(f.id);assert.deepEqual((await target.readRevisionAsset(3,image.id)).bytes,bytes);
 await humanCommand(target,{requestId:randomUUID(),deckId:f.id,expectedRevision:4,command:{action:'restore',revision:3}});
 assert.deepEqual((await target.read()).state.sources,archive.snapshot.sources);assert.deepEqual(await target.readFile('materials/'+image.sha256+'.bin'),bytes);
});
