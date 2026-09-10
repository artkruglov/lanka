import {z} from 'zod';
export const imageFrameSchema=z.object({
  sourceWidth:z.number().int().positive().max(100000),
  sourceHeight:z.number().int().positive().max(100000),
  fit:z.enum(['contain','cover']),
  zoom:z.number().finite().min(1).max(8),
  focusX:z.number().finite().min(0).max(1),
  focusY:z.number().finite().min(0).max(1),
}).strict();
export type ImageFrame=z.infer<typeof imageFrameSchema>;
export const defaultImageFrame=(width:number,height:number):ImageFrame=>({sourceWidth:width,sourceHeight:height,fit:'contain',zoom:1,focusX:.5,focusY:.5});
type Box={x:number;y:number;w:number;h:number};
/** All renderers use the same source rectangle, visible box and full-image transform. */
export function imagePlacement(box:Box,frame:ImageFrame){
 const {sourceWidth:sw,sourceHeight:sh}=frame;
 if(frame.fit==='contain'){
   const scale=Math.min(box.w/sw,box.h/sh),w=sw*scale,h=sh*scale;
   const viewport={x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h};
   return {viewport,draw:viewport,source:{x:0,y:0,w:sw,h:sh}};
 }
 const scale=Math.max(box.w/sw,box.h/sh)*frame.zoom;
 const w=box.w/scale,h=box.h/scale,x=(sw-w)*frame.focusX,y=(sh-h)*frame.focusY;
 return {viewport:box,source:{x,y,w,h},draw:{x:box.x-x*scale,y:box.y-y*scale,w:sw*scale,h:sh*scale}};
}
export function assertImageDimensions(frame:ImageFrame,width:number,height:number){
 if(frame.sourceWidth!==width||frame.sourceHeight!==height)throw Error('Размер исходного изображения изменился. Выберите изображение заново перед экспортом.');
}
