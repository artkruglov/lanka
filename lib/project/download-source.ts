import type {Source} from '../domain/model';
import {localFetch} from './local-client';
import {download} from './download';
/** Use the authenticated page transport so failures remain visible in the editor. */
export async function downloadSourceOriginal(documentId:string,source:Source,fetcher=localFetch,save=download){
 const response=await fetcher(`/api/sources?documentId=${encodeURIComponent(documentId)}&id=${encodeURIComponent(source.id)}`,{cache:'no-store'});
 const bytes=await response.arrayBuffer();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==source.sha256)throw Error('Контрольная сумма оригинала не совпала. Файл не скачан; повторите загрузку.');
 save(new Blob([bytes],{type:'application/octet-stream'}),source.name.replace(/[\x00-\x1f\x7f/\\]/g,'_'));
}
