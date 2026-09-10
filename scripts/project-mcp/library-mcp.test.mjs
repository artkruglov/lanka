import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {ProjectClient} from './client.mjs';
await build({stdin:{contents:'export {fromMarkdown} from "./lib/domain/intake"; export {creationDesignBrand} from "./lib/domain/creation-design"; export {humanCommand} from "./scripts/project-mcp/human"; export {PostgresMcpRepository} from "./lib/adapters/postgres/mcp-repository"; export {DataWindowDraft,browserDataWindowStore,dataRecordSaved} from "./lib/project/data-window-draft"; export {applyDataObjectChange,DataDraftConflict} from "./lib/domain/data-draft"; export {applyDataDraft} from "./lib/domain/data-draft"; export {EditorDraft} from "./lib/project/editor-draft"; export {CommentDraft} from "./lib/project/comment-draft"; export {ChatDatabase} from "./lib/adapters/postgres/chat-database"; export {LibraryStore} from "./scripts/project-mcp/library";',resolveDir:process.cwd()},outfile:'.project-runtime/library-mcp-exports.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {fromMarkdown,creationDesignBrand,humanCommand,PostgresMcpRepository,ChatDatabase,LibraryStore,CommentDraft,EditorDraft,applyDataDraft,DataWindowDraft,browserDataWindowStore,dataRecordSaved,applyDataObjectChange,DataDraftConflict}=await import('../../.project-runtime/library-mcp-exports.mjs');
const installed=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));

async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-library-mcp-'))),id=randomUUID();
 const config={...installed,workspaceRoot:root,runtimeRoot:join(root,'runtime'),tenantId:randomUUID(),ownerId:randomUUID()};
 const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const db=new ChatDatabase(config);await db.init();
 const client=new ProjectClient({configPath,documentId:id});
 const worker=spawn(process.execPath,[resolve('.project-runtime/web.mjs'),'--workspace',root,'--chat-config',configPath,'--port','0'],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{client.close();worker.kill();for(const table of ['source_intakes','agent_events','agent_runs','jobs','agent_messages','agent_sessions','command_receipts','blobs','material_revisions','materials','agent_connections'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);await db.close();await rm(root,{recursive:true,force:true});});
 const origin=await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Editor startup timeout')),10000);worker.once('exit',()=>{clearTimeout(timer);no(new Error('Editor stopped'));});worker.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);yes(m[0]);}});});
 const home=await fetch(origin),headers={Cookie:home.headers.get('set-cookie').split(';')[0],Origin:origin,'Content-Type':'application/json'};
 const get=async(path='/api/project?documentId='+id)=>(await fetch(origin+path,{headers})).json();
 const human=async(command,p)=>{const r=await fetch(origin+'/api/project?documentId='+id,{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),deckId:id,expectedRevision:p.state.revision,command})});assert.equal(r.status,200,await r.text());};
 return {id,root,configPath,db,client,origin,headers,get,human};
}

test('external stdio MCP and HTTP editor share a PG document, sources, revisions and review',async t=>{
 const {id,configPath,db,client,origin,headers,get,human}=await fixture(t);
 assert.equal((await client.call('initialize',{})).result.serverInfo.name,'lanka-library-document');
 assert.deepEqual(await client.tool('get_project'),{empty:true,deckId:id});
 const guide=await client.call('tools/call',{name:'get_design_profile',arguments:{profile:'focus-v3'}});
 assert.equal(guide.result.content.filter(x=>x.type==='image').length,3);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=id;
 const input={requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing};
 await assert.rejects(client.tool('create_deck',{...input,requestId:randomUUID(),doc:{...seed.doc,id:randomUUID()}}),/вне подключённой/);
 assert.equal((await db.listing()).length,0);
 assert.equal(Number((await db.pool.query('SELECT count(*) FROM lanka.blobs WHERE tenant_id=$1',[db.tenant])).rows[0].count),0);
 const created=await client.tool('create_deck',input);assert.equal(created.deckId,id);assert.deepEqual(await client.tool('create_deck',input),created);
 let p=await get();assert.equal(p.state.doc.id,id);assert.equal(p.state.doc.design,'focus-v3');assert.ok(p.state.sources.length);
 assert.ok(JSON.stringify(await get('/api/library')).includes(id));
 const cfg=await get('/api/connection?documentId='+id);assert.deepEqual(cfg.args.slice(-4),['--library-config',configPath,'--document-id',id]);
 const doc=structuredClone(p.state.doc);doc.slides[0].notes='Ручная заметка автора';await human({action:'save',editorContract:'lanka-editor/3',doc},p);
 p=await client.tool('get_project');assert.equal(p.state.revision,2);assert.equal(p.state.doc.slides[0].notes,'Ручная заметка автора');
 const proposal={requestId:randomUUID(),deckId:id,expectedRevision:2,title:'Уточнение обложки',commands:[{op:'set_title',slideId:doc.slides[0].id,value:'Общая работа\nКоманда и агенты'}]};
 await assert.rejects(client.tool('propose_commands',{...proposal,expectedRevision:1}),/Revision conflict/);
 const proposed=await client.tool('propose_commands',proposal);assert.deepEqual(await client.tool('propose_commands',proposal),proposed);
 p=await get();assert.equal(p.state.proposals[0].id,proposed.proposalId);assert.equal(p.state.doc.slides[0].title,doc.slides[0].title);
 await human({action:'accept',proposalId:proposed.proposalId,changeIds:p.state.proposals[0].changes.map(c=>c.id)},p);
 p=await client.tool('get_project');assert.equal(p.state.revision,3);assert.equal(p.state.doc.slides[0].notes,'Ручная заметка автора');assert.equal(p.state.doc.slides[0].title,proposal.commands[0].value);
 const exported=await client.tool('export_deck',{deckId:id,expectedRevision:3,format:'pdf'});
 const download=await fetch(origin+exported.downloadPath,{headers});assert.equal(download.status,200);assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,4).toString(),'%PDF');
 assert.equal((await fetch(origin+exported.downloadPath)).status,403);
 const savedBytes=await db.repository(id).readExportArtifact(exported.artifactId);
 const exportHistory=await client.tool('list_exports',{deckId:id});assert.equal(exportHistory.items[0].revision,3);
 const artifact=await client.tool('get_export_artifact',{deckId:id,artifactId:exported.artifactId});
 assert.deepEqual(artifact.manifest.snapshot,p.state.doc);assert.equal(artifact.manifest.sources.length,p.state.sources.length);
 const manifestResponse=await fetch(origin+artifact.manifestPath,{headers});assert.equal(manifestResponse.status,200);assert.equal((await manifestResponse.json()).id,exported.artifactId);
 await human({action:'save',editorContract:'lanka-editor/3',doc:{...p.state.doc,title:'Later saved title'}},p);
 const repeated=await fetch(origin+artifact.downloadPath,{headers});assert.equal(repeated.status,200);assert.equal(repeated.headers.get('x-lanka-revision'),'3');assert.deepEqual(Buffer.from(await repeated.arrayBuffer()),savedBytes);
 await assert.rejects(client.tool('get_export_artifact',{deckId:randomUUID(),artifactId:exported.artifactId}),/outside/);

 await assert.rejects(client.tool('get_story',{deckId:randomUUID()}),/outside/);
 await assert.rejects(client.tool('create_deck',{...input,requestId:randomUUID(),doc:{...seed.doc,id:randomUUID()}}),/already contains/);
 await db.catalogCommand(randomUUID(),id,{action:'trash_document',trashed:true});
 await assert.rejects(client.tool('get_project'),/недоступен/);await assert.rejects(client.tool('create_deck',input),/недоступен/);
 assert.equal((await fetch(origin+exported.downloadPath,{headers})).status,400);
});

test('UI empty drafts are fillable once through MCP with pinned design, sources and lost-response recovery',async t=>{
 const f=await fixture(t),clients=[];t.after(()=>clients.forEach(c=>c.close()));
 const blank=async()=>{
  const r=await fetch(f.origin+'/api/library',{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),command:{action:'create_document',title:'Название автора',folderId:null,empty:true,profile:'focus-v3'}})});
  assert.equal(r.status,200);const{id}=await r.json();const config=await f.get('/api/connection?documentId='+id);
  const client=new ProjectClient({configPath:config.args[config.args.indexOf("--library-config")+1],documentId:config.args[config.args.indexOf("--document-id")+1]});clients.push(client);return {id,client};
 };
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8')),slides=[seed.doc.slides[0],seed.doc.slides[3],seed.doc.slides[8]];
 const {id,client}=await blank();let p=await client.tool('get_project');assert.equal(p.canPopulate,true);assert.equal(p.state.doc.design,'focus-v3');assert.equal(p.state.doc.brand.version,2);
 for(const {name,contentType,base64} of seed.materials)await client.tool('register_source',{requestId:randomUUID(),deckId:id,expectedRevision:1,name,contentType,base64});
 const before=await client.tool('get_project');assert.equal(before.canPopulate,true);
 const briefing={audience:{value:'Руководители команд',origin:'user'},decision:{value:'Обсудить предложение',origin:'user'}};
 const input={requestId:randomUUID(),deckId:id,expectedRevision:1,slides,briefing};
 await assert.rejects(client.tool('populate_draft',{...input,expectedRevision:2}),/Revision conflict/);
 const bad=structuredClone(input);bad.slides[0].title='W'.repeat(90)+'\nAccent';
 await assert.rejects(client.tool('populate_draft',bad),e=>e.message.includes('оформление')&&e.message.includes(slides[0].id));
 assert.deepEqual((await client.tool('get_project')).state,before.state);
 const result=await client.tool('populate_draft',input);assert.equal(result.revision,2);assert.deepEqual(await client.tool('populate_draft',input),result);
 p=await f.get('/api/project?documentId='+id);assert.equal(p.state.doc.slides.length,3);assert.equal(p.state.doc.title,'Название автора');assert.deepEqual(p.state.doc.brand,before.state.doc.brand);assert.deepEqual(p.state.sources,before.state.sources);
 assert.equal(p.state.doc.brief.audience,briefing.audience.value);assert.equal(p.state.doc.brief.origins.audience,'user');assert.equal(p.state.doc.brief.origins.keyMessage,'assumption');assert.equal((await client.tool('get_project')).briefing.keyMessage.origin,'assumption');
 assert.equal((await client.tool('get_project')).canPopulate,false);
 await assert.rejects(client.tool('populate_draft',{...input,requestId:randomUUID(),expectedRevision:2}),/Заготовка уже/);
 const history=await f.get('/api/history?documentId='+id);assert.deepEqual(history.map(h=>h.revision),[1,2]);
 const contextual=structuredClone(p.state.doc);contextual.brief.keyMessage='Ручное уточнение цели';contextual.brief.origins.keyMessage='user';
 for(const [expectedRevision,command] of [[2,{action:'save',editorContract:'lanka-editor/3',doc:contextual}],[3,{action:'restore',revision:1}]]) {
  const r=await fetch(f.origin+'/api/project?documentId='+id,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:id,expectedRevision,command})});assert.equal(r.status,200);
  const current=await client.tool('get_project');
  if(expectedRevision===2){assert.equal(current.briefing.keyMessage.value,contextual.brief.keyMessage);assert.equal(current.briefing.keyMessage.origin,'user');}
  else {assert.equal(current.briefing,undefined);assert.equal(current.state.doc.brief,undefined);assert.equal(current.canPopulate,false);}
 }

 for(const action of ['save','comment']){
  const next=await blank(),base=await next.client.tool('get_project');const doc=structuredClone(base.state.doc);doc.slides[0].title='Ручная мысль';
  const command=action==='save'?{action,doc,editorContract:'lanka-editor/3'}:{action,slideId:doc.slides[0].id,text:'Сначала обсудим этот черновик'};
  const r=await fetch(f.origin+'/api/project?documentId='+next.id,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:next.id,expectedRevision:1,command})});assert.equal(r.status,200);
  const changed=await next.client.tool('get_project');assert.equal(changed.canPopulate,false);
  await assert.rejects(next.client.tool('populate_draft',{requestId:randomUUID(),deckId:next.id,expectedRevision:changed.state.revision,slides}),/Заготовка уже/);
  assert.deepEqual((await next.client.tool('get_project')).state,changed.state);
 }
});


test('proposal PNG previews preserve saved state, follow partial acceptance and reject slide conflicts',async t=>{
 const {id,client,get,human}=await fixture(t);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=id;
 await client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64}))});
 const slideIds=[seed.doc.slides[0].id,seed.doc.slides[8].id];
 const {proposalId}=await client.tool('propose_commands',{requestId:randomUUID(),deckId:id,expectedRevision:1,title:'Два уточнения',commands:[{op:'set_title',slideId:slideIds[0],value:'Общая работа\nКоманда и агенты'},{op:'set_title',slideId:slideIds[1],value:'Начнём\nс одной команды'}]});
 const preview=async(expectedRevision,withProposal=true)=>client.call('tools/call',{name:'render_slides',arguments:{deckId:id,expectedRevision,slideIds,...(withProposal?{proposalId}:{})}});
 let p=await get();const untouched=structuredClone(p.state);
 const saved=await preview(1,false),candidate=await preview(1);
 assert.equal(candidate.result.isError,false);
 assert.equal(JSON.parse(candidate.result.content[0].text).view,'proposal');
 assert.equal(JSON.parse(candidate.result.content[0].text).proposalId,proposalId);
 assert.notEqual(saved.result.content[1].data,candidate.result.content[1].data);
 assert.deepEqual((await get()).state,untouched);
 await human({action:'accept',proposalId,changeIds:[p.state.proposals[0].changes[0].id]},p);
 p=await get();assert.equal(p.state.revision,2);assert.equal(p.state.proposals[0].status,'pending');
 const partial=await preview(2);assert.equal(partial.result.isError,false);
 assert.deepEqual(partial.result.content.slice(1),candidate.result.content.slice(1));
 const unrelated=structuredClone(p.state.doc);unrelated.slides[1].notes='Ручная заметка другого слайда';await human({action:'save',editorContract:'lanka-editor/3',doc:unrelated},p);
 assert.equal((await preview(3)).result.isError,false);
 p=await get();const conflict=structuredClone(p.state.doc);conflict.slides[8].title='Другая ручная мысль';await human({action:'save',editorContract:'lanka-editor/3',doc:conflict},p);
 p=await get();const changed=structuredClone(p.state);
 const rejected=await preview(4);assert.equal(rejected.result.isError,true);assert.match(rejected.result.content[0].text,/Конфликт/);
 assert.deepEqual((await get()).state,changed);
 await human({action:'reject',proposalId},p);
 const closed=await preview(4);assert.equal(closed.result.isError,true);assert.match(closed.result.content[0].text,/закрыто/);
});

test('one workspace MCP discovers designs, creates in a folder, fills, reviews and exports the HTTP document',async t=>{
 const f=await fixture(t),c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath,editorOrigin:f.origin});t.after(()=>c.close());
 const init=(await c.call('initialize')).result;assert.equal(init.serverInfo.name,'lanka-workspace');assert.ok(init.capabilities.resources);assert.ok(init.capabilities.prompts);
 const tools=(await c.call('tools/list')).result.tools;assert.ok(tools.some(t=>t.name==='lanka_create_material'));assert.ok(!tools.some(t=>t.name==='create_deck'));
 const guide=await c.tool('lanka_get_workspace_guide');
 const resources=(await c.call('resources/list')).result.resources;
 assert.deepEqual(JSON.parse((await c.call('resources/read',{uri:resources[0].uri})).result.contents[0].text),guide);
 assert.ok((await c.call('resources/read',{uri:'file:///etc/passwd'})).error);
 assert.ok((await c.call('prompts/get',{name:'create-presentation'})).result.messages[0].content.text.includes('lanka_create_material'));
 assert.equal((await c.tool('lanka_get_workspace_context')).materialCount,0);
 const profiles=(await c.tool('lanka_list_design_packages')).packages;assert.equal(profiles.find(p=>p.id==='focus-v3').status,'candidate');
 assert.equal((await c.call('tools/call',{name:'get_design_profile',arguments:{profile:'focus-v3'}})).result.content.filter(c=>c.type==='image').length,3);
 const folderArgs={requestId:randomUUID(),name:'История'};
 const folder=await c.tool('lanka_create_folder',folderArgs);assert.deepEqual(await c.tool('lanka_create_folder',folderArgs),folder);
 assert.equal((await f.get('/api/library')).folders[0].id,folder.id);
 const args={requestId:randomUUID(),title:'История городов',folderId:folder.id,profile:'focus-v3'};
 const created=await c.tool('lanka_create_material',args);assert.deepEqual(await c.tool('lanka_create_material',args),created);assert.equal(created.editorUrl,f.origin+created.editorPath);
 await assert.rejects(c.tool('lanka_create_material',{...args,title:'Подмена'}),/Ключ повтора/);
 assert.equal((await c.tool('lanka_list_materials',{folderId:folder.id,query:'ГОРОД'})).materials.length,1);
 let p=await c.tool('lanka_get_material',{materialId:created.materialId});assert.equal(p.canPopulate,true);assert.equal(p.state.doc.title,args.title);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));
 const slides=[seed.doc.slides[0],seed.doc.slides[8]].map(s=>({...s,sourceIds:[]}));
 await c.tool('populate_draft',{materialId:created.materialId,requestId:randomUUID(),expectedRevision:1,slides});
 p=await f.get('/api/project?documentId='+created.materialId);assert.equal(p.state.revision,2);assert.equal(p.state.doc.slides.length,2);assert.equal(p.state.doc.title,args.title);
 const before=structuredClone(p.state.doc);
 const proposal=await c.tool('propose_commands',{materialId:created.materialId,requestId:randomUUID(),expectedRevision:2,title:'Уточнение',commands:[{op:'set_title',slideId:slides[1].id,value:'Начнём с одной команды'}]});
 const preview=await c.call('tools/call',{name:'render_slides',arguments:{materialId:created.materialId,expectedRevision:2,proposalId:proposal.proposalId,slideIds:[slides[1].id]}});assert.equal(preview.result.isError,false);assert.equal(preview.result.content.filter(c=>c.type==='image').length,1);
 p=await f.get('/api/project?documentId='+created.materialId);assert.deepEqual(p.state.doc,before);assert.equal(p.state.proposals[0].id,proposal.proposalId);
 const pdf=await c.tool('export_deck',{materialId:created.materialId,expectedRevision:2,format:'pdf'});
 assert.equal((await c.tool('list_exports',{materialId:created.materialId})).items[0].id,pdf.artifactId);assert.equal((await c.tool('get_export_artifact',{materialId:created.materialId,artifactId:pdf.artifactId})).manifest.revision,2);
 const bytes=await fetch(f.origin+pdf.downloadPath,{headers:f.headers});assert.equal(Buffer.from(await bytes.arrayBuffer()).subarray(0,4).toString(),'%PDF');
 await assert.rejects(c.tool('get_story',{materialId:created.materialId,deckId:created.materialId}),/materialId/);
 assert.equal(tools.find(t=>t.name==='suggest_data_size').annotations.readOnlyHint,true);
 const direct=structuredClone(p.state.doc),chart={id:'chart-size',kind:'chart',x:100,y:400,w:1000,h:80,style:{design:direct.design,brand:direct.brand},data:{seriesId:'s',unit:'hours',rows:[{id:'a',label:'Plan',value:20},{id:'b',label:'Actual',value:40}]}};direct.slides[0].canvas=[chart];
 const saved=await fetch(f.origin+'/api/project?documentId='+created.materialId,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:created.materialId,expectedRevision:p.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:direct}})});assert.equal(saved.status,200,await saved.text());
 const scoped=await c.tool('lanka_get_material',{materialId:created.materialId});const suggestions=await c.tool('suggest_data_size',{materialId:created.materialId,expectedRevision:scoped.state.revision,slideId:direct.slides[0].id,elementId:chart.id});
 assert.equal(suggestions.status,'options');assert.ok(suggestions.options.length);assert.deepEqual((await c.tool('lanka_get_material',{materialId:created.materialId})).state,scoped.state);

});

test('workspace HTTP and MCP share folder changes, paging, moves, trash and creation receipts',async t=>{
 const f=await fixture(t),c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath});t.after(()=>c.close());
 const config=await f.get('/api/workspace-connection');assert.deepEqual(config.args.slice(1),['--workspace',f.root,'--library-config',f.configPath,'--editor-origin',f.origin]);
 assert.equal((await fetch(f.origin+'/api/workspace-connection')).status,403);
 const folder=await c.tool('lanka_create_folder',{requestId:randomUUID(),name:'Команда'});
 const rename=await fetch(f.origin+'/api/library',{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),command:{action:'rename_folder',id:folder.id,name:'Продукт'}})});assert.equal(rename.status,200);
 assert.equal((await c.tool('lanka_list_folders')).folders[0].name,'Продукт');
 const ids=[];
 for(const title of ['Альфа','Бета','Гамма']) {
  const requestId=randomUUID(),command={action:'create_document',title,folderId:null,profile:'focus-v3',empty:true};
  const r=await fetch(f.origin+'/api/library',{method:'POST',headers:f.headers,body:JSON.stringify({requestId,command})});assert.equal(r.status,200);
  const created=await c.tool('lanka_create_material',{requestId,title,profile:'focus-v3'});assert.equal(created.materialId,requestId);ids.push(requestId);
 }
 const first=await c.tool('lanka_list_materials',{limit:2});assert.equal(first.materials.length,2);assert.equal(first.nextCursor,2);
 const second=await c.tool('lanka_list_materials',{limit:2,cursor:first.nextCursor});assert.equal(second.materials.length,1);assert.equal(second.nextCursor,null);
 assert.equal(new Set([...first.materials,...second.materials].map(d=>d.materialId)).size,3);
 await c.tool('lanka_move_material',{requestId:randomUUID(),materialId:ids[0],folderId:folder.id});assert.equal((await c.tool('lanka_list_materials',{folderId:folder.id})).materials[0].materialId,ids[0]);
 await assert.rejects(c.tool('lanka_move_material',{requestId:randomUUID(),materialId:ids[0],folderId:randomUUID()}),/Папка недоступна/);
 await c.tool('lanka_trash_material',{requestId:randomUUID(),materialId:ids[0]});assert.equal((await c.tool('lanka_list_materials')).materials.length,2);
 await assert.rejects(c.tool('lanka_get_material',{materialId:ids[0]}),/недоступен/);
 await assert.rejects(c.tool('propose_commands',{materialId:ids[0],requestId:randomUUID(),expectedRevision:1,title:'Hidden',commands:[]}),/недоступен/);
 assert.equal((await c.tool('lanka_list_materials',{includeTrash:true})).materials.length,3);
 await c.tool('lanka_restore_material',{requestId:randomUUID(),materialId:ids[0]});assert.equal((await c.tool('lanka_list_materials')).materials.length,3);
});

test('workspace routes legacy file documents by material ID and rejects foreign PG ownership',async t=>{
 const f=await fixture(t),c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath});t.after(()=>c.close());
 const legacyId=randomUUID(),library=new LibraryStore(f.root);
 await library.mutate({requestId:legacyId,command:{action:'create_document',title:'Старый документ',folderId:null,markdown:'# История\n\n## Города\nВозникают общие правила.'}});
 const p=await c.tool('lanka_get_material',{materialId:legacyId});assert.notEqual(p.state.doc.id,legacyId);
 await c.tool('propose_commands',{materialId:legacyId,requestId:randomUUID(),expectedRevision:1,title:'Уточнение',commands:[{op:'set_title',slideId:p.state.doc.slides[0].id,value:'Города и правила'}]});
 assert.equal((await f.get('/api/project?documentId='+legacyId)).state.proposals.length,1);
 const outsider=new ChatDatabase({...f.db.options,ownerId:randomUUID()});await outsider.init();t.after(()=>outsider.close());
 const foreign=structuredClone(p.state.doc);foreign.id=randomUUID();await outsider.create(randomUUID(),foreign);
 await assert.rejects(c.tool('lanka_get_material',{materialId:foreign.id}),/недоступен/);
 assert.ok(!(await c.tool('lanka_list_materials')).materials.some(d=>d.materialId===foreign.id));
 const bounded=new ProjectClient({configPath:f.configPath,documentId:foreign.id});t.after(()=>bounded.close());
 assert.ok(!(await bounded.call('tools/list')).result.tools.some(t=>t.name==='lanka_list_materials'));
});

test('direct canvas edits persist through HTTP, MCP proposal, conflict checks, review and export',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
 slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
  {id:'editable-text',kind:'text',x:120,y:140,w:900,h:110,text:'Ручная правка на холсте',size:44,bold:false,color:'#20243B',font:'sans',lineHeight:1.3},
  {id:'shape',kind:'rect',x:120,y:400,w:300,h:100,color:'#444BE8'}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.client.tool('get_project');
 assert.deepEqual(p.state.doc.slides[0].canvas,slide.canvas);
 const guide=await f.client.tool('get_authoring_guide');assert.match(guide.directEditing.rule,/canonical/);
 const proposal={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Предложение для объекта',commands:[{op:'set_element',slideId:slide.id,value:{...slide.canvas[1],x:180}},{op:'edit_text',slideId:slide.id,elementId:slide.canvas[1].id,value:{text:'Правка агента на холсте',size:88}}]};
 await assert.rejects(f.client.tool('propose_commands',{...proposal,commands:[{op:'set_body',slideId:slide.id,value:'Невидимая правка'}]}),/canvas objects/);
 const result=await f.client.tool('propose_commands',proposal);p=await f.get();
 assert.equal(p.state.doc.slides[0].canvas[1].text,'Ручная правка на холсте');
 assert.equal(p.state.proposals[0].changes[0].after.canvas[1].text,'Правка агента на холсте');
 assert.ok(p.state.proposals[0].changes[0].after.canvas[1].h>110);
 assert.deepEqual(p.state.proposals[0].changes[0].after.canvas[2],slide.canvas[2]);
 const rendered=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:p.state.revision,proposalId:result.proposalId,slideIds:[slide.id]}});
 assert.equal(rendered.result.isError,false);assert.equal(rendered.result.content.filter(x=>x.type==='image').length,1);
 await f.human({action:'accept',proposalId:result.proposalId,changeIds:p.state.proposals[0].changes.map(c=>c.id)},p);
 p=await f.client.tool('get_project');assert.equal(p.state.doc.slides[0].canvas[1].x,180);
 await assert.rejects(f.client.tool('propose_commands',{...proposal,requestId:randomUUID()}),/Revision conflict/);
 for(const format of ['pdf','pptx']) {
  const exported=await f.client.tool('export_deck',{deckId:f.id,expectedRevision:p.state.revision,format});
  const response=await fetch(f.origin+exported.downloadPath,{headers:f.headers});assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>1000);
  if(format==='pptx') {const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(bytes);const xml=await zip.file('ppt/slides/slide1.xml').async('string');const text=[...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(m=>m[1]).join(' ');assert.match(text,/Правка агента на\sхолсте/);}
 }
});

test('workspace MCP comments preserve object anchor and reject invented targets and quotes',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),s=doc.slides[0];s.canvas=[{id:'text',kind:'text',x:100,y:100,w:800,h:100,text:'Quoted on server',size:40,lineHeight:1.3,font:'sans',bold:false,color:'#20243B'}];await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);
 const input={requestId:randomUUID(),deckId:f.id,expectedRevision:2,slideId:s.id,elementId:'text',text:'Review object'};
 const result=await f.client.tool('add_comment',input);assert.deepEqual(await f.client.tool('add_comment',input),result);
 p=await f.get();assert.deepEqual(p.state.comments.at(-1).anchor,{elementId:'text',quote:'Quoted on server',revision:2});
 await f.human({action:'comment',slideId:s.id,elementId:'text',text:'HTTP editor review'},p);p=await f.get();assert.deepEqual(p.state.comments.at(-1).anchor,{elementId:'text',quote:'Quoted on server',revision:2});assert.equal(p.state.comments.at(-1).author,'Владелец проекта');
 await assert.rejects(f.client.tool('add_comment',{...input,requestId:randomUUID(),elementId:'outside'}),/Объект комментария недоступен/);
 await assert.rejects(f.client.tool('add_comment',{...input,requestId:randomUUID(),anchor:{quote:'Forged'}}),/Unrecognized/);
 assert.deepEqual((await f.get()).state.comments,p.state.comments);
});

test('six idle HTTP/1.1 event streams release slots for a queued human write',async t=>{
 const {Agent,request}=await import('node:http');
 const f=await fixture(t),agent=new Agent({keepAlive:true,maxSockets:6});t.after(()=>agent.destroy());
 await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Connection slots\n\n## Slide\nText',briefing:{audience:{value:'Test',origin:'user'},decision:{value:'Test',origin:'user'},keyMessage:{value:'Test',origin:'user'}}});
 const p=await f.get(),session=await f.db.ensureSession(f.id);
 const openStream=()=>new Promise((resolve,reject)=>{
   const req=request(f.origin+`/api/v1/agent-sessions/${session}/events`,{agent,headers:f.headers},res=>{
     assert.equal(res.statusCode,200);res.on('error',reject);res.resume();resolve(res);
   });req.on('error',reject);req.end();
 });
 const streams=await Promise.all(Array.from({length:6},openStream));assert.equal(streams.length,6);
 const start=Date.now();
 const response=await new Promise((resolve,reject)=>{
   const req=request(f.origin+'/api/project?documentId='+f.id,{agent,method:'POST',headers:f.headers},res=>{
     let body='';res.on('data',b=>body+=b);res.on('end',()=>{clearTimeout(deadline);resolve({status:res.statusCode,body});});res.on('error',reject);
   });const deadline=setTimeout(()=>req.destroy(new Error('Event streams starved the human write')),14500);
   req.on('error',e=>{clearTimeout(deadline);reject(e);});
   req.end(JSON.stringify({requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,command:{action:'comment',slideId:p.state.doc.slides[0].id,text:'Write survives six open chats'}}));
 });
 assert.equal(response.status,200,response.body);assert.ok(Date.now()-start<14500);
 assert.equal((await f.get()).state.comments.at(-1).text,'Write survives six open chats');
});

test('restored comment draft retries a committed HTTP write with its original receipt after a new revision',async t=>{
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Draft retry\n\n## Slide\nText',briefing:{audience:{value:'Test',origin:'user'},decision:{value:'Test',origin:'user'},keyMessage:{value:'Test',origin:'user'}}});
 let p=await f.get();const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},draft=new CommentDraft(storage,f.id),target={slideId:p.state.doc.slides[0].id};
 draft.set('Keep one comment',target);const input=draft.prepare(p.state.revision,{action:'comment',...target,text:draft.text});
 const send=body=>fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify(body)});
 const first=await send(input);assert.equal(first.status,200);await first.arrayBuffer(); // Simulate losing acknowledgement after commit.
 p=await f.get();const doc=structuredClone(p.state.doc);doc.slides[0].notes='A later manual revision';await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const restored=new CommentDraft(storage,f.id),retry=restored.prepare(p.state.revision,{action:'comment',...restored.target,text:restored.text});assert.deepEqual(retry,input);
 const second=await send(retry);assert.equal(second.status,200);await second.arrayBuffer();restored.acknowledge(retry.requestId);
 const saved=await f.get();assert.equal(saved.state.comments.filter(c=>c.text==='Keep one comment').length,1);assert.equal(saved.state.doc.slides[0].notes,doc.slides[0].notes);assert.equal(new CommentDraft(storage,f.id).text,'');
});

test('autosave journal survives lost acknowledgement, another author and a same-field conflict over real HTTP',async t=>{
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Autosave\n\n## One\nText',briefing:{audience:{value:'Test',origin:'user'},decision:{value:'Test',origin:'user'},keyMessage:{value:'Test',origin:'user'}}});
 let p=await f.get(),doc=structuredClone(p.state.doc);const text=(id,y)=>({id,kind:'text',x:100,y,w:700,h:120,text:id,size:40,bold:false,color:'#20243B',lineHeight:1.3});doc.slides[0].canvas=[text('a',100),text('b',300)];await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},snapshot=p=>({doc:p.state.doc,revision:p.state.revision}),edit=(d,id,text)=>{const v=structuredClone(d);v.slides[0].canvas.find(e=>e.id===id).text=text;return v;};
 const send=async body=>{const r=await fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
 const a=new EditorDraft(storage,f.id,snapshot(p));a.edit(edit(a.doc,'a','First'));const first=a.prepare(),firstResult=await send(first);
 a.edit(edit(a.doc,'a','Typed while saving')); // Deliberately do not acknowledge the committed response.
 const b=new EditorDraft(null,f.id,snapshot(await f.get()));b.edit(edit(b.doc,'b','Another author'));const rb=b.prepare();b.acknowledge(rb.requestId,(await send(rb)).revision);
 const restored=new EditorDraft(storage,f.id,snapshot(await f.get()));assert.deepEqual(restored.prepare(),first);assert.deepEqual(await send(first),firstResult);restored.acknowledge(first.requestId,firstResult.revision);
 assert.equal(restored.doc.slides[0].canvas[1].text,'Another author');const next=restored.prepare();restored.acknowledge(next.requestId,(await send(next)).revision);
 p=await f.get();assert.equal(p.state.doc.slides[0].canvas[0].text,'Typed while saving');assert.equal(p.state.doc.slides[0].canvas[1].text,'Another author');
 const c=new EditorDraft(null,f.id,snapshot(p));c.edit(edit(c.doc,'a','My resolution'));
 const remote=edit(edit(p.state.doc,'a','Competing text'),'b','Remote neighbor');await f.human({action:'save',editorContract:'lanka-editor/3',doc:remote},p);c.receive(snapshot(await f.get()));assert.equal(c.conflicts.length,1);
 c.resolve({[c.conflicts[0].key]:'local'});const resolved=c.prepare();c.acknowledge(resolved.requestId,(await send(resolved)).revision);
 p=await f.get();assert.equal(p.state.doc.slides[0].canvas[0].text,'My resolution');assert.equal(p.state.doc.slides[0].canvas[1].text,'Remote neighbor');assert.equal(c.needsSave,false);
});

test('registered image crops persist through HTTP, MCP review and native exports',async t=>{
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Images\n\n## Frame\nImage editing',briefing:{audience:{value:'Test',origin:'user'},decision:{value:'Test',origin:'user'},keyMessage:{value:'Test',origin:'user'}}});
 const {PNG}=await import('pngjs'),png=new PNG({width:2,height:1});png.data.set([255,0,0,255,0,255,0,255]);
 const source=await f.client.tool('register_source',{requestId:randomUUID(),deckId:f.id,expectedRevision:1,name:'Pixels.png',contentType:'image/png',base64:PNG.sync.write(png).toString('base64')});
 let p=await f.get(),doc=structuredClone(p.state.doc);doc.slides[0].canvas=[{id:'picture',kind:'image',x:200,y:200,w:400,h:400,assetId:source.sourceId,frame:{sourceWidth:2,sourceHeight:1,fit:'cover',zoom:1,focusX:0,focusY:.5}}];
 const untouchedSources=structuredClone(p.state.sources);await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.client.tool('get_project');assert.deepEqual(p.state.doc.slides[0].canvas,doc.slides[0].canvas);
 const value={...doc.slides[0].canvas[0],frame:{...doc.slides[0].canvas[0].frame,focusX:1}};
 const proposed=await f.client.tool('propose_commands',{requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Show right side',commands:[{op:'set_element',slideId:doc.slides[0].id,value}]});
 const args={deckId:f.id,expectedRevision:p.state.revision,slideIds:[doc.slides[0].id]};
 const before=await f.client.call('tools/call',{name:'render_slides',arguments:args}),after=await f.client.call('tools/call',{name:'render_slides',arguments:{...args,proposalId:proposed.proposalId}});
 assert.equal(after.result.isError,false);assert.notEqual(before.result.content[1].data,after.result.content[1].data);
 p=await f.get();await f.human({action:'accept',proposalId:proposed.proposalId,changeIds:p.state.proposals.at(-1).changes.map(c=>c.id)},p);
 p=await f.get();assert.deepEqual(p.state.doc.slides[0].canvas[0],value);assert.deepEqual(p.state.sources,untouchedSources);
 for(const format of ['pdf','pptx']){
  const result=await f.client.tool('export_deck',{deckId:f.id,expectedRevision:p.state.revision,format});const response=await fetch(f.origin+result.downloadPath,{headers:f.headers});assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>1000);
  if(format==='pptx'){const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(bytes),xml=await zip.file('ppt/slides/slide1.xml').async('string');assert.match(xml,/<p:pic>/);assert.match(xml,/<a:srcRect l="4999\d"/);}
 }
 const bad=structuredClone(p.state.doc);bad.slides[0].canvas[0].frame.zoom=20;
 const response=await fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:bad}})});assert.equal(response.status,400);assert.deepEqual((await f.get()).state.doc,p.state.doc);
});

test('image upload refuses an occupied Focus 2 cover without changing content or sources',async t=>{
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Photos\n\n## Team\nKeep this text'});
 const p=await f.get(),{default:sharp}=await import('sharp'),bytes=await sharp({create:{width:40,height:80,channels:3,background:'#123456'}}).png().toBuffer();
 const response=await fetch(f.origin+'/api/images?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,slideId:p.state.doc.slides[0].id,name:'Photo.png',contentType:'image/png',base64:bytes.toString('base64')})});
 assert.equal(response.status,400);assert.match((await response.json()).error,/нет свободного места/);assert.deepEqual((await f.get()).state,p.state);
});

test('atomic image upload normalizes EXIF, retains originals and replays lost replies without duplicate objects',async t=>{
 const f=await fixture(t),doc=fromMarkdown('# Photos\n\n## Team\nKeep this text');doc.id=f.id;
 // EXIF acceptance needs an intentional photo area; a Focus 2 cover is occupied.
 doc.slides[0].canvas=[{id:'page',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'caption',kind:'text',x:88,y:100,w:1000,h:80,text:'Keep this text',size:34,color:'#20243B',bold:false,lineHeight:1.3}];
 const originalObjects=structuredClone(doc.slides[0].canvas);
 await f.client.tool('create_deck',{requestId:randomUUID(),doc,briefing:{audience:{value:'Team',origin:'user'},decision:{value:'Review',origin:'user'},keyMessage:{value:'Photo',origin:'user'}}});
 const {default:sharp}=await import('sharp');const raw=Buffer.alloc(80*40*3);for(let y=0;y<40;y++)for(let x=0;x<80;x++){const i=(y*80+x)*3;raw[i]=x<40?255:0;raw[i+1]=x>=40?255:0;raw[i+2]=y>=20?255:0;}
 const bytes=await sharp(raw,{raw:{width:80,height:40,channels:3}}).jpeg({quality:100}).withMetadata({orientation:6}).toBuffer();let p=await f.get();
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,slideId:p.state.doc.slides[0].id,name:'Phone.jpg',contentType:'image/jpeg',base64:bytes.toString('base64')};
 const send=a=>fetch(f.origin+'/api/images?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify(a)});
 const response=await send(request);assert.equal(response.status,200,await response.clone().text());const first=await response.json();assert.equal(first.normalized,true);assert.deepEqual(first.image,{width:40,height:80});
 p=await f.get();assert.equal(p.state.revision,2);assert.equal(p.state.sources.length,2);const image=p.state.doc.slides[0].canvas.find(e=>e.id===first.elementId);assert.equal(image.assetId,first.sourceId);assert.equal(image.frame.sourceWidth,40);assert.deepEqual(p.state.doc.slides[0].canvas.filter(e=>e.id!==first.elementId),originalObjects);
 const original=await fetch(f.origin+'/api/assets?documentId='+f.id+'&id='+first.originalSourceId,{headers:f.headers});assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 const source=p.state.sources.find(s=>s.id===first.originalSourceId);assert.equal(source.image.normalizedSourceId,first.sourceId);
 const rendered=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:2,slideIds:[request.slideId]}});assert.equal(rendered.result.isError,false);
 const {PNG}=await import('pngjs'),preview=Buffer.from(rendered.result.content.find(c=>c.type==='image').data,'base64'),pixels=PNG.sync.read(preview);
 for(const [x,y,want] of [[558,264,[255,0,255]],[642,264,[255,0,0]],[558,433,[0,255,255]],[642,433,[0,255,0]]]){const offset=(y*pixels.width+x)*4;for(let c=0;c<3;c++)assert.ok(Math.abs(pixels.data[offset+c]-want[c])<15);}
 if(process.env.LANKA_IMAGE_EVIDENCE)await writeFile('out/image-upload-preview.png',preview);
 for(const format of ['pdf','pptx']){const result=await f.client.tool('export_deck',{deckId:f.id,expectedRevision:2,format});assert.equal((await fetch(f.origin+result.downloadPath,{headers:f.headers})).status,200);}
 const changed=structuredClone(p.state.doc);changed.slides[0].notes='Later edit';await f.human({action:'save',editorContract:'lanka-editor/3',doc:changed},p);
 const replay=await send(request);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),first);p=await f.get();assert.equal(p.state.revision,3);assert.equal(p.state.doc.slides[0].notes,'Later edit');assert.equal(p.state.doc.slides[0].canvas.filter(e=>e.kind==='image').length,1);
 const registered=await f.client.tool('register_source',{requestId:randomUUID(),deckId:f.id,expectedRevision:3,name:request.name,contentType:request.contentType,base64:request.base64});assert.equal(registered.sourceId,first.sourceId);assert.deepEqual(registered.image,first.image);
 const png=await sharp({create:{width:100,height:100,channels:4,background:{r:10,g:30,b:100,alpha:.5}}}).png().toBuffer();
 const replacement={...request,requestId:randomUUID(),expectedRevision:3,elementId:first.elementId,name:'Replacement.png',contentType:'image/png',base64:png.toString('base64')};const replace=await send(replacement);assert.equal(replace.status,200);const replaced=await replace.json();p=await f.get();const current=p.state.doc.slides[0].canvas.find(e=>e.id===first.elementId);assert.equal(current.assetId,replaced.sourceId);assert.deepEqual([current.x,current.y,current.w,current.h],[image.x,image.y,image.w,image.h]);assert.equal(p.state.sources.length,3);assert.equal(current.frame.fit,'contain');
 const before=structuredClone(p.state);const bad=await send({...replacement,requestId:randomUUID(),expectedRevision:4,base64:Buffer.from('bad image').toString('base64')});assert.equal(bad.status,400);assert.deepEqual((await f.get()).state,before);
 assert.equal((await send({...replacement,requestId:randomUUID(),deckId:'outside',expectedRevision:4})).status,400);
 for(const format of ['pdf','pptx']){const result=await f.client.tool('export_deck',{deckId:f.id,expectedRevision:4,format});assert.equal((await fetch(f.origin+result.downloadPath,{headers:f.headers})).status,200);}
 const locked=structuredClone(p.state.doc);locked.slides[0].canvas.find(e=>e.id===first.elementId).locked=true;await f.human({action:'save',editorContract:'lanka-editor/3',doc:locked},p);p=await f.get();assert.equal((await send({...replacement,requestId:randomUUID(),expectedRevision:p.state.revision})).status,400);assert.deepEqual((await f.get()).state.doc,p.state.doc);
 const {randomBytes}=await import('node:crypto'),large=await sharp(randomBytes(1200*800*3),{raw:{width:1200,height:800,channels:3}}).png().toBuffer();assert.ok(large.length>2_000_000);assert.ok(large.length<5_000_000);const largeResponse=await send({...request,requestId:randomUUID(),expectedRevision:p.state.revision,name:'Large.png',contentType:'image/png',base64:large.toString('base64')});assert.equal(largeResponse.status,200);const largeResult=await largeResponse.json();const asset=await fetch(f.origin+'/api/assets?documentId='+f.id+'&id='+largeResult.sourceId,{headers:f.headers});assert.deepEqual(Buffer.from(await asset.arrayBuffer()),large);
});

test('data dialog edit saves a numeric object through HTTP and exports the same chart data through MCP',async t=>{
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Data editing\n\n## Chart\nSynthetic editor fixture'});
 let p=await f.get();const doc=structuredClone(p.state.doc),s=doc.slides[0];
 s.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
  {id:'data',kind:'chart',x:100,y:400,w:1400,h:350,style:{design:doc.design??'classic-v1',brand:doc.brand},data:{seriesId:'s1',unit:'hours',rows:[{id:'research',label:'Research',value:20},{id:'development',label:'Development',value:40}]}}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const base=p.state.doc.slides[0].canvas[1],draft=structuredClone(base);draft.data.rows[0].value='25';
 const edited=structuredClone(p.state.doc);edited.slides[0].canvas[1]=applyDataDraft(draft,base,base);
 await f.human({action:'save',editorContract:'lanka-editor/3',doc:edited},p);p=await f.client.tool('get_project');
 assert.equal(p.state.doc.slides[0].canvas[1].data.rows[0].value,25);
 const invalid=structuredClone(edited);invalid.slides[0].canvas[1].data.rows[0].value='';
 const rejected=await fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:invalid}})});
 assert.equal(rejected.status,400);assert.equal((await f.get()).state.revision,p.state.revision);
 for(const format of ['pdf','pptx']){
  const result=await f.client.tool('export_deck',{deckId:f.id,expectedRevision:p.state.revision,format});
  const response=await fetch(f.origin+result.downloadPath,{headers:f.headers});assert.equal(response.status,200);
  const bytes=await response.arrayBuffer();
  if(format==='pptx'){const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(bytes);assert.match(await zip.file('ppt/charts/chart1.xml').async('string'),/<c:v>25<\/c:v>/);assert.ok(Object.keys(zip.files).some(n=>n.startsWith('ppt/embeddings/')&&n.endsWith('.xlsx')));}
 }
});

test('restored data window preserves later HTTP edits after a lost save acknowledgement',async t=>{
 const {indexedDB}=await import('fake-indexeddb');globalThis.indexedDB=indexedDB;
 const f=await fixture(t);await f.client.tool('create_deck',{requestId:randomUUID(),markdown:'# Recovery\n\n## Data\nSynthetic concurrent fixture'});
 let p=await f.get();const doc=structuredClone(p.state.doc),s=doc.slides[0];
 s.canvas=[{id:'chart',kind:'chart',x:100,y:400,w:1400,h:350,style:{design:doc.design??'classic-v1',brand:doc.brand},data:{seriesId:'series',unit:'hours',rows:[{id:'a',label:'A',value:20},{id:'b',label:'B',value:40}]}}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();const base=p.state.doc.slides[0].canvas[0];
 const target={documentId:f.id,slideId:s.id,owner:'test-tab',base};
 const window=new DataWindowDraft(target),raw=structuredClone(base);raw.data.rows[0].value='25';await window.set(raw);
 const snapshot=(await browserDataWindowStore.list(f.id))[0];
 const remote=structuredClone(p.state.doc);remote.slides[0].canvas[0].data.rows[0].value=30;remote.slides[0].canvas[0].data.rows[1].value=41;
 await f.human({action:'save',editorContract:'lanka-editor/3',doc:remote},p);p=await f.get();
 const restored=new DataWindowDraft(target,browserDataWindowStore,snapshot);await restored.start();const current=p.state.doc.slides[0].canvas[0];
 let conflict;try{applyDataDraft(restored.record.draft,restored.record.base,current);}catch(e){conflict=e;}
 assert.ok(conflict instanceof DataDraftConflict);
 const value=applyDataDraft(restored.record.draft,restored.record.base,current,{[conflict.conflicts[0].key]:'mine'});assert.deepEqual(value.data.rows.map(r=>r.value),[25,41]);
 await restored.stage(value,p.state.revision);
 const main=new EditorDraft({getItem:()=>null,setItem:()=>{throw Error('browser cache unavailable');}},f.id,{doc:p.state.doc,revision:p.state.revision},'test-tab');
 main.edit(applyDataObjectChange(p.state.doc,s.id,value,current));const request=main.prepare();assert.equal(main.persistent,false);
 const response=await fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify(request)});assert.equal(response.status,200);await response.arrayBuffer(); // Commit happened; acknowledgement is intentionally discarded.
 p=await f.get();const newer=structuredClone(p.state.doc);newer.slides[0].canvas[0].data.rows[1].value=42;newer.slides[0].notes='A later human note';await f.human({action:'save',editorContract:'lanka-editor/3',doc:newer},p);p=await f.get();
 assert.equal(dataRecordSaved(restored.record,p.state.doc.slides[0].canvas[0],p.state.revision),false);
 const fallback=(await browserDataWindowStore.list(f.id))[0],afterReload=new DataWindowDraft(target,browserDataWindowStore,fallback);await afterReload.start();
 const recovered=applyDataDraft(afterReload.record.draft,afterReload.record.base,p.state.doc.slides[0].canvas[0]);assert.deepEqual(recovered.data.rows.map(r=>r.value),[25,42]);
 const durable=new EditorDraft({getItem:()=>null,setItem:()=>{}},f.id,{doc:p.state.doc,revision:p.state.revision},'new-tab');
 durable.edit(applyDataObjectChange(p.state.doc,s.id,recovered,p.state.doc.slides[0].canvas[0]));assert.equal(durable.prepare(),null);assert.equal(durable.doc.slides[0].notes,'A later human note');
 await afterReload.discard();assert.deepEqual(await browserDataWindowStore.list(f.id),[]);
 assert.equal((await f.client.tool('get_project')).state.revision,p.state.revision);
});


test('workspace source upload preserves provenance and bytes through external authoring without an agent session',async t=>{
 const f=await fixture(t),c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath,editorOrigin:f.origin});t.after(()=>c.close());
 await c.call('initialize');
 assert.equal((await c.tool('lanka_get_capabilities')).sourceUploads,true);
 const tools=(await c.call('tools/list')).result.tools;assert.equal(tools.find(t=>t.name==='lanka_remove_source_upload').annotations.destructiveHint,true);assert.equal(tools.find(t=>t.name==='lanka_get_source_upload').annotations.readOnlyHint,true);
 const bytes=Buffer.from('Synthetic report: September 2026. 42 requests, 30 consultations, 12 implementations.');
 const upload={requestId:randomUUID(),name:'report.txt',base64:bytes.toString('base64')};
 const source=await c.tool('lanka_upload_source',upload);
 assert.equal(source.extraction.status,'extracted');
 assert.deepEqual(await c.tool('lanka_upload_source',upload),source);
 await assert.rejects(c.tool('lanka_upload_source',{...upload,base64:Buffer.from('different').toString('base64')}),/Ключ загрузки/);
 assert.deepEqual(await c.tool('lanka_get_source_upload',{sourceIntakeId:source.id}),source);
 const list=await c.tool('lanka_list_source_uploads');assert.equal(list.uploads.length,1);assert.equal(list.uploads[0].extraction.fragments,undefined);
 const args={requestId:randomUUID(),title:'External source report',profile:'focus-v3',sourceIntakeId:source.id};
 const created=await c.tool('lanka_create_material',args);
 let p=await c.tool('lanka_get_material',{materialId:created.materialId});assert.equal(p.canPopulate,true);
 assert.deepEqual(p.state.sources[0].extraction,source.extraction);
 const blob=await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.db.tenant,created.materialId]);assert.deepEqual(blob.rows[0].bytes,bytes);
 const downloadPath='/api/sources?documentId='+created.materialId+'&id='+source.id;
 const download=await fetch(f.origin+downloadPath,{headers:f.headers});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.equal(download.headers.get('cache-control'),'no-store');
 assert.equal((await fetch(f.origin+downloadPath)).status,403);
 assert.notEqual((await fetch(f.origin+'/api/sources?documentId='+created.materialId+'&id=../../etc/passwd',{headers:f.headers})).status,200);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));
 const slides=[{...seed.doc.slides[0],title:'September\nReport',sourceIds:[source.id]}];
 await c.tool('populate_draft',{materialId:created.materialId,requestId:randomUUID(),expectedRevision:1,slides});
 p=await f.get('/api/project?documentId='+created.materialId);assert.equal(p.state.revision,2);assert.equal(p.state.doc.slides[0].title,'September\nReport');assert.equal(p.state.sources[0].sha256,source.sha256);
 await c.tool('lanka_remove_source_upload',{sourceIntakeId:source.id});await c.tool('lanka_remove_source_upload',{sourceIntakeId:source.id});
 await assert.rejects(c.tool('lanka_get_source_upload',{sourceIntakeId:source.id}),/недоступен/);
 assert.deepEqual(await c.tool('lanka_create_material',args),created);
 assert.deepEqual((await c.tool('lanka_get_material',{materialId:created.materialId})).state,p.state);
 for(const table of ['agent_sessions','agent_runs','jobs'])assert.equal(Number((await f.db.pool.query(`SELECT count(*) FROM lanka.${table} WHERE tenant_id=$1`,[f.db.tenant])).rows[0].count),0);
 // Exercise an actual stdio message above the previous 1 MB transport cap.
 const bad=await c.tool('lanka_upload_source',{requestId:randomUUID(),name:'broken.pptx',base64:Buffer.alloc(800000,65).toString('base64')});assert.equal(bad.extraction.status,'failed');
 const failedId=randomUUID();await assert.rejects(c.tool('lanka_create_material',{...args,requestId:failedId,sourceIntakeId:bad.id}),/нет доступного текста/);
 assert.equal((await f.db.pool.query('SELECT id FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.db.tenant,failedId])).rowCount,0);
 const other=await fixture(t),foreign=new ProjectClient({workspaceRoot:other.root,configPath:other.configPath});t.after(()=>foreign.close());await foreign.call('initialize');
 await assert.rejects(foreign.tool('lanka_get_source_upload',{sourceIntakeId:bad.id}),/недоступен/);
 await foreign.tool('lanka_remove_source_upload',{sourceIntakeId:bad.id});assert.equal((await c.tool('lanka_get_source_upload',{sourceIntakeId:bad.id})).id,bad.id);
 const ownerConfig={...JSON.parse(await readFile(f.configPath,'utf8')),ownerId:randomUUID()};
 const ownerPath=join(f.root,'other-owner.json');await writeFile(ownerPath,JSON.stringify(ownerConfig),{mode:0o600});
 const otherOwner=new ProjectClient({workspaceRoot:f.root,configPath:ownerPath});t.after(()=>otherOwner.close());await otherOwner.call('initialize');
 await assert.rejects(otherOwner.tool('lanka_get_source_upload',{sourceIntakeId:bad.id}),/недоступен/);
 assert.deepEqual((await otherOwner.tool('lanka_list_source_uploads')).uploads,[]);
 const deniedId=randomUUID();await assert.rejects(otherOwner.tool('lanka_create_material',{...args,requestId:deniedId,sourceIntakeId:bad.id}),/недоступен/);
 assert.equal((await f.db.pool.query('SELECT id FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.db.tenant,deniedId])).rowCount,0);
 const expiring=await c.tool('lanka_upload_source',{...upload,requestId:randomUUID()});
 await f.db.pool.query(`UPDATE lanka.source_intakes SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2`,[f.db.tenant,expiring.id]);
 await assert.rejects(c.tool('lanka_create_material',{...args,requestId:randomUUID(),sourceIntakeId:expiring.id}),/срок хранения/);
 const fileOnly=new ProjectClient({workspaceRoot:f.root});t.after(()=>fileOnly.close());await fileOnly.call('initialize');assert.equal((await fileOnly.tool('lanka_get_capabilities')).sourceUploads,false);
 await assert.rejects(fileOnly.tool('lanka_create_material',{...args,requestId:randomUUID()}),/PostgreSQL/);
});


test('workspace copy preserves the saved design and sources but starts private without review or chat',async t=>{
 const f=await fixture(t),c=new ProjectClient({workspaceRoot:f.root,configPath:f.configPath,editorOrigin:f.origin});t.after(()=>c.close());await c.call('initialize');
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64}))});
 let original=await f.get();await f.human({action:'comment',slideId:seed.doc.slides[0].id,text:'Private discussion stays here'},original);
 original=await f.get();await f.client.tool('propose_commands',{requestId:randomUUID(),deckId:f.id,expectedRevision:original.state.revision,title:'Private proposal',commands:[{op:'set_title',slideId:seed.doc.slides[0].id,value:'Private\nProposal'}]});original=await f.get();
 const args={requestId:randomUUID(),materialId:f.id,expectedRevision:original.state.revision,title:'Independent copy'};
 const copied=await c.tool('lanka_duplicate_material',args);assert.deepEqual(await c.tool('lanka_duplicate_material',args),copied);
 let p=await c.tool('lanka_get_material',{materialId:copied.materialId});assert.equal(p.state.revision,1);assert.equal(p.canPopulate,false);assert.equal(p.state.doc.title,args.title);assert.deepEqual(p.state.doc.slides,original.state.doc.slides);assert.deepEqual(p.state.doc.brand,original.state.doc.brand);assert.equal(p.state.doc.design,'focus-v3');assert.deepEqual(p.state.sources,original.state.sources);assert.deepEqual(p.state.comments,[]);assert.deepEqual(p.state.proposals,[]);assert.deepEqual(p.state.grants,[]);assert.equal(p.state.approvedRevision,null);
 for(const source of p.state.sources){const rows=await f.db.pool.query('SELECT material_id,bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=ANY($2::uuid[]) AND key=$3',[f.db.tenant,[f.id,copied.materialId],'materials/'+source.sha256+'.bin']);assert.equal(rows.rows.length,2);assert.deepEqual(rows.rows[0].bytes,rows.rows[1].bytes);}
 const changed=structuredClone(p.state.doc);changed.slides[0].title='Only the\nCopy changes';
 const saved=await fetch(f.origin+'/api/project?documentId='+copied.materialId,{method:'POST',headers:f.headers,body:JSON.stringify({requestId:randomUUID(),deckId:copied.materialId,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:changed}})});assert.equal(saved.status,200);assert.deepEqual((await f.get()).state,original.state);
 await assert.rejects(c.tool('lanka_duplicate_material',{...args,requestId:randomUUID(),expectedRevision:999}),/Конфликт версии/);
 await assert.rejects(c.tool('lanka_duplicate_material',{...args,title:'Changed retry'}),/Ключ повтора/);
 const foreign=await fixture(t),other=new ProjectClient({workspaceRoot:foreign.root,configPath:foreign.configPath});t.after(()=>other.close());await other.call('initialize');await assert.rejects(other.tool('lanka_duplicate_material',{...args,requestId:randomUUID()}),/недоступен/);
 assert.equal(Number((await f.db.pool.query('SELECT count(*) FROM lanka.agent_sessions WHERE tenant_id=$1',[f.db.tenant])).rows[0].count),0);
});

test('legacy HTTP save replays an exact committed receipt without writing, but rejects an uncommitted request',async t=>{
 const f=await fixture(t),repo=new PostgresMcpRepository(f.db,f.id);
 const seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 const before=await f.get(),doc=structuredClone(before.state.doc);doc.title='Saved before upgrade';
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:1,command:{action:'save',doc}};
 // Prior supported server committed this old-format request before the response was lost.
 const receipt=await humanCommand(repo,request);assert.equal(receipt.revision,2);
 const saved=await f.get();
 const post=value=>fetch(f.origin+'/api/project?documentId='+f.id,{method:'POST',headers:f.headers,body:JSON.stringify(value)});
 const replay=await post(request);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),receipt);assert.deepEqual(await f.get(),saved);
 const rejected=await post({...request,requestId:randomUUID(),expectedRevision:2});assert.equal(rejected.status,426);assert.deepEqual(await f.get(),saved);
 const altered=structuredClone(request);altered.command.doc.title='Different bytes';const collision=await post(altered);assert.equal(collision.status,400);assert.deepEqual(await f.get(),saved);
 const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const later=structuredClone(doc);later.slides[0].notes='Typed after the lost response';
 storage.setItem(`lanka:editor-draft:v1:${f.id}:replay`,JSON.stringify({base:{doc:before.state.doc,revision:1},doc:later,pending:request}));
 const journal=new EditorDraft(storage,f.id,{doc:saved.state.doc,revision:2},'replay');
 assert.deepEqual(journal.prepare(),request);
 const confirmed=await post(journal.prepare());assert.equal(confirmed.status,200);journal.acknowledge(request.requestId,(await confirmed.json()).revision);
 assert.equal(journal.pending,undefined);assert.equal(journal.doc.slides[0].notes,later.slides[0].notes);
 journal.confirmUpgrade(journal.previewUpgrade().stamp);
 const next=journal.prepare(),result=await post(next);assert.equal(result.status,200);assert.equal((await result.json()).revision,3);
 assert.equal((await f.get()).state.doc.slides[0].notes,later.slides[0].notes);

});

for(const markdown of [undefined,'# Импорт\n\n## Города\nЗнания и обмен'])test(`PostgreSQL library preserves profile ${markdown?'with':'without'} Markdown`,async t=>{
 const f=await fixture(t);
 for(const profile of ['focus-v2','focus-v3']){
  const request={requestId:randomUUID(),command:{action:'create_document',title:'Выбранное название',folderId:null,profile,...(markdown?{markdown}:{})}};
  const create=async()=>{const r=await fetch(f.origin+'/api/library',{method:'POST',headers:f.headers,body:JSON.stringify(request)});assert.equal(r.status,200);return r.json();};
  const result=await create(),p=await f.get('/api/project?documentId='+result.id);
  assert.equal(p.state.doc.design,profile);assert.deepEqual(p.state.doc.brand,creationDesignBrand(profile));assert.equal(p.state.doc.title,request.command.title);assert.equal(p.state.revision,1);
  assert.deepEqual(await create(),result);assert.deepEqual((await f.get('/api/project?documentId='+result.id)).state.doc,p.state.doc);
  assert.equal((await f.get('/api/history?documentId='+result.id)).length,1);
 }
});

test('MCP layer proposal preserves main until review and survives accepted readback',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
 slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:120,y:140,w:900,h:110,text:'Текст поверх фигуры',size:44,bold:false,color:'#20243B',font:'sans',lineHeight:1.3},{id:'shape',kind:'rect',x:100,y:120,w:1000,h:160,color:'#99CCEE'}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const guide=await f.client.tool('get_authoring_guide');assert.match(guide.directEditing.layers,/reorder_element/);
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Фигура под текстом',commands:[{op:'reorder_element',slideId:slide.id,elementId:'shape',direction:'back'}]};
 const result=await f.client.tool('propose_commands',request);p=await f.get();assert.deepEqual(p.state.doc,doc);
 const change=p.state.proposals.find(item=>item.id===result.proposalId).changes[0];assert.deepEqual(change.after.canvas.map(e=>e.id),['background','shape','title']);
 const preview=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:p.state.revision,proposalId:result.proposalId,slideIds:[slide.id]}});assert.equal(preview.result.isError,false);assert.equal(preview.result.content.filter(x=>x.type==='image').length,1);
 await f.human({action:'accept',proposalId:result.proposalId,changeIds:[change.id]},p);const accepted=await f.client.tool('get_project');assert.deepEqual(accepted.state.doc.slides[0],change.after);
});

test('MCP alignment proposal preserves main until review and survives accepted readback',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
 slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:120,y:140,w:900,h:110,text:'Текст поверх фигуры',size:44,bold:false,color:'#20243B',font:'sans',lineHeight:1.3},{id:'shape',kind:'rect',x:100,y:120,w:1000,h:160,color:'#99CCEE'}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const guide=await f.client.tool('get_authoring_guide');assert.match(guide.directEditing.alignment,/align_element/);
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Фигура по центру',commands:[{op:'align_element',slideId:slide.id,elementId:'shape',direction:'center'}]};
 const result=await f.client.tool('propose_commands',request);p=await f.get();assert.deepEqual(p.state.doc,doc);
 const change=p.state.proposals.find(item=>item.id===result.proposalId).changes[0];assert.deepEqual(change.after.canvas,slide.canvas.map(e=>e.id==='shape'?{...e,x:300}:e));
 const preview=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:p.state.revision,proposalId:result.proposalId,slideIds:[slide.id]}});assert.equal(preview.result.isError,false);assert.equal(preview.result.content.filter(x=>x.type==='image').length,1);
 await f.human({action:'accept',proposalId:result.proposalId,changeIds:[change.id]},p);const accepted=await f.client.tool('get_project');assert.deepEqual(accepted.state.doc.slides[0],change.after);
});

test('MCP image insertion proposal preserves main until review and survives accepted readback',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
 slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:120,y:140,w:900,h:110,text:'Текст поверх фигуры',size:44,bold:false,color:'#20243B',font:'sans',lineHeight:1.3},{id:'shape',kind:'rect',x:100,y:120,w:1000,h:160,color:'#99CCEE'}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const {PNG}=await import('pngjs'),png=new PNG({width:2,height:1});png.data.set([255,0,0,255,0,255,0,255]);
 const source=await f.client.tool('register_source',{requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,name:'Insertion.png',contentType:'image/png',base64:PNG.sync.write(png).toString('base64')});p=await f.get();
 const guide=await f.client.tool('get_authoring_guide');assert.match(guide.directEditing.imageInsertion,/insert_image/);
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Изображение на свободном месте',commands:[{op:'insert_image',slideId:slide.id,elementId:'inserted-image',assetId:source.sourceId}]};
 const beforeInvalid=structuredClone(p.state);await assert.rejects(f.client.tool('propose_commands',{...request,requestId:randomUUID(),commands:[{...request.commands[0],assetId:'missing-image-source'}]}));assert.deepEqual((await f.get()).state,beforeInvalid);
 const result=await f.client.tool('propose_commands',request);p=await f.get();assert.deepEqual(p.state.doc,doc);
 const change=p.state.proposals.find(item=>item.id===result.proposalId).changes[0];assert.deepEqual(change.after.canvas.slice(0,-1),slide.canvas);const image=change.after.canvas.at(-1);assert.equal(image.kind,'image');assert.equal(image.assetId,source.sourceId);for(const e of slide.canvas.slice(1))assert.ok(image.x>=e.x+e.w||image.x+image.w<=e.x||image.y>=e.y+e.h||image.y+image.h<=e.y);
 const preview=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:p.state.revision,proposalId:result.proposalId,slideIds:[slide.id]}});assert.equal(preview.result.isError,false);assert.equal(preview.result.content.filter(x=>x.type==='image').length,1);
 await f.human({action:'accept',proposalId:result.proposalId,changeIds:[change.id]},p);const accepted=await f.client.tool('get_project');assert.deepEqual(accepted.state.doc.slides[0],change.after);
});

test('MCP basic insertion creates a previewable proposal with measured text and human acceptance',async t=>{
 const f=await fixture(t),seed=JSON.parse(await readFile('lib/examples/lanka-sales-focus-v3.json','utf8'));seed.doc.id=f.id;
 await f.client.tool('create_deck',{requestId:randomUUID(),doc:seed.doc,sources:seed.materials.map(({name,contentType,base64})=>({name,contentType,base64})),briefing:seed.briefing});
 let p=await f.get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
 slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:120,y:100,w:1000,h:110,text:'Развитие городов',size:44,bold:false,color:'#20243B',font:'sans',lineHeight:1.3}];
 await f.human({action:'save',editorContract:'lanka-editor/3',doc},p);p=await f.get();
 const guide=await f.client.tool('get_authoring_guide');assert.match(guide.directEditing.basicInsertion,/insert_text/);assert.match(guide.directEditing.basicInsertion,/insert_shape/);
 const request={requestId:randomUUID(),deckId:f.id,expectedRevision:p.state.revision,title:'Добавить пояснение',commands:[{op:'insert_text',slideId:slide.id,elementId:'new-text',value:'Города связывали торговлю, ремёсла и управление.'},{op:'insert_shape',slideId:slide.id,elementId:'new-shape'}]};
 const result=await f.client.tool('propose_commands',request);assert.equal((await f.client.tool('propose_commands',request)).proposalId,result.proposalId);p=await f.get();assert.deepEqual(p.state.doc,doc);
 const change=p.state.proposals.find(item=>item.id===result.proposalId).changes[0];assert.deepEqual(change.after.canvas.slice(0,2),slide.canvas);assert.equal(change.after.canvas[2].text,request.commands[0].value);assert.equal(change.after.canvas[3].color,doc.brand.accent);
 const preview=await f.client.call('tools/call',{name:'render_slides',arguments:{deckId:f.id,expectedRevision:p.state.revision,proposalId:result.proposalId,slideIds:[slide.id]}});assert.equal(preview.result.isError,false);const images=preview.result.content.filter(x=>x.type==='image');assert.equal(images.length,1);
 await writeFile('out/basic-mcp-insertion-preview.png',Buffer.from(images[0].data,'base64'));
 await f.human({action:'accept',proposalId:result.proposalId,changeIds:[change.id]},p);const accepted=await f.client.tool('get_project');assert.deepEqual(accepted.state.doc.slides[0],change.after);
});
