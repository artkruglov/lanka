import {z} from 'zod';
import type {ChatDatabase,DbTx} from '../adapters/postgres/chat-database';
import {sourceContent,type SourceIntakeScope} from '../agents/source-intake';
import {OrganizationAccessError} from '../server/organization-access';
export const creationSourcesSchema=z.array(z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),acceptPartial:z.boolean().default(false)}).strict()).max(8).refine(s=>new Set(s.map(v=>v.id)).size===s.length,'Источники не должны повторяться.');
export async function readCreationSources(db:ChatDatabase,c:DbTx,input:z.infer<typeof creationSourcesSchema>=[],scope?:SourceIntakeScope){
 const selected=[];
 for(const a of input){
  let item;try{item=await sourceContent(db,c,a.id,scope);}catch(e){throw new OrganizationAccessError(409,(e as Error).message);}
  if(item.source.sha256!==a.sha256)throw new OrganizationAccessError(409,'Снимок источника изменился. Прочитайте его заново.');
  if(item.source.extraction?.status==='partial'&&!a.acceptPartial)throw new OrganizationAccessError(409,'Источник прочитан частично. Сообщите об ограничении и явно выберите доступный фрагмент.');
  selected.push(item);
 }
 return {sources:selected.map(v=>v.source),blobs:selected.map(v=>({hash:v.source.sha256,bytes:v.bytes}))};
}
