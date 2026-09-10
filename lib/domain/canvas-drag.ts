import type {CanvasElement} from './model';

const geometry=(e:CanvasElement)=>[e.x,e.y,e.w,e.h];
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Apply a finished gesture to the latest objects, preserving concurrent content and neighbours. */
export function applyCanvasDrag(current:CanvasElement[],before:CanvasElement,after:CanvasElement,crop=false):CanvasElement[]|null {
  const target=current.find(e=>e.id===before.id);
  if(!target||target.locked||target.kind!==before.kind||after.kind!==before.kind||after.id!==before.id)return null;
  if(!equal(geometry(target),geometry(before)))return null;
  let next:CanvasElement;
  if(crop){
    if(target.kind!=='image'||before.kind!=='image'||after.kind!=='image'||!target.frame||!after.frame||target.assetId!==before.assetId||!equal(target.frame,before.frame))return null;
    next={...target,frame:{...target.frame,focusX:after.frame.focusX,focusY:after.frame.focusY}};
  }else next={...target,x:after.x,y:after.y,w:after.w,h:after.h};
  return current.map(e=>e.id===target.id?next:e);
}
