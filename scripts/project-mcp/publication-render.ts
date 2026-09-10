import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../lib/domain/canonical-json';
import {initialState} from '../../lib/domain/model';
import type {PublicationRenderer,PublicationArtifact} from '../../lib/adapters/postgres/publications';
import {publicationExportBytes} from './export';
import {rasterizePdfPages} from './preview';
export const renderPublication:PublicationRenderer=async pkg=>{
 const state=initialState(pkg.payload.document);state.sources=pkg.payload.sources;
 const project={format:'lanka-project/v1' as const,title:state.doc.title,state,receipts:[]};
 const store={readFile:async(path:string)=>{
  const blob=pkg.blobs.find(b=>path===`materials/${b.hash}.bin`);if(!blob)throw Error('Publication dependency unavailable');return Buffer.from(blob.bytes);
 }};
 const exported=await publicationExportBytes(store,project),pdf=Buffer.from(exported.pdf),pptx=Buffer.from(exported.pptx);
 const previews=await rasterizePdfPages(pdf,state.doc.slides.map((_,i)=>i),40_000_000);
 const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 const zip=new JSZip(),retained=[...exported.fonts.map(f=>({...f,path:'fonts/'+f.file})),...exported.licenses.map(f=>({...f,path:'licenses/'+f.file}))];
 for(const file of retained)zip.file(file.path,file.bytes,{date:new Date(pkg.payload.createdAt)});
 const manifest={format:'lanka-publication-dependencies/v1',publicationId:pkg.payload.id,payloadHash:pkg.hash,sourceRevision:pkg.payload.origin.revision,documentDependencies:pkg.payload.dependencies,renderer:exported.renderer,fontsEmbeddedIn:{pdf:true,pptx:false},files:retained.map(f=>({path:f.path,sha256:hash(f.bytes),bytes:f.bytes.length})),artifacts:[{kind:'pdf',page:0,sha256:hash(pdf)},{kind:'pptx',page:0,sha256:hash(pptx)},...previews.map(p=>({kind:'preview',page:p.number,sha256:hash(p.bytes)}))],limitations:['Renderer identity is retained, not an executable runtime image.','PPTX uses native objects and requires installed fonts.']};
 zip.file('manifest.json',canonicalJson(manifest),{date:new Date(pkg.payload.createdAt)});
 const dependencies=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 return [{kind:'dependencies',page:0,bytes:dependencies},{kind:'pdf',page:0,bytes:pdf},{kind:'pptx',page:0,bytes:pptx},...previews.map(p=>({kind:'preview' as const,page:p.number,bytes:p.bytes}))] satisfies PublicationArtifact[];
};
