import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {indexedDB} from 'fake-indexeddb';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
globalThis.indexedDB=indexedDB;
await build({stdin:{contents:`export {dataSizeOptions,sameBox} from './lib/domain/data-layout';export {DataObjectEditor} from './components/data-object-editor';export {dataConflictText} from './lib/domain/data-merge';export {DataWindowDraft,browserDataWindowStore,dataRecordSaved,dataWindowRecordSchema} from './lib/project/data-window-draft';export {applyDataDraft,DataDraftConflict,applyDataObjectChange} from './lib/domain/data-draft';export {demoDoc} from './lib/domain/model';export {EditorDraft} from './lib/project/editor-draft';`,resolveDir:process.cwd()},outfile:'.project-runtime/data-window-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {dataSizeOptions,sameBox,DataObjectEditor,dataConflictText,DataWindowDraft,browserDataWindowStore:store,dataRecordSaved,dataWindowRecordSchema,applyDataDraft,DataDraftConflict,applyDataObjectChange,demoDoc,EditorDraft}=await import('../../.project-runtime/data-window-test.mjs');
beforeEach(async()=>{await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('lanka-data-drafts-v1');r.onsuccess=resolve;r.onerror=()=>reject(r.error);});});
function fixture(kind='chart'){
 const doc=demoDoc();doc.id=randomUUID();doc.design='focus-v2';doc.slides=[{...doc.slides[0],id:'slide-1',title:'Data'}];
 const base={id:'data',kind,x:100,y:400,w:1400,h:350,style:{design:'focus-v2',brand:doc.brand},data:kind==='chart'?{seriesId:'series',unit:'hours',rows:[{id:'a',label:'A',value:20},{id:'b',label:'B',value:40}]}:
 {columns:[{id:'label',label:'Label',role:'key',valueType:'text',unit:''},{id:'value',label:'Value',role:'number',valueType:'number',unit:'hours'}],rows:[{id:'a',cells:{label:'A',value:20}},{id:'b',cells:{label:'B',value:40}}]}};
 doc.slides[0].canvas=[base];return {doc,base,target:{documentId:doc.id,slideId:'slide-1',owner:'tab-1',base}};
}
const edit=(session,value)=>{const next=structuredClone(session.record.draft);if(next.kind==='chart')next.data.rows[0].value=value;else next.data.rows[0].cells.value=value;return session.set(next);};
test('incomplete numeric input survives IndexedDB adapter close/reopen and restores only its target',async()=>{
 const f=fixture(),s=new DataWindowDraft(f.target);await edit(s,'25,');
 assert.equal(s.persistent,true);const [record]=await store.list(f.doc.id);assert.equal(record.draft.data.rows[0].value,'25,');
 assert.deepEqual(await store.list('other-document'),[]);
 assert.throws(()=>new DataWindowDraft({...f.target,slideId:'other'},store,record),/другого/);
 const restored=new DataWindowDraft(f.target,store,record);await restored.start();
 assert.notEqual(restored.record.id,record.id);assert.equal((await store.list(f.doc.id)).length,1);
 assert.throws(()=>applyDataDraft(restored.record.draft,restored.record.base,f.base),/Строка 1, значение: Введите число/);
 await edit(restored,'25,5');assert.equal(applyDataDraft(restored.record.draft,restored.record.base,f.base).data.rows[0].value,25.5);
});
test('table header and numeric partial input are recoverable without passing canonical validation',async()=>{
 const f=fixture('table'),s=new DataWindowDraft(f.target),draft=structuredClone(s.record.draft);
 draft.data.columns[0].label='';draft.data.rows[0].cells.value='-';await s.set(draft);
 const [r]=await store.list(f.doc.id);assert.equal(r.draft.data.columns[0].label,'');assert.equal(r.draft.data.rows[0].cells.value,'-');
 assert.throws(()=>applyDataDraft(r.draft,r.base,f.base),/Строка 1, колонка 2 «Value»: Введите число/);
 assert.equal(dataWindowRecordSchema.safeParse({...r,slideId:''}).success,false);
 assert.equal(dataWindowRecordSchema.safeParse({...r,draft:{...r.draft,id:'elsewhere'}}).success,false);
});
test('queued writes cannot acknowledge an older draft as the latest durable value',async()=>{
 const f=fixture();let release;const wait=new Promise(r=>release=r);let calls=0;
 const delayed={...store,write:async(...args)=>{if(++calls===1)await wait;return store.write(...args);}};
 const s=new DataWindowDraft(f.target,delayed);const first=edit(s,'21'),second=edit(s,'22');
 assert.equal(s.protected,false);assert.equal(s.record.draft.data.rows[0].value,'22');release();await first;
 assert.equal(s.persistent,false);await second;assert.equal(s.persistent,true);
 assert.equal((await store.list(f.doc.id))[0].draft.data.rows[0].value,'22');
});
test('storage failure leaves the latest input in memory and a later write recovers',async()=>{
 const f=fixture();let broken=false;
 const port={...store,write:async(...args)=>{if(broken)throw Error('quota');return store.write(...args);}};
 const s=new DataWindowDraft(f.target,port);await edit(s,'21');broken=true;await edit(s,'22');
 assert.equal(s.protected,false);assert.equal(s.record.draft.data.rows[0].value,'22');assert.equal((await store.list(f.doc.id))[0].draft.data.rows[0].value,'21');
 broken=false;await edit(s,'22');assert.equal(s.protected,true);assert.equal(s.problem,'');
 await s.discard();assert.deepEqual(await store.list(f.doc.id),[]);
});
test('discard removes the last successful copy when a newer write failed',async()=>{
 const f=fixture();let broken=false;
 const s=new DataWindowDraft(f.target,{...store,write:async(...a)=>{if(broken)throw Error('quota');return store.write(...a);}});
 await edit(s,'25');broken=true;await edit(s,'20');assert.equal(s.changed,false);
 await s.discard();assert.deepEqual(await store.list(f.doc.id),[]);
});
test('two windows fork recovery without deleting edits made after the captured snapshot',async()=>{
 const f=fixture(),a=new DataWindowDraft(f.target);await edit(a,'21');const [snapshot]=await store.list(f.doc.id);
 const b=new DataWindowDraft({...f.target,owner:'tab-2'},store,snapshot);
 await edit(a,'22');await b.start();await edit(b,'23');
 const records=await store.list(f.doc.id);assert.equal(records.length,2);assert.deepEqual(records.map(r=>r.draft.data.rows[0].value).sort(),['22','23']);
 await b.discard();assert.equal((await store.list(f.doc.id))[0].draft.data.rows[0].value,'22');
});
test('applied fallback waits for a newer saved version and remains when main editor storage fails',async()=>{
 const f=fixture(),s=new DataWindowDraft(f.target);await edit(s,'25');
 const value=applyDataDraft(s.record.draft,s.record.base,f.base);await s.stage(value,1);
 const initial={doc:f.doc,revision:1};const main=new EditorDraft({getItem:()=>null,setItem:()=>{throw Error('quota');}},f.doc.id,initial,'tab');
 const next=applyDataObjectChange(f.doc,'slide-1',value,f.base);main.edit(next);
 assert.equal(main.persistent,false);assert.equal(s.persistent,true);
 assert.equal(dataRecordSaved(s.record,value,1),false);assert.equal(dataRecordSaved(s.record,f.base,2),false);assert.equal(dataRecordSaved(s.record,value,2),true);
 assert.equal((await store.list(f.doc.id)).length,1);
 assert.equal(dataRecordSaved({...s.record,applied:undefined,appliedAfterRevision:undefined},value,2),false);
});
test('independent rows merge, conflicting cells require explicit choices tied to exact values',()=>{
 const f=fixture(),mine=structuredClone(f.base),current=structuredClone(f.base);mine.data.rows[0].value=25;current.data.rows[1].value=41;current.x+=10;
 const combined=applyDataDraft(mine,f.base,current);assert.deepEqual(combined.data.rows.map(r=>r.value),[25,41]);assert.equal(combined.x,current.x);
 current.data.rows[0].value=30;let conflict;try{applyDataDraft(mine,f.base,current);}catch(e){conflict=e;}
 assert.ok(conflict instanceof DataDraftConflict);assert.equal(conflict.conflicts.length,1);
 const choices={[conflict.conflicts[0].key]:'mine'};assert.deepEqual(applyDataDraft(mine,f.base,current,choices).data.rows.map(r=>r.value),[25,41]);
 current.data.rows[0].value=31;assert.throws(()=>applyDataDraft(mine,f.base,current,choices),DataDraftConflict);
});
test('units, source and column type changes never silently reinterpret another author’s numbers',()=>{
 for(const kind of ['chart','table']){
  const f=fixture(kind),mine=structuredClone(f.base),current=structuredClone(f.base);
  if(kind==='chart'){mine.data.rows[0].value=25;current.data.unit='days';}else{mine.data.rows[0].cells.value=25;current.data.columns[1].unit='days';}
  assert.throws(()=>applyDataDraft(mine,f.base,current),e=>e instanceof DataDraftConflict&&e.conflicts[0].path[0]==='data');
 }
 const f=fixture(),mine=structuredClone(f.base),current={...f.base,data:{...f.base.data,sourceId:'new-source'}};mine.data.rows[0].value=25;
 assert.throws(()=>applyDataDraft(mine,f.base,current),DataDraftConflict);
});
test('reordering preserves stable cells; kept rows return to their relative position after a deletion conflict',()=>{
 const f=fixture('table'),mine=structuredClone(f.base),current=structuredClone(f.base);mine.data.columns.reverse();current.data.rows[0].cells.value=26;
 assert.equal(applyDataDraft(mine,f.base,current).data.rows[0].cells.value,26);
 const deleted=structuredClone(f.base);deleted.data.rows.shift();let conflict;try{applyDataDraft(deleted,f.base,current);}catch(e){conflict=e;}
 assert.ok(conflict instanceof DataDraftConflict);const chosen=applyDataDraft(deleted,f.base,current,{[conflict.conflicts[0].key]:'current'});
 assert.deepEqual(chosen.data.rows.map(r=>r.id),['a','b']);assert.equal(chosen.data.rows[0].cells.value,26);
});
test('working-copy handoff rechecks a concurrent edit and never recreates deleted objects',()=>{
 const f=fixture(),value=structuredClone(f.base);value.data.rows[0].value=25;
 const current=structuredClone(f.doc);current.slides[0].canvas[0].data.rows[0].value=30;
 assert.throws(()=>applyDataObjectChange(current,'slide-1',value,f.base),/изменился во время/);assert.equal(current.slides[0].canvas[0].data.rows[0].value,30);
 current.slides[0].canvas=[];assert.throws(()=>applyDataObjectChange(current,'slide-1',value,f.base),/удалён/);
 const independent=structuredClone(f.doc);independent.slides[0].notes='A later manual note';
 assert.equal(applyDataObjectChange(independent,'slide-1',value,f.base).slides[0].notes,'A later manual note');
});

test('conflict previews name sources, types and values without exposing storage IDs',()=>{
 const f=fixture('table');f.base.data.sourceId='private-source-id';
 const text=dataConflictText(f.base,['data'],f.base.data,[{id:'private-source-id',name:'Рабочие часы.csv'}]);
 assert.match(text,/Рабочие часы.csv/);assert.match(text,/число/);assert.match(text,/A · 20/);
 assert.doesNotMatch(text,/private-source-id|"cells"|"id"/);
 assert.equal(dataConflictText(f.base,['sourceId'],'private-source-id',[{id:'private-source-id',name:'Рабочие часы.csv'}]),'Рабочие часы.csv');
 assert.equal(dataConflictText(f.base,['sourceId'],'missing',[]),'Недоступный источник');
 assert.equal(dataConflictText(f.base,['rows','a','cells','value'],0.0000000000001,[]),'1e-13');
});

test('autosave retry cannot merge a new number with changed units or reuse an old conflict choice',()=>{
 const f=fixture(),memory=new Map(),port={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
 const main=new EditorDraft(port,f.doc.id,{doc:f.doc,revision:1},'tab');
 const local=structuredClone(f.doc);local.slides[0].canvas[0].data.rows[0].value=25;local.slides[0].notes='Keep my independent note';main.edit(local);const request=main.prepare();
 const remote=structuredClone(f.doc);remote.slides[0].canvas[0].data.unit='days';main.receive({doc:remote,revision:2});main.rejected(request.requestId);
 assert.equal(main.conflicts.length,1);assert.equal(main.conflicts[0].path[4],'dataContent');
 const choices={[main.conflicts[0].key]:'remote'};
 const later=structuredClone(remote);later.slides[0].canvas[0].data.rows[0].value=21;main.receive({doc:later,revision:3});
 assert.throws(()=>main.resolve(choices),/Выберите решение/);
 main.resolve({[main.conflicts[0].key]:'remote'});
 assert.equal(main.doc.slides[0].canvas[0].data.rows[0].value,21);assert.equal(main.doc.slides[0].canvas[0].data.unit,'days');
 assert.equal(main.doc.slides[0].notes,'Keep my independent note');assert.equal(main.prepare().expectedRevision,3);
});


test('data dialog renders the recovered candidate before applying and exposes invalid input without a stale preview',()=>{
 const f=fixture(),session=new DataWindowDraft(f.target),snapshot=structuredClone(session.record);snapshot.draft.data.rows[0].value='25';
 const props={element:f.base,current:f.base,saved:f.base,revision:1,documentId:f.doc.id,previewDoc:f.doc,slideId:'slide-1',owner:'tab',recovered:snapshot,sources:[],onApply:()=>{throw Error('Preview must not write');},onClose:()=>{},onJournalChange:()=>{}};
 const html=renderToStaticMarkup(createElement(DataObjectEditor,props));assert.match(html,/Предпросмотр слайда/);assert.match(html,/<svg/);assert.match(html,/>25 hours</);assert.equal(f.doc.slides[0].canvas[0].data.rows[0].value,20);
 snapshot.draft.data.rows[0].value='25,';const partial=renderToStaticMarkup(createElement(DataObjectEditor,props));assert.match(partial,/Введите число/);assert.doesNotMatch(partial,/<svg/);assert.match(partial,/value="25,"/);
});


test('a size-only draft survives restoration and is retired only when the chosen geometry is saved',async()=>{
 const f=fixture();f.base.h=80;const [option]=dataSizeOptions(f.base,f.base,[f.base]);assert.ok(option);
 const session=new DataWindowDraft(f.target),raw={...f.base,...option.box};await session.set(raw);assert.equal(session.changed,true);assert.equal(session.persistent,true);
 const [snapshot]=await store.list(f.doc.id);assert.equal(snapshot.geometryIntent,true);assert.equal(dataWindowRecordSchema.innerType().omit({geometryIntent:true}).strict().safeParse(snapshot).success,false);const restored=new DataWindowDraft(f.target,store,snapshot);await restored.start();assert.ok(sameBox(restored.record.draft,raw));
 const applied=applyDataDraft(restored.record.draft,restored.record.base,f.base);await restored.stage(applied,1);
 assert.equal(dataRecordSaved(restored.record,f.base,2),false);assert.equal(dataRecordSaved(restored.record,applied,1),false);assert.equal(dataRecordSaved(restored.record,applied,2),true);
 await restored.discard();assert.deepEqual(await store.list(f.doc.id),[]);
});

test('the data dialog offers safe sizes and previews a restored selection without applying it',()=>{
 const f=fixture();f.base.h=80;const props={element:f.base,current:f.base,saved:f.base,revision:1,documentId:f.doc.id,previewDoc:f.doc,slideId:'slide-1',owner:'tab',sources:[],onApply:()=>{throw Error('Preview cannot write');},onClose:()=>{},onJournalChange:()=>{}};
 const initial=renderToStaticMarkup(createElement(DataObjectEditor,props));assert.match(initial,/Размер по шаблону/);assert.match(initial,/Варианты размера/);
 const [option]=dataSizeOptions(f.base,f.base,[f.base]),session=new DataWindowDraft(f.target),record={...session.record,geometryIntent:true,draft:{...f.base,...option.box}};
 const restored=renderToStaticMarkup(createElement(DataObjectEditor,{...props,recovered:record}));assert.match(restored,/Выбран новый размер/);assert.match(restored,/Вернуть прежний размер/);assert.equal(f.doc.slides[0].canvas[0].h,80);
});
