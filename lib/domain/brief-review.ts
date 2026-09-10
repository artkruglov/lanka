import {z} from 'zod';
import {briefSchema} from './narrative';
import {briefingFields} from './briefing';

type Brief=z.infer<typeof briefSchema>;
type Field=typeof briefingFields[number];
type Snapshot={value:string|null;origin:'user'|'assumption'|null};
export const briefReviewChangesSchema=z.array(z.object({
  field:z.enum(briefingFields),
  before:z.object({value:z.string().max(800).nullable(),origin:z.enum(['user','assumption']).nullable()}).strict(),
  after:z.string().max(800),
}).strict()).min(1).max(3);
export type BriefReviewChange=z.infer<typeof briefReviewChangesSchema>[number];
export const briefReviewInputSchema=briefSchema.omit({origins:true}).partial().strict()
  .refine(input=>Object.keys(input).length>0,'Укажите хотя бы одно поле замысла.');
const snapshot=(brief:Brief|undefined,field:Field):Snapshot=>({value:brief?.[field]??null,origin:brief?.origins?.[field]??null});
// Materializing an absent brief fills untouched fields with empty strings; origin still detects human edits.
const same=(a:Snapshot,b:Snapshot)=>(a.value??'')===(b.value??'')&&a.origin===b.origin;
/** Prepare only. Transport must authorize private document context and persist a review receipt. */
export function prepareBriefReview(current:Brief|undefined,input:unknown):BriefReviewChange[]{
  if(current)briefSchema.parse(current);
  const values=briefReviewInputSchema.parse(input);
  const changes=briefingFields.flatMap(field=>values[field]!==undefined&&values[field]!==current?.[field]
    ?[{field,before:snapshot(current,field),after:values[field]}]:[]);
  if(!changes.length)throw Error('Замысел уже содержит эти ответы.');
  return changes;
}
/** Atomic, field-level acceptance. Human acceptance confirms only selected answers. */
export function acceptBriefReview(current:Brief|undefined,changes:BriefReviewChange[],selected:Field[]):Brief {
  if(current)briefSchema.parse(current);
  changes=briefReviewChangesSchema.parse(changes);
  if(!selected.length||new Set(selected).size!==selected.length||new Set(changes.map(c=>c.field)).size!==changes.length)
    throw Error('Выберите неповторяющиеся поля замысла.');
  const chosen=selected.map(field=>{
    const change=changes.find(c=>c.field===field);
    if(!change)throw Error('Поле отсутствует в предложении.');
    if(!same(snapshot(current,field),change.before))throw Error('Конфликт замысла: ответ изменён после предложения.');
    return change;
  });
  const next:Brief=structuredClone(current??{audience:'',decision:'',keyMessage:''});
  for(const change of chosen){next[change.field]=change.after;next.origins={...next.origins,[change.field]:'user'};}
  return briefSchema.parse(next);
}
