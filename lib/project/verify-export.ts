import {createHash} from 'node:crypto';
import {initialState,validateReferences} from '../domain/model';
import {canonicalJson} from '../domain/canonical-json';
import {exportManifestSchema,type ExportManifest} from './export-artifact';
export const exportHash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export function verifyExportManifest(value:unknown,documentId:string,artifactId?:string):ExportManifest {
 const m=exportManifestSchema.parse(value);
 if(artifactId&&m.id!==artifactId||m.documentId!==documentId||m.snapshot.id!==documentId||m.title!==m.snapshot.title||exportHash(canonicalJson(m.snapshot))!==m.documentHash)
  throw Error('Паспорт экспорта не соответствует документу.');
 validateReferences({...initialState(m.snapshot),sources:m.sources});
 if(Buffer.byteLength(JSON.stringify(m))>3_000_000)throw Error('Паспорт экспорта превышает лимит.');
 return m;
}
export function verifyExportBytes(m:ExportManifest,bytes:Uint8Array){
 if(bytes.length!==m.output.bytes||exportHash(bytes)!==m.output.sha256)throw Error('Сохранённый экспорт повреждён.');
}
