import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Source,State} from '../domain/model';
import {canonicalJson} from '../domain/canonical-json';
import {documentSourceValue} from '../domain/document-source-value';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const documentSourceSelectionSchema=z.array(z.object({id:z.string().min(1).max(180),sha256:hash,contentHash:hash,acceptPartial:z.boolean().default(false)}).strict()).max(8).refine(v=>new Set(v.map(s=>s.id)).size===v.length,'Повтор источника.');
export function documentSourceText(source:Source){
 const value=documentSourceValue(source);
 return {...value,contentHash:createHash('sha256').update(canonicalJson(value)).digest('hex')};
}
export function selectedDocumentSource(source:Source,selection:z.infer<typeof documentSourceSelectionSchema>[number]){
 const value=documentSourceText(source);
 if(value.id!==selection.id||value.sha256!==selection.sha256||value.contentHash!==selection.contentHash)throw Error('Источник изменился. Подтвердите доступ заново.');
 if(value.extraction?.status==='partial'&&!selection.acceptPartial)throw Error('Подтвердите использование частично прочитанного источника.');
 return value;
}

/** Consent revocation does not invalidate a human review; changed source content does. */
export function assertProposalSources(state:State,proposalId:string,changeIds:string[]){
 const proposal=state.proposals.find(p=>p.id===proposalId);
 for(const change of proposal?.changes.filter(c=>changeIds.includes(c.id))??[]){
  for(const dependency of change.sourceDependencies??[]){
   const source=state.sources.find(s=>s.id===dependency.id);
   let current:string|undefined;
   try{if(source)current=documentSourceText(source).contentHash;}catch{}
   if(current!==dependency.contentHash)throw Error('Источник предложения изменился или удалён. Попросите агента проверить актуальные данные и предложить правку заново.');
  }
 }
}
