import type {CanvasElement} from './model';
import {isSlideBackground} from './canvas-lock';
import {boxesOverlap,type ObjectBox} from './data-layout';

/** Place a new object in free slide space; sizes are tried largest first. */
export function initialObjectPlacement(objects:CanvasElement[],sizes:ReadonlyArray<{w:number;h:number}>,preferredY=240):ObjectBox|undefined {
  if(objects.length>=240)return;
  const obstacles=objects.filter((e,i)=>!(i===0&&isSlideBackground(e))),margin=16,gap=16;
  for(const {w,h} of sizes){
    const maxX=1600-margin-w,maxY=900-margin-h;
    const xs=[(1600-w)/2,margin,maxX,...obstacles.flatMap(e=>[e.x-gap-w,e.x+e.w+gap])];
    const ys=[preferredY,margin,maxY,...obstacles.flatMap(e=>[e.y-gap-h,e.y+e.h+gap])];
    let best:ObjectBox|undefined,score=Infinity;
    for(const x of new Set(xs))for(const y of new Set(ys)){
      if(x<margin||y<margin||x>maxX||y>maxY)continue;
      const box={x,y,w,h},distance=(x-(1600-w)/2)**2+(y-preferredY)**2;
      if(distance>=score||obstacles.some(e=>boxesOverlap(box,e,gap)))continue;
      best=box;score=distance;
    }
    if(best)return best;
  }
}

export function initialBasicPlacement(objects:CanvasElement[]):ObjectBox|undefined {
  return initialObjectPlacement(objects,[{w:600,h:180},{w:480,h:160},{w:320,h:140}],300);
}
