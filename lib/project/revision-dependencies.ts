import {createHash} from 'node:crypto';
import {canonicalJson} from '../domain/canonical-json';
import type {FolderProject} from './package';

const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export type RevisionDependencies={
 format:'lanka-revision-dependencies/v1';documentId:string;revision:number;documentHash:string;
 sources:FolderProject['state']['sources'];
 files:{sha256:string;byteLength:number}[];
 unavailable:{sha256:string;reason:'missing'|'hash-mismatch'|'size-limit'|'file-count-limit'}[];
};
/** Capture at the revision's write boundary. Never reconstruct this from a later project.
 * Unavailable inputs are explicit: normal editing can continue, while historical
 * consumers must reject a required dependency that was not captured.
 */
export async function captureRevisionDependencies(project:FolderProject,read:(sha256:string)=>Promise<Uint8Array|undefined>){
 const state=structuredClone(project.state);
 if(!Number.isSafeInteger(state.revision)||state.revision<1)throw Error('Invalid source revision');
 const snapshot:RevisionDependencies={format:'lanka-revision-dependencies/v1',documentId:state.doc.id,revision:state.revision,documentHash:hash(canonicalJson(state.doc)),sources:state.sources,files:[],unavailable:[]};
 const blobs:{hash:string;bytes:Buffer}[]=[];let total=0,reads=0;
 for(const sha256 of [...new Set(state.sources.map(s=>s.sha256))].sort()){
  if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('Invalid dependency hash');
  if(reads>=256){snapshot.unavailable.push({sha256,reason:'file-count-limit'});continue;}
  if(total>=40_000_000){snapshot.unavailable.push({sha256,reason:'size-limit'});continue;}
  reads++;
  // Storage failures propagate. Treating a database outage as a missing file would
  // permanently mislabel a recoverable revision as incomplete.
  const value=await read(sha256);
  if(!value){snapshot.unavailable.push({sha256,reason:'missing'});continue;}
  if(value.byteLength===0||value.byteLength>5_000_000||total+value.byteLength>40_000_000){snapshot.unavailable.push({sha256,reason:'size-limit'});continue;}
  const bytes=Buffer.from(value);
  if(hash(bytes)!==sha256){snapshot.unavailable.push({sha256,reason:'hash-mismatch'});continue;}
  total+=bytes.length;blobs.push({hash:sha256,bytes});snapshot.files.push({sha256,byteLength:bytes.length});
 }
 const bytes=Buffer.from(canonicalJson(snapshot));
 if(bytes.length>3_000_000)throw Error('Revision dependencies exceed metadata limit');
 return {snapshot,bytes,hash:hash(bytes),blobs};
}

/** Restore a captured source by its historical ID, without consulting today's sources. */
export function capturedRevisionSource(snapshot:RevisionDependencies,id:string){
 const sources=snapshot.sources.filter(source=>source.id===id);
 if(sources.length!==1)throw Error('Historical source is unavailable or ambiguous');
 const source=sources[0];
 if(!snapshot.files.some(file=>file.sha256===source.sha256)||snapshot.unavailable.some(file=>file.sha256===source.sha256))throw Error('Historical source bytes were not captured');
 return structuredClone(source);
}
