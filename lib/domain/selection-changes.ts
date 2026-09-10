import {canonicalJson} from './canonical-json';
import {compileCommands} from './commands';
import type {DeckDoc,Slide} from './model';
type Selection={slideId:string;scope?:'document'|'slide'|'element';elementId?:string;field?:'title'|'body'|'takeaway'|null};
/** Validate the final candidate, including indirect changes made by normalization. */
export function assertSelectionChanges(doc:DeckDoc,changes:{slideId:string;after:Slide}[],selection:Selection){
 if(selection.scope==='document')return;
 for(const change of changes){
  if(change.slideId!==selection.slideId)throw Error('Агент попытался изменить другую область.');
  const original=doc.slides.find(s=>s.id===change.slideId);if(!original)throw Error('Выбранный слайд недоступен.');
  if(selection.elementId){
   if(!original.canvas?.some(e=>e.id===selection.elementId))throw Error('Выбранный объект недоступен.');
   const object=change.after.canvas?.find(e=>e.id===selection.elementId);
   let expected=compileCommands(doc,[object?{op:'set_element',slideId:original.id,value:object}:{op:'remove_element',slideId:original.id,elementId:selection.elementId}])[0].after;
   if(object&&expected.canvas&&change.after.canvas){
    const target=change.after.canvas.findIndex(e=>e.id===selection.elementId);
    const limit=expected.canvas.length;
    let index=expected.canvas.findIndex(e=>e.id===selection.elementId);
    for(let steps=0;index!==target&&steps<limit;steps++){
     const next=compileCommands({...doc,slides:doc.slides.map(s=>s.id===original.id?expected:s)},[{op:'reorder_element',slideId:original.id,elementId:selection.elementId,direction:target>index?'forward':'backward'}])[0].after;
     const nextIndex=next.canvas!.findIndex(e=>e.id===selection.elementId);if(nextIndex===index)break;
     expected=next;index=nextIndex;
    }
   }
   if(canonicalJson(change.after)!==canonicalJson(expected))throw Error('Агент попытался изменить соседний объект или другую часть слайда.');
  }
  if(selection.field){
   const field=selection.field,command=field==='takeaway'?{op:'set_takeaway' as const,slideId:change.slideId,value:change.after.intent?.takeaway||''}:{op:field==='title'?'set_title' as const:'set_body' as const,slideId:change.slideId,value:change.after[field]};
   const expected=compileCommands(doc,[command])[0].after;
   if(canonicalJson(change.after)!==canonicalJson(expected))throw Error('Агент попытался изменить другое поле.');
  }
 }
}
