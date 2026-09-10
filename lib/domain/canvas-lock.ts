import type {CanvasElement} from './model';
import {canonicalJson} from './canonical-json';
export function isSlideBackground(e:CanvasElement|undefined):e is Extract<CanvasElement,{kind:'rect'}> {
  return !!e&&e.kind==='rect'&&e.x===0&&e.y===0&&e.w===1600&&e.h===900;
}
/** The frozen page background is layout-locked, but its fill remains a design control. */
export function allowedLockedUpdate(before:CanvasElement,after:CanvasElement|undefined,index:number) {
  if(canonicalJson(before)===canonicalJson(after))return true;
  return index===0&&isSlideBackground(before)&&!!after&&after.kind==='rect'&&
    canonicalJson({...before,color:after.color})===canonicalJson(after);
}
