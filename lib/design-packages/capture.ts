import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {creationProfile,creationReferenceImages} from '../agents/creation-profile';
import {bytesDigest,createManifest,verifyPackage} from './manifest';
declare const __LANKA_SCENE_BUILD__:string;
/** Captures installed layout code and inputs. PDF/PPTX exporters are separate dependencies. */
export async function captureInstalledDesign(profile:'focus-v2'|'focus-v3'){
 const rules=await creationProfile(profile),references=await creationReferenceImages(rules);
 const blobs=new Map<string,Uint8Array>();
 const assets:Array<{path:string;role:'renderer'|'font'|'license'|'reference';sha256:string;byteLength:number}>=[];
 const add=(path:string,role:typeof assets[number]['role'],bytes:Uint8Array)=>{blobs.set(path,bytes);assets.push({path,role,sha256:bytesDigest(bytes),byteLength:bytes.byteLength});};
 const renderer=await readFile(resolve(import.meta.dirname,'design-scene.mjs'));
 if(typeof __LANKA_SCENE_BUILD__!=='undefined'&&bytesDigest(renderer)!==__LANKA_SCENE_BUILD__)throw Error('Рендерер обновлён. Перезапустите сервис перед созданием презентации.');
 add('renderer/scene.mjs','renderer',renderer);
 for(const entry of rules.fontSnapshot.files){
  const bytes=await readFile(resolve(import.meta.dirname,'../public/fonts',entry.file));
  if(bytesDigest(bytes)!==entry.sha256||bytes.byteLength!==entry.byteLength)throw Error('Font changed during package capture');
  add(`fonts/${entry.file}`,entry.file.endsWith('.ttf')?'font':'license',bytes);
 }
 for(const [i,path] of references.entries()){
  const bytes=await readFile(path);if(bytesDigest(bytes)!==rules.references[i].sha256)throw Error('Reference changed during package capture');
  add(`references/${rules.references[i].file}`,'reference',bytes);
 }
 const manifest=createManifest({format:'lanka-design-package/v1',profile,componentSchema:'lanka-scene/v1',renderer:{entry:'renderer/scene.mjs',buildSha256:assets[0].sha256},rules,assets});
 verifyPackage(manifest,blobs);return {manifest,blobs};
}
