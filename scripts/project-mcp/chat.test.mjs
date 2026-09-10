import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

// Explicit opt-in: this suite needs the private local PostgreSQL created by setup-local-chat.
const config = JSON.parse(await readFile(new URL("../../work/agent-chat/config.json", import.meta.url), "utf8"));
await build({stdin:{contents:`export {canPopulateDraft} from "./lib/project/empty-draft";
export {ChatDatabase} from "./lib/adapters/postgres/chat-database";
export {creationProfile,creationReferenceImages} from "./lib/agents/creation-profile";
export {designReview} from "./lib/domain/design-review";
export {runFailure} from "./lib/agents/run-failure";
export {composePresentation} from "./lib/agents/create-presentation";
export {ChatService} from "./lib/agents/chat-service";
export {LocalChatRunner} from "./lib/agents/codex-chat";
export {chatApi} from "./scripts/project-mcp/chat-api";
export {fromMarkdown} from "./lib/domain/intake";
export {humanCommand} from "./scripts/project-mcp/human";`,resolveDir:process.cwd()},
  outfile:".project-runtime/chat-test-exports.mjs",bundle:true,platform:"node",format:"esm",packages:"external"});
const { LocalChatRunner, chatApi, canPopulateDraft, ChatDatabase, ChatService, fromMarkdown, humanCommand, composePresentation, creationProfile, creationReferenceImages, designReview, runFailure } = await import("../../.project-runtime/chat-test-exports.mjs");

test("run failures identify the stage without retaining private provider errors",()=>{
  const busy=runFailure(Object.assign(new Error("Codex request failed"),{reason:"THREAD_IN_USE"}),"RESUME");
  assert.equal(busy.code,"NATIVE_THREAD_IN_USE");
  assert.match(busy.message,/Поручение не запущено/);
  assert.equal(runFailure(Object.assign(new Error("Codex request failed"),{rpcCode:-32603}),"READ_SESSION").code,"NATIVE_READ_SESSION_RPC_-32603");
  assert.equal(runFailure(Object.assign(new Error("Codex request failed"),{rpcCode:"secret"}),"RESUME").code,"NATIVE_RESUME_RPC");
  assert.equal(runFailure(new Error("private provider prompt"),"TURN").code,"NATIVE_TURN_FAILED");
  assert.equal(JSON.stringify(runFailure(new Error("private provider prompt"),"TURN")).includes("private"),false);
  assert.equal(runFailure(new Error("AUTH_REQUIRED"),"CONNECT").code,"AUTH_REQUIRED");
  assert.equal(runFailure(new Error("Codex request timed out"),"VERIFY_TOOLS").code,"NATIVE_VERIFY_TOOLS_TIMEOUT");
  assert.match(runFailure(new Error('Codex turn timed out'),'TURN').message,/за отведённое время/);
  assert.match(runFailure(new Error('NATIVE_BUSY'),'READ_SESSION').message,/Запрошена остановка/);
});

async function fixture(t) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "lanka-chat-test-"));
  const db = new ChatDatabase({...config, runtimeMode:'configured', tenantId:randomUUID(), ownerId:randomUUID(), runtimeRoot});
  await db.init();
  t.after(async()=>{
    // Only this fixture's random tenant; never the user's documents or agent account.
    for(const table of ["agent_events","agent_runs","jobs","agent_messages","agent_sessions","command_receipts","blobs","material_revisions","materials","agent_connections"])
      await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);
    await db.close();await rm(runtimeRoot,{recursive:true,force:true});
  });
  const doc=fromMarkdown("# Test civilization\n\n## Cities and writing\nCities supported specialized work.\n\n## Trade\nExchange connected regions.");
  doc.id=randomUUID();
  await db.create(randomUUID(),doc);
  const service=new ChatService(db);await service.setEnabled(true);
  const sessionId=await db.ensureSession(doc.id);
  const input=(overrides={})=>({requestId:randomUUID(),text:"Make the title clearer",mode:"edit",expectedRevision:1,selection:{slideId:doc.slides[0].id,field:"title"},...overrides});
  const enqueue=async(overrides={})=>{await service.enqueue(sessionId,input(overrides));return service.claim();};
  const output=(run,title="Cities changed society")=>JSON.stringify({reply:"Предлагаю уточнить заголовок.",title:"Ясный заголовок",commands:[{op:"set_title",slideId:run.selection.slideId,value:title}]});
  const human=async(command)=>{const p=await db.repository(doc.id).read();return humanCommand(db.repository(doc.id),{requestId:randomUUID(),deckId:doc.id,expectedRevision:p.state.revision,command});};
  return {db,service,sessionId,doc,input,enqueue,output,human};
}

test("one accepted send is durable, retries deduplicate and payload substitution is rejected",async t=>{
  const f=await fixture(t),a=f.input();
  const first=await f.service.enqueue(f.sessionId,a);
  assert.deepEqual(await f.service.enqueue(f.sessionId,a),first);
  await assert.rejects(f.service.enqueue(f.sessionId,{...a,text:"Different request"}),/Ключ повтора/);
  const reopened=new ChatService(f.db),view=await reopened.view(f.sessionId);
  assert.equal(view.messages.length,2);assert.equal(view.queued,1);
  assert.equal(await f.db.ensureSession(f.doc.id),f.sessionId);
  const run=await reopened.claim();assert.equal(run.id,first.runId);
  assert.equal(await reopened.claim(),null);
  assert.equal(run.input.revision,1);assert.equal(run.input.slide.id,f.doc.slides[0].id);
});

test('dedicated connection preserves documents and messages, renews owned contexts once and survives reopening',async t=>{
  const f=await fixture(t),run=await f.enqueue({mode:'discuss'});
  await f.service.native(run,'desktop-owned-thread','old-model');await f.service.fail(run,'Busy','NATIVE_THREAD_IN_USE');
  const before=await f.service.view(f.sessionId),project=await f.db.repository(f.doc.id).read();
  const otherOwner=randomUUID();
  await f.db.pool.query("INSERT INTO lanka.agent_connections(tenant_id,owner_id,id,enabled) VALUES($1,$2,'local-codex',true)",[f.db.tenant,otherOwner]);
  assert.equal(await f.service.runtimeMode(),'configured');
  assert.equal(await f.service.useDedicatedRuntime(),true);
  assert.equal(await f.service.enabled(),false);
  assert.equal(await f.service.runtimeMode(),'dedicated');
  assert.deepEqual((await f.service.view(f.sessionId)).messages,before.messages);
  assert.deepEqual(await f.db.repository(f.doc.id).read(),project);
  const session=await f.db.session(f.db.pool,f.sessionId);
  assert.equal(session.native_thread_id,null);assert.equal(session.model,null);
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='context.restarted').length,1);
  await f.service.setEnabled(true);
  assert.equal(await f.service.useDedicatedRuntime(),false);assert.equal(await f.service.enabled(),true);
  assert.equal((await f.db.session(f.db.pool,f.sessionId)).context_epoch,session.context_epoch);
  const other=await f.db.pool.query("SELECT enabled,runtime_mode FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2",[f.db.tenant,otherOwner]);
  assert.deepEqual(other.rows,[{enabled:true,runtime_mode:'configured'}]);
  await f.db.init();assert.equal(await new ChatService(f.db).runtimeMode(),'dedicated');
  const next=await f.enqueue({mode:'discuss'});assert.equal(next.nativeThreadId,null);assert.equal(next.input.conversation.messagesBefore,2);
});

test('profile switch rejects queued, running and uncertain work without changing the connection',async t=>{
  const f=await fixture(t);
  const queued=await f.service.enqueue(f.sessionId,f.input({mode:'discuss'}));
  for(const status of ['queued','running','unknown']){
    await f.db.pool.query('UPDATE lanka.jobs SET status=$3 WHERE tenant_id=$1 AND id=$2',[f.db.tenant,queued.runId,status]);
    await assert.rejects(f.service.useDedicatedRuntime(),/во всех своих презентациях/);
    assert.equal(await f.service.runtimeMode(),'configured');assert.equal(await f.service.enabled(),true);
  }
  await f.service.cancel(f.sessionId,queued.runId,randomUUID());
  assert.equal(await f.service.useDedicatedRuntime(),true);
});

test('new-install profile default applies only to newly created owner connections',async t=>{
  const f=await fixture(t),configured=new ChatDatabase({...f.db.options,runtimeMode:'dedicated'});
  t.after(()=>configured.close());await configured.init();
  assert.equal(await f.service.runtimeMode(),'configured');
  const fresh=new ChatDatabase({...f.db.options,ownerId:randomUUID(),runtimeMode:'dedicated'});
  t.after(()=>fresh.close());await fresh.init();
  assert.equal(await new ChatService(fresh).runtimeMode(),'dedicated');
  assert.equal(await new ChatService(fresh).enabled(),false);
});

test('explicit context recovery preserves chat and document, deduplicates, and affects only this session',async t=>{
  const f=await fixture(t),run=await f.enqueue({mode:'discuss'});
  await f.service.native(run,'old-native','test-model');await f.service.fail(run,'Busy','NATIVE_THREAD_IN_USE');
  const before=await f.service.view(f.sessionId),project=await f.db.repository(f.doc.id).read();
  assert.equal(before.recovery.failedRunId,run.id);
  const secondDoc=fromMarkdown('# Another\n\n## Slide\nText');secondDoc.id=randomUUID();await f.db.create(randomUUID(),secondDoc);
  const second=await f.db.ensureSession(secondDoc.id),secondBefore=await f.db.session(f.db.pool,second);
  const input={requestId:randomUUID(),failedRunId:run.id};
  const result=await f.service.restartContext(f.sessionId,input);
  assert.deepEqual(await f.service.restartContext(f.sessionId,input),result);
  assert.deepEqual(await f.db.session(f.db.pool,second),secondBefore);
  assert.deepEqual((await f.service.view(f.sessionId)).messages,before.messages);
  assert.equal((await f.service.view(f.sessionId)).recovery,undefined);
  assert.ok((await f.service.view(f.sessionId)).contextRestartedAt);
  assert.deepEqual(await f.db.repository(f.doc.id).read(),project);
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='context.restarted').length,1);
  await assert.rejects(f.service.restartContext(f.sessionId,{...input,requestId:randomUUID()}),/Состояние/);
  const next=await f.enqueue({mode:'discuss'});assert.equal(next.nativeThreadId,null);assert.equal(next.input.conversation.messagesBefore,2);
  await assert.rejects(f.service.restartContext(f.sessionId,{requestId:randomUUID(),failedRunId:run.id}),/текущее поручение/);
});

test('context recovery rejects unrelated failures, foreign owners and trashed documents',async t=>{
  const f=await fixture(t),run=await f.enqueue();await f.service.fail(run,'Failed');
  const input={requestId:randomUUID(),failedRunId:run.id};
  await assert.rejects(f.service.restartContext(f.sessionId,input),/Состояние/);
  const foreign=new ChatDatabase({...f.db.options,ownerId:randomUUID()});t.after(()=>foreign.close());
  await assert.rejects(new ChatService(foreign).restartContext(f.sessionId,input),/недоступна/);
  await f.db.pool.query('UPDATE lanka.materials SET trashed=true WHERE tenant_id=$1 AND id=$2',[f.db.tenant,f.doc.id]);
  await assert.rejects(f.service.restartContext(f.sessionId,input),/недоступна/);
});

test('competing recovery requests cannot silently replace the context twice',async t=>{
  const f=await fixture(t),run=await f.enqueue({mode:'discuss'});await f.service.native(run,'original-native','test-model');
  await f.service.fail(run,'Busy','NATIVE_THREAD_IN_USE');
  const outcomes=await Promise.allSettled([1,2].map(()=>f.service.restartContext(f.sessionId,{requestId:randomUUID(),failedRunId:run.id})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='context.restarted').length,1);
});

test("discussion streams with replayable events and cannot change the document",async t=>{
  const f=await fixture(t),run=await f.enqueue({mode:"discuss"});
  await f.service.append(run,"An idea ");await f.service.append(run,"about cities.");
  const cursor=(await f.service.view(f.sessionId)).cursor;
  await f.service.complete(run,"An idea about cities.");
  const p=await f.db.repository(f.doc.id).read(),view=await f.service.view(f.sessionId);
  assert.equal(p.state.revision,1);assert.equal(p.state.proposals.length,0);
  assert.equal(view.messages.at(-1).text,"An idea about cities.");assert.equal(view.active,null);
  const events=await f.service.events(f.sessionId,0);
  assert.deepEqual(events.map(e=>e.sequence),events.map((_,i)=>i+1));
  assert.ok(events.some(e=>e.kind==="message.delta"));
  assert.deepEqual((await f.service.events(f.sessionId,cursor)).map(e=>e.kind),["message.completed","run.completed"]);
});

test("proposal, final answer, events and receipt commit together; lost response is replayable",async t=>{
  const f=await fixture(t),run=await f.enqueue(),raw=f.output(run);
  const before=await f.service.view(f.sessionId);
  await assert.rejects(f.service.complete(run,raw,()=>{throw new Error("injected crash before commit");}),/injected crash/);
  assert.equal((await f.db.repository(f.doc.id).read()).state.proposals.length,0);
  assert.deepEqual(await f.service.view(f.sessionId),before);
  const result=await f.service.complete(run,raw);
  assert.deepEqual(await f.service.complete(run,raw),result);
  await assert.rejects(f.service.complete(run,f.output(run,"Different output")),/Ключ повтора/);
  const p=await f.db.repository(f.doc.id).read();
  assert.equal(p.state.proposals.length,1);assert.equal(p.state.revision,1);
  assert.equal(p.state.doc.slides[0].title,f.doc.slides[0].title);
  await f.human({action:"comment",slideId:f.doc.slides[0].id,text:"Please explain this."});
  const proposal=p.state.proposals[0];
  await f.human({action:"accept",proposalId:proposal.id,changeIds:proposal.changes.map(c=>c.id)});
  const saved=await f.db.repository(f.doc.id).read();
  assert.equal(saved.state.revision,2);assert.equal(saved.state.doc.slides[0].title,"Cities changed society");
  assert.equal(saved.state.comments[0].resolved,false);
  await f.human({action:"restore",revision:1});
  assert.equal((await f.db.repository(f.doc.id).read()).state.doc.slides[0].title,f.doc.slides[0].title);
});

test("selected-field boundary rejects other fields and other slides",async t=>{
  const f=await fixture(t),run=await f.enqueue();
  for(const command of [{op:"set_body",slideId:run.selection.slideId,value:"Wrong field"},{op:"set_title",slideId:f.doc.slides[1].id,value:"Wrong slide"}])
    await assert.rejects(f.service.complete(run,JSON.stringify({reply:"Done",title:"Change",commands:[command]})),/другую область/);
  assert.equal((await f.db.repository(f.doc.id).read()).state.proposals.length,0);
});

test("one document-scoped turn snapshots all slides and produces one partially reviewable proposal",async t=>{
  const f=await fixture(t);
  const selection={slideId:f.doc.slides[0].id,field:null,scope:"document"};
  const a=f.input({selection});
  const receipt=await f.service.enqueue(f.sessionId,a);
  assert.deepEqual(await f.service.enqueue(f.sessionId,a),receipt);
  await assert.rejects(f.service.enqueue(f.sessionId,{...a,selection:{...selection,scope:"slide"}}),/Ключ повтора/);
  const run=await f.service.claim();
  assert.deepEqual(run.input.slides,f.doc.slides);
  const commands=f.doc.slides.map((s,i)=>({op:"set_title",slideId:s.id,value:`Clear title ${i+1}`}));
  const raw=JSON.stringify({reply:"Предлагаю уточнить заголовки всей презентации.",title:"Заголовки всей деки",commands});
  const result=await f.service.complete(run,raw);
  assert.deepEqual(await f.service.complete(run,raw),result);
  let p=await f.db.repository(f.doc.id).read();
  assert.deepEqual(p.state.doc,f.doc);assert.equal(p.state.proposals.length,1);
  const proposal=p.state.proposals[0];assert.equal(proposal.changes.length,f.doc.slides.length);
  const view=await f.service.view(f.sessionId);
  assert.equal(view.messages.at(-1).selection.scope,"document");
  await f.human({action:"accept",proposalId:proposal.id,changeIds:[proposal.changes[0].id]});
  p=await f.db.repository(f.doc.id).read();
  assert.equal(p.state.doc.slides[0].title,"Clear title 1");
  assert.equal(p.state.doc.slides[1].title,f.doc.slides[1].title);
  await f.human({action:"accept",proposalId:proposal.id,changeIds:proposal.changes.slice(1).map(c=>c.id)});
  p=await f.db.repository(f.doc.id).read();
  assert.deepEqual(p.state.doc.slides.map(s=>s.title),commands.map(c=>c.value));
});

test("document scope rejects foreign IDs and mixed field selection and protects manual edits",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.enqueue(f.sessionId,f.input({selection:{slideId:f.doc.slides[0].id,field:"title",scope:"document"}})),/отдельного поля/);
  const run=await f.enqueue({selection:{slideId:f.doc.slides[0].id,field:null,scope:"document"}});
  const foreign=JSON.stringify({reply:"Changed",title:"Wrong scope",commands:[{op:"set_title",slideId:randomUUID(),value:"Wrong"}]});
  await assert.rejects(f.service.complete(run,foreign),/другую область/);
  const edited=structuredClone(f.doc);edited.slides[1].body="Human text must survive";
  await f.human({action:"save",doc:edited});
  assert.equal(run.input.slides[1].body,f.doc.slides[1].body);
  await assert.rejects(f.service.complete(run,f.output(run)),/Исходная версия/);
  const p=await f.db.repository(f.doc.id).read();
  assert.equal(p.state.proposals.length,0);assert.deepEqual(p.state.doc,edited);
});

test("manual edits during inference survive a stale agent result",async t=>{
  const f=await fixture(t),run=await f.enqueue();
  const doc=structuredClone(f.doc);doc.slides[0].title="Human decision";
  await f.human({action:"save",doc});
  await assert.rejects(f.service.complete(run,f.output(run)),/Исходная версия/);
  const p=await f.db.repository(f.doc.id).read();
  assert.equal(p.state.doc.slides[0].title,"Human decision");assert.equal(p.state.proposals.length,0);
  await assert.rejects(f.service.enqueue(f.sessionId,f.input()),/Презентация изменилась/);
});

test("cancellation is idempotent and fences late deltas and completion",async t=>{
  const f=await fixture(t),run=await f.enqueue(),id=randomUUID();
  await f.service.cancel(f.sessionId,run.id,id);await f.service.cancel(f.sessionId,run.id,id);
  await assert.rejects(f.service.append(run,"late text"),/RUN_FENCED/);
  await assert.rejects(f.service.complete(run,f.output(run)),/RUN_FENCED/);
  const view=await f.service.view(f.sessionId);
  assert.equal(view.active,null);assert.equal(view.messages.at(-1).status,"interrupted");
  assert.equal((await f.db.repository(f.doc.id).read()).state.proposals.length,0);
});

test("expired lease becomes unknown on restart and never starts the model twice",async t=>{
  const f=await fixture(t),run=await f.enqueue();
  await f.service.native(run,"native-thread-1","model-a","native-turn-1");
  await f.db.pool.query("UPDATE lanka.jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.db.tenant,run.id]);
  const restarted=new ChatService(f.db);await restarted.recoverExpired();
  assert.equal((await restarted.view(f.sessionId)).active.status,"unknown");assert.equal(await restarted.claim(),null);
  await assert.rejects(restarted.enqueue(f.sessionId,f.input()),/Остановите/);
  await assert.rejects(restarted.complete(run,f.output(run)),/RUN_FENCED/);
  await restarted.cancel(f.sessionId,run.id,randomUUID());
  await restarted.enqueue(f.sessionId,f.input());
  const next=await restarted.claim();assert.equal(next.nativeThreadId,"native-thread-1");assert.equal(next.model,"model-a");
});

test("disconnect invalidates active context, reconnection starts a fresh native thread",async t=>{
  const f=await fixture(t),run=await f.enqueue();await f.service.native(run,"native-private","model-a");
  await f.service.setEnabled(false);
  await assert.rejects(f.service.complete(run,f.output(run)),/RUN_FENCED/);
  await assert.rejects(f.service.enqueue(f.sessionId,f.input()),/Подключите/);
  await f.service.setEnabled(true);await f.service.enqueue(f.sessionId,f.input());
  assert.equal((await f.service.claim()).nativeThreadId,null);
});

test("owner, session and deleted-document checks apply before reads, replay and completion",async t=>{
  const f=await fixture(t),run=await f.enqueue();
  const outsider=new ChatDatabase({...f.db.options,ownerId:randomUUID()});
  t.after(()=>outsider.close());
  await assert.rejects(new ChatService(outsider).view(f.sessionId),/недоступна/);
  await assert.rejects(new ChatService(outsider).events(f.sessionId,0),/недоступна/);
  await assert.rejects(outsider.repository(f.doc.id).read(),/недоступен/);
  await assert.rejects(f.service.cancel(randomUUID(),run.id,randomUUID()),/недоступна/);
  await f.db.catalogCommand(randomUUID(),f.doc.id,{action:"trash_document",trashed:true});
  await assert.rejects(f.service.complete(run,f.output(run)),/недоступна/);
  await assert.rejects(f.service.events(f.sessionId,0),/недоступна/);
});


const creationOutput = () => JSON.stringify({reply:"Подготовил черновик.",title:"Общая библиотека",assumptions:["Сценарий вымышленный, без измеренных результатов."],slides:[
  {kind:"statement",title:"Презентации работают на команду",text:"Находим и переиспользуем нужные материалы.",points:[],notes:""},
  {kind:"explanation",title:"Общий каталог",text:"Дополнительное пояснение сохраняется в заметках.",points:[{label:"Найти",text:"Искать по названию и папке."},{label:"Использовать",text:"Брать проверенную версию."}],notes:"Подробности для выступающего."},
  {kind:"statement",title:"Проверьте на одной команде",text:"Соберите обратную связь перед расширением.",points:[],notes:""}
]});
const creationInput=()=>({requestId:randomUUID(),prompt:"Создай 3 слайда о библиотеке презентаций. Это вымышленный сценарий.",folderId:null});

test("creation reserves document, chat and job atomically and deduplicates a lost response",async t=>{
  const f=await fixture(t),input=creationInput();
  await f.service.setEnabled(false);
  await assert.rejects(f.service.startPresentation(input),/Подключите/);
  assert.equal(await f.db.owns(input.requestId),false);
  await f.service.setEnabled(true);
  const [a,b]=await Promise.all([f.service.startPresentation(input),f.service.startPresentation(input)]);
  assert.deepEqual(a,b);assert.equal(a.id,input.requestId);
  const view=await f.service.view(a.sessionId);assert.equal(view.messages.length,2);assert.equal(view.queued,1);
  await assert.rejects(f.service.startPresentation({...input,prompt:"Different task"}),/Ключ повтора/);
  const run=await f.service.claim();assert.equal(run.mode,"create");assert.equal(run.text,input.prompt);
  await assert.rejects(f.service.retryCreation(a.sessionId,randomUUID()),/уже в очереди/);
});

test("created draft, history, final message and events commit together; retries preserve slide IDs",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim(),raw=creationOutput();
  await assert.rejects(f.service.complete(run,raw,()=>{throw new Error("creation transaction rollback");}),/rollback/);
  assert.equal((await f.db.repository(a.id).read()).state.revision,1);
  assert.equal((await f.service.view(a.sessionId)).messages.at(-1).status,"streaming");
  await f.service.complete(run,raw);
  const saved=await f.db.repository(a.id).read();
  assert.equal(saved.state.revision,2);assert.equal(saved.state.doc.slides.length,3);assert.equal(saved.title,"Общая библиотека");
  assert.equal(saved.state.approvedRevision,null);assert.equal(saved.state.proposals.length,0);assert.deepEqual(saved.state.grants,[]);
  assert.deepEqual(saved.history.map(v=>v.revision),[1,2]);
  assert.match(saved.state.doc.slides[0].notes,/Сценарий вымышленный/);
  assert.match(saved.state.doc.slides[1].notes,/Дополнительное пояснение/);
  await f.service.complete(run,raw);
  assert.deepEqual((await f.db.repository(a.id).read()).state.doc,saved.state.doc);
  assert.ok((await f.service.events(a.sessionId,0)).some(e=>e.kind==="document.created"));
  assert.equal((await f.db.repository(f.doc.id).read()).state.revision,1);
  await assert.rejects(f.service.retryCreation(a.sessionId,randomUUID()),/Презентация изменилась/);
});

test("creation protects edits, comments and cancellation while an agent is running",async t=>{
  const f=await fixture(t);
  for(const action of ["save","comment","cancel"]) {
    const a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
    const repository=f.db.repository(a.id),p=await repository.read();
    if(action==="cancel")await f.service.cancel(a.sessionId,run.id,randomUUID());
    else {
      const command=action==="comment"?{action:"comment",slideId:p.state.doc.slides[0].id,text:"Не заменять этот слайд"}:{action:"save",doc:{...p.state.doc,slides:[{...p.state.doc.slides[0],body:"Ручной текст"}]}};
      await humanCommand(repository,{requestId:randomUUID(),deckId:a.id,expectedRevision:1,command});
    }
    await assert.rejects(f.service.complete(run,creationOutput()),/Исходная версия|RUN_FENCED/);
    const saved=await repository.read();assert.equal(saved.state.doc.slides.length,1);
    if(action==="save")assert.equal(saved.state.doc.slides[0].body,"Ручной текст");
    if(action!=="cancel")await f.service.cancel(a.sessionId,run.id,randomUUID());
  }
});

test("failed creation can be retried without making another document or duplicate job",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
  await f.service.fail(run,"Injected failure");
  const requestId=randomUUID(),retry=await f.service.retryCreation(a.sessionId,requestId);
  assert.deepEqual(await f.service.retryCreation(a.sessionId,requestId),retry);
  assert.equal(retry.sessionId,a.sessionId);assert.notEqual(retry.runId,run.id);
  await f.service.complete(await f.service.claim(),creationOutput());
  assert.equal((await f.db.repository(a.id).read()).state.doc.slides.length,3);
});

test("generation rejects invalid structure and overflowing text without saving a partial deck",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
  const wrong=JSON.parse(creationOutput());wrong.slides[1].kind="steps";wrong.slides[1].points=[];
  await assert.rejects(f.service.complete(run,JSON.stringify(wrong)),/структуре/);
  const long=JSON.parse(creationOutput());long.slides[0].title="W".repeat(90);
  await assert.rejects(f.service.complete(run,JSON.stringify(long)),/не вмещается/);
  assert.equal((await f.db.repository(a.id).read()).state.revision,1);
  assert.equal((await f.service.view(a.sessionId)).messages.at(-1).status,"streaming");
});


test("overflow cannot silently change an explanatory slide into a table",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
  const answer=JSON.parse(creationOutput());answer.slides[1].title="Разрозненные папки — повторная работа";
  assert.throws(()=>composePresentation(run.input.document,JSON.stringify(answer)),/не вмещается/);
});

test("the steps recipe owns numbering so agent labels cannot duplicate it",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
  const answer=JSON.parse(creationOutput());Object.assign(answer.slides[1],{kind:"steps",title:"Пилот",points:[{label:"1. Собрать",text:"Общая папка и шаблон."},{label:"2) Проверить",text:"Обсудить результат."}]});
  const candidate=composePresentation(run.input.document,JSON.stringify(answer));
  assert.equal(candidate.doc.slides[1].body,"Собрать\nОбщая папка и шаблон.\n\nПроверить\nОбсудить результат.");
});


test("the chosen Focus 3 profile pins brand v2, recipe guidance and verified image references",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation({...creationInput(),profile:"focus-v3"}),run=await f.service.claim();
  assert.equal(run.input.document.design,"focus-v3");assert.equal(run.input.document.brand.version,2);assert.equal(run.input.document.brand.paper,"#F6F6F3");
  assert.ok(run.input.designProfile.authoring.recipes.content.budgets.wordsPerPart);
  assert.equal(run.input.designProfile.fontSnapshot.profile,'focus-v3');
  assert.deepEqual(run.input.designProfile.fontSnapshot.files.map(f=>f.file),['IBMPlexSans-Regular.ttf','IBMPlexSans-SemiBold.ttf','IBMPlexMono-Medium.ttf','OFL-IBMPlexSans.txt','OFL-IBMPlexMono.txt']);
  const images=await creationReferenceImages(run.input.designProfile);assert.equal(images.length,3);
  const changed=structuredClone(run.input.designProfile);changed.references[0].sha256="0".repeat(64);
  await assert.rejects(creationReferenceImages(changed),/изменился/);
  const escaped=structuredClone(run.input.designProfile);escaped.references[0].file="../../secret.png";
  await assert.rejects(creationReferenceImages(escaped),/вне выбранного/);
  const answer=JSON.parse(creationOutput());answer.slides[0].title="Библиотека команды";answer.slides[0].titleAccent="Материалы и идеи";
  answer.slides[1].points=[
    {label:"Найти материалы",text:"Коллега находит нужную презентацию в общей папке проекта и проверяет дату обновления."},
    {label:"Взять за основу",text:"Автор копирует подходящую презентацию и адаптирует содержание под новую встречу с командой."},
    {label:"Обсудить правки",text:"Рецензент оставляет замечание на слайде; автор видит предложение и принимает нужные изменения."},
  ];
  answer.slides[2].title="Проверим вместе\nна одной команде";
  answer.slides[2].text="Выберите одну команду и соберите её материалы. После первой встречи обсудите, что помогло подготовке и какие правки нужны в библиотеке.";
  await f.service.complete(run,JSON.stringify(answer));
  const p=await f.db.repository(a.id).read();assert.equal(p.state.doc.design,"focus-v3");assert.match(p.state.doc.slides[0].title,/\nМатериалы и идеи/);assert.equal(p.state.doc.slides[1].layout,"content");
});

test("a six-line heading cannot pass creation design review",async t=>{
  const f=await fixture(t),a=await f.service.startPresentation(creationInput()),run=await f.service.claim();
  const answer=JSON.parse(creationOutput());answer.slides[1].title="Автор использует готовую основу и сохраняет контроль";
  assert.throws(()=>composePresentation(run.input.document,JSON.stringify(answer)),/Заголовок занимает 6 строк/);
});

test('edits carry the actual design and cannot introduce a six-line heading or save a partial proposal',async t=>{
 const f=await fixture(t),run=await f.enqueue();
 assert.equal(run.input.design.id,f.doc.design);assert.deepEqual(run.input.design.brand,f.doc.brand);
 assert.equal(run.input.designProfile.id,'focus-v2');
 const raw=f.output(run,'Автор использует готовую основу и сохраняет контроль');
 await assert.rejects(f.service.checkEdit(run,raw),/Заголовок занимает/);
 await assert.rejects(f.service.complete(run,raw),/Заголовок занимает/);
 const p=await f.db.repository(f.doc.id).read();assert.equal(p.state.proposals.length,0);assert.equal(p.state.revision,1);assert.deepEqual(p.state.doc,f.doc);
});

test('unchanged inherited title warnings do not block a valid body edit',async t=>{
 const f=await fixture(t),doc=structuredClone(f.doc);doc.slides[0].title='Автор использует готовую основу и сохраняет контроль';
 await f.human({action:'save',doc});
 const run=await f.enqueue({expectedRevision:2,selection:{slideId:doc.slides[0].id,field:'body'}});
 const raw=JSON.stringify({reply:'Пояснение уточнено.',title:'Пояснение',commands:[{op:'set_body',slideId:run.selection.slideId,value:'Города поддерживали ремесло и обмен.'}]});
 await f.service.checkEdit(run,raw);await f.service.complete(run,raw);
 const p=await f.db.repository(f.doc.id).read();assert.equal(p.state.proposals.length,1);assert.equal(p.state.doc.slides[0].title,doc.slides[0].title);
});

test('the text-edit capability cannot silently change layout',async t=>{
 const f=await fixture(t),run=await f.enqueue({selection:{slideId:f.doc.slides[0].id,field:null}});
 const raw=JSON.stringify({reply:'Изменено',title:'Композиция',commands:[{op:'set_layout',slideId:run.selection.slideId,value:'content'}]});
 await assert.rejects(f.service.complete(run,raw),/только правки/);
 assert.equal((await f.db.repository(f.doc.id).read()).state.proposals.length,0);
});

test('Focus 3 edits preserve the cover accent and the current custom brand',async t=>{
 const f=await fixture(t),profile=await creationProfile('focus-v3'),doc=structuredClone(f.doc);
 doc.id=randomUUID();doc.design='focus-v3';doc.brand={...profile.brand,company:'MY TEAM'};doc.slides[0].title='Библиотека команды\nМатериалы и идеи';
 await f.db.create(randomUUID(),doc);const sessionId=await f.db.ensureSession(doc.id);
 await f.service.enqueue(sessionId,f.input());const run=await f.service.claim();
 assert.deepEqual(run.input.designProfile.brand,doc.brand);
 await assert.rejects(f.service.complete(run,f.output(run,'Библиотека команды')),/цветовой акцент/);
});


test("creation material is stored atomically, delivered in context and protected on retry",async t=>{
 const f=await fixture(t),input={...creationInput(),material:{name:'Отчёт отдела',text:'За август 2026 обработано 42 заявки. Единица: заявки.'}};
 const a=await f.service.startPresentation(input),again=await f.service.startPresentation(input);assert.deepEqual(a,again);
 const p=await f.db.repository(a.id).read(),source=p.state.sources[0];assert.equal(p.state.sources.length,1);assert.equal(source.excerpt,input.material.text);assert.equal(canPopulateDraft(p),true);
 const blobs=await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.db.tenant,a.id,`materials/${source.sha256}.bin`]);assert.equal(blobs.rows[0].bytes.toString('utf8'),input.material.text);
 const run=await f.service.claim();assert.equal(run.input.sources[0].id,source.id);assert.equal(run.input.sources[0].excerpt,input.material.text);
 await assert.rejects(f.service.startPresentation({...input,material:{...input.material,text:'Другая версия'}}),/Ключ повтора/);
 const tampered=structuredClone(p);tampered.state.sources[0].excerpt='Подмена';assert.equal(canPopulateDraft(tampered),false);tampered.state.sources=[];assert.equal(canPopulateDraft(tampered),false);
 await f.service.cancel(a.sessionId,run.id,randomUUID());await f.service.retryCreation(a.sessionId,randomUUID());const retry=await f.service.claim();assert.deepEqual(retry.input.sources,run.input.sources);
});

test('daily usage reserves the last queue slot atomically and rejects new shells without losing receipts',async t=>{
 const f=await fixture(t);let lastInput,lastResult;
 for(let i=0;i<19;i++){
   lastInput=f.input({mode:'discuss'});lastResult=await f.service.enqueue(f.sessionId,lastInput);
   const run=await f.service.claim();await f.service.completeNative(run,'Ответ');
 }
 const usage=await f.service.usage();assert.equal(usage.used,19);assert.equal(usage.remaining,1);assert.equal(usage.queued,0);assert.match(usage.resetsAt,/T00:00:00.000Z$/);
 const raced=await Promise.allSettled([f.service.enqueue(f.sessionId,f.input({mode:'discuss'})),f.service.enqueue(f.sessionId,f.input({mode:'discuss'}))]);
 assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.match(raced.find(r=>r.status==='rejected').reason.message,/Лимит Lanka/);
 assert.equal((await f.service.usage()).remaining,0);assert.equal((await f.service.usage()).queued,1);
 assert.deepEqual(await f.service.enqueue(f.sessionId,lastInput),lastResult);
 const shellId=randomUUID();await assert.rejects(f.service.startPresentation({requestId:shellId,prompt:'Новая дека'}),/Лимит Lanka/);
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.db.tenant,shellId])).rowCount,0);
 const run=await f.service.claim();assert.ok(run);await f.service.completeNative(run,'Последний ответ');
 assert.equal((await f.service.usage()).used,20);assert.equal((await f.service.usage()).queued,0);
 const before=await f.service.view(f.sessionId);
 await assert.rejects(f.service.enqueue(f.sessionId,f.input()),/Текст не отправлен/);
 assert.deepEqual(await f.service.view(f.sessionId),before);
 // A queued-yesterday job that starts today counts today; creation timestamps must not discount it.
 await f.db.pool.query("UPDATE lanka.jobs SET created_at=created_at-interval '1 day' WHERE tenant_id=$1",[f.db.tenant]);
 assert.equal((await f.service.usage()).used,20);
 // Simulate yesterday's start events in this isolated fixture, not the owner's usage.
 await f.db.pool.query("UPDATE lanka.agent_events SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 second' WHERE tenant_id=$1 AND kind='run.started'",[f.db.tenant]);
 assert.equal((await f.service.usage()).remaining,20);
 const other=await fixture(t);assert.equal((await other.service.usage()).used,0);
});

test('local worker never claims external work or resets external conversations',async t=>{
 const f=await fixture(t);
 const links=await f.db.pool.query('SELECT material_id FROM lanka.agent_session_materials WHERE tenant_id=$1 AND session_id=$2',[f.db.tenant,f.sessionId]);
 assert.deepEqual(links.rows,[{material_id:f.doc.id}]);
 await f.service.enqueue(f.sessionId,f.input());
 await f.db.pool.query("INSERT INTO lanka.agent_connections(tenant_id,owner_id,id,enabled) VALUES($1,$2,'external-mcp',true)",[f.db.tenant,f.db.owner]);
 await f.db.pool.query("UPDATE lanka.agent_sessions SET connection_id='external-mcp',native_thread_id='external-thread' WHERE tenant_id=$1 AND id=$2",[f.db.tenant,f.sessionId]);
 assert.equal(await f.service.claim(),null);
 await f.service.setEnabled(false);
 const s=(await f.db.pool.query('SELECT context_epoch,native_thread_id FROM lanka.agent_sessions WHERE tenant_id=$1 AND id=$2',[f.db.tenant,f.sessionId])).rows[0];
 assert.equal(s.context_epoch,1);assert.equal(s.native_thread_id,'external-thread');
 const jobs=await f.db.pool.query('SELECT status FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2',[f.db.tenant,f.sessionId]);assert.equal(jobs.rows[0].status,'queued');
 await f.db.pool.query("UPDATE lanka.jobs SET status='running',lease_until=now()-interval '1 minute' WHERE tenant_id=$1 AND session_id=$2",[f.db.tenant,f.sessionId]);
 await f.service.recoverExpired();
 assert.equal((await f.db.pool.query('SELECT status FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2',[f.db.tenant,f.sessionId])).rows[0].status,'running');
});

test('native input authorization requires the live owner, fence and lease',async t=>{
 const f=await fixture(t),run=await f.enqueue();
 await f.service.authorizeInput(run);
 await assert.rejects(f.service.authorizeInput({...run,fence:run.fence+1}),/RUN_FENCED/);
 const otherDb=new ChatDatabase({...config,tenantId:f.db.tenant,ownerId:randomUUID()});
 t.after(()=>otherDb.close());
 await assert.rejects(new ChatService(otherDb).authorizeInput(run));
 await f.db.pool.query("UPDATE lanka.jobs SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.db.tenant,run.id]);
 await assert.rejects(f.service.authorizeInput(run),/RUN_FENCED/);
 await f.service.cancel(f.sessionId,run.id,randomUUID());
 await assert.rejects(f.service.authorizeInput(run),/RUN_FENCED/);
});

test('native input HTTP routes preserve scope and answer at most once',async t=>{
 const {createServer}=await import('node:http');const {EventEmitter}=await import('node:events');
 const {UserInputSession}=await import('../../runtime/user-input-session.mjs');
 const f=await fixture(t),run=await f.enqueue(),controller=new AbortController();
 const native=new EventEmitter();native.attachUserInputGate=g=>native.gate=g;
 const inputSession=new UserInputSession(native,{threadId:'native-private',turnId:'turn-private'});
 const runner=new LocalChatRunner(f.service,{});runner.active={run,controller,input:inputSession};
 t.after(()=>inputSession.close());let writes=0;
 const issue=n=>{native.gate.register({id:n,method:'item/tool/requestUserInput',params:{threadId:'native-private',turnId:'turn-private',itemId:'item-private',questions:[{id:'q',header:'Confirm',question:'Create proposal?',isOther:false,isSecret:false,options:[{label:'Decline',description:'Do not create'}]}]}},()=>writes++);native.emit('userInputPending',{id:n});};
 const server=createServer(async(req,res)=>{
  try{if(req.method!=='GET'&&(req.method!=='POST'||req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))){res.writeHead(403);res.end('Origin denied');return;}let body='';for await(const chunk of req)body+=chunk;
   await chatApi({db:f.db,service:f.service,runner,connection:{}},req,res,new URL(req.url,'http://127.0.0.1'),async()=>body?JSON.parse(body):{},async()=>{throw Error('Unused');});
  }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Request rejected'}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const get=async()=>{const r=await fetch(origin+'/api/v1/agent-sessions/'+f.sessionId);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');return r.json();};
 const post=(id,sessionId=f.sessionId,runId=run.id)=>fetch(origin+`/api/v1/agent-runs/${runId}/answer-input`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({sessionId,id,answers:{q:{answers:['Decline']}}})});
 issue(1);const view=await get(),id=view.inputRequests[0].id;
 assert.equal(JSON.stringify(view.inputRequests).includes('native-private'),false);
 assert.equal((await fetch(origin+`/api/v1/agent-runs/${run.id}/answer-input`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unrelated.example'},body:'{}'})).status,403);
 assert.equal((await post(id,randomUUID())).status,400);assert.equal((await post(id,f.sessionId,randomUUID())).status,400);assert.equal(writes,0);
 assert.equal((await post(id)).status,200);assert.equal(writes,1);assert.deepEqual((await get()).inputRequests,[]);
 assert.equal((await post(id)).status,400);assert.equal(writes,1);
 issue(2);const second=(await get()).inputRequests[0].id;
 await f.service.cancel(f.sessionId,run.id,randomUUID());
 assert.equal((await post(second)).status,400);assert.equal(writes,1);assert.deepEqual((await get()).inputRequests,[]);
});
