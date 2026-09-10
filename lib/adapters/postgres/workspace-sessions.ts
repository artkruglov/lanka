import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
import {PostgresResourceAccess} from './resource-access';
const uuid=z.string().uuid();
/** Private workspace-session persistence. No credential binding or inference is implied. */
export class WorkspaceSessions {
 constructor(private resources:PostgresResourceAccess){}
 async ownedIn(c:PoolClient,ctx:OrganizationContext,id:string){
  uuid.parse(id);
  const r=await c.query("SELECT id,title,scope_kind,folder_resource_id,creation_fingerprint FROM lanka.agent_sessions WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND scope_kind IN ('workspace','folder')",[ctx.tenantId,ctx.principalId,id]);
  if(!r.rowCount)throw new OrganizationAccessError(404);const row=r.rows[0];
  if(row.folder_resource_id){const folder=await this.resources.permissionIn(c,ctx,row.folder_resource_id);if(folder.kind!=='folder')throw new OrganizationAccessError(404);}
  return row;
 }
 create(p:BrowserPrincipal,tenant:string,input:unknown){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);
  const request=z.object({requestId:uuid,title:z.string().trim().min(1).max(140),folderResourceId:uuid.nullable().default(null)}).strict().parse(input);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':'+ctx.principalId]);
   if(request.folderResourceId){const folder=await this.resources.permissionIn(c,ctx,request.folderResourceId);if(folder.kind!=='folder')throw new OrganizationAccessError(409,'Выберите папку.');}
   const fingerprint=createHash('sha256').update(canonicalJson(request)).digest('hex');
   const prior=await c.query('SELECT owner_id,creation_fingerprint FROM lanka.agent_sessions WHERE tenant_id=$1 AND id=$2',[tenant,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].owner_id!==ctx.principalId)throw new OrganizationAccessError(404);if(prior.rows[0].creation_fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другой беседы.');return {id:request.requestId};}
   // This disabled connection cannot be picked up by the installed Codex worker.
   await c.query("INSERT INTO lanka.agent_connections(tenant_id,owner_id,id,enabled) VALUES($1,$2,'external-mcp',false) ON CONFLICT DO NOTHING",[tenant,ctx.principalId]);
   await c.query("INSERT INTO lanka.agent_sessions(tenant_id,id,owner_id,material_id,connection_id,scope_kind,folder_resource_id,title,creation_fingerprint) VALUES($1,$2,$3,NULL,'external-mcp',$4,$5,$6,$7)",[tenant,request.requestId,ctx.principalId,request.folderResourceId?'folder':'workspace',request.folderResourceId,request.title,fingerprint]);
   return {id:request.requestId};
  });
 }
 link(p:BrowserPrincipal,tenant:string,sessionId:string,materialId:string){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);uuid.parse(materialId);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   const session=await this.ownedIn(c,ctx,sessionId);
   const n=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,materialId]);if(!n.rowCount)throw new OrganizationAccessError(404);
   await this.resources.permissionIn(c,ctx,n.rows[0].id);
   if(session.folder_resource_id&&!(await this.resources.ancestryIn(c,ctx,n.rows[0].id)).some(n=>n.id===session.folder_resource_id))throw new OrganizationAccessError(403,'Документ вне папки беседы.');
   await c.query('INSERT INTO lanka.agent_session_materials(tenant_id,session_id,material_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenant,sessionId,materialId]);
   return {sessionId,materialId};
  });
 }
 read(p:BrowserPrincipal,tenant:string,sessionId:string){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);
  return this.resources.organizations.withTenant(p,tenant,(c,ctx)=>this.readIn(c,ctx,sessionId));
 }
 /** Internal: caller must authenticate and authorize conversation access first. */
 async readIn(c:PoolClient,ctx:OrganizationContext,sessionId:string){
   const tenant=ctx.tenantId;
   const session=await this.ownedIn(c,ctx,sessionId),rows=await c.query(`SELECT m.id,m.project->>'title' AS title,m.project#>>'{state,revision}' AS revision,n.id AS resource_id FROM lanka.agent_session_materials a JOIN lanka.materials m ON m.tenant_id=a.tenant_id AND m.id=a.material_id LEFT JOIN lanka.resource_nodes n ON n.tenant_id=m.tenant_id AND n.material_id=m.id WHERE a.tenant_id=$1 AND a.session_id=$2 ORDER BY a.created_at,a.material_id`,[tenant,sessionId]);
   const documents:{id:string;title:string;revision:number}[]=[];let unavailableDocumentCount=0;
   for(const row of rows.rows){try{
    if(!row.resource_id)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,row.resource_id);
    if(session.folder_resource_id&&!(await this.resources.ancestryIn(c,ctx,row.resource_id)).some(n=>n.id===session.folder_resource_id))throw new OrganizationAccessError(404);
    documents.push({id:row.id,title:row.title,revision:Number(row.revision)});
   }catch(e){if(e instanceof OrganizationAccessError&&(e.status===403||e.status===404))unavailableDocumentCount++;else throw e;}}
   const binding=await c.query(`SELECT d.revoked_at IS NULL AND d.expires_at>now() AND d.auth_epoch=i.auth_epoch AND NOT i.disabled AS active FROM lanka.agent_bindings b JOIN lanka.agent_delegations d ON d.tenant_id=b.tenant_id AND d.id=b.delegation_id JOIN lanka.auth_identities i ON i.id=$3 WHERE b.tenant_id=$1 AND b.session_id=$2`,[tenant,sessionId,ctx.userId]);
   return {id:session.id,title:session.title,scope:session.scope_kind,folderResourceId:session.folder_resource_id,documents,unavailableDocumentCount,connectionStatus:binding.rows[0]?.active?'mcp_only':binding.rowCount?'unavailable':'not_bound'};
 }
}
