import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectRepository } from "../../lib/project/repository";
import { materialPath, type FolderProject } from "../../lib/project/package";
import { pptxBytes, pdfBytes } from "../../lib/export";
import { pdfFontFiles } from "../../lib/domain/scene-typography";
import {canonicalJson} from '../../lib/domain/canonical-json';
import {exportHash} from '../../lib/project/verify-export';
import {exportCapabilities} from '../../lib/project/export-capabilities';
import {exportManifestSchema} from '../../lib/project/export-artifact';
declare const __LANKA_EXPORT_BUILD__:{buildHash:string;packageVersion:string};
// Bundled servers retain their own build identity even while another build is installed.
const rendererBuild=typeof __LANKA_EXPORT_BUILD__!=='undefined'?__LANKA_EXPORT_BUILD__:JSON.parse(await readFile(resolve(import.meta.dirname,'export-build.json'),'utf8'));

async function render(store:Pick<ProjectRepository,'readFile'>,p:FolderProject,format:'pptx'|'pdf',capture=false,fontSnapshot?:Buffer[]){
 const materials=new Map<string,Buffer>();
 const sourceBytes=async(id:string)=>{
  const src=p.state.sources.find(s=>s.id===id);if(!src)throw Error('Source is outside project');
  let data=materials.get(id);if(!data){data=await store.readFile(materialPath(src.sha256));if(exportHash(data)!==src.sha256)throw Error('Source hash mismatch');materials.set(id,data);}
  return {bytes:new Uint8Array(data).buffer,type:src.contentType};
 };
 // Capture all registered dependencies, including evidence behind numbers, not just visible images.
 if(capture)for(const src of p.state.sources)await sourceBytes(src.id);
 const fontNames=pdfFontFiles(p.state.doc.design);
 const fonts=fontSnapshot??((format==='pdf'||capture)?await Promise.all(fontNames.map(name=>readFile(resolve(import.meta.dirname,'../public/fonts',name)))):[]);
 const bytes=format==='pptx'?await pptxBytes(p.state.doc,p.state.sources,sourceBytes):await pdfBytes(p.state.doc,fonts[0],fonts[1],sourceBytes,fonts[2]);
 return {bytes,materials,fonts:fontNames.map((file,i)=>({file,sha256:fonts[i]?exportHash(fonts[i]):'',embedded:format==='pdf'}))};
}
export async function projectExportBytes(store:Pick<ProjectRepository,'readFile'>,p:FolderProject,format:'pptx'|'pdf'){
 return (await render(store,p,format)).bytes;
}
export async function renderProjectExport(store:ProjectRepository,value:FolderProject,format:'pptx'|'pdf'){
 // Preserve the input across asynchronous rendering and concurrent saves.
 const p=structuredClone(value);
 const renderer=rendererBuild;
 const result=await render(store,p,format,true),bytes=result.bytes;
 const manifest=exportManifestSchema.parse({format:'lanka-export/v1',id:randomUUID(),createdAt:new Date().toISOString(),documentId:p.state.doc.id,revision:p.state.revision,title:p.state.doc.title,
  output:{format,sha256:exportHash(bytes),bytes:bytes.length},documentHash:exportHash(canonicalJson(p.state.doc)),snapshot:p.state.doc,
  sources:p.state.sources.map(src=>({...src,bytes:result.materials.get(src.id)!.length})),renderer:{...renderer,nodeVersion:process.version},fonts:result.fonts,approval:'not-a-release',capabilities:exportCapabilities(p.state.doc,format)});
 const path=await store.saveExportArtifact(manifest,bytes);
 return {bytes,path,artifactId:manifest.id,revision:manifest.revision,sha256:manifest.output.sha256,manifest,draft:true};
}

/** Publication exports share one captured font set even if an installation changes on disk. */
export async function publicationExportBytes(store:Pick<ProjectRepository,'readFile'>,value:FolderProject){
 const p=structuredClone(value),files=pdfFontFiles(p.state.doc.design);
 const fonts=await Promise.all(files.map(async file=>({file,bytes:await readFile(resolve(import.meta.dirname,'../public/fonts',file))})));
 const licenseFiles=p.state.doc.design==='focus-v3'?['OFL-IBMPlexSans.txt','OFL-IBMPlexMono.txt']:['LICENSE.txt'];
 const licenses=await Promise.all(licenseFiles.map(async file=>({file,bytes:await readFile(resolve(import.meta.dirname,'../public/fonts',file))})));
 const captured=fonts.map(f=>f.bytes);
 const pdf=(await render(store,p,'pdf',false,captured)).bytes,pptx=(await render(store,p,'pptx',false,captured)).bytes;
 return {pdf,pptx,fonts,licenses,renderer:{...rendererBuild,nodeVersion:process.version}};
}
