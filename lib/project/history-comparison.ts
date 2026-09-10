import {canonicalJson} from '../domain/canonical-json';
import type {DeckDoc, Slide, Source} from '../domain/model';

export type HistorySlideComparison = {
  id: string;
  before?: Slide;
  current?: Slide;
  beforeIndex: number;
  currentIndex: number;
  changedSourceIds?:string[];
  sourcesUnknown?:boolean;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
};

/** Include both sides: restoring an older revision also removes newly added slides. */
export function historySourceComparisons(before:Source[],current:Source[]){
 const old=new Map(before.map(s=>[s.id,s])),now=new Map(current.map(s=>[s.id,s]));
 return [...new Set([...old.keys(),...now.keys()])].map(id=>{
  const a=old.get(id),b=now.get(id),status=!a?'added':!b?'removed':canonicalJson(a)!==canonicalJson(b)?'changed':'unchanged';
  return {id,before:a,current:b,status,contentChanged:!!a&&!!b&&a.sha256!==b.sha256,nameChanged:!!a&&!!b&&a.name!==b.name};
 });
}
const slideSources=(s:Slide)=>new Set([...s.sourceIds,...s.metrics.flatMap(m=>m.sourceId?[m.sourceId]:[]),...(s.table?.sourceId?[s.table.sourceId]:[]),...(s.assetId?[s.assetId]:[]),...(s.canvas??[]).flatMap(e=>e.kind==='image'?[e.assetId]:(e.kind==='chart'||e.kind==='table')&&e.data.sourceId?[e.data.sourceId]:[])]);
export function historySlideComparisons(before: DeckDoc, current: DeckDoc,sources?:{before:Source[]|null;current:Source[]}): HistorySlideComparison[] {
  const changedSources=new Set(sources?.before?historySourceComparisons(sources.before,sources.current).filter(s=>s.status!=='unchanged').map(s=>s.id):[]);
  const styleChanged = before.design !== current.design || JSON.stringify(before.brand) !== JSON.stringify(current.brand);
  const currentById = new Map(current.slides.map((slide, index) => [slide.id, {slide, index}]));
  const beforeIds = new Set(before.slides.map(slide => slide.id));
  const rows: HistorySlideComparison[] = before.slides.map((slide, index) => {
    const match = currentById.get(slide.id);
    const ids=new Set([...slideSources(slide),...(match?slideSources(match.slide):[])]),changedSourceIds=[...ids].filter(id=>changedSources.has(id));
    return {changedSourceIds,sourcesUnknown:sources?.before===null&&ids.size>0,id:slide.id, before:slide, current:match?.slide, beforeIndex:index, currentIndex:match?.index ?? -1,
      status:!match ? 'removed' : changedSourceIds.length>0 || styleChanged || match.index !== index || before.slides.length !== current.slides.length || JSON.stringify(slide) !== JSON.stringify(match.slide) ? 'changed' : 'unchanged'};
  });
  current.slides.forEach((slide, index) => {
    if (!beforeIds.has(slide.id)) rows.push({id:slide.id, current:slide, beforeIndex:-1, currentIndex:index, status:'added'});
  });
  return rows;
}
