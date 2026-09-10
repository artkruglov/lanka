import type { Proposal, Slide } from "./model";
import { canonicalJson } from "./canonical-json";
import { withCanvas } from "./canvas";
import {dataPlacementMergeConflicts} from './data-layout';
export type ProposalChange = Proposal["changes"][number];
const same = (a: unknown,b: unknown) => canonicalJson(a??null)===canonicalJson(b??null);

/** Object decisions are independent only when provenance and surviving layer order agree. */
export function objectChanges(c: ProposalChange): string[] | null {
  const a=c.before.canvas,b=c.after.canvas;
  if(!a||!b)return null;
  const metadata=(s:Slide)=>{const {canvas,title,...rest}=s;return rest;};
  if(!same(metadata(c.before),metadata(c.after)))return null;
  if(c.after.title!==withCanvas(c.before,b).title)return null;
  if(!same(a.filter(e=>b.some(v=>v.id===e.id)).map(e=>e.id),b.filter(e=>a.some(v=>v.id===e.id)).map(e=>e.id)))return null;
  const ids=[...new Set([...a,...b].map(e=>e.id))].filter(id=>!same(a.find(e=>e.id===id),b.find(e=>e.id===id)));
  return ids.length?ids:null;
}
export function pendingObjects(c:ProposalChange) {
  return objectChanges(c)?.filter(id=>!c.objectDecisions?.some(d=>d.elementId===id))??null;
}
export function mergeObjects(current:Slide|undefined,c:ProposalChange,ids:string[]):Slide {
  const pending=pendingObjects(c);
  if(!current?.canvas||!pending||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!pending.includes(id)))
    throw new Error("Объект уже обработан или изменение требует принятия слайда целиком.");
  // Preserve manual edits and previous decisions; reject concurrent edits to these exact objects.
  for(const id of ids)if(!same(current.canvas.find(e=>e.id===id),c.before.canvas!.find(e=>e.id===id)))
    throw new Error("Конфликт: этот объект изменён после предложения. Попросите агента обновить правку.");
  const proposed=c.before.canvas!.flatMap(e=>{if(!ids.includes(e.id))return [e];const after=c.after.canvas!.find(v=>v.id===e.id);return after?[after]:[];});
  proposed.push(...c.after.canvas!.filter(e=>ids.includes(e.id)&&!c.before.canvas!.some(v=>v.id===e.id)));
  if(dataPlacementMergeConflicts(c.before.canvas!,proposed,current.canvas).length)
    throw new Error('Конфликт размещения: соседний объект занял место после предложения. Попросите агента обновить размер.');
  // A manual layer reorder could change the meaning of an insertion; do not guess its position.
  const survivors=c.before.canvas!.filter(e=>current.canvas!.some(v=>v.id===e.id)).map(e=>e.id);
  if(ids.some(id=>!c.before.canvas!.some(e=>e.id===id))&&!same(survivors,current.canvas.filter(e=>survivors.includes(e.id)).map(e=>e.id)))
    throw new Error("Конфликт порядка слоёв: обновите предложение перед добавлением объекта.");
  let canvas=structuredClone(current.canvas);
  for(const id of ids){
    const after=c.after.canvas!.find(e=>e.id===id),index=canvas.findIndex(e=>e.id===id);
    if(index>=0){if(after)canvas[index]=structuredClone(after);else canvas.splice(index,1);}
  }
  // Insert in proposed order, relative to the next existing layer. Works for any acceptance order.
  for(const e of [...c.after.canvas!].reverse())if(ids.includes(e.id)&&!c.before.canvas!.some(v=>v.id===e.id)){
    const next=c.after.canvas!.slice(c.after.canvas!.findIndex(v=>v.id===e.id)+1).find(v=>canvas.some(x=>x.id===v.id));
    canvas.splice(next?canvas.findIndex(v=>v.id===next.id):canvas.length,0,structuredClone(e));
  }
  return withCanvas(current,canvas);
}
export function remainingSlide(current:Slide|undefined,c:ProposalChange):Slide {
  const ids=pendingObjects(c);
  if(ids)return mergeObjects(current,c,ids);
  if(!same(current,c.before))throw new Error("Конфликт: слайд изменён после предложения. Попросите агента обновить его.");
  return structuredClone(c.after);
}
export function canAcceptChange(current:Slide|undefined,c:ProposalChange){try{remainingSlide(current,c);return true;}catch{return false;}}
export function recordObjectDecisions(c:ProposalChange,ids:string[],status:"accepted"|"rejected") {
  c.objectDecisions=[...(c.objectDecisions??[]),...ids.map(elementId=>({elementId,status}))];
  if(!pendingObjects(c)?.length)c.status=c.objectDecisions.some(d=>d.status==="accepted")?"accepted":"rejected";
}
export function reviewStatus(c:ProposalChange){
  const accepted=c.objectDecisions?.filter(d=>d.status==="accepted").length??0,rejected=c.objectDecisions?.filter(d=>d.status==="rejected").length??0;
  return c.objectDecisions?`Объектов принято: ${accepted} · отклонено: ${rejected} · осталось: ${pendingObjects(c)?.length??0}`:c.status==="accepted"?"Принято":c.status==="rejected"?"Отклонено":"На проверке";
}
