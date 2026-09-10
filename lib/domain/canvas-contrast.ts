import type {CanvasElement} from './model';
import {canvasScene} from './canvas';
import {measure as plexMeasure} from './scene-text-v3';
import {measure as legacyMeasure} from './scene-text';

type Box={x:number;y:number;w:number;h:number};
type Layer={box:Box;kind:'text'|'rect'|'unknown';id:string;color?:string;size?:number;bold?:boolean;label?:string};
export type ContrastIssue={elementId:string;code:'canvas-text-contrast'|'canvas-rule-contrast';contrast:number;minimum:number;message:string};
export function contrastRatio(a:string,b:string){
  const luminance=(hex:string)=>{
    const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return .2126*r+.7152*g+.0722*b;
  };
  const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
function overlap(a:Box,b:Box):Box|null{
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),w=Math.min(a.x+a.w,b.x+b.w)-x,h=Math.min(a.y+a.h,b.y+b.h)-y;
  return w>0&&h>0?{x,y,w,h}:null;
}
function subtract(a:Box,b:Box):Box[]{
  const i=overlap(a,b);if(!i)return [a];
  return [{x:a.x,y:a.y,w:a.w,h:i.y-a.y},{x:a.x,y:i.y+i.h,w:a.w,h:a.y+a.h-i.y-i.h},
    {x:a.x,y:i.y,w:i.x-a.x,h:i.h},{x:i.x+i.w,y:i.y,w:a.x+a.w-i.x-i.w,h:i.h}].filter(v=>v.w>0&&v.h>0);
}

/** Deterministic screen: ordinary text and long thin rules on opaque solid fills.
 * Images/data objects are unknown surfaces; no guessed contrast from their pixels.
 * The thresholds are product heuristics, not accessibility certification.
 */
export function canvasContrast(elements:CanvasElement[]):ContrastIssue[]{
  const layers=elements.flatMap<Layer>(e=>{
    if(e.kind==='rect')return [{id:e.id,kind:'rect' as const,box:e,color:e.color}];
    if(e.kind!=='text')return [{id:e.id,kind:'unknown' as const,box:e}];
    return canvasScene([e]).items.flatMap(p=>p.kind==='text'&&p.text.trim()?[{id:e.id,kind:'text' as const,
      box:{x:p.x,y:p.y,w:Math.min(p.w,p.font?plexMeasure(p.text,p.size,p.font,p.bold,p.tracking):legacyMeasure(p.text,p.size,p.bold)),h:p.size},
      color:p.color,size:p.size,bold:p.bold,label:e.text.replace(/\s+/g,' ').slice(0,55)}]:[]);
  });
  const issues=new Map<string,ContrastIssue>();
  layers.forEach((p,index)=>{
    const rule=p.kind==='rect'&&Math.min(p.box.w,p.box.h)<=6&&Math.max(p.box.w,p.box.h)>=80;
    if(p.kind!=='text'&&!rule)return;
    let visible=[p.box];
    // Opaque objects later in the stack hide earlier content.
    for(const later of layers.slice(index+1))if(later.kind!=='text')visible=visible.flatMap(b=>subtract(b,later.box));
    let remaining=visible,ratio=Infinity;
    for(let j=index-1;j>=0&&remaining.length;j--){
      const under=layers[j];if(under.kind==='text')continue;
      const covered=remaining.some(b=>overlap(b,under.box));
      if(covered&&under.kind==='rect')ratio=Math.min(ratio,contrastRatio(p.color!,under.color!));
      remaining=remaining.flatMap(b=>subtract(b,under.box));
    }
    const minimum=rule?1.5:(p.size!>=32||p.bold&&p.size!>=24)?3:4.5;
    if(ratio>=minimum)return;
    const code=rule?'canvas-rule-contrast':'canvas-text-contrast',key=`${p.id}:${code}`;
    if(issues.has(key)&&issues.get(key)!.contrast<=ratio)return;
    issues.set(key,{elementId:p.id,code,contrast:ratio,minimum,
      message:rule?'Разделитель сливается с подложкой. Измените цвет линии или фона.':
        `Текст «${p.label}» плохо различим на подложке. Измените цвет текста или фона.`});
  });
  return [...issues.values()];
}
