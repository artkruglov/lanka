import {initialState,validateDoc,validateReferences} from '../domain/model';
import type {PublicationPayload} from './publication-package';
import type {FolderProject} from './package';
/** Copy the frozen editable composition directly; never render/reflow it against current sources. */
export function preparePublicationCopy(payload:PublicationPayload,id:string,title:string,createdAt:string):FolderProject{
 const doc=structuredClone(payload.document),sources=structuredClone(payload.sources);
 const sourceIds=new Map(sources.map((s,i)=>[s.id,`${id}-source-${i+1}`]));
 const mapped=(old:string)=>{const next=sourceIds.get(old);if(!next)throw Error('Publication source unavailable');return next;};
 doc.id=id;doc.title=title;
 doc.slides.forEach((s,i)=>{
  s.id=`${id}-slide-${i+1}`;s.sourceIds=s.sourceIds.map(mapped);
  if(!s.canvas)throw Error('Publication has no frozen canvas');
  s.canvas.forEach((e,j)=>{
   e.id=`${id}-object-${i+1}-${j+1}`;
   if(e.kind==='image')e.assetId=mapped(e.assetId);
   if((e.kind==='table'||e.kind==='chart')&&e.data.sourceId)e.data.sourceId=mapped(e.data.sourceId);
  });
 });
 const state=initialState(validateDoc(doc));
 state.sources=sources.map(s=>({...s,id:mapped(s.id),createdAt,...(s.kind==='document'?{excerpt:`Копия публикации ${payload.id}, версия ${payload.origin.revision}. Источник: /organizations/${payload.origin.tenantId}/documents/${payload.origin.materialId}. Снимок фиксирует содержание, а не достоверность исходных данных.`}:{})}));
 validateReferences(state);return {format:'lanka-project/v1',title,state,receipts:[]};
}
