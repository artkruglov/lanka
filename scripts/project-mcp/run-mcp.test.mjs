import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {ProjectClient} from './client.mjs';
import {EventEmitter} from 'node:events';

// Real PostgreSQL + stdio; no model or user documents are involved.
await build({stdin:{contents:`export {ChatDatabase} from './lib/adapters/postgres/chat-database';
export {ChatService} from './lib/agents/chat-service';
export {createWorkspaceDocument} from './lib/adapters/postgres/organization-workspace';
export {saveInstalledDesignIn} from './lib/adapters/postgres/design-package-resolver';
export {bindRevisionDesignIn} from './lib/adapters/postgres/revision-design-package';
export {PostgresMcpRepository} from './lib/adapters/postgres/mcp-repository';
export {scene} from './lib/domain/scene';
export {canvasFromScene} from './lib/domain/canvas';
export {RunMcp} from './lib/agents/run-mcp';
export {LocalChatRunner} from './lib/agents/codex-chat';
export {emptyDraft} from './lib/project/empty-draft';
export {invokeProjectTool} from './scripts/project-mcp/tools';
export {humanCommand} from './scripts/project-mcp/human';
export {fromMarkdown} from './lib/domain/intake';`,resolveDir:process.cwd()},outfile:'.project-runtime/run-mcp-test-exports.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {createWorkspaceDocument,saveInstalledDesignIn,bindRevisionDesignIn,ChatDatabase,ChatService,PostgresMcpRepository,scene,canvasFromScene,RunMcp,invokeProjectTool,humanCommand,fromMarkdown,LocalChatRunner,emptyDraft}=await import('../../.project-runtime/run-mcp-test-exports.mjs');
const installed=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));

async function fixture(t,{blank=false,material,ink}={}) {
  const root=await mkdtemp(join(tmpdir(),'lanka-run-mcp-'));
  const config={...installed,workspaceRoot:root,runtimeRoot:join(root,'runtime'),tenantId:randomUUID(),ownerId:randomUUID()};
  const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const db=new ChatDatabase(config);await db.init();const clients=[];
  t.after(async()=>{
    clients.forEach(c=>c.close());
    for(const table of ['agent_events','agent_runs','jobs','agent_messages','agent_sessions','command_receipts','blobs','material_revisions','materials','agent_connections'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);
    await db.close();await rm(root,{recursive:true,force:true});
  });
  const service=new ChatService(db);await service.setEnabled(true);
  let doc;
  if(blank){const {id}=await service.startPresentation({requestId:randomUUID(),prompt:'Расскажи о совместной работе',profile:'focus-v3',...(material?{material}:{})});doc=(await db.repository(id).read()).state.doc;}
  else {doc=fromMarkdown('# Cities\n\n## Writing\nRecords help people share knowledge.\n\n## Exchange\nTrade connects regions.');doc.id=randomUUID();if(ink)doc.brand.ink=ink;await db.create(randomUUID(),doc);}
  const sessionId=await db.ensureSession(doc.id);
  const read=()=>db.repository(doc.id).read();
  const human=async(command)=>{const p=await read();return humanCommand(db.repository(doc.id),{requestId:randomUUID(),deckId:doc.id,expectedRevision:p.state.revision,command});};
  const enqueue=async(overrides={})=>{
    if(!blank)await service.enqueue(sessionId,{requestId:randomUUID(),text:'Уточни заголовок',mode:'edit',expectedRevision:(await read()).state.revision,selection:{slideId:doc.slides[0].id,field:'title'},...overrides});
    const run=await service.claim();assert.ok(run);
    const binding={runId:run.id,fence:run.fence,documentId:doc.id};
    const gate=new RunMcp(db,binding);
    const client=new ProjectClient({configPath,...binding});clients.push(client);
    const call=(name,args={})=>gate.invoke(name,args,()=>invokeProjectTool(gate.repository,name,args));
    const proposal=(overrides={})=>({requestId:randomUUID(),deckId:doc.id,expectedRevision:run.input.revision,title:'Уточнение',commands:[{op:'set_title',slideId:doc.slides[0].id,value:'Общая память'}],...overrides});
    return {run,gate,client,call,proposal};
  };
  return {db,service,sessionId,doc,read,human,enqueue,configPath};
}

test('stdio discussion offers only reads, rejects unlisted writes and stops after cancellation',async t=>{
  const f=await fixture(t),r=await f.enqueue({mode:'discuss'});
  assert.equal((await r.client.call('initialize')).result.serverInfo.name,'lanka-chat-document');
  const catalog=(await r.client.call('tools/list')).result.tools;
  assert.deepEqual(catalog.map(t=>t.name).sort(),['read_conversation','get_project','get_design_profile','get_authoring_guide','get_story','get_briefing_questions','lint_deck','render_slides','suggest_data_size','list_exports','get_export_artifact'].sort());
  assert.ok(catalog.every(t=>t.annotations.readOnlyHint));
  const before=await f.read();assert.equal((await r.client.tool('get_project')).state.doc.id,f.doc.id);
 assert.deepEqual(await r.client.tool('list_exports',{deckId:f.doc.id}),{items:[],nextCursor:null});
 await assert.rejects(r.client.tool('get_export_artifact',{deckId:randomUUID(),artifactId:randomUUID()}),/вне области/);
  for(const name of ['propose_commands','populate_draft','register_source','export_deck','create_deck'])await assert.rejects(r.client.tool(name,r.proposal()),/недоступен/);
  await assert.rejects(r.client.tool('get_story',{deckId:randomUUID()}),/вне области/);
  // Bypassing dispatch still cannot use this repository to write.
  await assert.rejects(invokeProjectTool(r.gate.repository,'propose_commands',r.proposal()),/недоступен/);
  assert.deepEqual(await f.read(),before);
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());
  await assert.rejects(r.client.tool('get_project'),/RUN_FENCED/);
  assert.match((await r.client.call('tools/list')).error.message,/RUN_FENCED/);
});

test('native conversation pages recover prior messages, exclude future requests, and remain fenced',async t=>{
  const f=await fixture(t);
  for(let i=0;i<3;i++){const r=await f.enqueue({mode:'discuss',text:`Earlier ${i}`});await f.service.completeNative(r.run,`Answer ${i}`);}
  const r=await f.enqueue({mode:'discuss',text:'Current'});
  await f.service.enqueue(f.sessionId,{requestId:randomUUID(),mode:'discuss',text:'Future private instruction',expectedRevision:1,selection:{slideId:f.doc.slides[0].id,field:null}});
  const first=await r.client.tool('read_conversation',{}),second=await r.client.tool('read_conversation',{after:first.nextAfter});
  assert.equal(first.items.length,5);assert.equal(second.items.length,1);assert.equal(second.nextAfter,null);
  assert.deepEqual([...first.items,...second.items].map(m=>m.text),['Earlier 0','Answer 0','Earlier 1','Answer 1','Earlier 2','Answer 2']);
  await assert.rejects(r.client.tool('read_conversation',{sessionId:randomUUID()}));
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());
  await assert.rejects(r.client.tool('read_conversation',{}),/RUN_FENCED/);
  const unscoped=new ProjectClient({configPath:f.configPath,documentId:f.doc.id});t.after(()=>unscoped.close());
  assert.ok(!(await unscoped.call('tools/list')).result.tools.some(t=>t.name==='read_conversation'));
});

test('native edit commits one scoped proposal linked to chat; cancellation preserves it and fences replay',async t=>{
  const f=await fixture(t),r=await f.enqueue(),args=r.proposal();
  const result=await r.client.tool('propose_commands',args);
  assert.deepEqual(await r.client.tool('propose_commands',args),result);
  const saved=await f.read(),view=await f.service.view(f.sessionId);
  assert.deepEqual(saved.state.doc,f.doc);assert.equal(saved.state.revision,1);
  assert.equal(saved.state.proposals.length,1);assert.equal(view.messages.at(-1).proposalId,result.proposalId);
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='proposal.ready').length,1);
  await assert.rejects(r.client.tool('propose_commands',r.proposal()),/Одно поручение/);
  assert.deepEqual(await f.read(),saved);
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());
  await assert.rejects(r.client.tool('propose_commands',args),/RUN_FENCED/);
  assert.deepEqual(await f.read(),saved);
  const next=await f.enqueue();
  await assert.rejects(next.client.tool('propose_commands',args),/Ключ повтора/);
  assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,null);
});

test('both proposal tools enforce selected field and slide without saving rejected candidates',async t=>{
  const f=await fixture(t),r=await f.enqueue();
  const badCommands=[{op:'set_body',slideId:f.doc.slides[0].id,value:'Other field'},{op:'set_title',slideId:f.doc.slides[1].id,value:'Other slide'}];
  for(const command of badCommands)await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[command]})),/другое поле|другую область/);
  await assert.rejects(r.client.tool('propose_changes',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Wrong field',changes:[{slideId:f.doc.slides[0].id,after:{...f.doc.slides[0],title:'Новый заголовок',body:'Also replaced body'}}]}),/другое поле/);
  const p=await f.read();assert.deepEqual(p.state.doc,f.doc);assert.equal(p.state.proposals.length,0);
  const events=await f.service.events(f.sessionId,0);assert.ok(!events.some(e=>['proposal.ready','tool.completed'].includes(e.kind)));
  const result=await r.client.tool('propose_changes',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Only title',changes:[{slideId:f.doc.slides[0].id,after:{...f.doc.slides[0],title:'Общая память'}}]});
  assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,result.proposalId);
});

test('document scope permits one batch; replies are bound to selected feedback and the run proposal',async t=>{
  const f=await fixture(t);await f.human({action:'comment',slideId:f.doc.slides[0].id,text:'Сделайте понятнее'});await f.human({action:'comment',slideId:f.doc.slides[1].id,text:'Другой слайд'});
  const comments=(await f.read()).state.comments;
  const first=await f.enqueue();
  await assert.rejects(first.client.tool('reply_to_feedback',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,commentId:comments[1].id,text:'За пределами'}),/вне области/);
  await f.service.cancel(f.sessionId,first.run.id,randomUUID());
  const r=await f.enqueue({selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}});
  const result=await r.client.tool('propose_commands',r.proposal({commands:f.doc.slides.map((s,i)=>({op:'set_title',slideId:s.id,value:`Мысль ${i+1}`})),feedbackIds:comments.map(c=>c.id)}));
  await r.client.tool('reply_to_feedback',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,commentId:comments[0].id,proposalId:result.proposalId,text:'Предлагаю уточнить заголовки.'});
  const p=await f.read();assert.equal(p.state.proposals[0].changes.length,f.doc.slides.length);assert.equal(p.state.comments.at(-1).proposalId,result.proposalId);assert.equal(p.state.comments[0].resolved,false);
});

test('stale revision, wrong document, owner, context, lease and fence fail closed',async t=>{
  const f=await fixture(t),r=await f.enqueue();
  for(const binding of [{runId:r.run.id,fence:r.run.fence+1,documentId:f.doc.id},{runId:r.run.id,fence:r.run.fence,documentId:randomUUID()}])await assert.rejects(new RunMcp(f.db,binding).tools(),/RUN_FENCED/);
  const outsider=new ChatDatabase({...f.db.options,ownerId:randomUUID()});t.after(()=>outsider.close());
  await assert.rejects(new RunMcp(outsider,r.gate.binding).tools(),/RUN_FENCED/);
  const human=structuredClone(f.doc);human.slides[0].title='Ручной заголовок';await f.human({action:'save',doc:human});
  await assert.rejects(r.client.tool('propose_commands',r.proposal()),/Revision conflict/);
  await assert.rejects(r.client.tool('propose_commands',r.proposal({expectedRevision:2})),/Исходная версия/);
  assert.deepEqual((await f.read()).state.doc,human);
  await f.db.pool.query("UPDATE lanka.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.db.tenant,r.run.id]);
  await assert.rejects(r.gate.tools(),/RUN_FENCED/);
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());
  const next=await f.enqueue();
  await f.db.pool.query('UPDATE lanka.agent_sessions SET context_epoch=context_epoch+1 WHERE tenant_id=$1 AND id=$2',[f.db.tenant,f.sessionId]);
  await assert.rejects(next.gate.tools(),/RUN_FENCED/);
});

test('cancellation between authorization and mutation, and during a read, releases no late result',async t=>{
  const f=await fixture(t),r=await f.enqueue();
  await r.gate.authorize('propose_commands',r.proposal());
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  const read=r.gate.invoke('get_project',{},async()=>{started();await new Promise(resolve=>{release=resolve;});return {secret:'late document'};});
  await began;await f.service.cancel(f.sessionId,r.run.id,randomUUID());release();
  await assert.rejects(read,/RUN_FENCED/);
  await assert.rejects(invokeProjectTool(r.gate.repository,'propose_commands',r.proposal()),/RUN_FENCED/);
  assert.equal((await f.read()).state.proposals.length,0);
});

test('failure after candidate validation rolls back proposal, chat linkage, events and receipt atomically',async t=>{
  const f=await fixture(t),r=await f.enqueue(),args=r.proposal();
  const after=r.gate.after.bind(r.gate);
  r.gate.after=async(...a)=>{await after(...a);throw new Error('injected before commit');};
  const before=await f.read();await assert.rejects(r.call('propose_commands',args),/injected/);
  assert.deepEqual(await f.read(),before);assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,null);
  assert.ok(!(await f.service.events(f.sessionId,0)).some(e=>['proposal.ready','tool.completed'].includes(e.kind)));
  r.gate.after=async(c,...a)=>{await c.query("UPDATE lanka.jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.db.tenant,r.run.id]);return after(c,...a);};
  await assert.rejects(r.call('propose_commands',args),/RUN_FENCED/);assert.deepEqual(await f.read(),before);
  r.gate.after=after;await r.call('propose_commands',args);assert.equal((await f.read()).state.proposals.length,1);
});

test('create-mode MCP fills only the authorized pristine draft and preserves its chosen design',async t=>{
  const f=await fixture(t,{blank:true}),r=await f.enqueue({mode:'create',selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}});
  const tools=(await r.client.call('tools/list')).result.tools.map(t=>t.name);assert.ok(tools.includes('populate_draft'));assert.ok(!tools.includes('create_deck'));assert.ok(!tools.includes('propose_commands'));
  const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));
  const args={requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,slides:[seed.doc.slides[0],seed.doc.slides[8]].map(s=>({...s,sourceIds:[]})),briefing:{audience:{value:'Команда',origin:'user'}}};
  const result=await r.client.tool('populate_draft',args);assert.deepEqual(await r.client.tool('populate_draft',args),result);
  const p=await f.read();assert.equal(p.state.revision,2);assert.equal(p.state.doc.title,f.doc.title);assert.deepEqual(p.state.doc.brand,f.doc.brand);assert.equal(p.state.doc.design,'focus-v3');assert.equal(p.state.doc.slides.length,2);
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='document.created').length,1);
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());await assert.rejects(r.client.tool('populate_draft',args),/RUN_FENCED/);assert.deepEqual(await f.read(),p);
});

test('human feedback protects a creation shell even without a revision increment',async t=>{
  const f=await fixture(t,{blank:true}),r=await f.enqueue();
  await f.human({action:'comment',slideId:f.doc.slides[0].id,text:'Сначала обсудим структуру'});
  const before=await f.read();assert.equal(before.state.revision,1);
  const slide={...f.doc.slides[0],title:'Совместная работа\nЛюди и агенты'};
  await assert.rejects(r.client.tool('populate_draft',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,slides:[slide]}),/Заготовка уже/);
  assert.deepEqual(await f.read(),before);
});

test('disconnect and trash revoke an already authorized write',async t=>{
  for(const action of ['disconnect','trash']) {
    const f=await fixture(t),r=await f.enqueue(),args=r.proposal();
    await r.gate.authorize('propose_commands',args);
    if(action==='disconnect')await f.service.setEnabled(false);
    else await f.db.catalogCommand(randomUUID(),f.doc.id,{action:'trash_document',trashed:true});
    await assert.rejects(invokeProjectTool(r.gate.repository,'propose_commands',args),/RUN_FENCED/);
    if(action==='trash')await f.db.catalogCommand(randomUUID(),f.doc.id,{action:'trash_document',trashed:false});
    assert.equal((await f.read()).state.proposals.length,0);
  }
});

test('native finalization requires candidate preview, is atomic/replayable and never creates a duplicate',async t=>{
  const f=await fixture(t),r=await f.enqueue();
  const {proposalId}=await r.client.tool('propose_commands',r.proposal());
  await assert.rejects(f.service.completeNative(r.run,'Предложение готово'),/NATIVE_PREVIEW_REQUIRED/);
  await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:1,slideIds:[f.doc.slides[0].id]});
  await assert.rejects(f.service.completeNative(r.run,'Предложение готово'),/NATIVE_PREVIEW_REQUIRED/);
  await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:1,slideIds:[f.doc.slides[0].id],proposalId});
  const before=await f.service.view(f.sessionId);
  assert.equal(before.active.activity,'Проверяет вид слайдов');
  await assert.rejects(f.service.completeNative(r.run,'Предложение готово',()=>{throw new Error('crash');}),/crash/);
  assert.deepEqual(await f.service.view(f.sessionId),before);
  assert.deepEqual(await f.service.completeNative(r.run,'Предложение готово'),{proposalId});
  assert.deepEqual(await f.service.completeNative(r.run,'Предложение готово'),{proposalId});
  await assert.rejects(f.service.completeNative(r.run,'Другой ответ'),/Ключ повтора/);
  const p=await f.read(),view=await f.service.view(f.sessionId);
  assert.equal(p.state.proposals.length,1);assert.deepEqual(p.state.doc,f.doc);
  assert.equal(view.messages.at(-1).proposalId,proposalId);assert.equal(view.messages.at(-1).status,'complete');
  assert.equal((await f.service.events(f.sessionId,0)).filter(e=>e.kind==='proposal.ready').length,1);
});

test('automatic chat title can be named once, manual titles remain protected, create needs saved preview',async t=>{
  const f=await fixture(t,{blank:true}),r=await f.enqueue();
  assert.equal((await r.client.tool('get_project')).canSetTitle,true);
  await assert.rejects(f.service.completeNative(r.run,'Готово'),/NATIVE_CREATION_MISSING/);
  const slides=[{...f.doc.slides[0],title:'Совместная работа\nЛюди и агенты'}];
  await r.client.tool('populate_draft',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Командная работа',slides});
  assert.equal((await f.read()).state.doc.title,'Командная работа');
  await assert.rejects(f.service.completeNative(r.run,'Готово'),/NATIVE_PREVIEW_REQUIRED/);
  await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:2,slideIds:[slides[0].id]});
  await f.service.completeNative(r.run,'Готово');
  assert.equal((await f.service.view(f.sessionId)).active,null);
  const shell=await emptyDraft(randomUUID(),'Название автора','focus-v3');
  await f.db.tx(c=>f.db.createProjectIn(c,randomUUID(),shell,null,[],{},{}));
  const owner=new ProjectClient({configPath:f.configPath,documentId:shell.state.doc.id});t.after(()=>owner.close());
  assert.equal((await owner.tool('get_project')).canSetTitle,false);
  await assert.rejects(owner.tool('populate_draft',{requestId:randomUUID(),deckId:shell.state.doc.id,expectedRevision:1,title:'Подмена',slides}),/Название автора защищено/);
});

// Deterministic protocol double for inference only. Every document operation still
// crosses the real stdio MCP and PG boundary; no user's model/account is called.
function runnerFixture(f,behavior,{extraTool=false}={}) {
  const calls=[],nativeId=randomUUID();let current;
  class Provider extends EventEmitter {
    constructor(client,run){super();this.client=client;this.run=run;this.nativeThreadConfig={mcp_servers:{lanka_document:{args:['binding',run.id,String(run.fence)]}}};}
    async request(name){
      if(name==='thread/read')return {thread:{id:nativeId,turns:[]}};
      if(name==='mcpServerStatus/list') {
        const catalog=(await this.client.call('tools/list')).result.tools;
        return {data:[{name:'lanka_document',tools:Object.fromEntries([...catalog.map(t=>[t.name,{}]),...(extraTool?[['export_deck',{}]]:[])])}]};
      }
      throw new Error('Unexpected provider request');
    }
    async start(cwd,model,options){calls.push({kind:'start',options});return {thread:{id:nativeId}};}
    async resume(id,cwd,model,options){assert.equal(id,nativeId);calls.push({kind:'resume',options});return {thread:{id}};}
    async turn(id,prompt,options){calls.push({kind:'turn',prompt});await options.onStarted(randomUUID());return behavior(this.run,this.client,options,this);}
    attachUserInputGate(gate){this.inputGate?.close();this.inputGate=gate;}
    async releaseAndClose(){this.close();}
    close(){this.inputGate?.close();this.client.close();}
  }
  const connection={options:{runtimeRoot:f.db.options.runtimeRoot},probe:async()=>({status:'ready',model:'test-model'}),
    openRun:async(cwd,run)=>{current=new Provider(new ProjectClient({configPath:f.configPath,documentId:run.materialId,runId:run.id,fence:run.fence}),run);return current;},close(){current?.close();}};
  return {runner:new LocalChatRunner(f.service,connection),calls};
}
async function queue(f,mode='edit'){
  return f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Уточни заголовок',mode,expectedRevision:1,selection:{slideId:f.doc.slides[0].id,field:'title'}});
}

test('UI runner executes MCP edit, links proposal and resumes the exact session in read-only mode',async t=>{
  const f=await fixture(t);let turns=0;
  const {runner,calls}=runnerFixture(f,async(run,client,options)=>{
    turns++;const project=await client.tool('get_project');assert.equal(project.state.doc.id,f.doc.id);
    if(run.mode==='edit'){
      const {proposalId}=await client.tool('propose_commands',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Уточнение',commands:[{op:'set_title',slideId:f.doc.slides[0].id,value:'Общая память'}]});
      await client.tool('render_slides',{deckId:f.doc.id,expectedRevision:1,proposalId,slideIds:[f.doc.slides[0].id]});
    }else await assert.rejects(client.tool('propose_commands',{}),/недоступен/);
    options.onText('Ответ');return 'Ответ';
  });t.after(()=>runner.stop());
  await queue(f);await runner.pump();
  let view=await f.service.view(f.sessionId);assert.equal(view.messages.at(-1).status,'complete');assert.ok(view.messages.at(-1).proposalId);
  await queue(f,'discuss');await runner.pump();view=await f.service.view(f.sessionId);
  assert.equal(view.messages.at(-1).status,'complete');assert.equal(view.messages.at(-1).proposalId,null);
  assert.equal(turns,2);assert.deepEqual(calls.filter(c=>c.kind!=='turn').map(c=>c.kind),['start','resume']);
  for(const call of calls.filter(c=>c.kind!=='turn'))assert.ok(call.options.config.mcp_servers.lanka_document.args.includes('binding'));
  assert.deepEqual((await f.read()).state.doc,f.doc);assert.equal((await f.read()).state.proposals.length,1);
});

test('UI runner stops before inference on a wider native catalog',async t=>{
  const f=await fixture(t),{runner,calls}=runnerFixture(f,()=>{throw new Error('Must not infer');},{extraTool:true});t.after(()=>runner.stop());
  await queue(f);await runner.pump();
  assert.ok(!calls.some(c=>c.kind==='turn'));assert.equal((await f.service.view(f.sessionId)).messages.at(-1).status,'failed');assert.equal((await f.read()).state.proposals.length,0);
});

test('UI runner retains saved results on provider crash, missing preview, and cancellation',async t=>{
  for(const outcome of ['crash','unseen','cancel']) {
    const f=await fixture(t),{runner}=runnerFixture(f,async(run,client,options)=>{
      await client.tool('propose_commands',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Уточнение',commands:[{op:'set_title',slideId:f.doc.slides[0].id,value:'Общая память'}]});
      if(outcome==='cancel'){
        await f.service.cancel(f.sessionId,run.id,randomUUID());
        await assert.rejects(client.tool('get_project'),/RUN_FENCED/);
        return 'Late success';
      }
      if(outcome==='crash')throw new Error('Provider stopped');
      return 'Готово';
    });t.after(()=>runner.stop());
    await queue(f);await runner.pump();
    const view=await f.service.view(f.sessionId),last=view.messages.at(-1);
    assert.equal((await f.read()).state.proposals.length,1);assert.ok(last.proposalId);
    assert.equal(last.status,outcome==='cancel'?'interrupted':'failed');assert.doesNotMatch(last.text,/документ не изменён|Late success/);
    assert.equal(view.active,null);
  }
});

test('preview works in the macOS service environment without Homebrew in PATH',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),r=await f.enqueue({mode:'discuss'});
  const previousPath=process.env.PATH;let client;
  try {process.env.PATH='/usr/bin:/bin';client=new ProjectClient({configPath:f.configPath,documentId:f.doc.id,runId:r.run.id,fence:r.run.fence});}
  finally {if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;}
  t.after(()=>client.close());
  const response=await client.tool('render_slides',{deckId:f.doc.id,expectedRevision:1,slideIds:[f.doc.slides[0].id]});
  assert.ok(response.images?.length||response.imageCount);
});

test('object-scoped native MCP permits selected layer movement but rejects neighbours, background movement and metadata',async t=>{
 const f=await fixture(t),slide=f.doc.slides[0];
 slide.canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
  {id:'chosen',kind:'text',x:100,y:200,w:900,h:150,text:'Selected object',size:40,bold:false,color:'#20243B',lineHeight:1.3,sourceField:'title'},
  {id:'neighbour',kind:'text',x:100,y:500,w:900,h:150,text:'Preserve neighbour',size:40,bold:false,color:'#20243B',lineHeight:1.3}];
 slide.title='Selected object';
 await f.human({action:'save',doc:f.doc});
 const selection={slideId:slide.id,field:null,scope:'element',elementId:'chosen'};
 const r=await f.enqueue({selection});assert.deepEqual(r.run.input.selection,selection);
 const value={...slide.canvas[1],text:'Shortened'};
 for(const command of [
  {op:'set_element',slideId:slide.id,value:{...slide.canvas[2],text:'Wrong'}},
  {op:'edit_text',slideId:slide.id,elementId:'neighbour',value:{text:'Wrong'}},
  {op:'add_element',slideId:slide.id,value:{...value,id:'extra'}},
  {op:'remove_element',slideId:slide.id,elementId:'neighbour'},
 ])await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[command]})),/соседний объект/);
 for(const after of [
  {...slide,title:value.text,notes:'Unrequested note',canvas:slide.canvas.map(e=>e.id===value.id?value:e)},
  {...slide,title:value.text,canvas:[value,slide.canvas[0],slide.canvas[2]]},
 ])await assert.rejects(r.client.tool('propose_changes',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:r.run.input.revision,title:'Too broad',changes:[{slideId:slide.id,after}]}),/соседний объект|положение заблокированного объекта защищено/);
 assert.equal((await f.read()).state.proposals.length,0);
 assert.ok(!(await f.service.events(f.sessionId,0)).some(e=>e.kind==='proposal.ready'));
 const result=await r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:slide.id,value},{op:'reorder_element',slideId:slide.id,elementId:'chosen',direction:'front'}]}));
 const p=await f.read();assert.deepEqual(p.state.doc,f.doc);assert.equal(p.state.proposals[0].id,result.proposalId);assert.equal(p.state.proposals[0].changes[0].after.title,'Shortened');
 assert.deepEqual(p.state.proposals[0].changes[0].after.canvas.map(e=>e.id),['bg','neighbour','chosen']);
 assert.deepEqual(p.state.proposals[0].changes[0].after.canvas[1],slide.canvas[2]);
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());
 await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:slide.id,value}]})),/RUN_FENCED/);
});

test('object selection rejects missing, locked and ambiguous targets before queueing',async t=>{
 const f=await fixture(t),slide=f.doc.slides[0];
 slide.canvas=[{id:'locked',kind:'rect',x:100,y:100,w:600,h:300,color:'#FFFFFF',locked:true}];
 await f.human({action:'save',doc:f.doc});
 const selection={slideId:slide.id,field:null,scope:'element',elementId:'locked'};
 const send=s=>f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Change it',mode:'edit',expectedRevision:2,selection:s});
 await assert.rejects(send(selection),/заблокирован/);
 await assert.rejects(send({...selection,elementId:'missing'}),/объект недоступен/);
 await assert.rejects(send({...selection,scope:'document'}),/области объекта/);
 await assert.rejects(send({...selection,field:'title'}),/области объекта/);
 await assert.rejects(send({slideId:slide.id,field:null,scope:'element'}),/области объекта/);
 assert.equal((await f.service.view(f.sessionId)).messages.length,0);
});

test('object comments pin saved quotes, survive deletion and restrict feedback to the run object',async t=>{
 const f=await fixture(t),slide=f.doc.slides[0];
 slide.canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
  {id:'chosen',kind:'text',x:100,y:200,w:900,h:150,text:'Original wording',size:40,bold:false,color:'#20243B',lineHeight:1.3},
  {id:'neighbour',kind:'text',x:100,y:500,w:900,h:150,text:'Other object',size:40,bold:false,color:'#20243B',lineHeight:1.3}];
 await f.human({action:'save',doc:f.doc});
 await f.human({action:'comment',slideId:slide.id,elementId:'chosen',text:'Make this clearer'});
 await f.human({action:'comment',slideId:slide.id,elementId:'neighbour',text:'Different review'});
 await f.human({action:'comment',slideId:slide.id,text:'Keep the slide concise'});
 const p=await f.read(),[chosen,neighbour,general]=p.state.comments;
 assert.deepEqual(chosen.anchor,{elementId:'chosen',quote:'Original wording',revision:2});assert.equal(general.anchor,undefined);
 await assert.rejects(f.human({action:'comment',slideId:slide.id,elementId:'missing',text:'Wrong target'}),/Объект комментария недоступен/);
 assert.deepEqual(await f.read(),p);
 const r=await f.enqueue({selection:{slideId:slide.id,field:null,scope:'element',elementId:'chosen'}});
 assert.deepEqual(r.run.input.comments.map(c=>c.id),[chosen.id,general.id]);assert.deepEqual(r.run.input.comments[0].anchor,chosen.anchor);
 await assert.rejects(r.client.tool('reply_to_feedback',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:2,commentId:neighbour.id,text:'Wrong discussion'}),/Замечание вне области/);
 const commands=[{op:'set_element',slideId:slide.id,value:{...slide.canvas[1],text:'Clear wording'}}];
 await assert.rejects(r.client.tool('propose_commands',r.proposal({commands,feedbackIds:[neighbour.id]})),/Замечание вне области/);
 const proposal=await r.client.tool('propose_commands',r.proposal({commands,feedbackIds:[chosen.id]}));
 const reply=await r.client.tool('reply_to_feedback',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:2,commentId:chosen.id,text:'Proposed a clearer version',proposalId:proposal.proposalId});
 assert.deepEqual((await f.read()).state.comments.find(c=>c.id===reply.commentId).anchor,chosen.anchor);
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());
 const next=(await f.read()).state.doc;next.slides[0].canvas=next.slides[0].canvas.filter(e=>e.id!=='chosen');await f.human({action:'save',doc:next});
 const orphan=(await f.read()).state.comments.find(c=>c.id===chosen.id);assert.deepEqual(orphan.anchor,chosen.anchor);
 await f.human({action:'resolve_comment',commentId:chosen.id});assert.equal((await f.read()).state.comments.find(c=>c.id===chosen.id).resolved,true);
});

test('slide-scoped native MCP recolors a layout-locked background and preserves human approval',async t=>{
  const f=await fixture(t),p=await f.read(),doc=p.state.doc,s=doc.slides[0];
  s.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'text',kind:'text',x:100,y:150,w:1000,h:120,text:'Keep every word',size:40,bold:false,color:'#20243B',lineHeight:1.3},{id:'rule',kind:'rect',x:100,y:350,w:600,h:1,color:'#20243B'}];
  await f.human({action:'save',doc});
  const r=await f.enqueue({selection:{slideId:s.id,field:null,scope:'slide'},text:'Make the slide dark, preserve all words'});
  await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:{...s.canvas[0],x:1}}]})),/locked/);
  await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:{...s.canvas[0],color:'#101018'}},{op:'set_element',slideId:s.id,value:{...s.canvas[1],color:'#FFFFFF'}}]})),/Разделитель/);
  assert.equal((await f.read()).state.proposals.length,0);
  const result=await r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:{...s.canvas[0],color:'#101018'}},{op:'set_element',slideId:s.id,value:{...s.canvas[1],color:'#FFFFFF'}},{op:'set_element',slideId:s.id,value:{...s.canvas[2],color:'#777777'}}]}));
  const preview=await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:r.run.input.revision,slideIds:[s.id],proposalId:result.proposalId});
  assert.ok(!preview.designIssues.some(i=>i.code?.startsWith('canvas-')));
  const saved=await f.read(),proposal=saved.state.proposals.find(p=>p.id===result.proposalId);
  assert.equal(saved.state.doc.slides[0].canvas[0].color,'#FFFFFF');
  assert.equal(proposal.status,'pending');assert.deepEqual(proposal.changes[0].after.canvas[0],{...s.canvas[0],color:'#101018'});
  assert.equal(proposal.changes[0].after.canvas[1].text,'Keep every word');
  await f.human({action:'review_objects',proposalId:proposal.id,changeId:proposal.changes[0].id,elementIds:['background','text','rule'],decision:'accepted'});
  assert.equal((await f.read()).state.doc.slides[0].canvas[0].color,'#101018');
  await f.service.cancel(f.sessionId,r.run.id,randomUUID());
});

test('background object chat permits fill proposals without unlocking layout or expanding scope',async t=>{
 const f=await fixture(t),s=f.doc.slides[0];
 s.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
  {id:'text',kind:'text',x:100,y:150,w:1000,h:120,text:'Keep every word',size:40,bold:false,color:'#20243B',lineHeight:1.3},
  {id:'locked-overlay',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true}];
 await f.human({action:'save',doc:f.doc});
 const selection={slideId:s.id,field:null,scope:'element',elementId:'background'};
 await assert.rejects(f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Recolor overlay',mode:'edit',expectedRevision:2,selection:{...selection,elementId:'locked-overlay'}}),/заблокирован/);
 const r=await f.enqueue({selection,text:'Change only background fill'});
 const bg=s.canvas[0];
 for(const command of [
  {op:'set_element',slideId:s.id,value:{...bg,x:1}},
  {op:'set_element',slideId:s.id,value:{...bg,locked:false}},
  {op:'remove_element',slideId:s.id,elementId:bg.id},
 ])await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[command]})),/locked/);
 await assert.rejects(r.client.tool('propose_changes',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:2,title:'Unlock background',changes:[{slideId:s.id,after:{...s,canvas:s.canvas.map(e=>e.id===bg.id?{...e,locked:false}:e)}}]}),/заблокирован/);
 await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:{...s.canvas[1],text:'Unrequested'}}]})),/соседний объект/);
 assert.equal((await f.read()).state.proposals.length,0);
 const result=await r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:{...bg,color:'#F0F0F0'}}]}));
 const saved=await f.read(),proposal=saved.state.proposals.find(p=>p.id===result.proposalId);
 assert.deepEqual(saved.state.doc,f.doc);
 assert.equal(proposal.status,'pending');
 assert.deepEqual(proposal.changes[0].after.canvas,[{...bg,color:'#F0F0F0'},...s.canvas.slice(1)]);
 assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,proposal.id);
 await f.human({action:'review_objects',proposalId:proposal.id,changeId:proposal.changes[0].id,elementIds:[bg.id],decision:'accepted'});
 assert.deepEqual((await f.read()).state.doc.slides[0].canvas,proposal.changes[0].after.canvas);
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());
});

test('data-object chat reads its source and proposes a numeric edit through preview and human review',async t=>{
 const f=await fixture(t),s=f.doc.slides[0];
 const source=await invokeProjectTool(new PostgresMcpRepository(f.db,f.doc.id),'register_source',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,name:'Synthetic data.csv',contentType:'text/csv',base64:Buffer.from('department,hours\nResearch,25\nDevelopment,40').toString('base64')});
 s.layout='chart';s.chart=[{label:'Research',value:20},{label:'Development',value:40}];s.chartUnit='hours';
 s.canvas=canvasFromScene(scene(s,f.doc.brand,0,2,f.doc.design));
 const object=s.canvas.find(e=>e.kind==='chart');assert.ok(object);object.data.sourceId=source.sourceId;
 await f.human({action:'save',doc:f.doc});
 const r=await f.enqueue({selection:{slideId:s.id,field:null,scope:'element',elementId:object.id},text:'Change Research from 20 to 25 based on the source'});
 assert.deepEqual(r.run.input.sources.map(v=>v.id),[source.sourceId]);
 assert.match(JSON.stringify(await r.client.tool('get_authoring_guide')),/seriesId/);
 const value=structuredClone(object);value.data.rows[0].value=25;
 const commands=[{op:'set_element',slideId:s.id,value}];
 const invalid=structuredClone(value);invalid.data.sourceId='inaccessible';
 await assert.rejects(r.client.tool('propose_commands',r.proposal({commands:[{op:'set_element',slideId:s.id,value:invalid}]})),/недоступный источник/);
 const {proposalId}=await r.client.tool('propose_commands',r.proposal({commands}));
 const before=await f.read();assert.equal(before.state.doc.slides[0].canvas.find(e=>e.kind==='chart').data.rows[0].value,20);
 await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:r.run.input.revision,slideIds:[s.id],proposalId});
 await f.service.completeNative(r.run,'Предложено 25; диаграмма проверена.');
 const proposal=(await f.read()).state.proposals.find(p=>p.id===proposalId);
 await f.human({action:'review_objects',proposalId,changeId:proposal.changes[0].id,elementIds:[object.id],decision:'accepted'});
 const after=await f.read(),actual=after.state.doc.slides[0].canvas.find(e=>e.id===object.id);
 assert.deepEqual(actual,value);assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,proposalId);
 assert.deepEqual(after.state.doc.slides[0].canvas.filter(e=>e.id!==object.id),before.state.doc.slides[0].canvas.filter(e=>e.id!==object.id));
});


test('native MCP suggests sizes read-only, then review protects space occupied after the proposal',async t=>{
 const f=await fixture(t),s=f.doc.slides[0];
 const chart={id:'chart',kind:'chart',x:100,y:400,w:1000,h:80,style:{design:f.doc.design??'classic-v1',brand:f.doc.brand},data:{seriesId:'series',unit:'hours',rows:[{id:'a',label:'Plan',value:20},{id:'b',label:'Actual',value:40}]}};
 const neighbour={id:'neighbour',kind:'rect',x:100,y:750,w:100,h:20,color:'#CCCCCC'};s.canvas=[chart,neighbour];await f.human({action:'save',doc:f.doc});
 const r=await f.enqueue({selection:{slideId:s.id,field:null,scope:'element',elementId:'chart'},text:'Make the chart readable without moving neighbours'});
 const tools=(await r.client.call('tools/list')).result.tools;assert.equal(tools.find(t=>t.name==='suggest_data_size').annotations.readOnlyHint,true);
 const args={deckId:f.doc.id,expectedRevision:r.run.input.revision,slideId:s.id,elementId:'chart'},before=await f.read();
 const sizes=await r.client.tool('suggest_data_size',args);assert.equal(sizes.status,'options');assert.ok(sizes.options.length);assert.deepEqual((await f.read()).state,before.state);
 await assert.rejects(r.client.tool('suggest_data_size',{...args,expectedRevision:999}),/Revision conflict/);
 await assert.rejects(r.client.tool('suggest_data_size',{...args,deckId:randomUUID()}),/вне области/);
 await assert.rejects(r.client.tool('suggest_data_size',{...args,data:{...chart.data,sourceId:'missing'}}),/недоступный источник/);
 const selected=sizes.options[0].command;const {proposalId}=await r.client.tool('propose_commands',r.proposal({commands:[selected]}));
 await r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:r.run.input.revision,slideIds:[s.id],proposalId});await f.service.completeNative(r.run,'Предложен читаемый размер; соседние объекты сохранены.');
 let p=await f.read(),manual=structuredClone(p.state.doc);manual.slides[0].canvas.find(e=>e.id==='neighbour').y=selected.value.y;manual.slides[0].notes='Keep this manual note';await f.human({action:'save',doc:manual});
 p=await f.read();const proposal=p.state.proposals.find(v=>v.id===proposalId);const review={action:'review_objects',proposalId,changeId:proposal.changes[0].id,elementIds:['chart'],decision:'accepted'};
 await assert.rejects(f.human(review),/Конфликт размещения/);assert.deepEqual((await f.read()).state,p.state);
 manual=structuredClone(p.state.doc);manual.slides[0].canvas.find(e=>e.id==='neighbour').y=750;await f.human({action:'save',doc:manual});await f.human(review);
 p=await f.read();assert.deepEqual(p.state.doc.slides[0].canvas.find(e=>e.id==='chart'),selected.value);assert.equal(p.state.doc.slides[0].notes,'Keep this manual note');
 assert.equal(p.state.doc.slides[0].canvas.find(e=>e.id==='neighbour').y,750);
});


test('native creation MCP preserves supplied source and references it in populated slides',async t=>{
 const material={name:'Тестовый отчёт',text:'Обработано 42 заявки за август 2026.'};
 const f=await fixture(t,{blank:true,material}),r=await f.enqueue();const source=(await f.read()).state.sources[0];
 assert.equal(r.run.input.sources[0].sha256,source.sha256);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));
 const slides=[seed.doc.slides[0],seed.doc.slides[8]].map(s=>({...s,sourceIds:[source.id]}));
 await r.client.tool('populate_draft',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,slides});
 const saved=await f.read();assert.equal(saved.state.revision,2);assert.deepEqual(saved.state.sources,[source]);assert.deepEqual(saved.state.doc.slides.map(s=>s.sourceIds),[[source.id],[source.id]]);
});

test('creation question persists, answer resumes same draft once and completed deck still needs preview',async t=>{
  const f=await fixture(t,{blank:true}),r=await f.enqueue(),before=await f.read();
  const a={requestId:randomUUID(),question:'Для какой аудитории готовим презентацию?'};
  assert.ok((await r.client.call('tools/list')).result.tools.some(x=>x.name==='ask_creation_question'));
  const q=await r.client.tool('ask_creation_question',a);
  assert.deepEqual(await r.client.tool('ask_creation_question',a),q);
  await assert.rejects(r.client.tool('ask_creation_question',{...a,question:'Другой вопрос'}),/Вопрос уже/);
  await assert.rejects(r.client.tool('populate_draft',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,slides:f.doc.slides}),/Дождитесь ответа/);
  assert.equal((await f.service.view(f.sessionId)).creationQuestion,undefined);
  await f.service.completeNative(r.run,'Жду уточнения.');
  assert.deepEqual(await f.read(),before);
  let view=await f.service.view(f.sessionId);
  assert.equal(view.active,null);assert.deepEqual(view.creationQuestion,q);
  await assert.rejects(f.service.retryCreation(f.sessionId,randomUUID()),/Ответьте на вопрос/);
  assert.equal(view.messages.at(-1).text,a.question);assert.equal(view.messages.at(-1).status,'complete');
  const reply={requestId:randomUUID(),text:'Для руководителей поддержки, 3 слайда.',mode:'edit',creationQuestionId:q.id,expectedRevision:1,selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}};
  const [one,two]=await Promise.all([f.service.enqueue(f.sessionId,reply),f.service.enqueue(f.sessionId,reply)]);assert.deepEqual(one,two);
  await assert.rejects(f.service.enqueue(f.sessionId,{...reply,requestId:randomUUID()}),/Вопрос уже обработан/);
  assert.equal((await f.service.view(f.sessionId)).creationQuestion,undefined);
  const next=await f.service.claim();assert.equal(next.mode,'create');assert.equal(next.sessionId,r.run.sessionId);assert.equal(next.materialId,r.run.materialId);
  assert.equal(next.text,reply.text);
  const gate=new RunMcp(f.db,{runId:next.id,fence:next.fence,documentId:f.doc.id});
  const history=await gate.conversation({});assert.ok(history.items.some(m=>m.text===a.question));assert.ok(history.items.some(m=>m.text==='Расскажи о совместной работе'));
  const call=(name,args)=>gate.invoke(name,args,()=>invokeProjectTool(gate.repository,name,args));
  const slides=[{...f.doc.slides[0],title:'Поддержка\nИ знания'}];
  await call('populate_draft',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,slides});
  await assert.rejects(f.service.completeNative(next,'Создано'),/NATIVE_PREVIEW_REQUIRED/);
  await call('render_slides',{deckId:f.doc.id,expectedRevision:2,slideIds:[slides[0].id]});
  await f.service.completeNative(next,'Создано');
  assert.deepEqual(await f.service.enqueue(f.sessionId,reply),one); // lost response after revision changed
  assert.equal((await f.read()).state.revision,2);
});

test('creation questions respect cancellation, mode and intervening human edits',async t=>{
  const f=await fixture(t,{blank:true}),r=await f.enqueue();
  const q=await r.client.tool('ask_creation_question',{requestId:randomUUID(),question:'Кому покажем?'});
  await f.service.completeNative(r.run,'Вопрос');
  const edited=structuredClone(f.doc);edited.slides[0].title='Ручная работа';await f.human({action:'save',doc:edited});
  const before=await f.read();
  await assert.rejects(f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Директорам',mode:'edit',creationQuestionId:q.id,expectedRevision:2,selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}}),/новом пустом черновике/);
  assert.deepEqual(await f.read(),before);assert.deepEqual((await f.service.view(f.sessionId)).creationQuestion,q);
  const g=await fixture(t),d=await g.enqueue({mode:'discuss'});
  await assert.rejects(d.client.tool('ask_creation_question',{requestId:randomUUID(),question:'Нельзя'}),/недоступен/);
  const h=await fixture(t,{blank:true}),c=await h.enqueue();
  await c.client.tool('ask_creation_question',{requestId:randomUUID(),question:'Вопрос до отмены'});
  await h.service.cancel(h.sessionId,c.run.id,randomUUID());
  await assert.rejects(c.client.tool('ask_creation_question',{requestId:randomUUID(),question:'Поздний вопрос'}),/RUN_FENCED/);
  assert.equal((await h.service.view(h.sessionId)).creationQuestion,undefined);
});

test('a follow-up clarification must use a new identity and exposes only its pending question',async t=>{
 const f=await fixture(t,{blank:true}),r=await f.enqueue();
 const a={requestId:randomUUID(),question:'Кому покажем?'};
 const q=await r.client.tool('ask_creation_question',a);await f.service.completeNative(r.run,'Вопрос');
 await f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Руководителям',mode:'edit',creationQuestionId:q.id,expectedRevision:1,selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}});
 const next=await f.service.claim(),gate=new RunMcp(f.db,{runId:next.id,fence:next.fence,documentId:f.doc.id});
 await assert.rejects(gate.question(a),/Идентификатор вопроса уже/);
 const second=await gate.question({requestId:randomUUID(),question:'Какое решение нужно принять?'});
 await f.service.completeNative(next,'Уточнение');
 assert.deepEqual((await f.service.view(f.sessionId)).creationQuestion,second);
});

test('brief proposal requires whole-document edit run, links to chat and fences retries after cancellation',async t=>{
 const f=await fixture(t),slideRun=await f.enqueue();
 const args={requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Уточнить аудиторию',fields:{audience:'Совет директоров'}};
 assert.ok(!(await slideRun.client.call('tools/list')).result.tools.some(t=>t.name==='propose_brief'));
 await assert.rejects(slideRun.client.tool('propose_brief',args));await assert.rejects(invokeProjectTool(slideRun.gate.repository,'propose_brief',args),/недоступен|области/);
 await f.service.cancel(f.sessionId,slideRun.run.id,randomUUID());
 const r=await f.enqueue({selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}});
 assert.ok((await r.client.call('tools/list')).result.tools.some(t=>t.name==='propose_brief'));
 const result=await r.client.tool('propose_brief',args);assert.deepEqual(await r.client.tool('propose_brief',args),result);
 const saved=await f.read();assert.deepEqual(saved.state.doc,f.doc);assert.equal(saved.state.proposals.length,1);assert.equal(saved.state.proposals[0].briefChanges[0].after,'Совет директоров');
 assert.equal((await f.service.view(f.sessionId)).messages.at(-1).proposalId,result.proposalId);
 await assert.rejects(r.client.tool('propose_brief',{...args,requestId:randomUUID()}),/Одно поручение/);
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());await assert.rejects(r.client.tool('propose_brief',args),/RUN_FENCED/);
 assert.deepEqual(await f.read(),saved);
});


test('UI runner completes brief-only review without pretending it is a slide preview',async t=>{
 const f=await fixture(t);const {runner}=runnerFixture(f,async(run,client,options)=>{
  await client.tool('propose_brief',{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:1,title:'Замысел',fields:{decision:'Согласовать план'}});options.onText('Предложение замысла готово');return 'Предложение замысла готово';
 });t.after(()=>runner.stop());
 await f.service.enqueue(f.sessionId,{requestId:randomUUID(),text:'Уточни замысел',mode:'edit',expectedRevision:1,selection:{slideId:f.doc.slides[0].id,field:null,scope:'document'}});await runner.pump();
 const view=await f.service.view(f.sessionId);assert.equal(view.messages.at(-1).status,'complete');assert.ok(view.messages.at(-1).proposalId);assert.deepEqual((await f.read()).state.doc,f.doc);
});


test('stdio design profile preserves captured rules and document brand instead of rereading the installed package',async t=>{
 const f=await fixture(t,{ink:'#123456'}),doc=structuredClone((await f.read()).state.doc);
 const r=await f.enqueue();
 const pinned=structuredClone(r.run.input.designProfile);assert.equal(pinned.brand.ink,'#123456');
 // Model a queued snapshot from before a package upgrade, without touching installed files.
 pinned.authoring.instruction='Captured authoring rules before the upgrade';
 await f.db.pool.query("UPDATE lanka.agent_runs SET input_manifest=jsonb_set(input_manifest,'{designProfile}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.db.tenant,r.run.id,JSON.stringify(pinned)]);
 const actual=await r.client.tool('get_design_profile',{profile:doc.design});assert.deepEqual(actual,pinned);
 const wrong=await r.client.call('tools/call',{name:'get_design_profile',arguments:{profile:'focus-v3'}});assert.equal(wrong.result.isError,true);assert.match(wrong.result.content[0].text,/вне сохранённого поручения/);
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());
 const cancelled=await r.client.call('tools/call',{name:'get_design_profile',arguments:{profile:doc.design}});assert.equal(cancelled.result.isError,true);
});


test('stdio rejects changed captured font bytes and foreign file names before returning a design profile',async t=>{
 const f=await fixture(t),r=await f.enqueue(),original=structuredClone(r.run.input.designProfile);
 assert.equal(original.fontSnapshot.profile,'focus-v2');assert.equal(original.fontSnapshot.files.length,3);
 for(const [field,value,pattern] of [['sha256','0'.repeat(64),/изменились/],['file','../../outside.ttf',/вне выбранного/]]){
  const profile=structuredClone(original);profile.fontSnapshot.files[0][field]=value;
  await f.db.pool.query("UPDATE lanka.agent_runs SET input_manifest=jsonb_set(input_manifest,'{designProfile}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.db.tenant,r.run.id,JSON.stringify(profile)]);
  const response=await r.client.call('tools/call',{name:'get_design_profile',arguments:{profile:'focus-v2'}});assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,pattern);
 }
});

test('font drift blocks direct authoring and previews while document reads and cancellation remain available',async t=>{
 const f=await fixture(t),r=await f.enqueue(),before=await f.read();
 const profile=structuredClone(r.run.input.designProfile);profile.fontSnapshot.files[0].sha256='0'.repeat(64);
 await f.db.pool.query("UPDATE lanka.agent_runs SET input_manifest=jsonb_set(input_manifest,'{designProfile}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.db.tenant,r.run.id,JSON.stringify(profile)]);
 await assert.rejects(r.client.tool('propose_commands',r.proposal()),/Шрифты.*изменились/);
 await assert.rejects(r.client.tool('render_slides',{deckId:f.doc.id,expectedRevision:1,slideIds:[f.doc.slides[0].id]}),/Шрифты.*изменились/);
 // Exercise the transaction guard independently of invoke's early check.
 await assert.rejects(invokeProjectTool(r.gate.repository,'propose_commands',r.proposal()),/Шрифты.*изменились/);
 assert.deepEqual(await f.read(),before);
 await r.client.tool('get_project');
 assert.ok(!(await f.service.events(f.sessionId,0)).some(e=>e.kind==='proposal.ready'));
 await f.service.cancel(f.sessionId,r.run.id,randomUUID());
 await assert.rejects(r.client.tool('get_project'),/RUN_FENCED/);
});


test('manual saves inherit a pinned package; restoring an older unpinned revision keeps its original status',async t=>{
 const f=await fixture(t);
 try{
  await f.human({action:'save',doc:{...f.doc,title:'Revision two'}});
  await f.db.tx(async c=>{const m=await saveInstalledDesignIn(c,f.db.tenant,'focus-v2');const r=await c.query('SELECT hash FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=2',[f.db.tenant,f.doc.id]);await bindRevisionDesignIn(c,f.db.tenant,{documentId:f.doc.id,revision:2,documentHash:r.rows[0].hash},m.digest);});
  const pins=async()=> (await f.db.pool.query('SELECT revision,package_digest FROM lanka.revision_design_packages WHERE tenant_id=$1 AND material_id=$2 ORDER BY revision',[f.db.tenant,f.doc.id])).rows;
  await f.human({action:'save',doc:{...(await f.read()).state.doc,title:'Revision three'}});
  assert.deepEqual((await pins()).map(p=>p.revision),[2,3]);assert.equal((await pins())[0].package_digest,(await pins())[1].package_digest);
  await f.human({action:'restore',revision:1});
  assert.equal((await f.read()).state.revision,4);assert.deepEqual((await pins()).map(p=>p.revision),[2,3]);
  const repo=new PostgresMcpRepository(f.db,f.doc.id);
  await humanCommand(repo,{requestId:randomUUID(),deckId:f.doc.id,expectedRevision:4,command:{action:'restore',revision:2}});
  assert.deepEqual((await pins()).map(p=>p.revision),[2,3,5]);
 }finally{
  await f.db.pool.query('DELETE FROM lanka.revision_design_packages WHERE tenant_id=$1',[f.db.tenant]);
  await f.db.pool.query('DELETE FROM lanka.design_packages WHERE tenant_id=$1',[f.db.tenant]);
 }
});


test('workspace creation atomically pins the installed package and preserves its receipt',async t=>{
 const f=await fixture(t),id=randomUUID(),cmd={action:'create_document',title:'Pinned workspace draft',folderId:null,empty:true,profile:'focus-v3'};
 try{
  const create=()=>f.db.tx(c=>createWorkspaceDocument(f.db,c,id,cmd));
  const first=await create();assert.deepEqual(await create(),first);
  const pins=(await f.db.pool.query('SELECT package_digest FROM lanka.revision_design_packages WHERE tenant_id=$1 AND material_id=$2 AND revision=1',[f.db.tenant,id])).rows;
  assert.equal(pins.length,1);assert.match(pins[0].package_digest,/^[a-f0-9]{64}$/);
  await assert.rejects(f.db.tx(c=>createWorkspaceDocument(f.db,c,id,{...cmd,profile:'focus-v2'})),/повтора/);
  const aborted=randomUUID();await assert.rejects(f.db.tx(async c=>{await createWorkspaceDocument(f.db,c,aborted,cmd);throw Error('abort creation');}),/abort creation/);
  assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.db.tenant,aborted])).rowCount,0);
  assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.revision_design_packages WHERE tenant_id=$1 AND material_id=$2',[f.db.tenant,aborted])).rowCount,0);
 }finally{
  await f.db.pool.query('DELETE FROM lanka.revision_design_packages WHERE tenant_id=$1',[f.db.tenant]);
  await f.db.pool.query('DELETE FROM lanka.design_packages WHERE tenant_id=$1',[f.db.tenant]);
 }
});
