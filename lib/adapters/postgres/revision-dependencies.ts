import {prepareColleagueReviewVersion} from '../../project/colleague-review-version';
import {colleagueReviewSchema,type ColleagueReview} from '../../domain/colleague-review';
import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../../domain/canonical-json';
import {initialState,validateDoc,validateReferences} from '../../domain/model';
import type {FolderProject} from '../../project/package';
import type {RevisionDependencies} from '../../project/revision-dependencies';
import {OrganizationAccessError} from '../../server/organization-access';
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const unavailable=()=>new OrganizationAccessError(409,'Для этой версии нет проверяемого архива источников.');
/** Internal transaction reader. Caller must authorize private history before entry.
 * No fallback to the current project or current material blobs is permitted.
 */
async function loadRevisionDependenciesIn(c:PoolClient,tenant:string,material:string,revision:number){
 z.string().uuid().parse(tenant);z.string().uuid().parse(material);z.number().int().positive().parse(revision);
 const row=(await c.query('SELECT r.doc,r.hash AS document_hash,s.payload,s.bytes,s.hash FROM lanka.material_revisions r JOIN lanka.revision_dependency_snapshots s ON s.tenant_id=r.tenant_id AND s.material_id=r.material_id AND s.revision=r.revision AND s.document_hash=r.hash WHERE r.tenant_id=$1 AND r.material_id=$2 AND r.revision=$3',[tenant,material,revision])).rows[0];
 if(!row||hash(row.bytes)!==row.hash||canonicalJson(JSON.parse(row.bytes.toString('utf8')))!==canonicalJson(row.payload)||hash(canonicalJson(row.doc))!==row.document_hash)throw unavailable();
 const snapshot=row.payload as RevisionDependencies;
 if(snapshot.format!=='lanka-revision-dependencies/v1'||snapshot.documentId!==material||snapshot.revision!==revision||snapshot.documentHash!==row.document_hash||!Array.isArray(snapshot.sources)||!Array.isArray(snapshot.files)||!Array.isArray(snapshot.unavailable))throw unavailable();
 const state=initialState(validateDoc(row.doc));if(state.doc.id!==material)throw unavailable();state.revision=revision;state.sources=structuredClone(snapshot.sources);validateReferences(state);
 const project:FolderProject={format:'lanka-project/v1',title:state.doc.title,state,receipts:[]};
 const read=async(sha256:string)=>{
  if(!/^[a-f0-9]{64}$/.test(sha256))throw unavailable();
  const files=snapshot.files.filter(f=>f.sha256===sha256);
  if(files.length!==1||snapshot.unavailable.some(f=>f.sha256===sha256))throw unavailable();
  const file=(await c.query('SELECT bytes FROM lanka.revision_dependency_blobs WHERE tenant_id=$1 AND material_id=$2 AND hash=$3',[tenant,material,sha256])).rows[0]?.bytes;
  if(!file||file.length!==files[0].byteLength||file.length>5_000_000||hash(file)!==sha256)throw unavailable();
  return Buffer.from(file);
 };
 return {project,read,snapshot};
}

/** Full private archive. Caller must separately authorize private history. */
export async function readRevisionDependenciesIn(c:PoolClient,tenant:string,material:string,revision:number){
 return loadRevisionDependenciesIn(c,tenant,material,revision);
}
/** Caller has authorized both participants and this exact request. Never returns the
 * intermediate private archive or a loader capable of reading arbitrary source bytes. */
export async function readColleagueReviewVersionIn(c:PoolClient,input:ColleagueReview){
 const review=colleagueReviewSchema.parse(input);
 const archive=await loadRevisionDependenciesIn(c,review.tenantId,review.documentId,review.target.revision);
 try{return await prepareColleagueReviewVersion(archive.project,review,archive.read);}
 catch{throw new OrganizationAccessError(409,'Просмотр закреплённой версии недоступен: проверьте архив слайдов и изображений.');}
}

/** Used only under the caller's authorized write transaction. */
export async function loadRestorableRevisionIn(c:PoolClient,tenant:string,material:string,revision:number){
 const archive=await readRevisionDependenciesIn(c,tenant,material,revision),files=new Map<string,Buffer>();
 for(const source of archive.project.state.sources)if(!files.has(source.sha256))files.set(source.sha256,await archive.read(source.sha256));
 if(files.size){
  const existing=await c.query('SELECT key,bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=ANY($3::text[]) FOR SHARE',[tenant,material,[...files.keys()].map(h=>'materials/'+h+'.bin')]);
  for(const row of existing.rows)if(hash(row.bytes)!==row.key.slice(10,-4))throw unavailable();
 }
 return {doc:archive.project.state.doc,sources:archive.project.state.sources,files};
}
export async function readRevisionAssetIn(c:PoolClient,tenant:string,material:string,revision:number,id:string){
 const archive=await readRevisionDependenciesIn(c,tenant,material,revision);
 const sources=archive.project.state.sources.filter(s=>s.id===id&&s.kind==='image'&&['image/png','image/jpeg'].includes(s.contentType));
 if(sources.length!==1)throw new OrganizationAccessError(404,'Изображение версии недоступно.');
 return {bytes:await archive.read(sources[0].sha256),contentType:sources[0].contentType};
}
