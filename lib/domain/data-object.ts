import type {Brand,CanvasElement,Slide} from './model';
import type {Design} from './design';
import {scene,type Scene,type Primitive} from './scene';
import {focusV3Scene} from './focus-v3';
export type DataObject=Extract<CanvasElement,{kind:'chart'|'table'}>;
export const isDataObject=(e:CanvasElement):e is DataObject=>e.kind==='chart'||e.kind==='table';
export function dataSourceIds(slide:Slide):string[]{
 return (slide.canvas??[]).flatMap(e=>isDataObject(e)&&e.data.sourceId?[e.data.sourceId]:[]);
}
function bounds(items:Primitive[]){
 const x=Math.min(...items.map(p=>p.x)),y=Math.min(...items.map(p=>p.y));
 return {x,y,w:Math.max(...items.map(p=>p.x+p.w))-x,h:Math.max(...items.map(p=>p.y+(p.kind==='text'?p.size*(p.lineHeight??1.32):p.h)))-y};
}
/** Preserve the recipe's primitive range as one canonical, data-bearing object. */
export function attachDataObject(result:Scene,slide:Slide,brand:Brand,design:Design):Scene {
 const range=result.dataRange;if(!range||range.end<=range.start)return result;
 const box=bounds(result.items.slice(range.start,range.end)),style={brand,design,...(design==='focus-v3'?{layoutVersion:'focus-v3-data-2' as const}:{})},id=`data-${slide.layout}`;
 let element:DataObject;
 if(slide.layout==='chart'&&slide.chart.length)element={id,kind:'chart',...box,style,data:{seriesId:'series-1',unit:slide.chartUnit,sourceId:slide.sourceIds.length===1?slide.sourceIds[0]:undefined,rows:slide.chart.map((r,i)=>({id:`row-${i+1}`,...r}))}};
 else if(slide.layout==='table'&&slide.table){
  const t=slide.table;
  element={id,kind:'table',...box,style,data:{sourceId:t.sourceId,columns:t.columns.map((label,i)=>({id:`column-${i+1}`,label,role:t.columnRoles?.[i]??(i===0?'key':'text'),valueType:'text',unit:''})),rows:t.rows.map((cells,i)=>({id:`row-${i+1}`,cells:Object.fromEntries(cells.map((v,j)=>[`column-${j+1}`,v]))}))}};
 }else return result;
 return {...result,dataObjects:[{...range,element}]};
}
export function dataObjectSlide(e:DataObject):Slide {
 const stub:Slide={id:e.id,layout:e.kind,title:'',eyebrow:'',body:'',notes:'',metrics:[],chart:[],chartUnit:'',sourceIds:[]};
 if(e.kind==='chart')return {...stub,chart:e.data.rows.map(({label,value})=>({label,value})),chartUnit:e.data.unit};
 return {...stub,table:{columns:e.data.columns.map(c=>c.label+(c.unit?`, ${c.unit}`:'')),columnRoles:e.data.columns.map(c=>c.role),rows:e.data.rows.map(r=>e.data.columns.map(c=>typeof r.cells[c.id]==='number'?r.cells[c.id].toLocaleString('ru-RU'):String(r.cells[c.id])))}};
}
function dataScene(e:DataObject):Scene {
 const s=dataObjectSlide(e);
 return e.style.design==='focus-v3'&&!e.style.layoutVersion
  ?focusV3Scene(s,e.style.brand,0,1,0,false)
  :scene(s,e.style.brand,0,1,e.style.design);
}
/** Minimum box for the existing recipe, without reducing its smallest text below the requested size. */
export function minimumDataBox(e:DataObject,minTextSize?:number):{w:number;h:number}|undefined {
 const result=dataScene(e),range=result.dataRange;
 if(result.overflow||!range)return;
 const items=result.items.slice(range.start,range.end),b=bounds(items);
 const size=Math.min(...items.filter((p):p is Extract<Primitive,{kind:'text'}>=>p.kind==='text').map(p=>p.size));
 if(![b.w,b.h,size].every(Number.isFinite)||size<=0)return;
 return {w:b.w*(minTextSize??size)/size,h:b.h*(minTextSize??size)/size};
}
/** Layout runs from current data; moving the object never regenerates its neighbours. */
export function renderDataObject(e:DataObject):Scene {
 const result=dataScene(e),range=result.dataRange;
 if(!range)return {items:[],overflow:true};
 const items=result.items.slice(range.start,range.end),b=bounds(items),sx=e.w/b.w,sy=e.h/b.h,scale=Math.min(sx,sy);
 if(![b.x,b.y,b.w,b.h,sx,sy].every(Number.isFinite)||b.w<=0||b.h<=0)return {items:[],overflow:true};
 const transformed=items.map((p):Primitive=>p.kind==='text'?{...p,x:e.x+(p.x-b.x)*sx,y:e.y+(p.y-b.y)*sy,w:p.w*sx,size:p.size*scale,editField:`element:${e.id}`,blockId:e.id}:{...p,x:e.x+(p.x-b.x)*sx,y:e.y+(p.y-b.y)*sy,w:p.w*sx,h:p.h*sy});
 // Recipe overflow includes its synthetic heading. Data itself must remain readable.
 const overflow=result.overflow||transformed.some(p=>p.kind==='text'&&p.size<12);
 return {items:transformed,overflow,meta:result.meta};
}
