import {browserDatabaseName} from './browser-context';
import {z} from 'zod';
import {canvasElementSchema} from '../domain/model';
import {canonicalJson} from '../domain/canonical-json';
import {dataDraftSchema,normalizeDataDraft,type DataDraft} from '../domain/data-draft';
import type {DataObject} from '../domain/data-object';
import {sameBox} from '../domain/data-layout';
const dataObjectSchema=z.discriminatedUnion('kind',[canvasElementSchema.options[2],canvasElementSchema.options[3]]);
export const dataWindowRecordSchema=z.object({
 id:z.string().uuid(),documentId:z.string().min(1).max(80),slideId:z.string().min(1).max(80),
 owner:z.string().min(1).max(80),generation:z.number().int().nonnegative(),updatedAt:z.number().finite().nonnegative(),
 base:dataObjectSchema,draft:dataDraftSchema,applied:dataObjectSchema.optional(),appliedAfterRevision:z.number().int().positive().optional(),
 // Older strict readers skip this record instead of applying only its data and dropping the chosen size.
 geometryIntent:z.literal(true).optional(),
}).strict().superRefine((r,ctx)=>{
 if(!!r.applied!==(r.appliedAfterRevision!==undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Нет исходной версии применения.'});
 if(r.base.id!==r.draft.id||r.base.kind!==r.draft.kind||canonicalJson(r.base.style)!==canonicalJson(r.draft.style)||
  r.applied&&(r.applied.id!==r.base.id||r.applied.kind!==r.base.kind))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Черновик относится к другому объекту.'});
 if(new Set(r.draft.data.rows.map(v=>v.id)).size!==r.draft.data.rows.length||r.draft.kind==='table'&&new Set(r.draft.data.columns.map(v=>v.id)).size!==r.draft.data.columns.length)
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Повторяются идентификаторы данных.'});
});
export type DataWindowRecord=z.infer<typeof dataWindowRecordSchema>;
export interface DataWindowStore {
 list(documentId:string):Promise<DataWindowRecord[]>;
 write(record:DataWindowRecord,consume?:DataWindowRecord):Promise<void>;
 remove(record:DataWindowRecord):Promise<boolean>;
}
const parse=(value:unknown)=>{
 if(JSON.stringify(value).length>100_000)throw Error('Черновик данных слишком большой.');
 return dataWindowRecordSchema.parse(value);
};
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
async function database(){return new Promise<IDBDatabase>((resolve,reject)=>{
 const request=indexedDB.open(browserDatabaseName('lanka-data-drafts-v1'),1);
 request.onupgradeneeded=()=>{const store=request.result.createObjectStore('drafts',{keyPath:'id'});store.createIndex('documentId','documentId');};
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});}
async function transaction<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,set:(v:T)=>void)=>void):Promise<T>{
 const db=await database();
 try{return await new Promise<T>((resolve,reject)=>{
  const tx=db.transaction('drafts',mode);let result:T;
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('Не удалось сохранить черновик данных.'));
  try{work(tx.objectStore('drafts'),v=>{result=v;});}catch(error){tx.abort();reject(error);}
 });}finally{db.close();}
}
export const browserDataWindowStore:DataWindowStore={
 list(documentId){return transaction('readonly',(store,set)=>{
  const r=store.index('documentId').getAll(documentId);r.onsuccess=()=>{
   const found:DataWindowRecord[]=[];
   for(const value of r.result){try{const record=parse(value);if(record.documentId===documentId)found.push(record);}catch{/* Corrupt records do not execute or become editable documents. */}}
   set(found.sort((a,b)=>b.updatedAt-a.updatedAt));
  };
 });},
 async write(value,consume){
  const record=parse(value);if(consume&&(consume.documentId!==record.documentId||consume.slideId!==record.slideId||consume.base.id!==record.base.id))throw Error('Черновик другого документа или объекта.');
  await transaction<void>('readwrite',(store,set)=>{
   store.put(record);set(undefined);
   if(consume&&consume.id!==record.id){const prior=store.get(consume.id);prior.onsuccess=()=>{if(same(prior.result,consume))store.delete(consume.id);};}
  });
 },
 remove(record){return transaction('readwrite',(store,set)=>{
  const r=store.get(record.id);r.onsuccess=()=>{if(same(r.result,record)){store.delete(record.id);set(true);}else set(!r.result);};
 });},
};
/** Only a saved document can retire an applied fallback. A local optimistic preview cannot. */
export function dataRecordSaved(record:DataWindowRecord,saved:DataObject|undefined,revision:number){
 if(!record.applied||revision<=(record.appliedAfterRevision??Infinity)||!saved||saved.id!==record.base.id||saved.kind!==record.base.kind)return false;
 try{return same(record.applied.data,saved.data)&&(sameBox(record.applied,record.base)||sameBox(record.applied,saved));}catch{return false;}
}
/** Each open window owns a fresh record. Restoring consumes an unchanged older record atomically. */
export class DataWindowDraft {
 record:DataWindowRecord;
 persistent=false;
 pending=0;
 problem='';
 private savedGeneration=-1;
 private savedRecord:DataWindowRecord|undefined;
 private tail:Promise<void>=Promise.resolve();
 private closed=false;
 constructor(target:{documentId:string;slideId:string;owner:string;base:DataObject},readonly store:DataWindowStore=browserDataWindowStore,private restore?:DataWindowRecord){
  if(restore&&(restore.documentId!==target.documentId||restore.slideId!==target.slideId||restore.base.id!==target.base.id))throw Error('Черновик другого документа или объекта.');
  this.record=parse({id:crypto.randomUUID(),documentId:target.documentId,slideId:target.slideId,owner:target.owner,generation:0,updatedAt:Date.now(),base:restore?.base??target.base,draft:restore?.draft??target.base,...(restore?.geometryIntent?{geometryIntent:true}:{}),...(restore?.applied?{applied:restore.applied,appliedAfterRevision:restore.appliedAfterRevision}:{})});
 }
 get changed(){try{return !same(this.record.base.data,normalizeDataDraft(this.record.draft).data)||!sameBox(this.record.base,this.record.draft);}catch{return true;}}
 get protected(){return !this.changed||this.persistent&&this.pending===0;}
 private persist(){
  if(this.closed)throw Error('Окно данных уже закрыто.');
  const value=structuredClone(this.record);this.pending++;this.persistent=false;
  this.tail=this.tail.catch(()=>{}).then(()=>this.store.write(value,this.restore)).then(()=>{this.savedGeneration=value.generation;this.savedRecord=value;this.problem='';},()=>{this.problem='Не удалось сохранить черновик на устройстве.';}).finally(()=>{this.pending--;this.persistent=this.savedGeneration===this.record.generation;});
  return this.tail;
 }
 start(){if(this.restore)return this.persist();return Promise.resolve();}
 set(draft:DataDraft){
  const {geometryIntent,...previous}=this.record;
  this.record=parse({...previous,draft,...(!sameBox(previous.base,draft)?{geometryIntent:true}:{}),generation:this.record.generation+1,updatedAt:Date.now(),applied:undefined,appliedAfterRevision:undefined});return this.persist();
 }
 stage(applied:DataObject,revision:number){this.record=parse({...this.record,applied,appliedAfterRevision:revision,generation:this.record.generation+1,updatedAt:Date.now()});return this.persist();}
 async flush(){await this.tail;return this.protected;}
 async discard(){
  await this.tail;
  if(this.record.generation||this.restore){
   const removed=await this.store.remove(this.record);
   if(!removed&&this.savedRecord)await this.store.remove(this.savedRecord);
  }
  if(this.restore)await this.store.remove(this.restore);
  this.closed=true;
 }
}
