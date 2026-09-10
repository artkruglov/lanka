import {browserDatabaseName} from './browser-context';
import {imageUploadSchema,imageUploadLimit,type ImageUpload} from '../domain/image-source';
export async function imageUploadRequest(file:File,target:Pick<ImageUpload,'deckId'|'expectedRevision'|'slideId'|'elementId'>):Promise<ImageUpload>{
 if(!file.size||file.size>imageUploadLimit)throw Error('Выберите PNG или JPEG размером до 5 МБ.');
 const contentType=file.type||(/\.png$/i.test(file.name)?'image/png':/\.jpe?g$/i.test(file.name)?'image/jpeg':'');
 if(!['image/png','image/jpeg'].includes(contentType))throw Error('Поддерживаются PNG и JPEG.');
 const bytes=new Uint8Array(await file.arrayBuffer());let raw='';
 for(let i=0;i<bytes.length;i+=16384)raw+=String.fromCharCode(...bytes.subarray(i,i+16384));
 return imageUploadSchema.parse({...target,requestId:crypto.randomUUID(),name:file.name.slice(0,140),contentType,base64:btoa(raw)});
}
/** IndexedDB can keep a photo-sized request across reload without exhausting localStorage. */
export async function imageUploadJournal(documentId:string,slot:string,operation:'read'|'write'|'delete',value?:ImageUpload):Promise<ImageUpload|null>{
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
   const request=indexedDB.open(browserDatabaseName('lanka-image-uploads-v1'),1);
   request.onupgradeneeded=()=>request.result.createObjectStore('uploads');
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
 });
 try{return await new Promise((resolve,reject)=>{
   const tx=db.transaction('uploads',operation==='read'?'readonly':'readwrite'),store=tx.objectStore('uploads'),key=`${documentId}:${slot}`;
   let result:ImageUpload|null=null;
   tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('Загрузка не сохранена на устройстве.'));
   if(operation==='read'){
     const read=store.get(key);read.onsuccess=()=>{const parsed=imageUploadSchema.safeParse(read.result);if(parsed.success&&parsed.data.deckId===documentId)result=parsed.data;};
   }else if(operation==='delete')store.delete(key);
   else {if(!value||value.deckId!==documentId){tx.abort();return;}store.put(imageUploadSchema.parse(value),key);}
 });}finally{db.close();}
}
