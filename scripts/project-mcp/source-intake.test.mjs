import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
const config=JSON.parse(await readFile(new URL('../../work/agent-chat/config.json',import.meta.url),'utf8'));
await build({stdin:{contents:'export {withSourceExtractionSlot} from "./lib/adapters/postgres/source-extraction-slot"; export {stageSourceIntake,getSourceIntake,extractSource,attachSourceIntake} from "./lib/agents/source-intake"; export {ChatDatabase} from "./lib/adapters/postgres/chat-database"; export {ChatService} from "./lib/agents/chat-service"; export {canPopulateDraft} from "./lib/project/empty-draft";',resolveDir:process.cwd()},outfile:'.project-runtime/intake-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {withSourceExtractionSlot,stageSourceIntake,getSourceIntake,extractSource,attachSourceIntake,ChatDatabase,ChatService,canPopulateDraft}=await import('../../.project-runtime/intake-test.mjs');
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'lanka-intake-test-'));const db=new ChatDatabase({...config,runtimeRoot:root,tenantId:randomUUID(),ownerId:randomUUID()});await db.init();t.after(async()=>{for(const table of ['source_intakes','agent_events','agent_runs','jobs','agent_messages','agent_sessions','command_receipts','blobs','material_revisions','materials','agent_connections'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);await db.close();await rm(root,{recursive:true,force:true});});const service=new ChatService(db);await service.setEnabled(true);return {db,service};}
const input=(text='Сентябрь 2026: 42 заявки.')=>({requestId:randomUUID(),name:'facts.txt',base64:Buffer.from(text).toString('base64')});
const create=sourceIntakeId=>({requestId:randomUUID(),prompt:'Создай три слайда по материалу',profile:'focus-v3',sourceIntakeId});
test('real parser stages an immutable original and creation atomically adopts source and context',async t=>{
 const {db,service}=await fixture(t),a=input(),intake=await stageSourceIntake(db,a);
 assert.equal(intake.extraction.status,'extracted');assert.equal(intake.extraction.parser.sha256.length,64);assert.deepEqual(await stageSourceIntake(db,a),intake);
 await assert.rejects(stageSourceIntake(db,{...a,name:'changed.txt'}),/Ключ загрузки/);
 const request=create(intake.id),created=await service.startPresentation(request),p=await db.repository(created.id).read();assert.equal(p.state.sources[0].id,intake.id);assert.equal(canPopulateDraft(p),true);
 const source=p.state.sources[0];assert.deepEqual(source.extraction,intake.extraction);assert.match(source.excerpt,/Сентябрь 2026: 42 заявки/);
 const bytes=await db.repository(created.id).readFile(`materials/${source.sha256}.bin`);assert.equal(bytes.toString('base64'),a.base64);
 const run=await service.claim();assert.deepEqual(run.input.sources[0].extraction,source.extraction);assert.equal(run.input.sources[0].sha256,source.sha256);assert.equal(run.input.sources[0].excerpt,source.excerpt);
 await db.pool.query('DELETE FROM lanka.source_intakes WHERE tenant_id=$1',[db.tenant]);
 assert.deepEqual(await service.startPresentation(request),created);assert.equal((await db.repository(created.id).readFile(`materials/${source.sha256}.bin`)).toString('base64'),a.base64);
});
test('intakes reject other owners, expiry, failed reads and oversized input without creating documents',async t=>{
 const {db,service}=await fixture(t),intake=await stageSourceIntake(db,input());
 const other=new ChatDatabase({...db.options,ownerId:randomUUID()});t.after(()=>other.close());await assert.rejects(getSourceIntake(other,intake.id),/недоступен/);
 await db.pool.query("UPDATE lanka.source_intakes SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",[db.tenant]);await assert.rejects(service.startPresentation(create(intake.id)),/истёк/);
 const failed=await stageSourceIntake(db,{...input(),name:'bad.pptx'});assert.equal(failed.extraction.status,'failed');await assert.rejects(service.startPresentation(create(failed.id)),/нет доступного текста/);
 await assert.rejects(stageSourceIntake(db,input('a'.repeat(200001))),/200 КБ/);await assert.rejects(stageSourceIntake(db,{...input(),name:'unsafe.exe'}),/Поддерживаются/);
 assert.equal((await db.pool.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1',[db.tenant])).rowCount,0);
});
test('large extracted input explicitly limits agent text while retaining original bytes',async t=>{
 const {db,service}=await fixture(t),a=input('Текст отчёта. '.repeat(2000)),intake=await stageSourceIntake(db,a);
 assert.equal(intake.extraction.status,'partial');assert.match(intake.extraction.note,/12 000/);
 const created=await service.startPresentation(create(intake.id)),p=await db.repository(created.id).read(),s=p.state.sources[0];assert.ok(s.excerpt.length<=12000);assert.equal(createHash('sha256').update(Buffer.from(a.base64,'base64')).digest('hex'),s.sha256);
});
test('concurrent identical uploads persist only one frozen result',async t=>{
 const {db}=await fixture(t),a=input();const results=await Promise.all([stageSourceIntake(db,a),stageSourceIntake(db,a)]);assert.deepEqual(results[0],results[1]);assert.equal((await db.pool.query('SELECT 1 FROM lanka.source_intakes WHERE tenant_id=$1',[db.tenant])).rowCount,1);
});

test('two database-wide parser slots bound other pools while reads and saved upload replay remain available',async t=>{
 const a=await fixture(t),b=await fixture(t),savedInput=input(),saved=await stageSourceIntake(a.db,savedInput);
 const result=await extractSource(Buffer.from('Факты'),'source.txt');let release;const wait=new Promise(r=>release=r);t.after(()=>release());let began=0,ready;const started=new Promise(r=>ready=r);
 const blocked=async()=>{if(++began===2)ready();await wait;return result;};
 const first=stageSourceIntake(a.db,input('first'),blocked),second=stageSourceIntake(b.db,input('second'),blocked);
 try{await started;let invoked=false;await assert.rejects(stageSourceIntake(a.db,input('third'),async()=>{invoked=true;return result;}),/читает два файла/);assert.equal(invoked,false);
 assert.deepEqual(await stageSourceIntake(a.db,savedInput),saved);assert.equal((await a.db.tx(c=>c.query('SELECT 1 AS responsive'))).rows[0].responsive,1);
 }finally{release();await Promise.all([first,second]);}
 await stageSourceIntake(a.db,input('third'),async()=>result);
});
test('parser exceptions release capacity for the next attempt',async t=>{
 const {db}=await fixture(t);await assert.rejects(withSourceExtractionSlot(db,async()=>{throw Error('parser failed');}),/parser failed/);
 assert.deepEqual(await Promise.all([withSourceExtractionSlot(db,async()=>1),withSourceExtractionSlot(db,async()=>2)]),[1,2]);
});
test('loss of the slot connection aborts work and a fresh connection can retry',async t=>{
 const {db}=await fixture(t),name='lanka-slot-test-'+randomUUID(),worker=new ChatDatabase({...db.options,connection:{...db.options.connection,application_name:name}});t.after(()=>worker.close());
 let started;const ready=new Promise(r=>started=r);const work=withSourceExtractionSlot(worker,signal=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted parser')),{once:true});started();}));
 const failed=assert.rejects(work,/aborted parser|соединение/);await ready;
 const targets=await db.pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_try_advisory_lock%'",[name]);assert.equal(targets.rowCount,1);
 await db.pool.query('SELECT pg_terminate_backend($1)',[targets.rows[0].pid]);await failed;
 assert.equal(await withSourceExtractionSlot(worker,async()=>42),42);
});


test('attach an upload to an existing document preserves slides, is atomic and reaches the next agent input',async t=>{
 const {db,service}=await fixture(t),first=await stageSourceIntake(db,input()),created=await service.startPresentation(create(first.id)),run=await service.claim();await service.fail(run,'Fixture creation stopped','QA');
 let p=await db.repository(created.id).read();
 const second=await stageSourceIntake(db,input('Октябрь 2026: 48 заявок.'));
 const args={requestId:randomUUID(),expectedRevision:p.state.revision,sourceIntakeId:second.id};
 const result=await attachSourceIntake(db,created.id,args),after=await db.repository(created.id).read();assert.deepEqual(after.state.doc,p.state.doc);assert.equal(after.state.sources.length,2);assert.equal(after.state.revision,p.state.revision+1);assert.equal(canPopulateDraft(after),true);assert.equal(result.sourceId,second.id);
 assert.deepEqual(await attachSourceIntake(db,created.id,args),result);assert.equal((await db.repository(created.id).read()).state.sources.length,2);
 await assert.rejects(attachSourceIntake(db,created.id,{...args,requestId:randomUUID()}),/Конфликт версии/);
 const foreign=new ChatDatabase({...db.options,ownerId:randomUUID()});t.after(()=>foreign.close());await assert.rejects(attachSourceIntake(foreign,created.id,{...args,requestId:randomUUID(),expectedRevision:after.state.revision}),/недоступен/);
 await db.pool.query('DELETE FROM lanka.source_intakes WHERE tenant_id=$1 AND id=$2',[db.tenant,second.id]);assert.deepEqual(await attachSourceIntake(db,created.id,args),result);
 const next=await stageSourceIntake(db,input('Ноябрь 2026: 51 заявка.'));
 const sessionId=await db.ensureSession(created.id);await service.enqueue(sessionId,{requestId:randomUUID(),text:'Что изменилось в октябре?',mode:'discuss',expectedRevision:after.state.revision,selection:{slideId:after.state.doc.slides[0].id,field:null,scope:'document'}});
 await assert.rejects(attachSourceIntake(db,created.id,{requestId:randomUUID(),expectedRevision:after.state.revision,sourceIntakeId:next.id}),/Дождитесь завершения/);
 assert.deepEqual((await db.repository(created.id).read()).state,after.state);
 const discussion=await service.claim();assert.equal(discussion.input.sources.length,2);assert.match(discussion.input.sources.find(s=>s.id===second.id).excerpt,/48 заявок/);assert.deepEqual(discussion.input.sources.find(s=>s.id===second.id).extraction,second.extraction);
 await service.fail(discussion,'Fixture ended','QA');
 await service.enqueue(sessionId,{requestId:randomUUID(),text:'Обсуди только слайд',mode:'discuss',expectedRevision:after.state.revision,selection:{slideId:after.state.doc.slides[0].id,field:null,scope:'slide'}});
 assert.equal((await service.claim()).input.sources.length,0);
});
