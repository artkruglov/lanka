import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {demoDoc,blankSlide,validateDoc,canvasSchema,initialState,validateReferences,canvasElementSchema} from '../lib/domain/model';
import {scene} from '../lib/domain/scene';
import {canvasFromScene,canvasScene} from '../lib/domain/canvas';
import {isDataObject,renderDataObject} from '../lib/domain/data-object';
import {applyDataDraft,resolveDataDraft,applyDataObjectChange,dataNumber,DataDraftConflict} from '../lib/domain/data-draft';
import {block,measure} from '../lib/domain/scene-text-v3';
import {designOptions} from '../lib/domain/design';
import {buildPptx} from '../lib/export';
function sample(design:typeof designOptions[number]='focus-v3',kind:'chart'|'table'='chart'){
 const doc=demoDoc();doc.design=design;doc.slides=[{...blankSlide(),layout:kind,title:'Работа команды',chart:[{label:'План',value:20},{label:'Факт',value:40},{label:'Изменение',value:-10},{label:'Нет изменений',value:0}],chartUnit:'шт.',table:{columns:['Команда','Результат'],rows:[['Исследования','20'],['Разработка','40']],columnRoles:['key','number']}}];
 const original=scene(doc.slides[0],doc.brand,0,1,design);doc.slides[0].canvas=canvasSchema.parse(canvasFromScene(original));
 const object=doc.slides[0].canvas.find(isDataObject)!;assert.ok(object,`${design}/${kind}: no data object`);return {doc,object,original};
}
function visible(items:ReturnType<typeof scene>['items']){return items.map(p=>{
 const result:Record<string,unknown>={kind:p.kind,x:p.x,y:p.y};
 if(p.kind==='text')Object.assign(result,{text:p.text,size:p.size,bold:p.bold,color:p.color,font:p.font,tracking:p.tracking,lineHeight:p.lineHeight??1.32});
 else Object.assign(result,{w:p.w,h:p.h,...(p.kind==='rect'?{color:p.color}:{assetId:p.assetId})});
 for(const key of Object.keys(result))if(typeof result[key]==='number')result[key]=Math.round((result[key] as number)*1e6)/1e6;
 return JSON.parse(JSON.stringify(result));
});}
test('all seven templates preserve chart/table composition and data when unlocked',()=>{
 for(const design of designOptions)for(const kind of ['chart','table'] as const){
  const {doc,object,original}=sample(design,kind);assert.equal(object.kind,kind);validateDoc(doc);
  assert.deepEqual(visible(canvasScene(doc.slides[0].canvas!).items),visible(original.items),`${design}/${kind}`);
  assert.equal(canvasScene(doc.slides[0].canvas!).overflow,false,`${design}/${kind}`);
 }
});
test('chart data editing updates bars, preserves row IDs/geometry and detects changed data',()=>{
 const {object}=sample();assert.equal(object.kind,'chart');if(object.kind!=='chart')return;
 const draft=structuredClone(object);draft.data.rows[0].value=25;
 const current={...object,x:object.x+10};const updated=applyDataDraft(draft,object,current);
 assert.equal(updated.x,current.x);assert.equal(updated.w,object.w);assert.deepEqual(updated.data.rows.map(r=>r.id),object.data.rows.map(r=>r.id));
 assert.notDeepEqual(renderDataObject(updated).items.filter(p=>p.kind==='rect'),renderDataObject(current).items.filter(p=>p.kind==='rect'));
 assert.ok(renderDataObject(updated).items.some(p=>p.kind==='text'&&p.text.includes('25')));
 assert.throws(()=>applyDataDraft(draft,object,{...object,data:{...object.data,unit:'другое'}}),e=>e instanceof DataDraftConflict&&e.conflicts[0].path[0]==='data');
 for(const bad of ['', ' ', '-', 'abc', '1,2,3','1e999','1 23'])assert.throws(()=>dataNumber(bad));
 assert.equal(dataNumber('1 234,5'),1234.5);assert.equal(dataNumber('0'),0);assert.equal(dataNumber('-2.5'),-2.5);
 const duplicate=structuredClone(object);duplicate.data.rows[1].id=duplicate.data.rows[0].id;assert.equal(canvasElementSchema.safeParse(duplicate).success,false);
});
test('table stable column IDs preserve cells during reordering and enforce numeric input/sources',()=>{
 const {doc,object}=sample('focus-v3','table');if(object.kind!=='table')return;
 const draft=structuredClone(object);draft.data.columns.reverse();draft.data.columns[0].valueType='number';draft.data.rows[0].cells[draft.data.columns[0].id]='25,5';
 const updated=applyDataDraft(draft,object,object);if(updated.kind!=='table')return;
 assert.equal(updated.data.rows[0].cells[updated.data.columns[0].id],25.5);
 assert.equal(updated.data.rows[0].cells[updated.data.columns[1].id],'Исследования');
 assert.ok(renderDataObject(updated).items.some(p=>p.kind==='text'&&p.text==='25,5'));
 const state=initialState(doc);object.data.sourceId='missing';assert.throws(()=>validateReferences(state),/недоступный источник/);
 const bad=structuredClone(updated);delete bad.data.rows[0].cells[bad.data.columns[0].id];assert.equal(canvasElementSchema.safeParse(bad).success,false);
});
test('native PPTX contains a data workbook and a native table, with edited values and stable object names',async()=>{
 const {doc,object}=sample();if(object.kind!=='chart')return;object.data.rows[0].value=25;
 doc.slides.push(sample('focus-v3','table').doc.slides[0]);doc.slides[1].id='table-slide';
 const zero=structuredClone(doc.slides[0]);zero.id='zero-slide';zero.canvas!.forEach(e=>{if(e.kind==='chart')e.data.rows.forEach(r=>r.value=0);});doc.slides.push(zero);
 const pptx=await buildPptx(doc),zip=await JSZip.loadAsync(await pptx.write({outputType:'nodebuffer'}) as Buffer);
 const chart=await zip.file('ppt/charts/chart1.xml')!.async('string');assert.match(chart,/<c:barChart>/);assert.match(chart,/<c:v>25<\/c:v>/);assert.match(chart,/<c:v>-10<\/c:v>/);assert.match(chart,/<c:v>0<\/c:v>/);
 const embedded=Object.keys(zip.files).find(n=>n.startsWith('ppt/embeddings/')&&n.endsWith('.xlsx'))!;assert.ok(embedded);
 const workbook=await JSZip.loadAsync(await zip.file(embedded)!.async('nodebuffer'));assert.match(await workbook.file('xl/worksheets/sheet1.xml')!.async('string'),/<v>25<\/v>/);
 const table=await zip.file('ppt/slides/slide2.xml')!.async('string');assert.match(table,/<a:tbl>/);assert.match(table,/Исследования/);assert.match(table,/data-table/);
 assert.match(await zip.file('ppt/slides/slide1.xml')!.async('string'),/data-chart/);
 const zeros=await zip.file('ppt/charts/chart2.xml')!.async('string');assert.match(zeros,/<c:max val="1"/);assert.match(zeros,/<c:min val="0"/);
});

function dataTextFits(data:ReturnType<typeof scene>){
 const texts=data.items.filter((p):p is Extract<typeof p,{kind:'text'}>=>p.kind==='text'&&!!p.editField&&/^(chart|table):/.test(p.editField));
 for(const p of texts){
  const w=measure(p.text,p.size,p.font,p.bold,p.tracking);
  assert.ok(p.x>=96-.01&&p.x+w<=1504+.01,`${p.editField} leaves the content frame`);
  for(const q of texts){
   if(p===q||p.editField===q.editField)continue;
   const qw=measure(q.text,q.size,q.font,q.bold,q.tracking);
   const x=Math.min(p.x+w,q.x+qw)-Math.max(p.x,q.x),y=Math.min(p.y+p.size*(p.lineHeight??1.32),q.y+q.size*(q.lineHeight??1.32))-Math.max(p.y,q.y);
   assert.ok(x<.01||y<.01,`${p.editField} overlaps ${q.editField}`);
  }
 }
}
test('Focus 3 measures multiline chart rows and widens dense labels without losing values',()=>{
 const doc=demoDoc(),labels=['Планирование исследований и разработок','Поддержка корпоративных клиентов','Развитие инфраструктуры и сервисов','Проверка доступности и качества'];
 for(const count of [4,7,8]){
  const s={...blankSlide(),layout:'chart' as const,title:count===7?'Работа команд\nПланы на месяц':'Работа команд',chart:Array.from({length:count},(_,i)=>({label:labels[i%4],value:i===2?-10:i===3?0:25+i})),chartUnit:'часов'};
  const data=scene(s,doc.brand,0,1,'focus-v3');assert.equal(data.overflow,false);dataTextFits(data);
  if(count===8)assert.equal(data.meta?.variant,'bars-wide-labels');
  assert.deepEqual(visible(canvasScene(canvasFromScene(data)).items),visible(data.items),'freezing must preserve the chosen chart recipe');
  for(const [i,row] of s.chart.entries()){
   const label=data.items.filter(p=>p.kind==='text'&&p.editField===`chart:${i}:label`).map(p=>p.kind==='text'?p.text:'').join(' ').replaceAll('\u00a0',' ');
   assert.equal(label,row.label);
   assert.ok(data.items.some(p=>p.kind==='text'&&p.editField===`chart:${i}:value`&&p.text.includes(String(row.value))));
  }
 }
});
test('Focus 3 fits multiple key columns and measures multiline table headers',()=>{
 const doc=demoDoc();
 for(const roles of [['key','key','key','key'],['key','text','text','text']] as const){
  const s={...blankSlide(),layout:'table' as const,title:'Планы команд',table:{columns:['Задача','Ответственные за внедрение и сопровождение','Срок проверки и принятия результата','Следующий шаг после проверки'],columnRoles:[...roles],rows:[['Прототип','Рабочая группа','Проверка','Обучение'],['Релиз','Команда','Отчёт','Поддержка']]}};
  const data=scene(s,doc.brand,0,1,'focus-v3');assert.equal(data.overflow,false);dataTextFits(data);
  for(const [i,label] of s.table.columns.entries())assert.equal(data.items.filter(p=>p.kind==='text'&&p.editField===`table:column:${i}`).map(p=>p.kind==='text'?p.text:'').join(' ').replaceAll('\u00a0',' '),label.toLocaleUpperCase('ru-RU'));
 }
});
test('unbreakable words and genuinely excessive chart height remain layout errors',()=>{
 assert.equal(block('W'.repeat(50),328,24,1.38).overflow,true);
 const doc=demoDoc(),s={...blankSlide(),layout:'chart' as const,title:'Работа команд',chart:Array.from({length:8},()=>({label:'WWW WWW WWW WWW WWW WWW WWW WWW WWW WWW WWW WWW',value:25})),chartUnit:'часов'};
 assert.equal(scene(s,doc.brand,0,1,'focus-v3').overflow,true);
});
test('data preview preserves the document and matches application while exposing layouts that cannot be saved',()=>{
 const {doc,object}=sample(),base=structuredClone(doc),draft=structuredClone(object);if(draft.kind!=='chart')return;
 draft.data.rows[0].value=25;
 const preview=resolveDataDraft(draft,object,object),applied=applyDataDraft(draft,object,object);
 assert.deepEqual(preview,applied);assert.deepEqual(doc,base);
 const next=applyDataObjectChange(doc,doc.slides[0].id,preview,object);
 assert.deepEqual(next.slides[0].canvas?.filter(e=>e.id!==object.id),doc.slides[0].canvas?.filter(e=>e.id!==object.id));
 draft.data.rows[0].label='W'.repeat(50);
 const invalidPreview=resolveDataDraft(draft,object,object);assert.equal(renderDataObject(invalidPreview).overflow,true);
 assert.throws(()=>applyDataDraft(draft,object,object),/не помещаются/);assert.deepEqual(doc,base);
});
