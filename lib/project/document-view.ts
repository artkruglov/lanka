import { scene, W, H, type Primitive } from '../domain/scene';
import { validateDoc } from '../domain/model';
import type { FolderProject } from './package';
import type { ResourceRole } from '../server/resource-access';

export type ViewPrimitive =
  | Pick<Extract<Primitive,{kind:'rect'}>,'kind'|'x'|'y'|'w'|'h'|'color'>
  | Pick<Extract<Primitive,{kind:'text'}>,'kind'|'x'|'y'|'w'|'size'|'bold'|'color'|'text'|'font'|'tracking'|'lineHeight'>
  | Pick<Extract<Primitive,{kind:'image'}>,'kind'|'x'|'y'|'w'|'h'|'assetId'|'frame'>;
export type DocumentView = {
 format:'lanka-document-view/v1';id:string;title:string;revision:number;width:number;height:number;
 permission:{role:ResourceRole;canCopy:boolean;isOwner:boolean};
 slides:{id:string;label:string;items:ViewPrimitive[];targets:{id:string;label:string;x:number;y:number;w:number;h:number}[]}[];
};
/** A render projection, never a writable DeckDoc. Whitelist visible primitives, not stored template provenance. */
export function documentView(project:FolderProject,permission:DocumentView['permission'],options:{firstOnly?:boolean}={}):DocumentView {
 const doc=validateDoc(project.state.doc);
 return {format:'lanka-document-view/v1',id:doc.id,title:doc.title,revision:project.state.revision,width:W,height:H,permission,
  slides:(options.firstOnly?doc.slides.slice(0,1):doc.slides).map((slide,index)=>({id:slide.id,label:`Слайд ${index+1}`,targets:(slide.canvas??[]).map(e=>({id:e.id,label:e.kind==="text"?e.text.slice(0,160)||"Пустой текст":e.kind==="image"?"Изображение":e.kind==="chart"?"Диаграмма":e.kind==="table"?"Таблица":"Фигура",x:e.x,y:e.y,w:e.w,h:e.h})),items:scene(slide,doc.brand,index,doc.slides.length,doc.design).items.map(p=>{
   if(p.kind==='rect')return {kind:p.kind,x:p.x,y:p.y,w:p.w,h:p.h,color:p.color};
   if(p.kind==='image')return {kind:p.kind,x:p.x,y:p.y,w:p.w,h:p.h,assetId:p.assetId,...(p.frame?{frame:structuredClone(p.frame)}:{})};
   return {kind:p.kind,x:p.x,y:p.y,w:p.w,size:p.size,bold:p.bold,color:p.color,text:p.text,
    ...(p.font?{font:p.font}:{}),...(p.tracking!==undefined?{tracking:p.tracking}:{}),...(p.lineHeight!==undefined?{lineHeight:p.lineHeight}:{})};
  })}))};
}
export const viewAssetIds=(view:DocumentView)=>new Set(view.slides.flatMap(s=>s.items.flatMap(p=>p.kind==='image'?[p.assetId]:[])));
