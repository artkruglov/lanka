import test from 'node:test';
import assert from 'node:assert/strict';
import {demoDoc,blankSlide,type CanvasElement} from '../lib/domain/model';
import {dataSizeOptions,safeDataPlacement,sameBox,objectBox,boxesOverlap,initialDataPlacement} from '../lib/domain/data-layout';
import {applyDataDraft,applyDataObjectChange,DataDraftConflict} from '../lib/domain/data-draft';
import {renderDataObject,type DataObject} from '../lib/domain/data-object';
import {mergeDocuments,layoutConflictCanvas} from '../lib/domain/document-merge';
test('inserting a Focus 3 table preserves typography and avoids a cover title',()=>{
 const doc=demoDoc();
 const table:DataObject={id:'new',kind:'table',x:160,y:400,w:1280,h:350,style:{design:'focus-v3',brand:doc.brand},data:{columns:[{id:'name',label:'Название',role:'key',valueType:'text',unit:''},{id:'value',label:'Значение',role:'number',valueType:'number',unit:''}],rows:[{id:'a',cells:{name:'Категория A',value:20}},{id:'b',cells:{name:'Категория B',value:40}}]}};
 const objects:CanvasElement[]=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:96,y:300,w:1408,h:280,size:96,lineHeight:1.2,bold:true,color:'#20243B',text:'Большой заголовок'}];
 const before=structuredClone({table,objects});assert.equal(renderDataObject(table).overflow,true);
 const placed=initialDataPlacement(table,objects);assert.ok(placed);assert.equal(renderDataObject(placed).overflow,false);assert.equal(boxesOverlap(placed,objects[1],16),false);assert.deepEqual(placed.data,table.data);assert.deepEqual({table,objects},before);
 assert.equal(initialDataPlacement(table,[...objects,{id:'occupied',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF'}]),undefined);
 assert.equal(initialDataPlacement({...table,locked:true},[]),undefined);
});
test('new charts use free space and reject data that cannot fit its recipe',()=>{
 const {chart,objects}=fixture();const placed=initialDataPlacement(chart,objects.filter(e=>e.id!==chart.id));assert.ok(placed);assert.equal(renderDataObject(placed).overflow,false);assert.ok(safeDataPlacement(placed,placed,objects.filter(e=>e.id!==chart.id)));
 const invalid=structuredClone(chart);invalid.style.design='focus-v3';invalid.data.rows[0].label='W'.repeat(100);assert.equal(initialDataPlacement(invalid,[]),undefined);
});
function fixture(){
 const doc=demoDoc();doc.design='focus-v2';
 const chart:DataObject={id:'chart',kind:'chart',x:100,y:400,w:1000,h:80,style:{design:doc.design,brand:doc.brand},data:{seriesId:'series',unit:'часов',rows:[{id:'a',label:'План',value:20},{id:'b',label:'Факт',value:40}]}};
 const objects:CanvasElement[]=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:100,y:150,w:1000,h:100,size:60,text:'Работа команды',bold:true,color:'#15182A',lineHeight:1.2},chart,{id:'note',kind:'text',x:100,y:820,w:1300,h:30,size:18,text:'Синтетические данные',bold:false,color:'#15182A',lineHeight:1.3}];
 doc.slides=[{...blankSlide(),id:'s1',title:'Работа команды',canvas:objects}];return {doc,chart,objects};
}
test('size alternatives make data readable and stay clear of every neighbour without changing input',()=>{
 const {doc,chart,objects}=fixture(),before=structuredClone(doc);assert.equal(renderDataObject(chart).overflow,true);
 const options=dataSizeOptions(chart,chart,objects);assert.equal(options.length,2);
 for(const option of options){const candidate={...chart,...option.box};assert.equal(renderDataObject(candidate).overflow,false);assert.ok(safeDataPlacement(candidate,chart,objects));assert.ok(candidate.x<=chart.x&&candidate.y<=chart.y&&candidate.x+candidate.w>=chart.x+chart.w&&candidate.y+candidate.h>=chart.y+chart.h);}
 const value=applyDataDraft({...chart,...options[0].box},chart,chart),next=applyDataObjectChange(doc,'s1',value,chart);
 assert.deepEqual(next.slides[0].canvas!.filter(e=>e.id!=='chart'),objects.filter(e=>e.id!=='chart'));assert.deepEqual(value.data,chart.data);assert.deepEqual(doc,before);
});
test('size search rejects occupied space, extra backgrounds, locks and intrinsic recipe overflow',()=>{
 const {chart}=fixture();const rect=(id:string,x:number,y:number,w:number,h:number):CanvasElement=>({id,kind:'rect',x,y,w,h,color:'#FFFFFF'});
 const blocked=[rect('top',0,0,1600,400),rect('bottom',0,480,1600,420),rect('left',0,400,100,80),rect('right',1100,400,500,80),chart];
 assert.deepEqual(dataSizeOptions(chart,chart,blocked),[]);
 assert.deepEqual(dataSizeOptions(chart,chart,[rect('bg',0,0,1600,900),rect('extra',0,0,1600,900),chart]),[]);
 assert.deepEqual(dataSizeOptions(chart,{...chart,locked:true},[chart]),[]);
 const invalid=structuredClone(chart);invalid.style.design='focus-v3';invalid.data.rows[0].label='W'.repeat(50);assert.deepEqual(dataSizeOptions(invalid,invalid,[invalid]),[]);
});
test('edge placement grows inward and rejects a neighbour that arrives during journal persistence',()=>{
 const {doc,chart}=fixture(),edge={...chart,x:600,y:820};doc.slides[0].canvas=[edge];
 const [option]=dataSizeOptions(edge,edge,[edge]);assert.ok(option);assert.ok(option.box.x>=0&&option.box.y>=0&&option.box.x+option.box.w<=1600.00001&&option.box.y+option.box.h<=900.00001);
 const value={...edge,...option.box};const neighbour:CanvasElement={id:'late',kind:'rect',x:edge.x,y:value.y,w:100,h:20,color:'#FF0000'};doc.slides[0].canvas.push(neighbour);
 assert.ok(boxesOverlap(value,neighbour));assert.throws(()=>applyDataObjectChange(doc,'s1',value,edge),/нет свободного места/);assert.equal(doc.slides[0].canvas[0].h,80);
});
test('a data resize conflicts with a concurrent move as a whole box and keeps independent data',()=>{
 const {chart,objects}=fixture(),option=dataSizeOptions(chart,chart,objects)[0],mine={...chart,...option.box},remote={...chart,x:chart.x+20};
 let error:DataDraftConflict|undefined;try{applyDataDraft(mine,chart,remote);}catch(e){if(e instanceof DataDraftConflict)error=e;else throw e;}
 assert.ok(error);assert.deepEqual(error.conflicts[0].path,['geometry']);
 const resolved=applyDataDraft(mine,chart,remote,{[error.conflicts[0].key]:'mine'});assert.ok(sameBox(resolved,mine));assert.deepEqual(resolved.data,chart.data);
 assert.throws(()=>applyDataDraft(mine,chart,{...remote,x:remote.x+10},{[error.conflicts[0].key]:'mine'}),DataDraftConflict);
});
test('autosave resolves colliding positions together and preserves independent cell, text and note edits',()=>{
 const {doc,chart}=fixture();chart.h=200;
 doc.slides[0].canvas!.push({id:'neighbour',kind:'rect',x:100,y:800,w:200,h:15,color:'#CCCCCC'});
 const local=structuredClone(doc),remote=structuredClone(doc),lc=local.slides[0].canvas!.find(e=>e.id==='chart') as Extract<DataObject,{kind:'chart'}>,rc=remote.slides[0].canvas!.find(e=>e.id==='chart') as Extract<DataObject,{kind:'chart'}>;
 lc.h=350;lc.data.rows[0].value=25;rc.data.rows[1].value=41;
 const label=local.slides[0].canvas!.find(e=>e.id==='title')!;if(label.kind==='text')label.text='Сохранить этот заголовок';
 remote.slides[0].canvas!.find(e=>e.id==='neighbour')!.y=700;remote.slides[0].notes='Сохранить заметку';
 const merge=mergeDocuments(doc,local,remote);assert.equal(merge.conflicts.length,1);assert.deepEqual(merge.conflicts[0].layoutIds,['chart','neighbour']);
 for(const choice of ['local','remote'] as const){
  const resolved=mergeDocuments(doc,local,remote,{[merge.conflicts[0].key]:choice});assert.equal(resolved.conflicts.length,0);
  const canvas=resolved.doc.slides[0].canvas!,data=canvas.find(e=>e.id==='chart') as DataObject;
  assert.deepEqual(data.data.rows.map(r=>'value' in r?r.value:undefined),[25,41]);assert.equal(resolved.doc.slides[0].notes,remote.slides[0].notes);assert.ok(canvas.some(e=>e.kind==='text'&&e.text==='Сохранить этот заголовок'));
  assert.equal(boxesOverlap(data,canvas.find(e=>e.id==='neighbour')!),false);
  const preview=layoutConflictCanvas(merge.doc.slides[0].canvas!,choice==='local'?local.slides[0].canvas!:remote.slides[0].canvas!,merge.conflicts[0].layoutIds);
  assert.deepEqual(preview,canvas);
 }
});
test('a concurrent new object requires a visible placement decision while distant edits merge normally',()=>{
 const {doc,chart}=fixture();chart.h=200;const local=structuredClone(doc),remote=structuredClone(doc);local.slides[0].canvas!.find(e=>e.id==='chart')!.h=350;
 const added:CanvasElement={id:'added',kind:'rect',x:100,y:700,w:200,h:15,color:'#CCCCCC'};remote.slides[0].canvas!.splice(1,0,added);
 const merged=mergeDocuments(doc,local,remote);assert.equal(merged.conflicts.length,1);
 const kept=mergeDocuments(doc,local,remote,{[merged.conflicts[0].key]:'remote'});assert.ok(kept.doc.slides[0].canvas!.some(e=>e.id==='added'));
 assert.deepEqual(layoutConflictCanvas(merged.doc.slides[0].canvas!,remote.slides[0].canvas!,merged.conflicts[0].layoutIds),kept.doc.slides[0].canvas);
 const declined=mergeDocuments(doc,local,remote,{[merged.conflicts[0].key]:'local'});assert.ok(!declined.doc.slides[0].canvas!.some(e=>e.id==='added'));
 added.x=1400;assert.equal(mergeDocuments(doc,local,remote).conflicts.length,0);
});
