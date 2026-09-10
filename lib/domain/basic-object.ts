import type {Brand,CanvasElement,DeckDoc} from './model';
import {elementLines} from './canvas';
import {initialObjectPlacement,initialBasicPlacement} from './object-placement';

export const basicPlacementUnavailable='Для нового объекта нет свободного места. Добавьте новый слайд или освободите место на этом. Слайд не изменён.';
/** Shared visual-editor and MCP defaults; text height is measured before placement. */
export function createBasicObject(objects:CanvasElement[],brand:Brand,design:DeckDoc['design'],id:string,kind:'text'|'rect',text='Новый текст'):CanvasElement|undefined {
  if(kind==='rect'){
    const box=initialBasicPlacement(objects);
    return box?{id,kind,...box,color:brand.accent}:undefined;
  }
  const prototype:Extract<CanvasElement,{kind:'text'}>={id,kind,x:0,y:0,w:600,h:180,text,size:40,lineHeight:1.3,bold:false,color:brand.ink,...(design==='focus-v3'?{font:'sans' as const}:{})};
  const sizes=[{w:600,h:180},{w:480,h:160},{w:320,h:140}].map(box=>({...box,h:Math.max(box.h,elementLines({...prototype,w:box.w}).length*prototype.size*prototype.lineHeight)}));
  const box=initialObjectPlacement(objects,sizes,300);
  return box?{...prototype,...box}:undefined;
}
