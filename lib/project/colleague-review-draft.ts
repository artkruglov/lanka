import {z} from 'zod';
import {colleagueReviewCommandSchema} from '../domain/colleague-review';
const answer=z.object({text:z.string().max(2000),outcome:z.enum(['reviewed','changes_requested'])}).strict();
const schema=z.object({documentId:z.string().uuid(),note:z.string().max(2000),search:z.string().max(140),recipient:z.string().uuid().nullable(),selected:z.string().uuid().nullable(),answers:z.record(z.string().uuid(),answer),pending:colleagueReviewCommandSchema.nullable()}).strict();
type Value=z.infer<typeof schema>;
/** Per-tab storage must already be scoped to the authenticated user and organization.
 * Persist the exact command before sending; uncertain writes survive page reload.
 */
export class ColleagueReviewDraft {
 private value:Value;private key:string;private unreadable=false;
 constructor(private storage:Pick<Storage,'getItem'|'setItem'>|null,documentId:string){
  this.key='colleague-review:v1:'+documentId;this.value=schema.parse({documentId,note:'',search:'',recipient:null,selected:null,answers:{},pending:null});
  try{if(!storage)throw Error();const raw=storage.getItem(this.key);if(raw){const parsed=schema.parse(JSON.parse(raw));if(parsed.documentId!==documentId)throw Error();this.value=parsed;}}
  catch{this.unreadable=true;}
 }
 get snapshot(){return structuredClone(this.value);}
 private save(next:Value){
  if(this.unreadable||!this.storage)throw Error('Не удалось прочитать черновик проверки. Перезагрузите страницу после восстановления хранилища.');
  const parsed=schema.parse(next);this.storage.setItem(this.key,JSON.stringify(parsed));this.value=parsed;
 }
 edit(change:Partial<Pick<Value,'note'|'search'|'recipient'|'selected'>>){this.save({...this.value,...change});}
 answer(id:string,text:string,outcome:'reviewed'|'changes_requested'){
  const answers={...this.value.answers,[id]:{text,outcome}};if(Object.keys(answers).length>100)throw Error('Слишком много незавершённых ответов в этой вкладке.');this.save({...this.value,answers});
 }
 stage(input:unknown){
  if(this.value.pending)return this.snapshot.pending!;
  const pending=colleagueReviewCommandSchema.parse(input);this.save({...this.value,pending});return pending;
 }
 settle(requestId:string,accepted:boolean){
  const op=this.value.pending;if(!op||op.requestId!==requestId)return;
  const next=this.snapshot;next.pending=null;
  if(accepted){
   if(op.action==='create'&&next.note.trim()===op.note)next.note='';
   if(op.action==='respond'&&next.answers[op.id]?.text.trim()===op.note)delete next.answers[op.id];
   next.selected=null;
  }
  this.save(next);
 }
}
