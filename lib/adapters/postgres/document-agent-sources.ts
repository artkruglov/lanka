import type {PoolClient} from 'pg';
import type {FolderProject} from '../../project/package';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import type {OrganizationContext} from '../../server/organization-access';
import {OrganizationAccessError} from '../../server/organization-access';
import {documentSourceText,selectedDocumentSource} from '../../project/document-source-grant';
import {PostgresResourceAccess} from './resource-access';
/** Caller must already hold current document/key authorization in this transaction. */
export async function documentAgentSourcesIn(c:PoolClient,ctx:OrganizationContext,material:string,project:FolderProject){
 if(!ctx.delegation)return [];
 const grants=await c.query('SELECT source_id AS id,sha256,content_hash AS "contentHash",accept_partial AS "acceptPartial" FROM lanka.document_source_grants WHERE tenant_id=$1 AND delegation_id=$2 AND material_id=$3 AND EXISTS(SELECT 1 FROM lanka.materials m WHERE m.tenant_id=$1 AND m.id=$3 AND m.owner_id=$4 AND NOT m.trashed) ORDER BY source_id LIMIT 8',[ctx.tenantId,ctx.delegation.id,material,ctx.principalId]);
 const items=[];
 for(const grant of grants.rows){const source=project.state.sources.find(s=>s.id===grant.id);if(!source)continue;try{items.push(selectedDocumentSource(source,grant));}catch{/* Changed, unsupported or removed consent never reveals new text. */}}
 return items;
}
export class DocumentAgentSources{
 constructor(private resources:PostgresResourceAccess){}
 list(p:CorporatePrincipal,tenant:string,material:string){
  return this.resources.withMaterial(p,tenant,material,'viewer',async(c,ctx,permission)=>{
   const r=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed FOR SHARE',[tenant,material,permission.ownerId]);if(!r.rowCount)throw new OrganizationAccessError(404);
   const project=r.rows[0].project as FolderProject;
   if(ctx.delegation&&permission.ownerId!==ctx.principalId)throw new OrganizationAccessError(403,'Владелец источников изменился.');
   if(ctx.delegation)return {revision:project.state.revision,items:await documentAgentSourcesIn(c,ctx,material,project)};
   if(permission.ownerId!==ctx.principalId)throw new OrganizationAccessError(403,'Источники выбирает владелец документа.');
   const items=[];for(const source of project.state.sources){try{items.push(documentSourceText(source));}catch{}}
   if(items.length>80||Buffer.byteLength(JSON.stringify(items))>256_000)throw new OrganizationAccessError(409,'Слишком много источников для одного запроса.');
   return {revision:project.state.revision,items};
  });
 }
 async read(p:CorporatePrincipal,tenant:string,material:string,id:string){const value=await this.list(p,tenant,material);const item=value.items.find(s=>s.id===id);if(!item)throw new OrganizationAccessError(404,'Источник не разрешён или изменился.');return {revision:value.revision,...item};}
}
