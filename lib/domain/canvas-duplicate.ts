import type {CanvasElement} from './model';
import {fitElement} from './canvas';
/** A copy is independent of template bindings, while referenced source assets stay shared. */
export function duplicateCanvasElement(objects:CanvasElement[],elementId:string,newId:string):CanvasElement[]|null {
 const source=objects.find(e=>e.id===elementId);
 if(!source||source.locked||objects.length>=240||objects.some(e=>e.id===newId))return null;
 const copy=structuredClone(source);copy.id=newId;
 if(copy.kind==='text'){delete copy.sourceField;delete copy.binding;}
 if(copy.kind==='rect')delete copy.binding;
 return [...objects,fitElement({...copy,x:copy.x+24,y:copy.y+24})];
}
