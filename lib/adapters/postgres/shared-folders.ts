import type {PoolClient} from 'pg';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {permissionIn} from './resource-permission';
/** Readable shared-folder metadata; resource IDs disambiguate equal legacy IDs belonging to different owners. */
export async function sharedFoldersIn(c:PoolClient,ctx:OrganizationContext,includeOwn=false){
 const rows=await c.query(`WITH RECURSIVE nodes AS MATERIALIZED (SELECT * FROM lanka.resource_nodes WHERE tenant_id=$1 AND deleted_at IS NULL),
 reachable(id) AS (
  SELECT n.id FROM nodes n WHERE n.owner_id=$2 OR EXISTS(SELECT 1 FROM lanka.acl_grants a WHERE a.tenant_id=$1 AND a.resource_id=n.id AND (a.principal_id=$2 OR a.group_id IN(SELECT g.id FROM lanka.groups g JOIN lanka.group_members m ON m.tenant_id=g.tenant_id AND m.group_id=g.id WHERE g.tenant_id=$1 AND g.status='active' AND m.principal_id=$2)))
  UNION SELECT n.id FROM nodes n JOIN reachable r ON n.parent_folder_id=r.id WHERE n.inheritance='inherit'
 ), healthy(id,depth) AS (
  SELECT id,0 FROM nodes WHERE parent_folder_id IS NULL UNION ALL SELECT n.id,h.depth+1 FROM nodes n JOIN healthy h ON n.parent_folder_id=h.id WHERE h.depth<65
 ), visible AS (
  SELECT n.id,f.name,n.parent_folder_id FROM nodes n JOIN lanka.catalog_folders f ON f.tenant_id=n.tenant_id AND f.owner_id=n.owner_id AND f.id=n.folder_id JOIN reachable r ON r.id=n.id JOIN healthy h ON h.id=n.id
  WHERE ($4::boolean OR n.owner_id<>$2) AND ($3::uuid IS NULL OR n.id=$3 OR n.id IN(SELECT descendant_id FROM lanka.folder_closure WHERE tenant_id=$1 AND ancestor_id=$3))
 ) SELECT v.id,v.name,p.id AS "parentId" FROM visible v LEFT JOIN visible p ON p.id=v.parent_folder_id ORDER BY v.name,v.id`,[ctx.tenantId,ctx.principalId,ctx.delegation?.folderResourceId??null,includeOwn]);
 const result=[];for(const row of rows.rows)try{const p=await permissionIn(c,ctx,row.id);result.push({id:row.id,resourceId:row.id,name:row.name as string,parentId:row.parentId as string|null,role:p.role});}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}
 return result;
}
