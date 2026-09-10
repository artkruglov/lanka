import {reactionsIn} from './document-reactions';
import {sharedFoldersIn} from './shared-folders';
import {z} from 'zod';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';

/** Discovery filters current authority before LIMIT; publication bytes remain immutable. */
export class PublicationCatalog {
 constructor(private resources:PostgresResourceAccess){}
 list(p:CorporatePrincipal,tenant:string,input:unknown={}) {
  const filter=z.object({search:z.string().trim().max(140).default(''),cursor:z.string().max(100).optional(),folderResourceId:z.string().uuid().optional(),bookmarked:z.boolean().default(false)}).strict().parse(input);
  const cursor=filter.cursor?z.tuple([z.string().datetime({precision:6}),z.string().uuid()]).parse(filter.cursor.split('|')):null;
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(filter.bookmarked&&ctx.delegation)throw new OrganizationAccessError(403,'Личное избранное недоступно агенту.');
   if(filter.folderResourceId){
    const permission=await this.resources.permissionIn(c,ctx,filter.folderResourceId);
    if(permission.kind!=='folder')throw new OrganizationAccessError(404);
   }
   const rows=await c.query(`WITH RECURSIVE
    nodes AS MATERIALIZED (SELECT * FROM lanka.resource_nodes WHERE tenant_id=$1 AND deleted_at IS NULL),
    scoped(id) AS (
     SELECT id FROM nodes WHERE id=$6::uuid
     UNION SELECT n.id FROM nodes n JOIN scoped s ON n.parent_folder_id=s.id
    ),
    reachable(id) AS (
     SELECT n.id FROM nodes n WHERE n.owner_id=$2 OR EXISTS (
      SELECT 1 FROM lanka.acl_grants a WHERE a.tenant_id=$1 AND a.resource_id=n.id AND
       (a.principal_id=$2 OR a.group_id IN (SELECT g.id FROM lanka.groups g
        JOIN lanka.group_members m ON m.tenant_id=g.tenant_id AND m.group_id=g.id
        WHERE g.tenant_id=$1 AND g.status='active' AND m.principal_id=$2)))
     UNION SELECT n.id FROM nodes n JOIN reachable r ON n.parent_folder_id=r.id WHERE n.inheritance='inherit'
    ),
    healthy(id,depth) AS (
     SELECT id,0 FROM nodes WHERE parent_folder_id IS NULL
     UNION ALL SELECT n.id,h.depth+1 FROM nodes n JOIN healthy h ON n.parent_folder_id=h.id WHERE h.depth<65
    )
    SELECT p.id,p.material_id AS "documentId",n.id AS "resourceId",p.source_revision AS revision,
     p.payload_hash AS hash,p.payload#>>'{document,title}' AS title,
     jsonb_array_length(p.payload#>'{document,slides}') AS "slideCount",
     to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAt",
     COALESCE(NULLIF(i.display_name,''),'Участник') AS "publishedBy"
    FROM lanka.publications p
    JOIN lanka.materials m ON m.tenant_id=p.tenant_id AND m.id=p.material_id AND NOT m.trashed
    JOIN nodes n ON n.id=p.resource_id AND n.material_id=m.id AND n.owner_id=m.owner_id
    JOIN reachable r ON r.id=n.id JOIN healthy h ON h.id=n.id
    JOIN lanka.principals author ON author.tenant_id=p.tenant_id AND author.id=p.actor_id
    JOIN lanka.auth_identities i ON i.id=author.user_id
    WHERE p.tenant_id=$1 AND ($6::uuid IS NULL OR n.id IN (SELECT id FROM scoped))
     AND ($7::uuid IS NULL OR n.parent_folder_id=$7)
     AND (NOT $8::boolean OR EXISTS(SELECT 1 FROM lanka.document_reactions d WHERE d.tenant_id=$1 AND d.material_id=p.material_id AND d.principal_id=$2 AND d.kind='bookmark'))
     AND NOT EXISTS(SELECT 1 FROM lanka.publication_withdrawals w WHERE w.tenant_id=p.tenant_id AND w.publication_id=p.id)
     AND strpos(lower((p.payload#>>'{document,title}') COLLATE "und-x-icu"),lower($3 COLLATE "und-x-icu"))>0
     AND ($4::timestamptz IS NULL OR (p.created_at,p.id)<($4::timestamptz,$5::uuid))
    ORDER BY p.created_at DESC,p.id DESC LIMIT 51`,[tenant,ctx.principalId,filter.search,cursor?.[0]??null,cursor?.[1]??null,ctx.delegation?.folderResourceId??null,filter.folderResourceId??null,filter.bookmarked]);
   const items=[],reactions=new Map<string,Awaited<ReturnType<typeof reactionsIn>>>();
   for(const row of rows.rows.slice(0,50)){
    // Grant/revoke/move uses the same tenant lock. Keep the canonical check here.
    const permission=await this.resources.permissionIn(c,ctx,row.resourceId);
    if(!ctx.delegation&&!reactions.has(row.documentId))reactions.set(row.documentId,await reactionsIn(c,tenant,row.documentId,ctx.principalId));
    items.push({...row,...(!ctx.delegation?{reactions:reactions.get(row.documentId)}:{}),revision:Number(row.revision),canCopy:permission.canCopy&&(!ctx.delegation||ctx.delegation.capabilities.includes('create'))});
   }
   const folders=await sharedFoldersIn(c,ctx,true);
   const folder=filter.folderResourceId?folders.find(f=>f.id===filter.folderResourceId):null;
   if(filter.folderResourceId&&!folder)throw new OrganizationAccessError(404);
   const last=items.at(-1);
   return {format:'lanka-publication-catalog/v1',folders,folder:folder??null,items,nextCursor:rows.rows.length>50&&last?`${last.publishedAt}|${last.id}`:null};
  },false,{workspace:true,capability:'read'});
 }
}
