import {canonicalJson} from '../domain/canonical-json';
import {EDITOR_CONTRACT,assertEditorContract} from './editor-contract';
import {z} from 'zod';
import {docSchema,validateDoc,type DeckDoc} from '../domain/model';
import {sameDocument} from '../domain/editing';
import {mergeDocuments,type MergeChoices} from '../domain/document-merge';
const editableDoc=docSchema.extend({title:z.string().max(140)});
const snapshot=z.object({doc:editableDoc,revision:z.number().int().positive()});
const requestSchema=z.object({requestId:z.string().uuid(),deckId:z.string(),expectedRevision:z.number().int().positive(),command:z.object({action:z.literal('save'),doc:docSchema,editorContract:z.string().optional()})});
const journalSchema=z.object({editorContract:z.string().optional(),base:snapshot,doc:editableDoc,pending:requestSchema.optional(),updatedAt:z.number().optional()});
type Snapshot=z.infer<typeof snapshot>;
type Journal=z.infer<typeof journalSchema>;
/** A tab owns its working copy; the server owns revisions. Pending writes never change identity. */
export class EditorDraft {
 private value:Journal;
 private remote:Snapshot|null=null;
 private key:string;
 persistent:boolean;
 recovered=false;
 constructor(private storage:Pick<Storage,'getItem'|'setItem'>|null,documentId:string,initial:Snapshot,slot="default"){
   this.key=`lanka:editor-draft:v1:${documentId}:${slot}`;this.persistent=!!storage;
   this.value={editorContract:EDITOR_CONTRACT,base:structuredClone(initial),doc:structuredClone(initial.doc)};
   try{const raw=storage?.getItem(this.key);if(raw&&raw.length<4_000_000){const parsed=journalSchema.safeParse(JSON.parse(raw));if(parsed.success&&parsed.data.doc.id===documentId&&parsed.data.base.doc.id===documentId&&(!parsed.data.pending||parsed.data.pending.deckId===documentId&&parsed.data.pending.command.doc.id===documentId&&parsed.data.pending.expectedRevision===parsed.data.base.revision)){
     this.value=parsed.data;this.recovered=this.dirty||!!this.pending;
     if(!this.recovered)this.value={editorContract:EDITOR_CONTRACT,base:structuredClone(initial),doc:structuredClone(initial.doc)};
   }}}catch{this.persistent=false;}
   this.receive(initial);
 }
 adopt(raw:string){
   if(this.needsSave)throw Error('Сначала сохраните или разберите текущие правки.');
   const parsed=journalSchema.parse(JSON.parse(raw));
   if(parsed.doc.id!==this.doc.id||parsed.base.doc.id!==this.doc.id||parsed.pending&&(parsed.pending.deckId!==this.doc.id||parsed.pending.command.doc.id!==this.doc.id||parsed.pending.expectedRevision!==parsed.base.revision))throw Error('Черновик другого документа.');
   const current=this.base;this.value=parsed;this.receive(current);this.save();this.recovered=true;
 }
 previewBackup(raw:string,choices:MergeChoices={}){
   if(this.needsSave||this.conflicts.length||this.needsUpgrade)throw Error('Сначала сохраните и разберите текущие правки.');
   if(raw.length>4_000_000)throw Error('Файл копии слишком большой.');
   let json;try{json=JSON.parse(raw);}catch{throw Error('Не удалось прочитать JSON копии.');}
   const parsed=journalSchema.safeParse(json);if(!parsed.success)throw Error('Файл не является поддерживаемой копией черновика.');
   const copy=parsed.data;
   if(copy.doc.id!==this.doc.id||copy.base.doc.id!==this.doc.id)throw Error('Копия относится к другой презентации.');
   if(copy.pending)throw Error('В копии есть неподтверждённое сохранение. Сначала проверьте его результат в исходной беседе редактора.');
   if(copy.editorContract!==undefined&&![EDITOR_CONTRACT,'lanka-editor/1','lanka-editor/2'].includes(copy.editorContract))throw Error('Версия копии пока не поддерживается. Исходный файл сохранён без изменений.');
   const losesFields=(a:any,b:any):boolean=>a&&typeof a==='object'&&Object.keys(a).some(k=>!b||!Object.hasOwn(b,k)||losesFields(a[k],b[k]));
   if(losesFields(json.doc,copy.doc)||losesFields(json.base.doc,copy.base.doc))throw Error('Копия содержит неизвестные поля. Восстановление остановлено, чтобы не потерять данные.');
   const merged=mergeDocuments(copy.base.doc,copy.doc,this.doc,choices);
   return {stamp:canonicalJson({base:this.base,doc:this.doc,raw,choices}),before:structuredClone(this.doc),after:merged.conflicts.length?null:validateDoc(merged.doc),conflicts:merged.conflicts};
 }
 confirmBackup(raw:string,stamp:string,choices:MergeChoices={}){
   const preview=this.previewBackup(raw,choices);
   if(preview.stamp!==stamp)throw Error('Презентация изменилась после просмотра. Загрузите копию заново.');
   if(!preview.after)throw Error('Выберите варианты для всех конфликтов.');
   return preview.after;
 }
 get needsUpgrade(){return this.value.editorContract!==EDITOR_CONTRACT;}
 previewUpgrade(){
   if(!this.needsUpgrade)throw Error('Черновик уже совместим.');
   if(this.value.editorContract!==undefined&&!['lanka-editor/1','lanka-editor/2'].includes(this.value.editorContract))throw Error('Эта версия черновика пока не поддерживается для переноса. Скачайте копию правок.');
   if(this.pending)throw Error('Сначала проверьте результат ранее отправленного сохранения.');
   if(this.conflicts.length)throw Error('Сначала разберите конфликт версий ниже.');
   return {stamp:canonicalJson({base:this.base,doc:this.doc}),before:structuredClone(this.base.doc),after:validateDoc(structuredClone(this.doc))};
 }
 confirmUpgrade(stamp:string){
   const preview=this.previewUpgrade();
   if(preview.stamp!==stamp)throw Error('Документ изменился после просмотра. Проверьте перенос заново.');
   if(!this.storage)throw Error('Не удалось сохранить резервную копию. Скачайте правки перед переносом.');
   // A durable original precedes the opt-in conversion. Never overwrite this backup on retry.
   const backup=this.key.replace('lanka:editor-draft:v1:','lanka:editor-upgrade-backup:v1:')+':'+crypto.randomUUID(),original=JSON.stringify(this.value);
   try{this.storage.setItem(backup,original);if(this.storage.getItem(backup)!==original)throw Error('Backup not persisted');}
   catch{throw Error('Не удалось сохранить резервную копию. Перенос не выполнен.');}
   this.value={...this.value,editorContract:EDITOR_CONTRACT,doc:preview.after};this.save();
 }
 get doc(){return this.value.doc;}
 get base(){return this.value.base;}
 get pending(){return this.value.pending;}
 get dirty(){return !sameDocument(this.value.doc,this.value.base.doc);}
 get needsSave(){return this.dirty||!!this.pending;}
 get conflicts(){return this.remote?mergeDocuments(this.base.doc,this.doc,this.remote.doc).conflicts:[];}
 get remoteSnapshot(){return this.remote;}
 private save(){this.value.updatedAt=Date.now();try{const data=JSON.stringify(this.value);if(data.length>4_000_000)throw Error('Draft too large');this.storage?.setItem(this.key,data);}catch{this.persistent=false;}}
 edit(doc:DeckDoc){if(doc.id!==this.doc.id)throw Error('Документ вне черновика.');this.value.doc=structuredClone(doc);this.save();}
 receive(incoming:Snapshot){
   if(incoming.doc.id!==this.doc.id)throw Error('Документ вне черновика.');
   if(incoming.revision<this.base.revision)return;
   if(this.pending){this.remote=structuredClone(incoming);return;}
   const merged=mergeDocuments(this.base.doc,this.doc,incoming.doc);
   if(merged.conflicts.length){this.remote=structuredClone(incoming);return;}
   this.value.base=structuredClone(incoming);this.value.doc=merged.doc;this.remote=null;this.save();
 }
 prepare(){
   // Retry unchanged bytes: the server resolves an existing receipt or rejects an obsolete write.
   if(this.pending)return structuredClone(this.pending);
   assertEditorContract(this.value.editorContract);
   if(this.conflicts.length)throw Error('Сначала разрешите конфликт версий.');
   if(!this.dirty)return null;
   if(!this.doc.title.trim())throw Error("Добавьте название презентации. Остальные правки сохранены на устройстве, если локальное хранилище доступно.");
   const doc=validateDoc(this.doc);this.value.doc=structuredClone(doc);
   this.value.pending={requestId:crypto.randomUUID(),deckId:doc.id,expectedRevision:this.base.revision,command:{action:'save',doc,editorContract:EDITOR_CONTRACT}};
   this.save();return structuredClone(this.pending!);
 }
 acknowledge(requestId:string,revision:number){
   const p=this.pending;if(!p||p.requestId!==requestId)return;
   if(!Number.isSafeInteger(revision)||revision<=p.expectedRevision)throw Error('Не подтверждена версия сохранения.');
   this.value.base={doc:structuredClone(p.command.doc),revision};delete this.value.pending;
   const remote=this.remote;this.remote=null;this.save();if(remote&&remote.revision>=revision)this.receive(remote);
 }
 rejected(requestId:string){if(this.pending?.requestId===requestId){delete this.value.pending;const remote=this.remote;this.remote=null;this.save();if(remote)this.receive(remote);}}
 resolve(choices:MergeChoices){
   if(this.pending||!this.remote)throw Error('Конфликт недоступен для решения.');
   const result=mergeDocuments(this.base.doc,this.doc,this.remote.doc,choices);
   if(result.conflicts.length)throw Error('Выберите решение для каждого спорного поля.');
   this.value.doc=validateDoc(result.doc);this.value.base=structuredClone(this.remote);this.remote=null;this.save();
 }
 reset(incoming:Snapshot){if(this.pending)throw Error('Сначала проверьте результат отправленного сохранения.');this.value={editorContract:EDITOR_CONTRACT,base:structuredClone(incoming),doc:structuredClone(incoming.doc)};this.remote=null;this.save();}
 /** An atomic local action (for example image upload) may save outside autosave. */
 adoptSavedChange(incoming:Snapshot,expectedRevision:number){
   if(this.needsSave||this.base.revision!==expectedRevision||incoming.revision!==expectedRevision+1||incoming.doc.id!==this.doc.id)return null;
   const before=structuredClone(this.doc);this.reset({...incoming,doc:validateDoc(incoming.doc)});return before;
 }
}

export function recoverableEditorDrafts(storage:Pick<Storage,'getItem'|'key'|'length'>|null,documentId:string,slot:string){
 const prefix=`lanka:editor-draft:v1:${documentId}:`,result:{key:string;updatedAt:number;title:string;raw:string}[]=[];
 try{for(let i=0;i<(storage?.length??0);i++){
   const key=storage!.key(i);if(!key?.startsWith(prefix)||key===prefix+slot)continue;
   const raw=storage!.getItem(key);if(!raw||raw.length>=4_000_000)continue;
   let json:unknown;try{json=JSON.parse(raw);}catch{continue;}
   const parsed=journalSchema.safeParse(json);if(!parsed.success)continue;
   const v=parsed.data;if(v.doc.id!==documentId||v.base.doc.id!==documentId||!v.pending&&sameDocument(v.doc,v.base.doc))continue;
   result.push({key,raw,title:v.doc.title,updatedAt:v.updatedAt??0});
 }}catch{}return result.sort((a,b)=>b.updatedAt-a.updatedAt);
}
