import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {resourceRole,type ResourcePermission} from '../../server/resource-access';
import type {DocumentSharing,ShareEntry,ShareSearch,ShareSubject} from '../../project/document-sharing';
import {PostgresResourceAccess} from './resource-access';

const requestSchema=z.object({requestId:z.string().uuid(),expectedEpoch:z.string().regex(/^\d+$/).max(30),
 subject:z.object({kind:z.enum(['principal','group']),id:z.string().uuid()}).strict(),role:resourceRole.nullable(),canCopy:z.boolean()}).strict();
const activePeople=`SELECT p.id,i.display_name AS name FROM lanka.principals p
 JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
 JOIN lanka.auth_identities i ON i.id=p.user_id
 WHERE p.tenant_id=$1 AND p.status='active' AND m.status='active' AND NOT i.disabled`;

/** Only managers of the selected document or folder can inspect its audience or search recipients. */
export class OrganizationDocumentSharing {
 constructor(private resources:PostgresResourceAccess,private kind:'material'|'folder'='material') {}
 private using<T>(p:BrowserPrincipal,tenant:string,document:string,fn:(c:PoolClient,ctx:OrganizationContext,permission:ResourcePermission)=>Promise<T>) {
  if(this.kind==='folder')return this.resources.withResource(p,tenant,document,'manager',async(c,ctx,permission)=>{
   if(ctx.delegation||permission.kind!=='folder')throw new OrganizationAccessError(403);
   return fn(c,ctx,permission);
  });
  return this.resources.withMaterial(p,tenant,document,'manager',async(c,ctx,permission)=>{
   const row=await c.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed',[tenant,document,permission.ownerId]);
   if(!row.rowCount)throw new OrganizationAccessError(404);
   return fn(c,ctx,permission);
  });
 }
 read(p:BrowserPrincipal,tenant:string,document:string,previewInheritance?:'inherit'|'restricted'):Promise<DocumentSharing> {
  return this.using(p,tenant,document,async(c,ctx,permission)=>{
   let canInherit=false;
   if(permission.parentFolderId)try{await this.resources.permissionIn(c,ctx,permission.parentFolderId,'manager');canInherit=true;}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}
   if(previewInheritance&&(!permission.parentFolderId||previewInheritance==='inherit'&&!canInherit))throw new OrganizationAccessError(403,'Для наследования нужны права управления папкой.');
   const ancestry=await this.resources.ancestryIn(c,ctx,permission.resourceId);let eligible=true;
   const nodes=ancestry.filter((node,index)=>{const include=eligible;eligible=eligible&&(index===0?(previewInheritance??node.inheritance):node.inheritance)==='inherit';return include;}),ids=nodes.map(n=>n.id);
   const subjects=await c.query(`WITH active_people AS (${activePeople})
    SELECT a.resource_id,a.role,a.can_copy,COALESCE(a.principal_id,a.group_id) AS id,
     CASE WHEN a.principal_id IS NULL THEN 'group' ELSE 'principal' END AS kind,
     COALESCE(i.display_name,g.name,'Участник недоступен') AS name,
     CASE WHEN a.principal_id IS NULL THEN g.status='active' ELSE ap.id IS NOT NULL END AS active,
     CASE WHEN a.group_id IS NOT NULL THEN (SELECT count(*)::int FROM lanka.group_members gm JOIN active_people x ON x.id=gm.principal_id WHERE gm.tenant_id=$1 AND gm.group_id=a.group_id) END AS member_count
    FROM lanka.acl_grants a LEFT JOIN lanka.principals p ON p.tenant_id=a.tenant_id AND p.id=a.principal_id
    LEFT JOIN lanka.auth_identities i ON i.id=p.user_id LEFT JOIN active_people ap ON ap.id=a.principal_id
    LEFT JOIN lanka.groups g ON g.tenant_id=a.tenant_id AND g.id=a.group_id
    WHERE a.tenant_id=$1 AND a.resource_id=ANY($2::uuid[]) ORDER BY name,a.resource_id,id`,[tenant,ids]);
   const owners=await c.query(`WITH active_people AS (${activePeople}) SELECT n.id AS resource_id,n.owner_id,i.display_name AS name,ap.id IS NOT NULL AS active
    FROM lanka.resource_nodes n JOIN lanka.principals p ON p.tenant_id=n.tenant_id AND p.id=n.owner_id
    JOIN lanka.auth_identities i ON i.id=p.user_id LEFT JOIN active_people ap ON ap.id=n.owner_id
    WHERE n.tenant_id=$1 AND n.id=ANY($2::uuid[]) ORDER BY n.id`,[tenant,ids]);
   const entries:ShareEntry[]=[...owners.rows.map(r=>({resourceId:r.resource_id,subject:{kind:'principal' as const,id:r.owner_id,name:r.name||'Участник',active:r.active},role:'manager' as const,canCopy:true,origin:r.resource_id===permission.resourceId?'owner' as const:'folder' as const})),
    ...subjects.rows.map(r=>({resourceId:r.resource_id,subject:{kind:r.kind,id:r.id,name:r.name,active:!!r.active,...(r.kind==='group'?{memberCount:r.member_count}: {})},role:r.role,canCopy:r.can_copy,origin:r.resource_id===permission.resourceId?'direct' as const:'folder' as const}))];
   // Expand groups and aggregate every active person before limiting the display page.
   const audience=await c.query(`WITH active_people AS (${activePeople}), sources AS (
    SELECT n.owner_id AS id,4 AS rank,true AS can_copy FROM lanka.resource_nodes n WHERE n.tenant_id=$1 AND n.id=ANY($2::uuid[])
    UNION ALL SELECT COALESCE(a.principal_id,gm.principal_id),CASE a.role WHEN 'manager' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END,a.can_copy
    FROM lanka.acl_grants a LEFT JOIN lanka.groups g ON g.tenant_id=a.tenant_id AND g.id=a.group_id AND g.status='active'
    LEFT JOIN lanka.group_members gm ON gm.tenant_id=g.tenant_id AND gm.group_id=g.id
    WHERE a.tenant_id=$1 AND a.resource_id=ANY($2::uuid[])
   ), people AS (SELECT p.id,p.name,max(s.rank) AS rank,bool_or(s.can_copy) AS can_copy FROM active_people p JOIN sources s ON s.id=p.id GROUP BY p.id,p.name)
   SELECT *,count(*) OVER()::int AS total FROM people ORDER BY name,id LIMIT 100`,[tenant,ids]);
   return {format:'lanka-document-sharing/v1',authzEpoch:ctx.authzEpoch,inheritance:{mode:previewInheritance??permission.inheritance,hasParent:!!permission.parentFolderId,canInherit},entries,
    audience:audience.rows.map(r=>({id:r.id,name:r.name||'Участник',role:resourceRole.options[r.rank-1],canCopy:r.can_copy})),audienceCount:audience.rows[0]?.total??0};
  });
 }
 search(p:BrowserPrincipal,tenant:string,document:string,search:string):Promise<ShareSearch> {
  const q=z.string().trim().min(2).max(140).parse(search);
  return this.using(p,tenant,document,async(c,ctx,permission)=>{
   const result=await c.query(`WITH active_people AS (${activePeople}), subjects AS (
    SELECT 'principal' AS kind,id,COALESCE(name,'Участник') AS name,NULL::int AS member_count FROM active_people WHERE id<>$3
    UNION ALL SELECT 'group',g.id,g.name,(SELECT count(*)::int FROM lanka.group_members gm JOIN active_people p ON p.id=gm.principal_id WHERE gm.tenant_id=$1 AND gm.group_id=g.id)
    FROM lanka.groups g WHERE g.tenant_id=$1 AND g.status='active'
   ) SELECT * FROM subjects WHERE strpos(lower(name COLLATE "und-x-icu"),lower($2 COLLATE "und-x-icu"))>0 ORDER BY name,kind,id LIMIT 21`,[tenant,q,permission.ownerId]);
   return {authzEpoch:ctx.authzEpoch,subjects:result.rows.slice(0,20).map(r=>({kind:r.kind,id:r.id,name:r.name,active:true,...(r.kind==='group'?{memberCount:r.member_count}:{})}) as ShareSubject),hasMore:result.rows.length>20};
  });
 }
 async change(p:BrowserPrincipal,tenant:string,document:string,input:unknown) {
  if(input&&typeof input==='object'&&'action' in input&&input.action==='inheritance'){
   const request=z.object({action:z.literal('inheritance'),requestId:z.string().uuid(),expectedEpoch:z.string().regex(/^\d+$/).max(30),inheritance:z.enum(['inherit','restricted'])}).strict().parse(input);
   const resourceId=await this.using(p,tenant,document,async(c,ctx,permission)=>{
    if(!permission.parentFolderId)throw new OrganizationAccessError(409,'Сначала переместите документ или папку в родительскую папку.');return permission.resourceId;
   });
   return this.resources.mutate(p,tenant,{requestId:request.requestId,expectedEpoch:request.expectedEpoch,command:{action:'inheritance',resourceId,inheritance:request.inheritance}});
  }
  const request=requestSchema.parse(input);
  const resourceId=await this.using(p,tenant,document,async(c,ctx,permission)=>permission.resourceId);
  // Resolve ID from the URL; mutate rechecks authority and the reviewed epoch under an exclusive lock.
  return this.resources.mutate(p,tenant,{requestId:request.requestId,expectedEpoch:request.expectedEpoch,
   command:{action:'grant',resourceId,subject:request.subject,role:request.role,canCopy:request.canCopy}});
 }
}
