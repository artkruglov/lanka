import {initialImagePlacement,ImagePlacementError} from '../../lib/domain/image-placement';
import {imageUploadSchema} from '../../lib/domain/image-source';
import {defaultImageFrame} from '../../lib/domain/image-frame';
import {canvasFromScene,withCanvas} from '../../lib/domain/canvas';
import {scene} from '../../lib/domain/scene';
import {changedContent,validateDoc,validateReferences} from '../../lib/domain/model';
import {registerImage,type MaterialRepository} from './image-source';
export async function uploadImage(store:MaterialRepository,input:unknown){
 const a=imageUploadSchema.parse(input);
 return store.mutate(a.requestId,{surface:'human-image',...a},async old=>{
   if(!old||old.state.doc.id!==a.deckId)throw Error('Изображение вне документа.');
   if(old.state.revision!==a.expectedRevision)throw Error('Версия изменилась. Проверьте слайд и выберите файл повторно.');
   const p=structuredClone(old),index=p.state.doc.slides.findIndex(s=>s.id===a.slideId),slide=p.state.doc.slides[index];
   if(!slide)throw Error('Слайд недоступен.');
   const objects=slide.canvas??canvasFromScene(scene(slide,p.state.doc.brand,index,p.state.doc.slides.length,p.state.doc.design));
   const existing=a.elementId?objects.find(e=>e.id===a.elementId):null;
   if(a.elementId&&(!existing||existing.kind!=='image'||existing.locked))throw Error('Выбранное изображение недоступно или заблокировано.');
   const placement=existing?null:initialImagePlacement(objects);
   if(!existing&&!placement)throw new ImagePlacementError();
   const source=await registerImage(store,p,a),frame=defaultImageFrame(source.image.width,source.image.height);
   const id=existing?.id??`image-${a.requestId}`;
   const object=existing?{...existing,assetId:source.sourceId,frame}:{id,kind:'image' as const,...placement!,assetId:source.sourceId,frame};
   p.state.doc.slides[index]=withCanvas(slide,existing?objects.map(e=>e.id===id?object:e):[...objects,object]);
   p.state.doc=validateDoc(p.state.doc);validateReferences(p.state);changedContent(p.state);
   return {project:p,result:{...source,revision:p.state.revision,elementId:id,slideId:slide.id}};
 });
}
