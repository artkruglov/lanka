import {z} from 'zod';
import {canvasElementSchema,chartDataSchema,tableDataSchema,type DeckDoc} from './model';
import {mergeDataObjects,type DataChoices,type DataConflict} from './data-merge';
import {canonicalJson} from './canonical-json';
import {canvasFromScene,withCanvas} from './canvas';
import {scene} from './scene';
import {isDataObject,renderDataObject,type DataObject} from './data-object';
import {safeDataPlacement,sameBox} from './data-layout';
export type DataDraft=Extract<DataObject,{kind:'table'}>|(Omit<Extract<DataObject,{kind:'chart'}>,'data'>&{data:Omit<Extract<DataObject,{kind:'chart'}>['data'],'rows'>&{rows:{id:string;label:string;value:string|number}[]}});
const rawNumber=z.union([z.number().finite(),z.string().max(160)]);
export const dataDraftSchema=z.discriminatedUnion('kind',[
 canvasElementSchema.options[2].extend({data:chartDataSchema.innerType().extend({rows:z.array(z.object({id:z.string().min(1).max(80),label:z.string().max(50),value:rawNumber}).strict()).min(1).max(8)})}),
 canvasElementSchema.options[3].extend({data:tableDataSchema.innerType().extend({columns:tableDataSchema.innerType().shape.columns.element.extend({label:z.string().max(60)}).array().min(2).max(4)})}),
]);
export class DataDraftConflict extends Error {
 constructor(readonly conflicts:DataConflict[]){super('Одни и те же данные изменились. Выберите вариант для каждого расхождения.');}
}
export function dataNumber(value:string|number):number {
 if(typeof value==='number'&&Number.isFinite(value))return value;
 const raw=String(value).trim().replace(/[\u00a0\u202f]/g,' ');
 // Empty, partial or ambiguous input must never become a made-up zero.
 if(!/^[+-]?(?:\d+|\d{1,3}(?: \d{3})+)(?:[.,]\d+)?$/.test(raw))throw Error('Введите число в каждой числовой ячейке. Пустое значение не равно нулю.');
 const n=Number(raw.replaceAll(' ','').replace(',','.'));
 if(!Number.isFinite(n))throw Error('Число выходит за допустимый диапазон.');return n;
}
export function normalizeDataDraft(draft:DataDraft):DataObject {
 const next=structuredClone(draft);
 const cellNumber=(value:string|number,row:number,column:string)=>{
  try{return dataNumber(value);}
  catch(e){throw Error(`Строка ${row+1}, ${column}: ${e instanceof Error?e.message:'Введите число.'}`);}
 };
 if(next.kind==='chart')next.data.rows=next.data.rows.map((r,i)=>({...r,value:cellNumber(r.value,i,'значение')}));
 else next.data.rows=next.data.rows.map((r,i)=>({...r,cells:Object.fromEntries(next.data.columns.map((c,j)=>[c.id,c.valueType==='number'?cellNumber(r.cells[c.id],i,`колонка ${j+1}${c.label?` «${c.label}»`:''}`):String(r.cells[c.id]??'')]))}));
 const checked=canvasElementSchema.safeParse(next);
 if(!checked.success)throw Error('Проверьте данные: названия колонок обязательны (до 60 символов), подписи диаграммы — до 50, ячейки — до 160. В таблице нужны 2–4 колонки и 1–6 строк, в диаграмме — 1–8 строк.');
 return checked.data as DataObject;
}
/** Resolve exact data choices without hiding a layout that needs correction from the preview. */
export function resolveDataDraft(draft:DataDraft,base:DataObject,current:DataObject,choices:DataChoices={}):DataObject {
 if(current.id!==base.id||current.kind!==base.kind||draft.id!==base.id||draft.kind!==base.kind||canonicalJson(draft.style)!==canonicalJson(base.style))
  throw Error('Объект изменил тип или недоступен для этого черновика. Сохраните копию данных.');
 if(current.locked)throw Error('Объект заблокирован. Черновик данных сохранён отдельно.');
 const merged=mergeDataObjects(base,normalizeDataDraft(draft),current,choices);
 if(merged.conflicts.length)throw new DataDraftConflict(merged.conflicts);
 const checked=canvasElementSchema.safeParse(merged.element);
 if(!checked.success)throw Error('Изменения структуры таблицы несовместимы. Проверьте состав колонок и строк.');
 return checked.data as DataObject;
}
export function applyDataDraft(draft:DataDraft,base:DataObject,current:DataObject,choices:DataChoices={}):DataObject {
 const parsed=resolveDataDraft(draft,base,current,choices);
 if(renderDataObject(parsed).overflow)throw Error('Данные не помещаются читаемо. Сократите подписи или увеличьте объект.');
 return parsed;
}

/** Recheck after asynchronous draft persistence, immediately before editing the working copy. */
export function applyDataObjectChange(doc:DeckDoc,slideId:string,value:DataObject,expected:DataObject):DeckDoc {
 const index=doc.slides.findIndex(s=>s.id===slideId),slide=doc.slides[index];
 if(!slide)throw Error('Слайд удалён. Черновик данных сохранён отдельно.');
 const objects=slide.canvas??canvasFromScene(scene(slide,doc.brand,index,doc.slides.length,doc.design));
 const current=objects.find(e=>e.id===value.id);
 if(!current||!isDataObject(current)||current.locked)throw Error('Объект удалён или заблокирован. Черновик данных сохранён отдельно.');
 if(canonicalJson(current)!==canonicalJson(expected))throw Error('Объект изменился во время сохранения черновика. Нажмите «Применить» ещё раз, чтобы сравнить версии.');
 if(!sameBox(value,current)&&!safeDataPlacement(value,current,objects))throw Error('Для этого размера больше нет свободного места. Выберите другой вариант; соседние объекты не изменены.');
 return {...doc,slides:doc.slides.map(s=>s.id===slideId?withCanvas(s,objects.map(e=>e.id===value.id?value:e)):s)};
}
export function dataObjectFor(doc:DeckDoc,slideId:string,elementId:string):DataObject|undefined {
 const index=doc.slides.findIndex(s=>s.id===slideId),s=doc.slides[index];if(!s)return;
 const objects=s.canvas??canvasFromScene(scene(s,doc.brand,index,doc.slides.length,doc.design));
 return objects.find((e):e is DataObject=>e.id===elementId&&isDataObject(e));
}
