import type {CanvasElement} from './model';
import {minimumDataBox,renderDataObject,type DataObject} from './data-object';
import {canonicalJson} from './canonical-json';
export type ObjectBox={x:number;y:number;w:number;h:number};
export const objectBox=(e:ObjectBox):ObjectBox=>({x:e.x,y:e.y,w:e.w,h:e.h});
export const sameBox=(a:ObjectBox,b:ObjectBox)=>canonicalJson(objectBox(a))===canonicalJson(objectBox(b));
const eps=.00001;
const right=(e:ObjectBox)=>e.x+e.w,bottom=(e:ObjectBox)=>e.y+e.h;
const background=(e:CanvasElement,i:number)=>i===0&&e.kind==='rect'&&e.x===0&&e.y===0&&e.w===1600&&e.h===900;
export const boxesOverlap=(a:ObjectBox,b:ObjectBox,gap=0)=>a.x<right(b)+gap-eps&&right(a)>b.x-gap+eps&&a.y<bottom(b)+gap-eps&&bottom(a)>b.y-gap+eps;
/** New data objects use their recipe's readable size and search the whole slide before saving. */
export function initialDataPlacement(value:DataObject,objects:CanvasElement[]):DataObject|undefined {
 const size=minimumDataBox(value);if(!size||value.locked)return;
 const obstacles=objects.filter((e,i)=>!background(e,i)),margin=16,gap=16;
 const maxX=1600-margin-size.w,maxY=900-margin-size.h;
 if(maxX<margin||maxY<margin)return;
 const clamp=(n:number,max:number)=>Math.max(margin,Math.min(max,n));
 const xs=[clamp((1600-size.w)/2,maxX),margin,maxX,...obstacles.flatMap(e=>[e.x-gap-size.w,right(e)+gap])];
 const ys=[clamp(value.y,maxY),margin,maxY,...obstacles.flatMap(e=>[e.y-gap-size.h,bottom(e)+gap])];
 let result:DataObject|undefined,score=Infinity;
 for(const x of new Set(xs))for(const y of new Set(ys)){
  if(x<margin||x>maxX||y<margin||y>maxY)continue;
  const candidate={...value,...size,x,y},distance=(x-(1600-size.w)/2)**2+(y-value.y)**2;
  if(distance>=score||obstacles.some(e=>boxesOverlap(candidate,e,gap)))continue;
  if(renderDataObject(candidate).overflow)continue;
  result=candidate;score=distance;
 }
 return result;
}
const clearance=(a:ObjectBox,b:ObjectBox)=>Math.min(8,Math.max(0,b.x-right(a),a.x-right(b),b.y-bottom(a),a.y-bottom(b)));
/** Only the first whole-slide rectangle is a background; other overlapping objects are obstacles. */
export function safeDataPlacement(value:DataObject,current:DataObject,objects:CanvasElement[]):boolean {
 if(current.locked||value.w<=0||value.h<=0||![value.x,value.y,value.w,value.h].every(Number.isFinite)||value.x<0||value.y<0||right(value)>1600+eps||bottom(value)>900+eps)return false;
 return objects.every((e,i)=>e.id===current.id||background(e,i)||!boxesOverlap(value,e,clearance(current,e)));
}
/** Search critical horizontal edges, then subtract occupied vertical intervals. No neighbour is moved. */
function place(current:DataObject,w:number,h:number,objects:CanvasElement[]):ObjectBox|undefined {
 const left=Math.min(16,current.x),top=Math.min(16,current.y),edgeX=Math.max(1584,right(current)),edgeY=Math.max(884,bottom(current));
 const minX=Math.max(left,right(current)-w),maxX=Math.min(current.x,edgeX-w),minY=Math.max(top,bottom(current)-h),maxY=Math.min(current.y,edgeY-h);
 if(minX>maxX+eps||minY>maxY+eps)return;
 const obstacles=objects.flatMap((e,i)=>e.id===current.id||background(e,i)?[]:[{e,gap:clearance(current,e)}]);
 const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
 // Prefer keeping the user's top-left anchor; shift only when an edge or neighbour requires it.
 const cx=current.x,cy=current.y;
 const xs=[minX,maxX,clamp(cx,minX,maxX),...obstacles.flatMap(({e,gap})=>[e.x-gap-w,right(e)+gap])].filter(x=>x>=minX-eps&&x<=maxX+eps);
 let chosen:ObjectBox|undefined,score=Infinity;
 for(const x of new Set(xs)){
  const intervals=obstacles.filter(({e,gap})=>x<right(e)+gap-eps&&x+w>e.x-gap+eps).map(({e,gap})=>({lo:e.y-gap-h,hi:bottom(e)+gap}));
  const merged:{lo:number;hi:number}[]=[];
  for(const interval of intervals.sort((a,b)=>a.lo-b.lo)){
   const last=merged.at(-1);
   if(last&&interval.lo<last.hi-eps)last.hi=Math.max(last.hi,interval.hi);else merged.push({...interval});
  }
  const preferred=clamp(cy,minY,maxY),hit=merged.find(v=>preferred>v.lo+eps&&preferred<v.hi-eps);
  const ys=(hit?[hit.lo,hit.hi]:[preferred]).filter(y=>y>=minY-eps&&y<=maxY+eps);
  for(const y of ys){
   const distance=(x-cx)**2+(y-cy)**2;
   if(distance<score){const candidate={...current,x,y,w,h};if(safeDataPlacement(candidate,current,objects)){chosen=objectBox(candidate);score=distance;}}
  }
 }
 return chosen;
}
export function dataSizeOptions(value:DataObject,current:DataObject,objects:CanvasElement[]){
 if(current.locked||!renderDataObject(value).overflow)return [];
 const found:{id:string;label:string;box:ObjectBox}[]=[];
 const natural=minimumDataBox(value);if(!natural)return found;
 for(const [scale,label] of [[1,'Размер по шаблону'],[.9,'Компактнее по шаблону']] as const){
  const box=place(current,Math.max(current.w,natural.w*scale),Math.max(current.h,natural.h*scale),objects);
  if(!box||sameBox(box,current)||found.some(v=>sameBox(v.box,box))||renderDataObject({...value,...box}).overflow)continue;
  found.push({id:canonicalJson(box),label,box});
 }
 return found;
}
/** A data resize and a concurrent neighbour move/add must not silently create a new overlap on autosave. */
export function dataPlacementMergeConflicts(base:CanvasElement[],local:CanvasElement[],remote:CanvasElement[]):string[] {
 const ids=new Set<string>();
 const side=(ours:CanvasElement[],theirs:CanvasElement[])=>ours.forEach(e=>{
  const original=base.find(v=>v.id===e.id);if((e.kind!=='chart'&&e.kind!=='table')||!original||sameBox(e,original))return;
  theirs.forEach((other,i)=>{
   if(other.id===e.id||background(other,i))return;
   const oldOther=base.find(v=>v.id===other.id),ourOther=ours.find(v=>v.id===other.id),theirTarget=theirs.find(v=>v.id===e.id);
   if(oldOther&&sameBox(oldOther,other)||!theirTarget)return;
   if(boxesOverlap(e,other)&&(!ourOther||!boxesOverlap(e,ourOther))&&!boxesOverlap(theirTarget,other)){ids.add(e.id);ids.add(other.id);}
  });
 });
 side(local,remote);side(remote,local);return [...ids].sort();
}
