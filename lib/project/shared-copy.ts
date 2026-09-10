import {createHash} from 'node:crypto';
import {initialState,validateDoc,validateReferences,type CanvasElement,type Slide} from '../domain/model';
import {canvasFromScene} from '../domain/canvas';
import {scene} from '../domain/scene';
import {canonicalJson} from '../domain/canonical-json';
import {documentView} from './document-view';
import type {FolderProject} from './package';
/** Freeze the shared composition as editable objects, never clone the owner's package or provenance. */
export function prepareSharedCopy(source:FolderProject,id:string,title:string,tenant:string,createdAt:string){
 const original=validateDoc(source.state.doc),images=new Map<string,string>(),snapshotId='shared-slide-snapshot';
 const slides:Slide[]=original.slides.map((s,index)=>{
  const canvas=canvasFromScene(scene(s,original.brand,index,original.slides.length,original.design)).map((e):CanvasElement=>{
   if(e.kind==='image'){if(!images.has(e.assetId))images.set(e.assetId,`shared-image-${images.size+1}`);return {...e,assetId:images.get(e.assetId)!};}
   if(e.kind==='chart'||e.kind==='table'){e.data.sourceId=snapshotId;e.style.brand={...e.style.brand,id:'shared-brand',name:'Оформление слайдов',version:1,status:'draft',company:''};return e;}
   if(e.kind==='text'){const {sourceField,...rest}=e;return {...rest,...(sourceField==='title'?{sourceField}:{})};}
   return e;
  });
  const visibleTitle=canvas.filter(e=>e.kind==='text'&&e.sourceField==='title').map(e=>e.kind==='text'?e.text:'').join('\n').slice(0,180);
  return {id:s.id,layout:'content',title:visibleTitle||`Слайд ${index+1}`,eyebrow:'',body:'',notes:'',metrics:[],chart:[],chartUnit:'',sourceIds:[snapshotId],canvas};
 });
 const view=documentView(source,{role:'viewer',canCopy:true,isOwner:false});
 const bytes=Buffer.from(canonicalJson({format:'lanka-shared-slide-snapshot/v1',tenantId:tenant,documentId:original.id,title:original.title,revision:source.state.revision,slides:view.slides.map(s=>({id:s.id,items:s.items}))}));
 const hash=createHash('sha256').update(bytes).digest('hex');
 const doc=validateDoc({schemaVersion:1,id,title,design:original.design,brand:{...original.brand,id:'shared-brand',name:'Оформление слайдов',version:1,status:'draft',company:''},slides});
 const state=initialState(doc);state.sources=[{id:snapshotId,name:`Слайды: ${original.title}`.slice(0,140),kind:'document',sha256:hash,createdAt,contentType:'application/json',excerpt:`Снимок доступных слайдов презентации «${original.title}», версия ${source.state.revision}. Источник: /organizations/${tenant}/documents/${original.id}. Оригинальные исходные материалы не переданы; снимок подтверждает содержание слайдов, а не достоверность исходных данных.`}];
 return {project:{format:'lanka-project/v1',title,state,receipts:[]} as FolderProject,images,blobs:[{hash,bytes}] as {hash:string;bytes:Buffer}[]};
}
export function validateSharedCopy(project:FolderProject){validateReferences(project.state);}
