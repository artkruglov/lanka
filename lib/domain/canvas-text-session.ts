import type {CanvasElement,Slide} from './model';
import {withCanvas} from './canvas';
type TextElement=Extract<CanvasElement,{kind:'text'}>;
export type CanvasTextSession={slide:Slide;objects:CanvasElement[];original:TextElement;added?:boolean;written?:TextElement};
/** Restore only our own last write. Concurrent changes to the target are never overwritten. */
export function cancelCanvasTextSession(slide:Slide,objects:CanvasElement[],session:CanvasTextSession):Partial<Slide>|null {
  const written=session.written??(session.added?session.original:undefined);
  if(slide.id!==session.slide.id||!written)return null;
  const current=objects.find(e=>e.id===session.original.id);
  if(!current||JSON.stringify(current)!==JSON.stringify(written))return null;
  const expected={...session.slide,...withCanvas(session.slide,session.objects.map(e=>e.id===current.id?written:e))};
  // An otherwise untouched template can return to its original responsive composition.
  if(JSON.stringify(slide)===JSON.stringify(expected))return {...session.slide,canvas:session.slide.canvas};
  return withCanvas(slide,session.added?objects.filter(e=>e.id!==current.id):objects.map(e=>e.id===current.id?session.original:e));
}
