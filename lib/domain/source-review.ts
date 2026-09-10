import type {State} from './model';
import {documentSourceValue} from './document-source-value';
import {canonicalJson} from './canonical-json';
export const sourceReviewWarning='Источник предложения изменился или удалён. Попросите агента проверить актуальные данные и предложить правку заново.';
/** Browser preview only; acceptance is always checked again on the server. */
export async function sourceReviewWarnings(state:State):Promise<Record<string,string>>{
 const dependencies=state.proposals.filter(p=>p.status==='pending').flatMap(p=>p.changes.filter(c=>c.status==='pending').flatMap(c=>c.sourceDependencies??[]));
 const hashes=new Map<string,string>();
 await Promise.all([...new Set(dependencies.map(d=>d.id))].map(async id=>{
  try{const source=state.sources.find(s=>s.id===id);if(!source)return;
   const bytes=new TextEncoder().encode(canonicalJson(documentSourceValue(source)));
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   hashes.set(id,Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''));
  }catch{/* Missing or unreadable sources cannot be silently accepted. */}
 }));
 return Object.fromEntries(state.proposals.flatMap(p=>p.changes.filter(c=>c.sourceDependencies?.some(d=>hashes.get(d.id)!==d.contentHash)).map(c=>[c.id,sourceReviewWarning])));
}
