import {preparePublicationCopy} from '../../project/publication-copy';
import type {PublicationPayload} from '../../project/publication-package';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../../domain/canonical-json';
import {prepareSharedCopy,validateSharedCopy} from '../../project/shared-copy';
import type {FolderProject} from '../../project/package';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
import {usingTransactionDatabase} from './transaction-database';
const uuid=z.string().uuid();
export const sharedCopyInput=z.object({requestId:uuid,sourceDocumentId:uuid,publicationId:uuid.optional(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140),folderId:uuid.nullable()}).strict();
export class OrganizationDocumentCopy{
 constructor(private resources:PostgresResourceAccess,private runtimeRoot:string){}
 copy(p:CorporatePrincipal,tenant:string,input:unknown){
  const request=sharedCopyInput.parse(input),fingerprint=createHash('sha256').update(canonicalJson({operation:'shared-copy',actor:p.kind==='delegated'?p.tokenHash:p.userId,request})).digest('hex');
  return this.resources.organizations.withTenant(p,tenant,(c,ctx)=>usingTransactionDatabase(c,ctx,this.runtimeRoot,db=>db.tx(async()=>{
   const node=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,request.sourceDocumentId]);if(!node.rowCount)throw new OrganizationAccessError(404);
   const permission=await this.resources.permissionIn(c,ctx,node.rows[0].id);if(!permission.canCopy)throw new OrganizationAccessError(403,'Владелец не разрешил копирование этой презентации.');
   if(request.folderId){const dest=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[tenant,ctx.principalId,request.folderId]);if(!dest.rowCount)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,dest.rows[0].id,'manager');if((await this.resources.ancestryIn(c,ctx,dest.rows[0].id)).length>=66)throw new OrganizationAccessError(409,'Достигнута максимальная глубина папок.');}
   else if(ctx.delegation?.folderResourceId)throw new OrganizationAccessError(403,'Выберите папку внутри области подключения.');
   let publication:PublicationPayload|undefined;
   if(request.publicationId){
    const row=(await c.query('SELECT p.payload,p.payload_bytes,p.payload_hash FROM lanka.publications p JOIN lanka.materials m ON m.tenant_id=p.tenant_id AND m.id=p.material_id AND NOT m.trashed WHERE p.tenant_id=$1 AND p.material_id=$2 AND p.id=$3 AND NOT EXISTS(SELECT 1 FROM lanka.publication_withdrawals w WHERE w.tenant_id=p.tenant_id AND w.publication_id=p.id)',[tenant,request.sourceDocumentId,request.publicationId])).rows[0];
    if(!row)throw new OrganizationAccessError(404);
    if(createHash('sha256').update(row.payload_bytes).digest('hex')!==row.payload_hash)throw new OrganizationAccessError(409,'Комплект публикации повреждён.');
    publication=row.payload as PublicationPayload;
    if(publication.origin.revision!==request.expectedRevision)throw new OrganizationAccessError(409,'Выбрана другая версия публикации.');
   }
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,ctx.principalId,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');const target=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,request.requestId]);if(!target.rowCount)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,target.rows[0].id,'manager');return prior.rows[0].result;}
   const used=await c.query('SELECT 1 FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.catalog_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.imported_project_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[tenant,ctx.principalId,request.requestId]);if(used.rowCount)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');
   let copied:{project:FolderProject;blobs:{hash:string;bytes:Buffer}[]};
   if(publication){
    copied={project:preparePublicationCopy(publication,request.requestId,request.title,new Date().toISOString()),blobs:[]};
    let total=0;const seen=new Set<string>();
    for(const source of copied.project.state.sources){
     if(seen.has(source.sha256))continue;seen.add(source.sha256);
     const row=(await c.query('SELECT bytes,content_type FROM lanka.publication_blobs WHERE tenant_id=$1 AND publication_id=$2 AND hash=$3',[tenant,request.publicationId,source.sha256])).rows[0];
     const bytes=row?.bytes as Buffer|undefined;
     if(!bytes||!bytes.length||bytes.length>5_000_000||(total+=bytes.length)>40_000_000||row.content_type!==source.contentType||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new OrganizationAccessError(409,'Файл опубликованной версии недоступен.');
     copied.blobs.push({hash:source.sha256,bytes});
    }
   }else{
   const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed FOR SHARE',[tenant,request.sourceDocumentId,permission.ownerId]);if(!row.rowCount)throw new OrganizationAccessError(404);
   const source=row.rows[0].project as FolderProject;if(source.state.revision!==request.expectedRevision)throw new OrganizationAccessError(409,'Версия изменилась. Обновите презентацию перед копированием.');
   const shared=prepareSharedCopy(source,request.requestId,request.title,tenant,new Date().toISOString());copied=shared;let total=copied.blobs[0].bytes.length;if(total>5_000_000)throw new OrganizationAccessError(409,'Снимок слайдов превышает допустимый размер.');
   for(const [oldId,id] of shared.images){
    const matches=source.state.sources.filter(s=>s.id===oldId),image=matches[0];if(matches.length!==1||image.kind!=='image'||!['image/png','image/jpeg'].includes(image.contentType))throw new OrganizationAccessError(409,'Изображение слайда недоступно.');
    const blob=await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[tenant,request.sourceDocumentId,`materials/${image.sha256}.bin`]);const bytes=blob.rows[0]?.bytes as Buffer|undefined;
    if(!bytes||bytes.length>5_000_000||(total+=bytes.length)>40_000_000||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new OrganizationAccessError(409,'Изображение изменилось или превышен размер копии.');
    copied.blobs.push({hash:image.sha256,bytes});copied.project.state.sources.push({id,name:`Изображение слайда ${id}`,kind:'image',sha256:image.sha256,createdAt:new Date().toISOString(),contentType:image.contentType,excerpt:''});
   }
   }
   validateSharedCopy(copied.project);if(Buffer.byteLength(JSON.stringify(copied.project))>1_500_000)throw new OrganizationAccessError(409,'Копия превышает допустимый размер.');
   await c.query("INSERT INTO lanka.workspace_catalogs(tenant_id,owner_id,origin) VALUES($1,$2,'native') ON CONFLICT DO NOTHING",[tenant,ctx.principalId]);
   const result={id:request.requestId,revision:1,url:`/organizations/${tenant}/documents/${request.requestId}`,sourceDocumentId:request.sourceDocumentId,sourceRevision:request.expectedRevision,...(request.publicationId?{sourcePublicationId:request.publicationId}:{}),privateMaterialsCopied:false};
   await db.createProjectIn(c,request.requestId,copied.project,request.folderId,copied.blobs,{operation:'shared-copy',request},result);
   const epoch=await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1 RETURNING authz_epoch',[tenant]);
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenant,ctx.principalId,request.requestId,fingerprint,JSON.stringify(result)]);
   await c.query('INSERT INTO lanka.resource_audit(tenant_id,sequence,actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[tenant,epoch.rows[0].authz_epoch,ctx.principalId,'document.copy_shared',node.rows[0].id,JSON.stringify({...result,delegationId:ctx.delegation?.id??null})]);return result;
  })),true,{workspace:true,write:true,capability:'create'});
 }
}
