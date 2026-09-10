import {ancestryIn,permissionIn} from './resource-permission';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {resourceRequest,roleRank,type ResourceRole,type ResourcePermission} from '../../server/resource-access';
import {canonicalJson} from '../../domain/canonical-json';
import {PostgresOrganizationAccess} from './organization-access';
const id=z.string().uuid(),hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

/** ACL engine; document/project contents require their own visibility projection after this check. */
export class PostgresResourceAccess {
 constructor(readonly organizations:PostgresOrganizationAccess) {}
 /** Caller holds withTenant's shared/exclusive authorization lock. Never call with a browser-supplied context. */
 ancestryIn=ancestryIn;
 permissionIn=permissionIn;
 withResource<T>(p:BrowserPrincipal,tenantId:string,resourceId:string,minimum:ResourceRole,fn:(c:PoolClient,ctx:OrganizationContext,permission:ResourcePermission)=>Promise<T>) {
  return this.organizations.withTenant(p,tenantId,async(c,ctx)=>fn(c,ctx,await this.permissionIn(c,ctx,resourceId,minimum)));
 }
 withMaterial<T>(p:CorporatePrincipal,tenantId:string,materialId:string,minimum:ResourceRole,fn:(c:PoolClient,ctx:OrganizationContext,permission:ResourcePermission)=>Promise<T>,scope?:{capability?:'propose';write?:boolean}) {
  id.parse(materialId);
  if(p.kind==="delegated"&&!(["viewer","commenter"] as string[]).includes(minimum)&&!(minimum==="editor"&&scope?.capability==="propose"))throw new OrganizationAccessError(403,"Операция вне области доступа агента.");
  return this.organizations.withTenant(p,tenantId,async(c,ctx)=>{
   const node=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenantId,materialId]);
   if(!node.rowCount)throw new OrganizationAccessError(404);
   let permission=await this.permissionIn(c,ctx,node.rows[0].id,minimum);
   if(ctx.delegation)permission={...permission,canPropose:ctx.delegation.capabilities.includes('propose')&&roleRank[permission.role]>=3,role:ctx.delegation.capabilities.includes('comment')&&roleRank[permission.role]>=2?'commenter':'viewer',canCopy:ctx.delegation.capabilities.includes('create')&&permission.canCopy,sources:[]};
   return fn(c,ctx,permission);
  },false,{documentId:materialId,write:scope?.write,capability:scope?.capability??(minimum==='viewer'?'read':'comment')});
 }
 inspect(p:BrowserPrincipal,tenantId:string,resourceId:string) {
  return this.withResource(p,tenantId,resourceId,'viewer',async(c,ctx,permission)=>{
   if(permission.role!=='manager')return {permission};
   const grants=await c.query('SELECT principal_id AS "principalId",group_id AS "groupId",role,can_copy AS "canCopy" FROM lanka.acl_grants WHERE tenant_id=$1 AND resource_id=$2 ORDER BY principal_id,group_id',[ctx.tenantId,resourceId]);
   return {permission,grants:grants.rows};
  });
 }
 async mutate(p:BrowserPrincipal,tenantId:string,input:unknown) {
  const request=resourceRequest.parse(input),command=request.command;
  return this.organizations.withTenant(p,tenantId,async(c,ctx)=>{
   // Current authority is checked before idempotent replay, including after self-revocation.
   const node='resourceId' in command?await this.permissionIn(c,ctx,command.resourceId,'manager'):null;
   if(command.action==='inheritance'&&command.inheritance==='inherit'&&node?.parentFolderId)await this.permissionIn(c,ctx,node.parentFolderId,'manager');
   if(!node&&ctx.role==='member')throw new OrganizationAccessError(403);
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenantId,ctx.principalId,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==hash(command))throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');return prior.rows[0].result as {authzEpoch:string};}
   if(request.expectedEpoch!==undefined&&request.expectedEpoch!==ctx.authzEpoch)throw new OrganizationAccessError(409,'Права изменились. Обновите список и подтвердите действие заново.');
   if(command.action==='grant') {
    const s=command.subject;
    if(s.kind==='principal') {
     const target=await c.query(`SELECT 1 FROM lanka.principals p JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
      JOIN lanka.auth_identities i ON i.id=p.user_id WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='active' AND m.status='active' AND NOT i.disabled`,[tenantId,s.id]);
     if(!target.rowCount&&command.role!==null)throw new OrganizationAccessError(404);
     // Owner authority is an invariant, not an ordinary grant that a delegated manager can remove.
     if(s.id===node!.ownerId)throw new OrganizationAccessError(409,'Права владельца меняются только при передаче владения.');
    }else {
     const target=await c.query("SELECT 1 FROM lanka.groups WHERE tenant_id=$1 AND id=$2 AND status='active'",[tenantId,s.id]);
     if(!target.rowCount&&command.role!==null)throw new OrganizationAccessError(404);
    }
    const column=s.kind==='principal'?'principal_id':'group_id';
    await c.query(`DELETE FROM lanka.acl_grants WHERE tenant_id=$1 AND resource_id=$2 AND ${column}=$3`,[tenantId,command.resourceId,s.id]);
    if(command.role!==null)await c.query(`INSERT INTO lanka.acl_grants(tenant_id,resource_id,${column},role,can_copy) VALUES($1,$2,$3,$4,$5)`,[tenantId,command.resourceId,s.id,command.role,command.canCopy]);
   }else if(command.action==='inheritance') {
    await c.query('UPDATE lanka.resource_nodes SET inheritance=$3 WHERE tenant_id=$1 AND id=$2',[tenantId,command.resourceId,command.inheritance]);
   }else if(command.action==='move') {
    const target=command.parentFolderId?await this.permissionIn(c,ctx,command.parentFolderId,'manager'):null;
    if(target&&target.kind!=='folder')throw new OrganizationAccessError(409,'Нужна папка назначения.');
    if(node!.parentFolderId)await this.permissionIn(c,ctx,node!.parentFolderId,'manager');
    if(node!.kind==='folder') {
     const descendants=await c.query('SELECT descendant_id,depth FROM lanka.folder_closure WHERE tenant_id=$1 AND ancestor_id=$2',[tenantId,node!.resourceId]);
     if(!descendants.rowCount||descendants.rows.some(d=>d.descendant_id===command.parentFolderId))throw new OrganizationAccessError(409,'Папку нельзя переместить внутрь себя.');
     if(target){const above=await c.query('SELECT max(depth) AS depth FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=$2',[tenantId,target.resourceId]);
      if(Number(above.rows[0].depth)+1+Math.max(...descendants.rows.map(d=>d.depth))>64)throw new OrganizationAccessError(409,'Слишком глубокое дерево папок.');}
     const subtree=descendants.rows.map(d=>d.descendant_id);
     await c.query('DELETE FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=ANY($2::uuid[]) AND NOT ancestor_id=ANY($2::uuid[])',[tenantId,subtree]);
     if(target)await c.query(`INSERT INTO lanka.folder_closure(tenant_id,ancestor_id,descendant_id,depth)
      SELECT $1,a.ancestor_id,d.descendant_id,a.depth+d.depth+1 FROM lanka.folder_closure a CROSS JOIN lanka.folder_closure d
      WHERE a.tenant_id=$1 AND d.tenant_id=$1 AND a.descendant_id=$2 AND d.ancestor_id=$3`,[tenantId,target.resourceId,node!.resourceId]);
    }else {
     // Legacy personal catalogue pointer is a compatibility view; resource parent remains canonical.
     await c.query('UPDATE lanka.materials SET folder_id=$3 WHERE tenant_id=$1 AND id=$2',[tenantId,node!.materialId,target?.ownerId===node!.ownerId?target.folderId:null]);
    }
    await c.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[tenantId,node!.resourceId,command.parentFolderId]);
   }else if(command.action==='group_set') {
    await c.query(`INSERT INTO lanka.groups(tenant_id,id,name,status) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status`,[tenantId,command.id,command.name,command.status]);
   }else if(command.action==='group_member') {
    const group=await c.query('SELECT 1 FROM lanka.groups WHERE tenant_id=$1 AND id=$2',[tenantId,command.groupId]);if(!group.rowCount)throw new OrganizationAccessError(404);
    if(command.present) {
     const target=await c.query(`SELECT 1 FROM lanka.principals p JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
      JOIN lanka.auth_identities i ON i.id=p.user_id WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='active' AND m.status='active' AND NOT i.disabled`,[tenantId,command.principalId]);
     if(!target.rowCount)throw new OrganizationAccessError(404);
     await c.query('INSERT INTO lanka.group_members(tenant_id,group_id,principal_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[tenantId,command.groupId,command.principalId]);
    }else await c.query('DELETE FROM lanka.group_members WHERE tenant_id=$1 AND group_id=$2 AND principal_id=$3',[tenantId,command.groupId,command.principalId]);
   }
   const epoch=await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1 RETURNING authz_epoch',[tenantId]),result={authzEpoch:String(epoch.rows[0].authz_epoch)};
   await c.query('INSERT INTO lanka.resource_audit(tenant_id,sequence,actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,result.authzEpoch,ctx.principalId,command.action,node?.resourceId??null,JSON.stringify(command)]);
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenantId,ctx.principalId,request.requestId,hash(command),JSON.stringify(result)]);
   return result;
  },true);
 }
}
