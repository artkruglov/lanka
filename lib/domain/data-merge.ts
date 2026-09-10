import {canonicalJson} from './canonical-json';
import type {DataObject} from './data-object';
import {objectBox} from './data-layout';
export type DataConflict={key:string;path:string[];mine:unknown;current:unknown;label:string};
export type DataChoices=Record<string,'mine'|'current'>;
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keyed=(v:unknown[]):v is (Record<string,unknown>&{id:string})[]=>v.every(x=>record(x)&&typeof x.id==='string')&&new Set(v.map(x=>(x as {id:string}).id)).size===v.length;
export function dataConflictLabel(object:DataObject,path:string[]):string {
 if(path[0]==='geometry')return 'Размер и положение объекта';
 const fields:Record<string,string>={value:'Значение',label:'Подпись',unit:'Единицы',sourceId:'Источник',rows:'Строки',columns:'Колонки',cells:'Ячейки',data:'Данные'};
 const rowIndex=path[0]==='rows'?object.data.rows.findIndex(r=>r.id===path[1]):-1;
 const column=object.kind==='table'?object.data.columns.find(c=>c.id===path.at(-1)||path[0]==='columns'&&c.id===path[1]):undefined;
 return [rowIndex>=0?`Строка ${rowIndex+1}`:null,column?.label,fields[path.at(-1)??'data']??(column?'Ячейка':'Данные')].filter(Boolean).join(' · ');
}
/** Stable row/column IDs merge independent values. Unit/source changes need a full-data decision. */
export function dataChangeNeedsChoice(base:DataObject,mine:DataObject,current:DataObject){
 const semantic=(o:DataObject)=>o.kind==='chart'?{sourceId:o.data.sourceId,unit:o.data.unit,seriesId:o.data.seriesId}:
  {sourceId:o.data.sourceId,columns:o.data.columns.map(c=>({id:c.id,unit:c.unit,valueType:c.valueType})).sort((a,b)=>a.id.localeCompare(b.id))};
 return !same(base.data,mine.data)&&!same(base.data,current.data)&&(!same(semantic(base),semantic(mine))||!same(semantic(base),semantic(current)));
}
export function mergeDataObjects(base:DataObject,mine:DataObject,current:DataObject,choices:DataChoices={}) {
 const conflicts:DataConflict[]=[];
 const conflict=(b:unknown,l:unknown,r:unknown,path:string[])=>{
  // Choices authorize these exact values, not a field name whose content may change later.
  const key=canonicalJson({path,b,l,r});
  if(choices[key])return choices[key]==='mine'?l:r;
  conflicts.push({key,path,mine:l,current:r,label:dataConflictLabel(mine,path)});return l;
 };
 const walk=(b:unknown,l:unknown,r:unknown,path:string[]):unknown=>{
  if(same(l,r)||same(b,r))return l;if(same(b,l))return r;
  if(path[0]==='geometry')return conflict(b,l,r,path);
  if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)&&keyed(b)&&keyed(l)&&keyed(r)){
   const bi=b.map(v=>v.id),li=l.map(v=>v.id),ri=r.map(v=>v.id);
   if(!same(bi,li)&&!same(bi,ri)&&!same(li,ri))return conflict(b,l,r,path);
   const values=new Map([...new Set([...bi,...li,...ri])].map(id=>[id,walk(b.find(v=>v.id===id),l.find(v=>v.id===id),r.find(v=>v.id===id),[...path,id])]));
   const order=(!same(bi,li)?li:ri).filter(id=>values.get(id)!==undefined);
   // A kept row that the other branch deleted returns to its original relative position.
   for(const reference of [ri,li,bi])for(const id of reference)if(values.get(id)!==undefined&&!order.includes(id)){
    const next=reference.slice(reference.indexOf(id)+1).find(v=>order.includes(v));
    order.splice(next?order.indexOf(next):order.length,0,id);
   }
   return order.map(id=>values.get(id));
  }
  if(record(b)&&record(l)&&record(r)){
   return Object.fromEntries([...new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])].map(k=>[k,walk(b[k],l[k],r[k],[...path,k])]).filter(([,v])=>v!==undefined));
  }
  return conflict(b,l,r,path);
 };
 const b=base.data,l=mine.data,r=current.data;
 const coupled=dataChangeNeedsChoice(base,mine,current);
 const data=coupled&&!same(l,r)?conflict(b,l,r,['data']):walk(b,l,r,[]);
 const geometry=walk(objectBox(base),objectBox(mine),objectBox(current),['geometry']) as ReturnType<typeof objectBox>;
 return {element:{...current,...geometry,data} as DataObject,conflicts};
}

/** User-facing conflict values omit storage IDs and expose the data people actually edit. */
export function dataConflictText(object:DataObject,path:string[],value:unknown,sources:{id:string;name:string}[]):string {
 if(value===undefined)return 'Удалено';
 if(path[0]==='geometry'&&record(value))return `${Math.round(Number(value.w))} × ${Math.round(Number(value.h))} px; отступ слева ${Math.round(Number(value.x))}, сверху ${Math.round(Number(value.y))}`;
 if(path.at(-1)==='sourceId')return sources.find(s=>s.id===value)?.name??'Недоступный источник';
 if(!record(value)&&!Array.isArray(value))return String(value);
 const columns=record(value)&&Array.isArray(value.columns)?value.columns:object.kind==='table'?object.data.columns:[];
 const columnText=(column:unknown)=>{if(!record(column))return '';const detail=[column.unit,column.valueType==='number'?'число':column.valueType==='text'?'текст':''].filter(Boolean).join(', ');return String(column.label??'')+(detail?` (${detail})`:'');};
 const rowText=(row:unknown)=>{
  if(!record(row))return String(row);
  const cells=row.cells;if(record(cells))return columns.map(c=>record(c)?String(cells[String(c.id)]??''):String(c)).join(' · ');
  return `${String(row.label??'')}: ${String(row.value??'')}`;
 };
 if(path[0]==='columns')return (Array.isArray(value)?value:[value]).map(columnText).join(' · ');
 if(Array.isArray(value))return value.map(rowText).join('\n');
 if(Array.isArray(value.rows)){
  const source=typeof value.sourceId==='string'?sources.find(s=>s.id===value.sourceId)?.name??'Недоступный источник':'Не указан';
  return [`Источник: ${source}`,typeof value.unit==='string'&&value.unit?`Единицы: ${value.unit}`:'',columns.length?columns.map(columnText).join(' · '):'',...value.rows.map(rowText)].filter(Boolean).join('\n');
 }
 return rowText(value);
}
