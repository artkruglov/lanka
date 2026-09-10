import type {DeckDoc,CanvasElement} from './model';
import {dataPlacementMergeConflicts,objectBox} from './data-layout';
import {canonicalJson} from './canonical-json';
import {dataChangeNeedsChoice,dataConflictLabel} from './data-merge';
import type {DataObject} from './data-object';
import {withCanvas} from './canvas';
export type MergeConflict={key:string;path:string[];before:unknown;local:unknown;remote:unknown;layoutIds?:string[]};
export type MergeChoices=Record<string,'local'|'remote'>;
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keyed=(v:unknown[]):v is (Record<string,unknown>&{id:string})[]=>v.every(x=>record(x)&&typeof x.id==='string')&&new Set(v.map(x=>(x as {id:string}).id)).size===v.length;
/** Three-way merge. Structural ambiguity is explicit; never combine incompatible components. */
export function mergeDocuments(base:DeckDoc,local:DeckDoc,remote:DeckDoc,choices:MergeChoices={}){
 const conflicts:MergeConflict[]=[];
 const conflict=(b:unknown,l:unknown,r:unknown,path:string[],layoutIds?:string[])=>{
   const key=canonicalJson({path,b,l,r});if(choices[key])return choices[key]==='local'?l:r;
   conflicts.push({key,path,before:b,local:l,remote:r,...(layoutIds?{layoutIds}:{})});return l;
 };
 const walk=(b:unknown,l:unknown,r:unknown,path:string[]):unknown=>{
   if(same(l,r)||same(b,r))return l;if(same(b,l))return r;
   if(path.length===5&&path[2]==='canvas'&&['geometry','imageContent','dataContent'].includes(path[4]))return conflict(b,l,r,path);
   if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)&&keyed(b)&&keyed(l)&&keyed(r)){
     const bi=b.map(x=>x.id),li=l.map(x=>x.id),ri=r.map(x=>x.id);
     if(!same(bi,li)&&!same(bi,ri)&&!same(li,ri))return conflict(b,l,r,path);
     const layoutIds=path.length===3&&path[0]==='slides'&&path[2]==='canvas'?dataPlacementMergeConflicts(b as CanvasElement[],l as CanvasElement[],r as CanvasElement[]):[];
     const selected=layoutIds.length?conflict(b,l,r,path,layoutIds) as CanvasElement[]:undefined;
     const order=!same(bi,li)?li:ri;
     const ids=[...new Set([...order,...bi,...li,...ri])];
     return ids.map(id=>{
       const chosen=selected?.find(e=>e.id===id);
       if(layoutIds.includes(id)&&!chosen)return;
       const version=(items:typeof b)=>{const v=items.find(x=>x.id===id);return v&&chosen&&layoutIds.includes(id)?{...v,...objectBox(chosen)}:v;};
       return walk(version(b),version(l),version(r),[...path,id]);
     }).filter(v=>v!==undefined);
   }
   if(record(b)&&record(l)&&record(r)){
     // A renderer/design switch or template-to-canvas conversion changes the meaning of fields.
     if((b.schemaVersion&&(!same(b.design,l.design)||!same(b.design,r.design)))||
       ('layout' in b&&'body' in b&&(!!b.canvas!==!!l.canvas||!!b.canvas!==!!r.canvas))||
       ('kind' in b&&(!same(b.kind,l.kind)||!same(b.kind,r.kind))))return conflict(b,l,r,path);
     const derivedTitle=Array.isArray(l.canvas)&&Array.isArray(r.canvas)&&[l,r].every(s=>(s.canvas as unknown[]).some(e=>record(e)&&e.kind==='text'&&e.sourceField==='title'));
     const output:Record<string,unknown>={};
     // Position and dimensions describe one box. Merging them independently can
     // push an otherwise valid object off the slide after concurrent move/resize.
     const boxKeys=['x','y','w','h'];
     const canvasObject=path.length===4&&path[0]==='slides'&&path[2]==='canvas';
     if(canvasObject){
       const box=(v:Record<string,unknown>)=>Object.fromEntries(boxKeys.map(k=>[k,v[k]]));
       Object.assign(output,walk(box(b),box(l),box(r),[...path,'geometry']));
     }
     const imageObject=canvasObject&&b.kind==='image';
     if(imageObject){const content=(v:Record<string,unknown>)=>({assetId:v.assetId,frame:v.frame});Object.assign(output,walk(content(b),content(l),content(r),[...path,'imageContent']));}
     const coupledData=canvasObject&&(b.kind==='chart'||b.kind==='table')&&dataChangeNeedsChoice(b as unknown as DataObject,l as unknown as DataObject,r as unknown as DataObject);
     if(coupledData)output.data=walk(b.data,l.data,r.data,[...path,'dataContent']);
     for(const key of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])){
       if(imageObject&&['assetId','frame'].includes(key)||coupledData&&key==='data')continue;
       if(canvasObject&&boxKeys.includes(key))continue;
       const value=derivedTitle&&key==='title'?l.title:walk(b[key],l[key],r[key],[...path,key]);
       if(value!==undefined)output[key]=value;
     }
     return output;
   }
   return conflict(b,l,r,path);
 };
 const doc=structuredClone(walk(base,local,remote,[]) as DeckDoc);
 doc.slides=doc.slides.map(s=>s.canvas?withCanvas(s,s.canvas):s);
 return {doc,conflicts};
}
/** Render the chosen positions with already merged independent content, not an obsolete whole slide. */
export function layoutConflictCanvas(current:CanvasElement[],selected:CanvasElement[],ids?:string[]):CanvasElement[]{
 if(!ids)return selected;
 const canvas=current.flatMap(e=>{
  if(!ids.includes(e.id))return [e];const choice=selected.find(v=>v.id===e.id);return choice?[{...e,...objectBox(choice)}]:[];
 });
 for(const e of [...selected].reverse())if(ids.includes(e.id)&&!canvas.some(v=>v.id===e.id)){
  const next=selected.slice(selected.findIndex(v=>v.id===e.id)+1).find(v=>canvas.some(c=>c.id===v.id));
  canvas.splice(next?canvas.findIndex(v=>v.id===next.id):canvas.length,0,e);
 }
 return canvas;
}
export function conflictLabel(doc:DeckDoc,path:string[]){
 const fields:Record<string,string>={mode:'Вид сравнения',dataContent:'Данные, единицы и источник',data:'Данные',rows:'Строки',columns:'Колонки',cells:'Ячейки',value:'Значение',label:'Подпись',unit:'Единицы',style:'Оформление объекта',imageContent:'Изображение и кадр',geometry:'Положение и размеры',text:'Текст',title:'Название',body:'Содержание',notes:'Заметки',canvas:'Объекты',slides:'Порядок и состав слайдов',color:'Цвет',x:'Положение по горизонтали',y:'Положение по вертикали',w:'Ширина',h:'Высота',size:'Размер текста',design:'Оформление',brief:'Бриф'};
 const i=path[0]==='slides'?doc.slides.findIndex(s=>s.id===path[1]):-1;
 const object=i>=0&&path[2]==='canvas'?doc.slides[i].canvas?.find(e=>e.id===path[3]):null;
 return [i>=0?`Слайд ${i+1}`:'Презентация',object?(object.kind==='text'?`«${object.text.slice(0,60)}»`:object.kind==='image'?'Изображение':object.kind==='chart'?'Диаграмма':object.kind==='table'?'Таблица':'Фигура'):null,object&&(object.kind==='chart'||object.kind==='table')&&path[4]==='data'?dataConflictLabel(object,path.slice(5)):fields[path.at(-1)??'']??path.at(-1)??'Документ'].filter(Boolean).join(' · ');
}
