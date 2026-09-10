import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../domain/canonical-json';
import type {DeckDoc,Source} from '../domain/model';
import type {FolderProject} from './package';
import {prepareSharedCopy,validateSharedCopy} from './shared-copy';

const optionsSchema=z.object({tenantId:z.string().uuid(),materialId:z.string().uuid(),publicationId:z.string().uuid(),expectedRevision:z.number().int().positive(),createdAt:z.string().datetime()}).strict();
type Options=z.infer<typeof optionsSchema>;
export type PublicationPayload={
 format:'lanka-publication/v1';
 id:string;
 origin:{tenantId:string;materialId:string;documentId:string;revision:number;documentHash:string};
 createdAt:string;
 evidence:'visible-content-not-fact-verification';
 document:DeckDoc;
 sources:Source[];
 dependencies:{sha256:string;contentType:string;byteLength:number}[];
};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** Preparation only. Caller must authorize, retain blobs, render, and fence activation separately.
 * The loader is scoped by the caller to the exact tenant/material and receives only a hash.
 */
export async function preparePublicationPackage(source:FolderProject,input:Options,loadBlob:(sha256:string)=>Promise<Uint8Array|undefined>){
 const options=optionsSchema.parse(input),snapshot=structuredClone(source);
 if(snapshot.state.revision!==options.expectedRevision)throw Error('Версия изменилась. Подготовьте публикацию заново.');
 const copied=prepareSharedCopy(snapshot,options.publicationId,snapshot.state.doc.title,options.tenantId,options.createdAt);
 const doc=copied.project.state.doc;
 // Provenance bytes derive only from the sanitized composition, not the owner's view/source IDs.
 const provenance=Buffer.from(canonicalJson({format:'lanka-visible-content/v1',document:doc}));
 const blobs=new Map<string,{hash:string;bytes:Buffer;contentType:string}>();
 blobs.set(hash(provenance),{hash:hash(provenance),bytes:provenance,contentType:'application/json'});
 const snapshotSource=copied.project.state.sources[0];snapshotSource.sha256=hash(provenance);
 snapshotSource.excerpt='Снимок видимого содержания слайдов; достоверность исходных данных не подтверждена.';
 let total=provenance.length;
 if(total>5_000_000)throw Error('Снимок слайдов превышает допустимый размер.');
 for(const [oldId,id] of copied.images){
  const matches=snapshot.state.sources.filter(s=>s.id===oldId),image=matches[0];
  if(matches.length!==1||image.kind!=='image'||!['image/png','image/jpeg'].includes(image.contentType)||! /^[a-f0-9]{64}$/.test(image.sha256))throw Error('Изображение выбранной версии недоступно.');
  let blob=blobs.get(image.sha256);
  if(!blob){
   let loaded:Uint8Array|undefined;
   try{loaded=await loadBlob(image.sha256);}catch{throw Error('Изображение выбранной версии недоступно.');}
   if(!loaded||loaded.byteLength===0||loaded.byteLength>5_000_000||(total+=loaded.byteLength)>40_000_000)throw Error('Изображение недоступно или превышен размер публикации.');
   const bytes=Buffer.from(loaded);
   if(hash(bytes)!==image.sha256)throw Error('Изображение выбранной версии изменилось.');
   blob={hash:image.sha256,bytes,contentType:image.contentType};blobs.set(image.sha256,blob);
  }
  if(blob.contentType!==image.contentType)throw Error('Тип изображения выбранной версии не совпадает.');
  copied.project.state.sources.push({id,name:`Изображение ${id}`,kind:'image',sha256:image.sha256,createdAt:options.createdAt,contentType:image.contentType,excerpt:''});
 }
 validateSharedCopy(copied.project);
 const payload:PublicationPayload={format:'lanka-publication/v1',id:options.publicationId,
  origin:{tenantId:options.tenantId,materialId:options.materialId,documentId:snapshot.state.doc.id,revision:options.expectedRevision,documentHash:hash(canonicalJson(snapshot.state.doc))},
  createdAt:options.createdAt,evidence:'visible-content-not-fact-verification',document:doc,sources:copied.project.state.sources,
  dependencies:[...blobs.values()].map(b=>({sha256:b.hash,contentType:b.contentType,byteLength:b.bytes.length})).sort((a,b)=>a.sha256.localeCompare(b.sha256))};
 const bytes=Buffer.from(canonicalJson(payload));
 if(bytes.length>1_500_000)throw Error('Публикация превышает допустимый размер.');
 return {payload,bytes,hash:hash(bytes),blobs:[...blobs.values()]};
}
