import { z } from 'zod';
const id=z.string().min(1).max(80);
export const commentTargetSchema=z.object({slideId:id,elementId:id.optional()}).strict();
export type CommentTarget=z.infer<typeof commentTargetSchema>;
const commentSchema=commentTargetSchema.extend({action:z.literal('comment'),text:z.string().trim().min(1).max(2000)}).strict();
const requestSchema=z.object({requestId:z.string().uuid(),deckId:id,expectedRevision:z.number().int().positive(),command:commentSchema}).strict();
const draftSchema=z.object({text:z.string().max(2000),target:commentTargetSchema.nullable(),pending:requestSchema.optional()}).strict();
type Draft=z.infer<typeof draftSchema>;
const sameTarget=(a:CommentTarget|null,b:CommentTarget|null)=>a?.slideId===b?.slideId&&a?.elementId===b?.elementId;
/** Per-document, per-tab draft. A pending write retains its exact revision and receipt across reload. */
export class CommentDraft {
  private value:Draft={text:'',target:null};
  private key:string;
  persistent:boolean;
  constructor(private storage:Pick<Storage,'getItem'|'setItem'>|null,private documentId:string){
    this.key=`lanka:comment-draft:v1:${documentId}`;this.persistent=!!storage;
    try{const raw=storage?.getItem(this.key);if(raw){const parsed=draftSchema.safeParse(JSON.parse(raw));if(parsed.success&&(!parsed.data.pending||parsed.data.pending.deckId===documentId))this.value=parsed.data;}}
    catch{this.persistent=false;}
  }
  get text(){return this.value.text;}
  get target(){return this.value.target;}
  private save(){try{this.storage?.setItem(this.key,JSON.stringify(this.value));}catch{this.persistent=false;}}
  set(text:string,target:CommentTarget|null){this.value.text=text.slice(0,2000);this.value.target=target?commentTargetSchema.parse(target):null;this.save();}
  prepare(expectedRevision:number,command:unknown){
    const c=commentSchema.parse(command),old=this.value.pending;
    if(old&&old.command.text===c.text&&sameTarget(old.command,c))return old;
    const pending=requestSchema.parse({requestId:crypto.randomUUID(),deckId:this.documentId,expectedRevision,command:c});
    this.value.pending=pending;this.save();return pending;
  }
  acknowledge(requestId:string){
    const pending=this.value.pending;if(pending?.requestId!==requestId)return;
    if(this.value.text.trim()===pending.command.text&&sameTarget(this.value.target,pending.command)){this.value.text='';this.value.target=null;}
    delete this.value.pending;this.save();
  }
  rejected(requestId:string){if(this.value.pending?.requestId===requestId){delete this.value.pending;this.save();}}
  clear(){this.value={text:'',target:null};this.save();}
}
