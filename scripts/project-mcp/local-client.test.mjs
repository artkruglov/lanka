import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
await build({stdin:{contents:'export {recoverableChatRequest} from "./lib/project/chat-retry"; export {editorUpgradeBackups} from "./lib/project/editor-backups"; export {EditorDraft,recoverableEditorDrafts} from "./lib/project/editor-draft"; export {mergeDocuments} from "./lib/domain/document-merge"; export {demoDoc,blankSlide,validateDoc} from "./lib/domain/model"; export {CommentDraft} from "./lib/project/comment-draft"; export {createLocalTransport,LocalRequestError} from "./lib/project/local-client"; export {CreationDraft} from "./lib/project/creation-draft"; export {chatContext} from "./lib/project/chat-context"; export {ChatDraft,selectionForScope} from "./lib/project/chat-draft";',resolveDir:process.cwd()},outfile:'.project-runtime/local-client-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {recoverableChatRequest,chatContext,createLocalTransport,LocalRequestError,ChatDraft,CreationDraft,selectionForScope,CommentDraft,EditorDraft,editorUpgradeBackups,recoverableEditorDrafts,mergeDocuments,demoDoc,blankSlide,validateDoc}=await import('../../.project-runtime/local-client-test.mjs');
const expired=()=>Response.json({code:'LOCAL_SESSION_EXPIRED',error:'Сессия обновилась.'},{status:403});
const page=()=>new Response('<html></html>',{headers:{'Content-Type':'text/html'}});
const input=(overrides={})=>({text:'Shorten the title',mode:'edit',selection:{slideId:'slide-3',field:'title'},expectedRevision:2,...overrides});
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};};

test('expired local cookie recovers once and replays identical command bytes',async()=>{
 const calls=[];let refreshed=false;
 const client=createLocalTransport(async(path,init)=>{calls.push([path,init?.body]);if(path==='/'){refreshed=true;return page();}return refreshed?Response.json({receipt:'same'}):expired();});
 const body=JSON.stringify({requestId:'fixed',command:{action:'save'}});
 assert.deepEqual(await (await client('/api/project',{method:'POST',body})).json(),{receipt:'same'});
 assert.deepEqual(calls,[['/api/project',body],['/',undefined],['/api/project',body]]);
});
test('parallel readers share a session refresh and persistent expiry is bounded',async()=>{
 let refreshes=0,ready=false;
 const client=createLocalTransport(async path=>{if(path==='/'){refreshes++;await new Promise(r=>setTimeout(r,10));ready=true;return page();}return ready?Response.json({ok:true}):expired();});
 await Promise.all([client('/api/project'),client('/api/v1/agent-connections'),client('/api/library')]);assert.equal(refreshes,1);
 let requests=0;
 const broken=createLocalTransport(async path=>{requests++;return path==='/'?page():expired();});
 await assert.rejects(broken('/api/project'),e=>e instanceof LocalRequestError&&e.status===403);assert.equal(requests,3);
});
test('origin, permission and malformed error responses never trigger session bootstrap',async()=>{
 for(const response of [new Response('Origin denied',{status:403}),Response.json({error:'Нет доступа.'},{status:403}),new Response('<html>proxy error</html>',{status:502})]){
  let calls=0;const client=createLocalTransport(async()=>{calls++;return response;});
  await assert.rejects(client('/api/project'),e=>e instanceof LocalRequestError&&!/Unexpected token|<html>/.test(e.message));assert.equal(calls,1);
 }
 const client=createLocalTransport(async()=>{throw new Error('must not fetch');});await assert.rejects(client('https://outside.example/api/project'),/Local API/);
});
test('network failure never automatically repeats a write and failed refresh can recover later',async()=>{
 let calls=0;const client=createLocalTransport(async()=>{calls++;throw new TypeError('offline');});
 await assert.rejects(client('/api/project',{method:'POST',body:'same'}),/Нет связи/);assert.equal(calls,1);
 let online=false,bootstrapped=false;
 const reconnect=createLocalTransport(async path=>{if(path==='/'){if(!online)throw new TypeError('offline');bootstrapped=true;return page();}return bootstrapped?Response.json({ok:true}):expired();});
 await assert.rejects(reconnect('/api/project'),/Нет связи/);online=true;assert.equal((await reconnect('/api/project')).status,200);
 const abort=new AbortController();abort.abort();const reason=new DOMException('aborted','AbortError');
 await assert.rejects(createLocalTransport(async()=>{throw reason;})('/api/project',{signal:abort.signal}),e=>e===reason);
});
test('draft text, area and original pending receipt survive reload and changing current revision',()=>{
 const s=storage(),draft=new ChatDraft(s,'doc-a');draft.setText('Shorten the title');draft.setOptions({mode:'edit',scope:'slide'});draft.setSelection(input().selection);
 assert.equal(new ChatDraft(s,'doc-a').text,'Shorten the title');assert.equal(new ChatDraft(s,'doc-b').text,'');
 draft.setText('');const pending=draft.prepare(input());
 const reloaded=new ChatDraft(s,'doc-a');assert.equal(reloaded.text,pending.text);assert.deepEqual(reloaded.selection,input().selection);
 assert.deepEqual(reloaded.prepare(input({expectedRevision:9})),pending);
 assert.deepEqual(reloaded.prepare(input({text:'  Shorten the title  ',expectedRevision:9})),pending);
 reloaded.acknowledge(pending.requestId);assert.equal(new ChatDraft(s,'doc-a').text,'');
});
test('accepted send preserves newly typed text; changed intent uses a new receipt; erased draft stays erased',()=>{
 const s=storage(),d=new ChatDraft(s,'doc');const pending=d.prepare(input());d.setText('My next question');d.acknowledge(pending.requestId);
 assert.equal(new ChatDraft(s,'doc').text,'My next question');
 const next=d.prepare(input({text:'Different question'}));assert.notEqual(next.requestId,pending.requestId);
 d.setText(next.text);d.setText('');assert.equal(new ChatDraft(s,'doc').text,'');
 const changed=d.prepare(input({selection:{slideId:'other',field:'title'}}));assert.notEqual(changed.requestId,next.requestId);
 const all=d.prepare(input({selection:{slideId:'slide-1',field:null,scope:'document'}}));
 assert.deepEqual(d.prepare(input({expectedRevision:7,selection:{slideId:'slide-2',field:null,scope:'document'}})),all);
});
test('blocked or corrupt browser storage does not break in-memory retry',()=>{
 const blocked=new ChatDraft({getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}},'doc');
 blocked.setText('Keep this');assert.equal(blocked.text,'Keep this');assert.equal(blocked.persistent,false);
 const a=blocked.prepare(input());assert.deepEqual(blocked.prepare(input()),a);
 const corrupt=new ChatDraft({getItem:()=>'{bad json',setItem(){}},'doc');assert.equal(corrupt.text,'');
});


test('creation request survives reload and ambiguous response; changing task creates a new intent',()=>{
 const store=storage(),draft=new CreationDraft(store);
 draft.setText('  Сделай презентацию  ');const first=draft.prepare(null);
 const reopened=new CreationDraft(store);assert.equal(reopened.text,'  Сделай презентацию  ');
 assert.deepEqual(reopened.prepare(null),first);
 reopened.setText('Другой сценарий');assert.notEqual(reopened.prepare(null).requestId,first.requestId);
 reopened.acknowledge();assert.equal(new CreationDraft(store).text,'');
});


test('creation profile survives reload and a different profile gets its own idempotent request',()=>{
 const store=storage(),draft=new CreationDraft(store);draft.setText('Собери деку');assert.equal(draft.profile,'focus-v3');
 const first=draft.prepare(null),reopened=new CreationDraft(store);assert.deepEqual(reopened.prepare(null),first);
 reopened.setProfile('focus-v2');const next=reopened.prepare(null);assert.notEqual(next.requestId,first.requestId);assert.equal(next.profile,'focus-v2');
});

test('legacy pending creation replays its exact payload without adopting a new profile',()=>{
 const store=storage(),pending={requestId:crypto.randomUUID(),prompt:'Старая заявка',folderId:null};
 store.setItem('lanka:creation-draft:v1',JSON.stringify({text:pending.prompt,pending}));
 const draft=new CreationDraft(store);assert.equal(draft.profile,'focus-v2');assert.deepEqual(draft.prepare(null),pending);
 draft.setProfile('focus-v3');const next=draft.prepare(null);assert.notEqual(next.requestId,pending.requestId);assert.equal(next.profile,'focus-v3');
});


test('object draft survives reload and retries; another object gets a distinct idempotency key',()=>{
 const s=storage(),draft=new ChatDraft(s,'object-doc');
 const selection={slideId:'slide-1',field:null,scope:'element',elementId:'one'};
 draft.setSelection(selection);draft.setOptions({mode:'edit',scope:'element'});
 const pending=draft.prepare(input({selection}));
 const restored=new ChatDraft(s,'object-doc');assert.deepEqual(restored.selection,selection);assert.equal(restored.options.scope,'element');
 assert.deepEqual(restored.prepare(input({selection,expectedRevision:99})),pending);
 assert.notEqual(restored.prepare(input({selection:{...selection,elementId:'two'}})).requestId,pending.requestId);
 assert.equal(selectionForScope({slideId:'slide-1',field:null},'element'),null);
 assert.deepEqual(selectionForScope(selection,'slide'),{slideId:'slide-1',field:null,scope:'slide'});
 assert.deepEqual(selectionForScope(selection,'document'),{slideId:'slide-1',field:null,scope:'document'});
});

test('comment text and pinned target survive reload without following another selected object',()=>{
 const s=storage(),draft=new CommentDraft(s,'doc-a'),target={slideId:'slide-2',elementId:'object-3'};
 draft.set('Clarify this object',target);
 const restored=new CommentDraft(s,'doc-a');assert.equal(restored.text,'Clarify this object');assert.deepEqual(restored.target,target);
 assert.equal(new CommentDraft(s,'doc-b').text,'');assert.equal(new CommentDraft(storage(),'doc-a').text,'');
 restored.clear();assert.equal(new CommentDraft(s,'doc-a').text,'');assert.equal(new CommentDraft(s,'doc-a').target,null);
});
test('comment ambiguous writes reuse their exact receipt and revision; confirmed failures keep text with a fresh request',()=>{
 const s=storage(),d=new CommentDraft(s,'doc'),target={slideId:'slide',elementId:'object'},command={action:'comment',...target,text:'  Clarify  '};d.set(command.text,target);
 const first=d.prepare(2,command),restored=new CommentDraft(s,'doc');assert.deepEqual(restored.prepare(9,command),first);
 restored.rejected(first.requestId);assert.equal(restored.text,command.text);const next=restored.prepare(9,command);assert.notEqual(next.requestId,first.requestId);assert.equal(next.expectedRevision,9);
 restored.acknowledge(next.requestId);assert.equal(new CommentDraft(s,'doc').text,'');
});
test('comment acknowledgement does not erase a newer draft; changing the target creates a new intent',()=>{
 const d=new CommentDraft(storage(),'doc'),target={slideId:'slide',elementId:'object'};d.set('First',target);
 const first=d.prepare(1,{action:'comment',...target,text:'First'});d.set('Next',target);d.acknowledge(first.requestId);assert.equal(d.text,'Next');
 const second=d.prepare(1,{action:'comment',...target,text:'Next'}),third=d.prepare(1,{action:'comment',slideId:'other',text:'Next'});assert.notEqual(second.requestId,third.requestId);
 d.acknowledge(second.requestId);assert.equal(d.text,'Next');
});
test('comment draft handles denied storage, invalid data and forged document identity',()=>{
 const bad=new CommentDraft({getItem(){throw Error('denied');},setItem(){throw Error('denied');}},'doc');bad.set('Keep locally',{slideId:'slide'});assert.equal(bad.text,'Keep locally');assert.equal(bad.persistent,false);
 const corrupt=new CommentDraft({getItem:()=>'{bad',setItem(){}},'doc');assert.equal(corrupt.text,'');
 const forged={text:'Wrong document',target:{slideId:'slide'},pending:{requestId:crypto.randomUUID(),deckId:'another',expectedRevision:1,command:{action:'comment',slideId:'slide',text:'Wrong document'}}};
 assert.equal(new CommentDraft({getItem:()=>JSON.stringify(forged),setItem(){}},'doc').text,'');
});

const editorFixture=()=>{const doc=demoDoc();doc.slides=[blankSlide()];doc.slides[0].canvas=[
 {id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},
 {id:'text-a',kind:'text',x:100,y:100,w:700,h:100,text:'A',color:'#20243B',size:40,bold:false,lineHeight:1.3},
 {id:'text-b',kind:'text',x:100,y:300,w:700,h:100,text:'B',color:'#20243B',size:40,bold:false,lineHeight:1.3}];return {doc,revision:1};};
const changeText=(doc,id,text)=>{const next=structuredClone(doc);next.slides[0].canvas.find(e=>e.id===id).text=text;return next;};
test('autosave acknowledgement preserves typing after the send, then saves the newer snapshot once',()=>{
 const base=editorFixture(),s=storage(),d=new EditorDraft(s,base.doc.id,base);d.edit(changeText(d.doc,'text-a','First'));
 const first=d.prepare();d.edit(changeText(d.doc,'text-a','Newer text'));d.acknowledge(first.requestId,2);
 assert.equal(d.doc.slides[0].canvas[1].text,'Newer text');assert.equal(d.base.doc.slides[0].canvas[1].text,'First');assert.equal(d.dirty,true);
 const second=d.prepare();assert.equal(second.expectedRevision,2);assert.notEqual(first.requestId,second.requestId);d.acknowledge(second.requestId,3);assert.equal(d.needsSave,false);assert.equal(d.prepare(),null);
});
test('pending autosave survives reload and retries the exact old revision even after a newer remote change',()=>{
 const base=editorFixture(),s=storage(),d=new EditorDraft(s,base.doc.id,base);d.edit(changeText(d.doc,'text-a','First'));const first=d.prepare();
 d.edit(changeText(d.doc,'text-a','Typed after send'));
 const remote={doc:changeText(first.command.doc,'text-b','Other author'),revision:3},reloaded=new EditorDraft(s,base.doc.id,remote);
 assert.deepEqual(reloaded.prepare(),first);assert.equal(reloaded.recovered,true);
 reloaded.acknowledge(first.requestId,2);
 assert.equal(reloaded.base.revision,3);assert.equal(reloaded.doc.slides[0].canvas[1].text,'Typed after send');assert.equal(reloaded.doc.slides[0].canvas[2].text,'Other author');
 assert.equal(reloaded.prepare().expectedRevision,3);
});
test('undo while a save is in flight creates a compensating save instead of losing the undo',()=>{
 const base=editorFixture(),d=new EditorDraft(storage(),base.doc.id,base);d.edit(changeText(d.doc,'text-a','Edited'));const request=d.prepare();d.edit(base.doc);
 assert.equal(d.dirty,false);assert.equal(d.needsSave,true);d.acknowledge(request.requestId,2);assert.equal(d.dirty,true);
 assert.equal(d.prepare().command.doc.slides[0].canvas[1].text,'A');
});
test('independent object fields merge; undo rebasing does not erase a remote edit',()=>{
 const base=editorFixture(),local=changeText(base.doc,'text-a','Mine'),remote=changeText(base.doc,'text-b','Theirs');remote.slides[0].canvas[1].x=200;
 const merged=mergeDocuments(base.doc,local,remote);assert.equal(merged.conflicts.length,0);assert.equal(merged.doc.slides[0].canvas[1].text,'Mine');assert.equal(merged.doc.slides[0].canvas[1].x,200);assert.equal(merged.doc.slides[0].canvas[2].text,'Theirs');
 const undo=mergeDocuments(base.doc,base.doc,remote);assert.deepEqual(undo.doc,remote);
});
test('same-field and delete-vs-edit conflicts require explicit choices and keep unrelated changes',()=>{
 const base=editorFixture(),d=new EditorDraft(storage(),base.doc.id,base);d.edit(changeText(base.doc,'text-a','Mine'));
 let remote=changeText(base.doc,'text-a','Theirs');remote=changeText(remote,'text-b','Independent');d.receive({doc:remote,revision:2});
 assert.equal(d.conflicts.length,1);assert.throws(()=>d.prepare(),/конфликт/);assert.throws(()=>d.resolve({}),/каждого/);
 const key=d.conflicts[0].key;d.resolve({[key]:'local'});assert.equal(d.doc.slides[0].canvas[1].text,'Mine');assert.equal(d.doc.slides[0].canvas[2].text,'Independent');assert.equal(d.prepare().expectedRevision,2);
 const deleted=structuredClone(base.doc);deleted.slides[0].canvas.splice(1,1);const conflict=mergeDocuments(base.doc,changeText(base.doc,'text-a','Changed'),deleted);assert.equal(conflict.conflicts.length,1);
 const result=mergeDocuments(base.doc,changeText(base.doc,'text-a','Changed'),deleted,{[conflict.conflicts[0].key]:'remote'});assert.equal(result.doc.slides[0].canvas.some(e=>e.id==='text-a'),false);
});
test('concurrent movement and resizing require one box choice while retaining independent text',()=>{
 const base=editorFixture(),local=changeText(base.doc,'text-a','Local text'),remote=structuredClone(base.doc);
 local.slides[0].canvas[1].x=900;remote.slides[0].canvas[1].w=1000;
 const merged=mergeDocuments(base.doc,local,remote);assert.equal(merged.conflicts.length,1);
 assert.equal(merged.conflicts[0].path.at(-1),'geometry');
 const resolved=mergeDocuments(base.doc,local,remote,{[merged.conflicts[0].key]:'remote'});
 const object=resolved.doc.slides[0].canvas[1];assert.equal(object.x,100);assert.equal(object.w,1000);assert.equal(object.text,'Local text');assert.equal(resolved.conflicts.length,0);
});
test('concurrent layer restructuring and renderer changes do not silently mix incompatible structures',()=>{
 const base=editorFixture(),local=structuredClone(base.doc),remote=structuredClone(base.doc);
 local.slides[0].canvas.reverse();remote.slides[0].canvas.splice(1,1);assert.equal(mergeDocuments(base.doc,local,remote).conflicts.length,1);
 const template=structuredClone(base.doc);delete template.slides[0].canvas;const remoteTemplate=structuredClone(template);remoteTemplate.slides[0].body='Remote content';assert.equal(mergeDocuments(template,base.doc,remoteTemplate).conflicts.length,1);
 const otherDesign={...base.doc,design:'classic-v1'};assert.equal(mergeDocuments(base.doc,changeText(base.doc,'text-a','Mine'),otherDesign).conflicts.length,1);
});
test('normalized save values do not trigger an endless autosave loop; invalid title remains recoverable',()=>{
 const base=editorFixture(),s=storage(),d=new EditorDraft(s,base.doc.id,base),doc=structuredClone(base.doc);doc.title='';d.edit(doc);assert.throws(()=>d.prepare());
 const restored=new EditorDraft(s,doc.id,base);assert.equal(restored.doc.title,'');restored.edit({...restored.doc,title:'Fixed'});const req=restored.prepare();restored.acknowledge(req.requestId,2);assert.equal(restored.needsSave,false);
});
test('explicit discard cannot erase an unconfirmed write; denied storage keeps in-memory changes',()=>{
 const base=editorFixture(),d=new EditorDraft({getItem(){throw Error('denied');},setItem(){throw Error('denied');}},base.doc.id,base);assert.equal(d.persistent,false);
 d.edit(changeText(d.doc,'text-a','Local'));const req=d.prepare();assert.throws(()=>d.reset(base),/результат/);d.rejected(req.requestId);assert.equal(d.doc.slides[0].canvas[1].text,'Local');d.reset(base);assert.equal(d.dirty,false);
});

test('device recovery finds another tab copy and adopts it without altering the original slot',()=>{
 const base=editorFixture(),data=new Map(),s={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),key:i=>[...data.keys()][i]??null,get length(){return data.size;}};
 s.setItem(`lanka:editor-draft:v1:${base.doc.id}:corrupt`,'{broken');
 const a=new EditorDraft(s,base.doc.id,base,'tab-a');a.edit(changeText(a.doc,'text-a','Recover after closing'));const request=a.prepare();
 const b=new EditorDraft(s,base.doc.id,base,'tab-b'),copies=recoverableEditorDrafts(s,base.doc.id,'tab-b');assert.equal(copies.length,1);
 const original=s.getItem(copies[0].key);b.adopt(copies[0].raw);assert.equal(b.doc.slides[0].canvas[1].text,'Recover after closing');assert.deepEqual(b.prepare(),request);assert.equal(s.getItem(copies[0].key),original);
 assert.equal(recoverableEditorDrafts(s,'another-document','tab-c').length,0);
});

test('replacement and concurrent crop cannot attach an old frame to a different source',()=>{
 const base=editorFixture();base.doc.slides[0].canvas.push({id:'image',kind:'image',x:100,y:500,w:300,h:200,assetId:'first',frame:{sourceWidth:200,sourceHeight:100,fit:'cover',zoom:1,focusX:.5,focusY:.5}});
 const local=structuredClone(base.doc),remote=structuredClone(base.doc);local.slides[0].canvas.at(-1).assetId='second';delete local.slides[0].canvas.at(-1).frame;remote.slides[0].canvas.at(-1).frame.zoom=2;remote.slides[0].canvas.at(-1).x=500;
 const result=mergeDocuments(base.doc,local,remote);assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].path.at(-1),'imageContent');
 const resolved=mergeDocuments(base.doc,local,remote,{[result.conflicts[0].key]:'local'});assert.equal(resolved.doc.slides[0].canvas.at(-1).assetId,'second');assert.equal(resolved.doc.slides[0].canvas.at(-1).frame,undefined);assert.equal(resolved.doc.slides[0].canvas.at(-1).x,500);
});

test('an acknowledged image upload is undoable without erasing a later remote note',()=>{
 const base=editorFixture(),journal=new EditorDraft(storage(),base.doc.id,base),saved=structuredClone(base.doc);saved.slides[0].canvas.push({id:'uploaded',kind:'image',assetId:'asset',x:100,y:500,w:200,h:200});
 const undo=journal.adoptSavedChange({doc:saved,revision:2},1);assert.deepEqual(undo,base.doc);assert.equal(journal.needsSave,false);
 const remote=structuredClone(saved);remote.slides[0].notes='Another author';journal.receive({doc:remote,revision:3});
 const rebased=mergeDocuments(saved,undo,remote);assert.equal(rebased.conflicts.length,0);journal.edit(rebased.doc);const request=journal.prepare();assert.equal(request.expectedRevision,3);assert.equal(request.command.doc.slides[0].canvas.some(e=>e.id==='uploaded'),false);assert.equal(request.command.doc.slides[0].notes,'Another author');
 assert.equal(journal.adoptSavedChange({doc:saved,revision:2},1),null);
});


test('chat history resolves saved slide and object IDs after selection, reorder and deletion',()=>{
 const first={id:'a',title:'First'}, second={id:'b',title:'Second',canvas:[{id:'text-1',kind:'text',text:'Actual object'}]};
 const selection={slideId:'b',field:'title'};
 assert.equal(chatContext(selection,[first,second]).label,'Слайд 2 · Заголовок');
 assert.equal(chatContext(selection,[second,first]).label,'Слайд 1 · Заголовок');
 assert.equal(chatContext(selection,[first]).label,'Слайд удалён');
 assert.equal(chatContext({...selection,field:null,scope:'document'},[]).label,'Вся презентация');
 const object={slideId:'b',field:null,scope:'element',elementId:'text-1'};
 assert.equal(chatContext(object,[first,second]).label,'Слайд 2 · Actual object');
 assert.equal(chatContext({...object,elementId:'missing'},[first,second]).label,'Слайд 2 · Объект недоступен');
 assert.equal(chatContext(object,[first,{...second,canvas:[]}]).label,'Слайд 2 · Объект недоступен');
 assert.match(chatContext(selection,[first,{...second,title:'Renamed'}]).title,/Renamed/);
});

test('creation material survives reload, and changed source text cannot replay an old request',()=>{
 const store=storage(),draft=new CreationDraft(store);draft.setText('Подготовь отчёт');draft.setMaterial('Итоги','42 заявки');const first=draft.prepare(null);
 const next=new CreationDraft(store);assert.equal(next.materialText,'42 заявки');assert.deepEqual(next.prepare(null),first);
 next.setMaterial('Итоги','43 заявки');assert.notEqual(next.prepare(null).requestId,first.requestId);
 next.setMaterial('Итоги','');assert.equal(next.prepare(null).material,undefined);next.acknowledge();assert.equal(new CreationDraft(store).materialText,'');
});

test('file preview survives reload but only an explicitly selected intake is submitted',()=>{
 const store=storage(),draft=new CreationDraft(store),id=crypto.randomUUID();draft.setText('Создай отчёт');draft.setIntakePreview(id);
 const reloaded=new CreationDraft(store);assert.equal(reloaded.intakePreviewId,id);assert.equal(reloaded.prepare(null).sourceIntakeId,undefined);
 reloaded.setSourceIntake(id);const first=reloaded.prepare(null);assert.equal(first.sourceIntakeId,id);assert.deepEqual(new CreationDraft(store).prepare(null),first);
 reloaded.setSourceIntake(undefined);assert.notEqual(reloaded.prepare(null).requestId,first.requestId);reloaded.acknowledge();assert.equal(new CreationDraft(store).intakePreviewId,undefined);
});


test('retry offers only the terminal failed request with original mode and object scope',()=>{
 const selection={slideId:'slide-2',field:null,scope:'element',elementId:'text-7'};
 const request={id:'u',role:'user',text:'Make this shorter',status:'complete',mode:'edit',selection,proposalId:null,createdAt:new Date().toISOString()};
 const answer={...request,id:'a',role:'assistant',text:'Interrupted',status:'failed'};
 const view={sessionId:'s',messages:[request,answer],cursor:2,active:null,queued:0};
 assert.deepEqual(recoverableChatRequest(view),{request,status:'failed'});
 assert.deepEqual(recoverableChatRequest({...view,messages:[request,{...answer,status:'interrupted'}]}),{request,status:'interrupted'});
 for(const v of [null,{...view,active:{id:'run'}},{...view,queued:1},{...view,messages:[request]},{...view,messages:[request,{...answer,status:'complete'}]},{...view,messages:[request,{...answer,status:'streaming'}]},{...view,messages:[request,{...answer,proposalId:'p'}]},{...view,messages:[{...request,mode:'create'},{...answer,mode:'create'}]},{...view,messages:[request,{...answer,mode:'discuss'}]}])assert.equal(recoverableChatRequest(v),null);
});

test('an old dirty journal remains recoverable but cannot be stamped as a current editor save',()=>{
 const data=new Map(),s={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const doc=demoDoc(),base={doc,revision:1},changed=structuredClone(doc);changed.title='Legacy unsaved work';
 const key=`lanka:editor-draft:v1:${doc.id}:old`;
 s.setItem(key,JSON.stringify({base,doc:changed}));
 const draft=new EditorDraft(s,doc.id,base,'old');
 assert.equal(draft.doc.title,changed.title);assert.equal(draft.recovered,true);
 assert.throws(()=>draft.prepare(),/Редактор.*устарел/);
 assert.equal(JSON.parse(s.getItem(key)).doc.title,changed.title);
 const reopened=new EditorDraft(s,doc.id,base,'old');assert.throws(()=>reopened.prepare(),/устарел/);
 reopened.reset(base);reopened.edit(changed);assert.equal(reopened.prepare().command.editorContract,'lanka-editor/3');
});
test('clean legacy journal safely refreshes but an old pending request is never silently upgraded',()=>{
 const data=new Map(),s={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const doc=demoDoc(),base={doc,revision:1},key=`lanka:editor-draft:v1:${doc.id}:old`;
 s.setItem(key,JSON.stringify({base,doc}));
 const clean=new EditorDraft(s,doc.id,base,'old');clean.edit({...doc,title:'Current edit'});assert.equal(clean.prepare().command.editorContract,'lanka-editor/3');
 const raw=JSON.parse(s.getItem(key));delete raw.pending.command.editorContract;s.setItem(key,JSON.stringify(raw));
 const pending=new EditorDraft(s,doc.id,base,'old');assert.deepEqual(pending.prepare(),raw.pending);assert.equal(pending.prepare().command.editorContract,undefined);assert.equal(pending.pending.command.doc.title,'Current edit');
});

test('reviewed legacy transfer preserves independent server edits and persists the original before allowing a save',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const doc=demoDoc(),base={doc,revision:1},local=structuredClone(doc);local.title='My legacy title';
 storage.setItem(`lanka:editor-draft:v1:${doc.id}:old`,JSON.stringify({base,doc:local}));
 const server=structuredClone(doc);server.slides[0].notes='New server notes';
 const draft=new EditorDraft(storage,doc.id,{doc:server,revision:2},'old'),preview=draft.previewUpgrade();
 assert.equal(preview.after.title,local.title);assert.equal(preview.after.slides[0].notes,server.slides[0].notes);
 assert.throws(()=>draft.prepare(),/устарел/);draft.confirmUpgrade(preview.stamp);
 const request=draft.prepare();assert.equal(request.expectedRevision,2);assert.equal(request.command.editorContract,'lanka-editor/3');
 const backups=[...values.entries()].filter(([k])=>k.includes('lanka:editor-upgrade-backup:'));assert.equal(backups.length,1);assert.equal(JSON.parse(backups[0][1]).doc.title,local.title);assert.equal(JSON.parse(backups[0][1]).editorContract,undefined);
});
test('legacy transfer rejects stale previews, concurrent conflicts, unknown versions and unavailable backups',()=>{
 function fixture(version){const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};const doc=demoDoc(),base={doc,revision:1};storage.setItem(`lanka:editor-draft:v1:${doc.id}:old`,JSON.stringify({editorContract:version,base,doc:{...doc,title:'Local title'}}));return {storage,doc,draft:new EditorDraft(storage,doc.id,base,'old')};}
 const a=fixture(),preview=a.draft.previewUpgrade();a.draft.edit({...a.draft.doc,title:'Later typing'});assert.throws(()=>a.draft.confirmUpgrade(preview.stamp),/изменился/);assert.equal(a.draft.needsUpgrade,true);
 const b=fixture();b.draft.receive({doc:{...b.doc,title:'Concurrent title'},revision:2});assert.throws(()=>b.draft.previewUpgrade(),/конфликт/);
 const c=fixture('lanka-editor/999');assert.throws(()=>c.draft.previewUpgrade(),/не поддерживается/);
 const d=fixture(),p=d.draft.previewUpgrade();d.storage.setItem=()=>{throw Error('quota');};assert.throws(()=>d.draft.confirmUpgrade(p.stamp),/резервную копию/);assert.equal(d.draft.needsUpgrade,true);
});

test('legacy transfer retains newly received data layout version while carrying independent text edits',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const doc=demoDoc();doc.design='focus-v3';
 doc.slides[0].canvas=[{id:'data-chart',kind:'chart',x:100,y:200,w:1000,h:400,style:{design:'focus-v3',brand:doc.brand},data:{seriesId:'series',unit:'шт.',rows:[{id:'row-a',label:'Отдел А',value:12},{id:'row-b',label:'Отдел Б',value:18}]}}];
 const local=structuredClone(doc);local.title='Legacy manual title';
 storage.setItem(`lanka:editor-draft:v1:${doc.id}:old`,JSON.stringify({base:{doc,revision:1},doc:local}));
 const remote=structuredClone(doc);remote.slides[0].canvas[0].style.layoutVersion='focus-v3-data-2';
 const draft=new EditorDraft(storage,doc.id,{doc:remote,revision:2},'old'),preview=draft.previewUpgrade();draft.confirmUpgrade(preview.stamp);
 const next=draft.prepare().command.doc;assert.equal(next.title,local.title);assert.deepEqual(next.slides[0].canvas,remote.slides[0].canvas);
});

test('creation answer retries exact persisted request after question is consumed and document changes',()=>{
 const s=storage(),d=new ChatDraft(s,'creation-answer');
 const a={...input(),mode:'edit',selection:{...input().selection,field:null,scope:'document'},creationQuestionId:crypto.randomUUID()};
 const pending=d.prepare(a);const reloaded=new ChatDraft(s,'creation-answer');
 const {creationQuestionId,...after}=a;
 assert.deepEqual(reloaded.prepare({...after,expectedRevision:2}),pending);
 assert.notEqual(reloaded.prepare({...a,creationQuestionId:crypto.randomUUID()}).requestId,pending.requestId);
});

test('upgrade backups preserve exact original bytes and future fields, isolate documents, expose storage failures',()=>{
 const doc=demoDoc(),prefix=`lanka:editor-upgrade-backup:v1:${doc.id}:`;
 const raw=JSON.stringify({base:{doc,revision:7},doc:{...doc,title:'Original title',future:{keep:'unchanged'}},updatedAt:123456,editorContract:'future'},null,2);
 const entries=new Map([[prefix+'slot:one',raw],[prefix+'slot:damaged','{broken'],[prefix+'wrong',JSON.stringify({doc:{id:'different'},base:{doc:{id:'different'}}})],['lanka:editor-upgrade-backup:v1:another:slot',raw]]);
 const s={get length(){return entries.size;},key:i=>[...entries.keys()][i],getItem:k=>entries.get(k)??null};
 const result=editorUpgradeBackups(s,doc.id);assert.equal(result.unavailable,false);assert.equal(result.items.length,2);
 assert.equal(result.items[0].raw,raw);assert.equal(result.items[0].revision,7);assert.equal(result.items[1].raw,'{broken');
 assert.equal(editorUpgradeBackups(null,doc.id).unavailable,true);
 assert.equal(editorUpgradeBackups({get length(){throw Error('denied');}},doc.id).unavailable,true);
 assert.deepEqual(entries.get(prefix+'slot:one'),raw);
});

test('import preview merges independent current edits, requires conflict choices and never writes on preview',()=>{
 const doc=demoDoc(),copy=structuredClone(doc),current=structuredClone(doc);copy.title='Из копии';current.slides[0].notes='Новая заметка';
 const raw=JSON.stringify({base:{doc,revision:1},doc:copy});
 const s=storage(),draft=new EditorDraft(s,doc.id,{doc:current,revision:3});
 const preview=draft.previewBackup(raw);assert.equal(preview.after.title,copy.title);assert.equal(preview.after.slides[0].notes,current.slides[0].notes);assert.deepEqual(draft.doc,current);assert.equal(draft.needsSave,false);
 assert.deepEqual(draft.confirmBackup(raw,preview.stamp),preview.after);assert.deepEqual(draft.doc,current);
 const newer=structuredClone(current);newer.title='Текущий заголовок';draft.receive({doc:newer,revision:4});
 assert.throws(()=>draft.confirmBackup(raw,preview.stamp),/изменилась после просмотра/);
 const conflict=draft.previewBackup(raw);assert.equal(conflict.after,null);assert.equal(conflict.conflicts.length,1);
 const choices={[conflict.conflicts[0].key]:'remote'};const resolved=draft.previewBackup(raw,choices);
 assert.equal(draft.confirmBackup(raw,resolved.stamp,choices).title,newer.title);
});
test('import rejects pending writes, other documents, unsupported versions and unknown fields without changing local work',()=>{
 const doc=demoDoc(),draft=new EditorDraft(storage(),doc.id,{doc,revision:1}),base={doc,revision:1};
 const cases=[{base,doc:{...doc,id:'another'}},{base,doc,editorContract:'future'},{base,doc:{...doc,unknown:'preserve'}},{base,doc,pending:{requestId:crypto.randomUUID(),deckId:doc.id,expectedRevision:1,command:{action:'save',doc}}}];
 for(const value of cases)assert.throws(()=>draft.previewBackup(JSON.stringify(value)));
 assert.throws(()=>draft.previewBackup('{bad'));
 assert.deepEqual(draft.doc,doc);assert.equal(draft.needsSave,false);
 const changed=structuredClone(doc);changed.title='Несохранённая правка';draft.edit(changed);
 assert.throws(()=>draft.previewBackup(JSON.stringify({base,doc})),/текущие правки/);assert.equal(draft.doc.title,changed.title);
});
