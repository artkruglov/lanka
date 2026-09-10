import type {CanvasElement} from './model';
import {isSlideBackground} from './canvas-lock';
export type LayerDirection='front'|'back'|'forward'|'backward';
/** Preserve objects and their IDs; the slide background always stays beneath content. */
export function reorderCanvasLayer(objects:CanvasElement[],id:string,direction:LayerDirection):CanvasElement[]{
 const index=objects.findIndex(object=>object.id===id);
 if(index<0||objects[index].locked||index===0&&isSlideBackground(objects[0]))return objects;
 const floor=Math.max(isSlideBackground(objects[0])?1:0,objects.slice(0,index).findLastIndex(object=>object.locked)+1);
 const nextLocked=objects.findIndex((object,i)=>i>index&&object.locked),ceiling=nextLocked<0?objects.length-1:nextLocked-1;
 const target=direction==='front'?ceiling:direction==='back'?floor:direction==='forward'?Math.min(ceiling,index+1):Math.max(floor,index-1);
 if(target===index)return objects;
 const next=objects.slice();const [object]=next.splice(index,1);next.splice(target,0,object);return next;
}
