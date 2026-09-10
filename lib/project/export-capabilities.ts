import {z} from 'zod';
import type {DeckDoc} from '../domain/model';
import {scene} from '../domain/scene';
export const exportCapabilitiesSchema=z.object({
 version:z.literal(1),slides:z.array(z.object({slideId:z.string(),objects:z.array(z.object({
  objectId:z.string(),kind:z.enum(['text','rect','image','chart','table']),representation:z.enum(['native-text','native-shape','native-image','native-chart','native-table','pdf-content']),
 }).strict())}).strict()),
}).strict();
export type ExportCapabilities=z.infer<typeof exportCapabilitiesSchema>;
/** Mirrors the exporter's native data ranges; does not claim visual fidelity in an external editor. */
export function exportCapabilities(doc:DeckDoc,format:'pdf'|'pptx'):ExportCapabilities {
 return {version:1,slides:doc.slides.map((slide,index)=>{
  const rendered=scene(slide,doc.brand,index,doc.slides.length,doc.design),objects:ExportCapabilities['slides'][number]['objects']=[];
  rendered.items.forEach((p,i)=>{
   const native=rendered.dataObjects?.find(r=>i>=r.start&&i<r.end);
   if(native&&i!==native.start)return;
   const kind=native?.element.kind??p.kind;
   const representation=format==='pdf'?'pdf-content':kind==='text'?'native-text':kind==='rect'?'native-shape':kind==='image'?'native-image':kind==='chart'?'native-chart':'native-table';
   objects.push({objectId:native?.element.id??`${slide.id}:primitive:${i}`,kind,representation});
  });return {slideId:slide.id,objects};
 })};
}
