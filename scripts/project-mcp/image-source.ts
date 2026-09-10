import sharp from 'sharp';
import {createHash} from 'node:crypto';
import type {ProjectRepository} from '../../lib/project/repository';
import type {FolderProject} from '../../lib/project/package';
import type {Source} from '../../lib/domain/model';
import {imageUploadLimit} from '../../lib/domain/image-source';
export interface MaterialRepository extends ProjectRepository {writeMaterial(bytes:Buffer):Promise<string>}
const decodeError=(error:unknown):never=>{throw Error(/pixel limit/i.test(String(error))?'Разрешение изображения превышает 32 Мп. Выберите файл меньшего размера.':'Не удалось прочитать изображение. Используйте исправный статичный PNG или JPEG.');};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Decode before committing; the original and normalized derivative share the transaction. */
export async function registerImage(store:MaterialRepository,p:FolderProject,input:{name:string;contentType:string;base64:string}){
 const bytes=Buffer.from(input.base64,'base64');
 if(bytes.toString('base64')!==input.base64||!bytes.length||bytes.length>imageUploadLimit)throw Error('Изображение должно быть корректным PNG/JPEG до 5 МБ.');
 if(input.contentType==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Файл не распознан как PNG.');
 if(input.contentType==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw Error('Файл не распознан как JPEG.');
 const pipeline=sharp(bytes,{limitInputPixels:32_000_000,failOn:'error'}).timeout({seconds:10});
 const meta=await pipeline.metadata().catch(decodeError);
 if(!meta.width||!meta.height||!['png','jpeg'].includes(meta.format)||meta.pages&&meta.pages>1)throw Error('Нужно статичное изображение PNG или JPEG.');
 let normalized:Buffer|null=null,width=meta.width,height=meta.height;
 if(meta.orientation&&meta.orientation!==1){
   const oriented=pipeline.autoOrient();
   const result=await (meta.format==='png'?oriented.png():oriented.jpeg({quality:95,chromaSubsampling:'4:4:4'})).toBuffer({resolveWithObject:true}).catch(decodeError);
   normalized=result.data;width=result.info.width;height=result.info.height;
   if(normalized.length>imageUploadLimit)throw Error('Обработанное изображение превышает 5 МБ. Выберите файл меньшего размера.');
 }else await pipeline.stats().catch(decodeError); // Verify the full compressed payload, not just its header.
 const sha256=digest(bytes),normalizedHash=normalized?digest(normalized):sha256;
 const sourceId=p.state.sources.find(s=>s.sha256===normalizedHash)?.id??`src-${normalizedHash}`,originalSourceId=p.state.sources.find(s=>s.sha256===sha256)?.id??`src-${sha256}`;
 const missing=[sha256,...(normalized?[normalizedHash]:[])].filter(hash=>!p.state.sources.some(s=>s.sha256===hash));
 if(p.state.sources.length+new Set(missing).size>100)throw Error('Too many sources');
 await store.writeMaterial(bytes);if(normalized)await store.writeMaterial(normalized);
 const add=(hash:string,name:string,contentType:string,image:NonNullable<Source['image']>)=>{
   const existing=p.state.sources.find(s=>s.sha256===hash);
   if(existing){existing.image={...image,...existing.image,width:image.width,height:image.height};return existing;}
   const source:Source={id:`src-${hash}`,sha256:hash,name,contentType,kind:'image',createdAt:new Date().toISOString(),excerpt:'',image};p.state.sources.push(source);return source;
 };
 const original=add(sha256,input.name,input.contentType,{width:meta.width,height:meta.height,...(normalized?{normalizedSourceId:sourceId}:{})});
 const source=normalized?add(normalizedHash,input.name.slice(0,125)+' · обработано',input.contentType,{width,height,originalSourceId}):original;
 return {sourceId:source.id,sha256:source.sha256,originalSourceId,originalSha256:sha256,image:{width,height},normalized:!!normalized,revision:p.state.revision};
}
