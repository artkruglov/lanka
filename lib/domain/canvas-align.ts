import type {CanvasElement} from './model';
import {fitElement} from './canvas';
import {W,H} from './scene';

/** Align the bounding box to the slide without changing content or layer order. */
export function alignCanvasElement(element:CanvasElement,direction:string):CanvasElement {
  if(element.locked)return element;
  const next={...element};
  switch(direction){
    case 'left':next.x=0;break;
    case 'center':next.x=(W-element.w)/2;break;
    case 'right':next.x=W-element.w;break;
    case 'top':next.y=0;break;
    case 'middle':next.y=(H-element.h)/2;break;
    case 'bottom':next.y=H-element.h;break;
    default:return element;
  }
  const fitted=fitElement(next);
  return fitted.x===element.x&&fitted.y===element.y&&fitted.w===element.w&&fitted.h===element.h?element:fitted;
}
