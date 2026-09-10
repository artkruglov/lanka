import {isDataObject,renderDataObject} from "./data-object";
import type { CanvasElement, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import { wrap as legacyWrap, measure as legacyMeasure } from "./scene-text";
import { wrap as plexWrap, measure as plexMeasure } from "./scene-text-v3";

export const canvasWidth = 1600, canvasHeight = 900;
export function elementLines(e: Extract<CanvasElement,{kind:"text"}>) {
  return e.font ? plexWrap(e.text,e.w,e.size,e.font,e.bold,e.tracking) : legacyWrap(e.text,e.w,e.size,e.bold);
}
/** Text and typography edits grow downwards without moving the object or its neighbours. */
export function growTextBox(e:Extract<CanvasElement,{kind:"text"}>):Extract<CanvasElement,{kind:"text"}> {
  const height=elementLines(e).length*e.size*e.lineHeight;
  return {...e,h:Math.min(canvasHeight-e.y,Math.max(e.h,height))};
}
export function canvasScene(elements: CanvasElement[]): Scene {
  const items:Primitive[]=[];
  let overflow=false;
  const dataObjects:NonNullable<Scene["dataObjects"]>=[];
  for(const e of elements) {
    if(e.x+e.w>canvasWidth+0.5 || e.y+e.h>canvasHeight+0.5)overflow=true;
    if(isDataObject(e)){
      const rendered=renderDataObject(e),start=items.length;items.push(...rendered.items);
      overflow ||= rendered.overflow;dataObjects.push({start,end:items.length,element:e});continue;
    }
    if(e.kind!=="text") {items.push(e);continue;}
    const lines=elementLines(e);
    if(lines.length*e.size*e.lineHeight>e.h+0.5)overflow=true;
    lines.forEach((text,i)=>items.push({kind:"text",x:e.x,y:e.y+i*e.size*e.lineHeight,w:e.w,
      text,size:e.size,bold:e.bold,color:e.color,font:e.font,tracking:e.tracking,lineHeight:e.lineHeight,
      editField:`element:${e.id}`,blockId:e.id,...(e.binding?{binding:e.binding}:{})}));
  }
  return {items,overflow,dataObjects};
}

/** Freeze the displayed composition, retaining each measured block and its line breaks. */
export function canvasFromScene(data:Scene, includePaginationSegments=false):CanvasElement[] {
  const result:CanvasElement[]=[];
  const groups=new Map<string,Extract<CanvasElement,{kind:"text"}>>();
  data.items.forEach((p,i)=>{
    // Persist one text anchor for dynamic pagination; segments are render-time objects.
    if(p.kind==="rect"&&p.binding&&!includePaginationSegments)return;
    const region=data.dataObjects?.find(r=>i>=r.start&&i<r.end);
    if(region){if(i===region.start)result.push(structuredClone(region.element));return;}
    const id=`object-${i}`;
    if(p.kind!=="text") {
      result.push({...p,id,locked:p.kind==="rect"&&!!p.binding||p.kind==="rect"&&p.x===0&&p.y===0&&p.w===canvasWidth&&p.h===canvasHeight||undefined});
      return;
    }
    const lh=p.lineHeight??1.32;
    const measured=p.font?plexMeasure(p.text,p.size,p.font,p.bold,p.tracking):legacyMeasure(p.text,p.size,p.bold);
    const width=Math.min(canvasWidth-p.x,Math.max(p.w,measured+0.5,1));
    const prior=p.blockId?groups.get(p.blockId):undefined;
    // Right-aligned lines may have different x. Preserve those as independent objects.
    if(prior && Math.abs(prior.x-p.x)<0.1) {
      const gap=Math.max(1,Math.round((p.y-prior.y)/(p.size*lh)) - prior.text.split("\n").length+1);
      prior.text+="\n".repeat(gap)+p.text;prior.w=Math.max(prior.w,width);prior.h=p.y-prior.y+p.size*lh;
    } else {
      const e:Extract<CanvasElement,{kind:"text"}>={id,kind:"text",x:p.x,y:p.y,w:width,h:p.size*lh,text:p.text,
        size:p.size,bold:p.bold,color:p.color,lineHeight:lh,
        ...(p.font?{font:p.font}:{}),...(p.tracking!==undefined?{tracking:p.tracking}:{}),
        ...(p.editField?{sourceField:p.editField}:{}),...(p.binding?{binding:p.binding,locked:true}:{})};
      result.push(e);if(p.blockId)groups.set(p.blockId,e);
    }
  });
  return result;
}

/** Navigation follows the visible title objects. Original body/metrics remain provenance, not display. */
export function withCanvas(slide:Slide, canvas:CanvasElement[]):Slide {
  const titles=canvas.filter((e):e is Extract<CanvasElement,{kind:"text"}>=>e.kind==="text"&&e.sourceField==="title");
  return {...slide,canvas,...(titles.length?{title:titles.map(e=>e.text).join("\n").slice(0,180)}:{})};
}
export function fitElement<T extends CanvasElement>(e:T):T {
  const w=Math.max(1,Math.min(canvasWidth,e.w)),h=Math.max(1,Math.min(canvasHeight,e.h));
  return {...e,w,h,x:Math.max(0,Math.min(canvasWidth-w,e.x)),y:Math.max(0,Math.min(canvasHeight-h,e.y))};
}

/** Generated pagination segments are display-only; compact only when saving a resolved canvas. */
export function compactPagination(canvas:CanvasElement[]):CanvasElement[] {
  return canvas.filter(e=>!(e.kind==='rect'&&e.binding==='focus-v3-pagination'));
}
