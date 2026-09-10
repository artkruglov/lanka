import type {PoolClient} from 'pg';
import type {OrganizationContext} from '../../server/organization-access';
/** Own folder metadata only; absent/foreign parents are not exposed. Caller holds the tenant lock. */
export async function libraryFoldersIn(c:PoolClient,ctx:OrganizationContext){
 const result=await c.query<{id:string;name:string;resourceId:string;parentId:string|null}>(`WITH RECURSIVE healthy AS (
  SELECT n.*,0 AS depth FROM lanka.resource_nodes n WHERE tenant_id=$1 AND parent_folder_id IS NULL AND deleted_at IS NULL
  UNION ALL SELECT n.*,h.depth+1 FROM lanka.resource_nodes n JOIN healthy h ON n.tenant_id=h.tenant_id AND n.parent_folder_id=h.id WHERE n.deleted_at IS NULL AND h.depth<65
 ), own AS (
  SELECT f.id,f.name,n.id AS resource_id,n.parent_folder_id FROM lanka.catalog_folders f JOIN healthy n ON n.folder_id=f.id AND n.owner_id=f.owner_id
  WHERE f.tenant_id=$1 AND f.owner_id=$2 AND ($3::uuid IS NULL OR n.id=$3 OR n.id IN (SELECT descendant_id FROM lanka.folder_closure WHERE tenant_id=$1 AND ancestor_id=$3))
 ) SELECT f.id,f.name,f.resource_id AS "resourceId",p.id AS "parentId" FROM own f LEFT JOIN own p ON p.resource_id=f.parent_folder_id ORDER BY f.name,f.id`,[ctx.tenantId,ctx.principalId,ctx.delegation?.folderResourceId??null]);
 return result.rows;
}
