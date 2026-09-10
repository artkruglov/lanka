import {readRevisionDependenciesIn} from './revision-dependencies';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {canonicalJson} from '../../domain/canonical-json';
import type {FolderProject} from '../../project/package';
import {preparePublicationPackage} from '../../project/publication-package';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import type {ResourcePermission} from '../../server/resource-access';
import {PostgresResourceAccess} from './resource-access';
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const uuid=z.string().uuid();
type Package=Awaited<ReturnType<typeof preparePublicationPackage>>;
export type PublicationArtifact={kind:'pdf'|'pptx'|'preview'|'dependencies';page:number;bytes:Buffer};
export type PublicationRenderer=(snapshot:Package)=>Promise<PublicationArtifact[]>;
type Prepared={headRevision:number;headHash:string;package:Package;artifacts:PublicationArtifact[];actorId:string;epoch:string;expires:number;size:number};
const fail=(message:string)=>new OrganizationAccessError(409,message);
/** Prepared handles are process-local, actor-bound and expire; activation alone is durable.
 * Restart requests a fresh preview, never implicitly publishes an unreviewed version.
 */
export class OrganizationPublications{
 private prepared=new Map<string,Prepared>();private rendering=0;
 constructor(private resources:PostgresResourceAccess,private render:PublicationRenderer){}
 private clean(){for(const [id,p] of this.prepared)if(p.expires<=Date.now())this.prepared.delete(id);}
 private manager<T>(p:CorporatePrincipal,tenant:string,material:string,write:boolean,fn:(c:PoolClient,ctx:OrganizationContext,permission:ResourcePermission)=>Promise<T>){
  uuid.parse(material);if(p.kind!=='oidc')throw new OrganizationAccessError(403,'Публикацию подтверждает человек с правом управления документом.');
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   const row=await c.query('SELECT n.id FROM lanka.resource_nodes n JOIN lanka.materials m ON m.tenant_id=n.tenant_id AND m.id=n.material_id WHERE n.tenant_id=$1 AND n.material_id=$2 AND NOT m.trashed',[tenant,material]);
   if(!row.rowCount)throw new OrganizationAccessError(404);
   return fn(c,ctx,await this.resources.permissionIn(c,ctx,row.rows[0].id,'manager'));
  },write);
 }
 history(p:CorporatePrincipal,tenant:string,material:string,before?:number){
  if(before!==undefined)z.number().int().positive().parse(before);
  return this.manager(p,tenant,material,false,async(c,ctx,permission)=>{
   if(ctx.principalId!==permission.ownerId)return {canReadHistory:false,items:[],nextCursor:null};
   const rows=await c.query(`SELECT r.revision,r.created_at AS "createdAt",jsonb_array_length(s.payload->'unavailable')>0 AS incomplete
    FROM lanka.material_revisions r JOIN lanka.revision_dependency_snapshots s ON s.tenant_id=r.tenant_id AND s.material_id=r.material_id AND s.revision=r.revision AND s.document_hash=r.hash
    JOIN lanka.materials m ON m.tenant_id=r.tenant_id AND m.id=r.material_id
    WHERE r.tenant_id=$1 AND r.material_id=$2 AND r.revision<(m.project#>>'{state,revision}')::integer AND ($3::integer IS NULL OR r.revision<$3)
    ORDER BY r.revision DESC LIMIT 51`,[tenant,material,before??null]);
   const items=rows.rows.slice(0,50);return {canReadHistory:true,items,nextCursor:rows.rows.length>50?items.at(-1)!.revision:null};
  });
 }
 async prepare(p:CorporatePrincipal,tenant:string,material:string,input:unknown){
  const {expectedRevision,sourceRevision}=z.object({expectedRevision:z.number().int().positive(),sourceRevision:z.number().int().positive().optional()}).strict().parse(input);
  const selectedRevision=sourceRevision??expectedRevision;if(selectedRevision>expectedRevision)throw fail('Выберите существующую версию.');
  this.clean();if(this.rendering>=2)throw fail('Подготовка публикаций занята. Повторите немного позже.');
  this.rendering++;
  try{
   const staged=await this.manager(p,tenant,material,false,async(c,ctx,permission)=>{
    const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,material]);
    const project=row.rows[0].project as FolderProject;
    if(project.state.revision!==expectedRevision)throw fail('Версия изменилась. Подготовьте публикацию заново.');
    if(selectedRevision!==expectedRevision&&ctx.principalId!==permission.ownerId)throw new OrganizationAccessError(403,'История доступна владельцу документа.');
    const historical=selectedRevision===expectedRevision?null:await readRevisionDependenciesIn(c,tenant,material,selectedRevision);
    const pkg=await preparePublicationPackage(historical?.project??project,{tenantId:tenant,materialId:material,publicationId:randomUUID(),expectedRevision:selectedRevision,createdAt:new Date().toISOString()},historical?.read??(async h=>(await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[tenant,material,`materials/${h}.bin`])).rows[0]?.bytes));
    return {package:pkg,headRevision:expectedRevision,headHash:hash(canonicalJson(project.state.doc)),actorId:ctx.principalId,epoch:ctx.authzEpoch};
   });
   // Renderer receives an independent safe snapshot and cannot rewrite the retained package.
   const rendered=await this.render(structuredClone(staged.package));
   const artifacts:PublicationArtifact[]=rendered.map(a=>({kind:z.enum(['pdf','pptx','preview','dependencies']).parse(a.kind),page:z.number().int().min(0).max(40).parse(a.page),bytes:Buffer.from(a.bytes)}));
   const expected=['dependencies:0','pdf:0','pptx:0',...staged.package.payload.document.slides.map((_,i)=>`preview:${i+1}`)];
   const keys=artifacts.map(a=>`${a.kind}:${a.page}`);
   if(keys.length!==expected.length||new Set(keys).size!==keys.length||expected.some(k=>!keys.includes(k))||artifacts.some(a=>a.bytes.length===0||a.bytes.length>40_000_000))throw fail('Не все файлы публикации подготовлены.');
   const size=staged.package.bytes.length+staged.package.blobs.reduce((n,b)=>n+b.bytes.length,0)+artifacts.reduce((n,a)=>n+a.bytes.length,0);
   this.clean();if(size>120_000_000||this.prepared.size>=8||size+[...this.prepared.values()].reduce((n,e)=>n+e.size,0)>160_000_000)throw fail('Превышен размер временных публикаций. Подготовьте комплект позже.');
   const entry={...staged,artifacts,size,expires:Date.now()+10*60_000};
   await this.manager(p,tenant,material,false,async(c,ctx)=>{await this.assertCurrent(c,ctx,material,entry);});
   const preparedId=staged.package.payload.id;this.prepared.set(preparedId,entry);
   setTimeout(()=>this.prepared.delete(preparedId),10*60_000).unref();
   return {id:staged.package.payload.id,sourceRevision:selectedRevision,headRevision:expectedRevision,hash:staged.package.hash,expiresAt:new Date(entry.expires).toISOString(),audience:'current-document-access' as const,audienceEpoch:entry.epoch,document:structuredClone(staged.package.payload.document)};
  }finally{this.rendering--;}
 }
 private async assertCurrent(c:PoolClient,ctx:OrganizationContext,material:string,entry:Prepared){
  if(ctx.principalId!==entry.actorId||ctx.authzEpoch!==entry.epoch)throw fail('Права или аудитория изменились. Подготовьте публикацию заново.');
  const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.tenantId,material]);
  const current=row.rows[0]?.project as FolderProject|undefined;
  if(!current||current.state.revision!==entry.headRevision||hash(canonicalJson(current.state.doc))!==entry.headHash)throw fail('Версия изменилась. Подготовьте публикацию заново.');
 }
 async activate(p:CorporatePrincipal,tenant:string,material:string,input:unknown){
  const request=z.object({requestId:uuid,preparedId:uuid,expectedHash:z.string().regex(/^[a-f0-9]{64}$/),audience:z.literal('current-document-access')}).strict().parse(input);
  return this.manager(p,tenant,material,true,async(c,ctx,permission)=>{
   const fingerprint=hash(canonicalJson({operation:'publish',material,request}));
   const prior=await this.receipt(c,ctx,request.requestId,fingerprint);if(prior)return this.summary(c,tenant,material,prior.publicationId);
   this.clean();const entry=this.prepared.get(request.preparedId);
   if(!entry||entry.actorId!==ctx.principalId||entry.package.payload.origin.tenantId!==tenant||entry.package.payload.origin.materialId!==material||entry.package.hash!==request.expectedHash)throw fail('Предпросмотр истёк или недоступен. Подготовьте публикацию заново.');
   await this.assertCurrent(c,ctx,material,entry);
   const pkg=entry.package,id=pkg.payload.id,origin=pkg.payload.origin;
   await c.query('INSERT INTO lanka.publications(tenant_id,id,resource_id,material_id,source_revision,document_hash,actor_id,created_at,payload,payload_bytes,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[tenant,id,permission.resourceId,material,origin.revision,origin.documentHash,ctx.principalId,new Date().toISOString(),JSON.stringify(pkg.payload),pkg.bytes,pkg.hash]);
   for(const b of pkg.blobs)await c.query('INSERT INTO lanka.publication_blobs(tenant_id,publication_id,hash,content_type,bytes) VALUES($1,$2,$3,$4,$5)',[tenant,id,b.hash,b.contentType,b.bytes]);
   for(const a of entry.artifacts)await c.query('INSERT INTO lanka.publication_artifacts(tenant_id,publication_id,kind,page,bytes,hash) VALUES($1,$2,$3,$4,$5,$6)',[tenant,id,a.kind,a.page,a.bytes,hash(a.bytes)]);
   await this.record(c,ctx,id,request.requestId,fingerprint,'publish');
   return this.summary(c,tenant,material,id);
  }).then(result=>{this.prepared.delete(request.preparedId);return result;});
 }
 private async receipt(c:PoolClient,ctx:OrganizationContext,requestId:string,fingerprint:string){
  const prior=await c.query('SELECT fingerprint,publication_id FROM lanka.publication_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[ctx.tenantId,ctx.principalId,requestId]);
  if(!prior.rowCount)return null;if(prior.rows[0].fingerprint!==fingerprint)throw fail('Ключ повтора использован для другого действия.');return {publicationId:prior.rows[0].publication_id as string};
 }
 private async record(c:PoolClient,ctx:OrganizationContext,id:string,requestId:string,fingerprint:string,action:'publish'|'withdraw'){
  await c.query('INSERT INTO lanka.publication_audit(tenant_id,publication_id,actor_id,action) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ctx.tenantId,id,ctx.principalId,action]);
  await c.query('INSERT INTO lanka.publication_receipts(tenant_id,publication_id,actor_id,request_id,fingerprint,operation,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,id,ctx.principalId,requestId,fingerprint,action,JSON.stringify({publicationId:id})]);
 }
 private async summary(c:PoolClient,tenant:string,material:string,id:string){
  const row=(await c.query("SELECT p.id,p.source_revision AS revision,p.payload_hash AS hash,p.payload#>>'{document,title}' AS title,EXISTS(SELECT 1 FROM lanka.publication_withdrawals w WHERE w.tenant_id=p.tenant_id AND w.publication_id=p.id) AS withdrawn FROM lanka.publications p JOIN lanka.materials m ON m.tenant_id=p.tenant_id AND m.id=p.material_id AND NOT m.trashed WHERE p.tenant_id=$1 AND p.material_id=$2 AND p.id=$3",[tenant,material,id])).rows[0];
  if(!row)throw new OrganizationAccessError(404);return row as {id:string;revision:number;hash:string;title:string;withdrawn:boolean};
 }
 withdraw(p:CorporatePrincipal,tenant:string,material:string,input:unknown){
  const request=z.object({requestId:uuid,publicationId:uuid}).strict().parse(input);
  return this.manager(p,tenant,material,true,async(c,ctx)=>{
   const fingerprint=hash(canonicalJson({operation:'withdraw',material,request}));
   const prior=await this.receipt(c,ctx,request.requestId,fingerprint);if(prior)return this.summary(c,tenant,material,prior.publicationId);
   await this.summary(c,tenant,material,request.publicationId);
   await c.query('INSERT INTO lanka.publication_withdrawals(tenant_id,publication_id,actor_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenant,request.publicationId,ctx.principalId]);
   await this.record(c,ctx,request.publicationId,request.requestId,fingerprint,'withdraw');return this.summary(c,tenant,material,request.publicationId);
  });
 }
 preparedArtifact(p:CorporatePrincipal,tenant:string,material:string,id:string,kind:'pdf'|'pptx'|'preview'|'dependencies',page=0){
  uuid.parse(id);z.enum(['pdf','pptx','preview','dependencies']).parse(kind);z.number().int().min(0).max(40).parse(page);
  return this.manager(p,tenant,material,false,async(c,ctx)=>{
   this.clean();const entry=this.prepared.get(id);
   if(!entry||entry.actorId!==ctx.principalId||entry.package.payload.origin.tenantId!==tenant||entry.package.payload.origin.materialId!==material)throw new OrganizationAccessError(404);
   await this.assertCurrent(c,ctx,material,entry);
   const a=entry.artifacts.find(a=>a.kind===kind&&a.page===page);if(!a)throw new OrganizationAccessError(404);return {bytes:Buffer.from(a.bytes),hash:hash(a.bytes)};
  });
 }
 list(p:CorporatePrincipal,tenant:string,material:string,input:unknown={}){
  const {cursor,includeWithdrawn}=z.object({cursor:z.string().max(100).optional(),includeWithdrawn:z.boolean().default(false)}).strict().parse(input);
  const after=cursor?z.tuple([z.string().datetime({precision:6}),z.string().uuid()]).parse(cursor.split('|')):null;
  return this.resources.withMaterial(p,tenant,material,'viewer',async(c,ctx,permission)=>{
   const canReadWithdrawn=p.kind==='oidc'&&ctx.principalId===permission.ownerId;
   if(includeWithdrawn&&!canReadWithdrawn)throw new OrganizationAccessError(403,'История снятых публикаций доступна владельцу документа.');
   const rows=await c.query(`SELECT p.id,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM lanka.publications p JOIN lanka.materials m ON m.tenant_id=p.tenant_id AND m.id=p.material_id AND NOT m.trashed WHERE p.tenant_id=$1 AND p.material_id=$2 AND ($5::boolean OR NOT EXISTS(SELECT 1 FROM lanka.publication_withdrawals w WHERE w.tenant_id=p.tenant_id AND w.publication_id=p.id)) AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT 51`,[tenant,material,after?.[0]??null,after?.[1]??null,includeWithdrawn]);
   const page=rows.rows.slice(0,50),last=page.at(-1);return {canReadWithdrawn,items:await Promise.all(page.map(async r=>({...await this.summary(c,tenant,material,r.id),publishedAt:r.stamp as string}))),nextCursor:rows.rows.length>50&&last?`${last.stamp}|${last.id}`:null};
  });
 }
 read(p:CorporatePrincipal,tenant:string,material:string,id:string){
  uuid.parse(id);return this.resources.withMaterial(p,tenant,material,'viewer',async(c,ctx,permission)=>{
   const summary=await this.summary(c,tenant,material,id);if(summary.withdrawn)throw new OrganizationAccessError(404);
   const payload=(await c.query('SELECT payload FROM lanka.publications WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0].payload as Package['payload'];return {...payload,permission:{canCopy:permission.canCopy},hasDependencies:!!(await c.query("SELECT 1 FROM lanka.publication_artifacts WHERE tenant_id=$1 AND publication_id=$2 AND kind='dependencies'",[tenant,id])).rowCount};
  });
 }
 artifact(p:CorporatePrincipal,tenant:string,material:string,id:string,kind:'pdf'|'pptx'|'preview'|'dependencies',page=0){
  uuid.parse(id);z.enum(['pdf','pptx','preview','dependencies']).parse(kind);z.number().int().min(0).max(40).parse(page);
  return this.resources.withMaterial(p,tenant,material,'viewer',async(c)=>{
   if((await this.summary(c,tenant,material,id)).withdrawn)throw new OrganizationAccessError(404);
   const row=(await c.query('SELECT bytes,hash FROM lanka.publication_artifacts WHERE tenant_id=$1 AND publication_id=$2 AND kind=$3 AND page=$4',[tenant,id,kind,page])).rows[0];
   if(!row||hash(row.bytes)!==row.hash)throw new OrganizationAccessError(404);return {bytes:row.bytes as Buffer,hash:row.hash as string};
  });
 }
}
