import type {PoolClient} from 'pg';
import {z} from 'zod';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {roleRank,type ResourceRole,type ResourcePermission} from '../../server/resource-access';
const id=z.string().uuid();
type NodeRow={id:string;kind:'folder'|'material';owner_id:string;material_id:string|null;folder_id:string|null;parent_folder_id:string|null;inheritance:'inherit'|'restricted';deleted_at:Date|null;eligible:boolean;depth:number};

export async function ancestryIn(c:PoolClient,ctx:OrganizationContext,resourceId:string) {
  id.parse(resourceId);
  const result=await c.query<NodeRow>(`WITH RECURSIVE ancestry AS (
   SELECT n.*,0 AS depth,true AS eligible,ARRAY[n.id] AS visited FROM lanka.resource_nodes n WHERE tenant_id=$1 AND id=$2
   UNION ALL SELECT p.*,a.depth+1,a.eligible AND a.inheritance='inherit',a.visited||p.id
   FROM ancestry a JOIN lanka.resource_nodes p ON p.tenant_id=a.tenant_id AND p.id=a.parent_folder_id
   WHERE a.depth<65 AND NOT p.id=ANY(a.visited)
  ) SELECT * FROM ancestry ORDER BY depth`,[ctx.tenantId,resourceId]);
  const nodes=result.rows,root=nodes[0];
  // Traverse even beyond restricted boundaries to reject deletion, malformed cycles and excessive depth.
  if(!root||nodes.some(n=>n.deleted_at)||nodes[nodes.length-1].parent_folder_id)throw new OrganizationAccessError(404);
  return nodes;
 }
export async function permissionIn(c:PoolClient,ctx:OrganizationContext,resourceId:string,minimum:ResourceRole='viewer'):Promise<ResourcePermission> {
  const nodes=await ancestryIn(c,ctx,resourceId),root=nodes[0];
  if(ctx.delegation?.folderResourceId&&!nodes.some(n=>n.id===ctx.delegation!.folderResourceId))throw new OrganizationAccessError(404);
  const eligible=nodes.filter(n=>n.eligible),sources:ResourcePermission['sources']=eligible.filter(n=>n.owner_id===ctx.principalId).map(n=>({resourceId:n.id,via:'owner',role:'manager',canCopy:true}));
  const grants=await c.query(`SELECT a.resource_id,a.role,a.can_copy,CASE WHEN a.principal_id IS NOT NULL THEN 'principal' ELSE 'group' END AS via
   FROM lanka.acl_grants a WHERE a.tenant_id=$1 AND a.resource_id=ANY($2::uuid[]) AND
   (a.principal_id=$3 OR a.group_id IN (SELECT g.id FROM lanka.groups g JOIN lanka.group_members m ON m.tenant_id=g.tenant_id AND m.group_id=g.id
    WHERE g.tenant_id=$1 AND g.status='active' AND m.principal_id=$3))`,[ctx.tenantId,eligible.map(n=>n.id),ctx.principalId]);
  for(const g of grants.rows)sources.push({resourceId:g.resource_id,via:g.via,role:g.role,canCopy:g.can_copy});
  const role=sources.reduce<ResourceRole|null>((best,s)=>!best||roleRank[s.role]>roleRank[best]?s.role:best,null);
  if(!role)throw new OrganizationAccessError(404);
  if(roleRank[role]<roleRank[minimum])throw new OrganizationAccessError(403,'Недостаточно прав на ресурс.');
  return {resourceId:root.id,kind:root.kind,ownerId:root.owner_id,materialId:root.material_id,folderId:root.folder_id,parentFolderId:root.parent_folder_id,
   inheritance:root.inheritance,role,canCopy:sources.some(s=>s.canCopy),sources};
 }
