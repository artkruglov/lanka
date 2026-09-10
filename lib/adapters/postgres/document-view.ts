import {exportCapabilities} from '../../project/export-capabilities';
import {reactionsIn} from './document-reactions';
import {sharedFoldersIn} from './shared-folders';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {documentView,viewAssetIds} from '../../project/document-view';
import type {FolderProject} from '../../project/package';
import {PostgresResourceAccess} from './resource-access';
import type {SharedLibrary} from '../../project/shared-library';

/** Current shared content only. Full project/history/proposals still require the owner's repository. */
export class OrganizationDocumentView {
 constructor(private resources:PostgresResourceAccess) {}
 async list(p:CorporatePrincipal,tenant:string,options:{search?:string;cursor?:string;folderResourceId?:string;bookmarked?:boolean}={},includeOwn=false):Promise<SharedLibrary> {
  const filter=z.object({search:z.string().trim().max(140).default(''),cursor:z.string().max(100).optional(),folderResourceId:z.string().uuid().optional(),bookmarked:z.boolean().default(false)}).strict().parse(options);
  // A value cursor survives revocation/deletion of the previous page's last document.
  // Preserve PostgreSQL microseconds; a JS Date would truncate them and skip nearby rows.
  const cursor=filter.cursor?z.tuple([z.string().datetime({precision:6}),z.string().uuid()]).parse(filter.cursor.split('|')):null;
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(filter.bookmarked&&ctx.delegation)throw new OrganizationAccessError(403,'Личное избранное недоступно агенту.');
   let folder:SharedLibrary['folder']=null;
   if(filter.folderResourceId){
    const permission=await this.resources.permissionIn(c,ctx,filter.folderResourceId);
    if(permission.kind!=='folder')throw new OrganizationAccessError(404);
    const names=await c.query('SELECT name FROM lanka.catalog_folders WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[tenant,permission.ownerId,permission.folderId]);
    if(!names.rowCount)throw new OrganizationAccessError(404);
    folder={id:permission.resourceId,name:names.rows[0].name,role:permission.role};
   }
   const result=await c.query(`WITH RECURSIVE
    nodes AS MATERIALIZED (SELECT * FROM lanka.resource_nodes WHERE tenant_id=$1 AND deleted_at IS NULL),
    scoped(id) AS (
     SELECT id FROM nodes WHERE id=$7::uuid
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
    SELECT m.id,n.id AS resource_id,m.project->>'title' AS title,m.project#>>'{state,revision}' AS revision,
     to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM lanka.materials m JOIN nodes n ON n.material_id=m.id AND n.owner_id=m.owner_id
    JOIN reachable r ON r.id=n.id JOIN healthy h ON h.id=n.id
    WHERE ($7::uuid IS NULL OR n.id IN (SELECT id FROM scoped)) AND m.tenant_id=$1 AND ($6 OR m.owner_id<>$2) AND NOT m.trashed
     AND ($8::uuid IS NULL OR n.parent_folder_id=$8)
     AND (NOT $9 OR EXISTS(SELECT 1 FROM lanka.document_reactions dr WHERE dr.tenant_id=$1 AND dr.material_id=m.id AND dr.principal_id=$2 AND dr.kind='bookmark'))
     AND m.project#>>'{state,doc,id}'=m.id::text
     AND strpos(lower((m.project->>'title') COLLATE "und-x-icu"),lower($3 COLLATE "und-x-icu"))>0
     AND ($4::timestamptz IS NULL OR (m.updated_at,m.id)<($4::timestamptz,$5::uuid))
    ORDER BY m.updated_at DESC,m.id DESC LIMIT 51`,[tenant,ctx.principalId,filter.search,cursor?.[0]??null,cursor?.[1]??null,includeOwn||!!filter.folderResourceId||filter.bookmarked,ctx.delegation?.folderResourceId??null,filter.folderResourceId??null,filter.bookmarked]);
   const documents:SharedLibrary['documents']=[];
   for(const row of result.rows.slice(0,50)) {
    // Candidate traversal does not replace the canonical permission engine. Recheck
    // every returned item under the same tenant lock used by grant/revoke/moves.
    const permission=await this.resources.permissionIn(c,ctx,row.resource_id);
    const revision=Number(row.revision);
    if(!Number.isSafeInteger(revision)||revision<1||typeof row.title!=='string')throw Error('Invalid shared catalogue entry');
    documents.push({id:row.id,title:row.title,revision,updatedAt:row.updated_at,role:permission.role,...(!ctx.delegation?{reactions:await reactionsIn(c,tenant,row.id,ctx.principalId)}:{})});
   }
   const last=documents.at(-1);
   return {format:'lanka-shared-library/v1',folders:await sharedFoldersIn(c,ctx,!!filter.folderResourceId),folder,documents,nextCursor:result.rows.length>50&&last?`${last.updatedAt}|${last.id}`:null};
  },false,{workspace:true,capability:'read'});
 }
 private using<T>(p:CorporatePrincipal,tenant:string,id:string,fn:(view:ReturnType<typeof documentView>,project:FolderProject,c:import('pg').PoolClient)=>Promise<T>,firstOnly=false) {
  return this.resources.withMaterial(p,tenant,id,'viewer',async(c,ctx,permission)=>{
   const result=await c.query('SELECT project,owner_id FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND NOT trashed FOR SHARE',[tenant,id]);
   const row=result.rows[0];if(!row||row.owner_id!==permission.ownerId)throw new OrganizationAccessError(404);
   const project=row.project as FolderProject;
   if(project.state.doc.id!==id||!Number.isSafeInteger(project.state.revision)||project.state.revision<1)throw Error('Invalid current document');
   const view=documentView(project,{role:permission.role,canCopy:permission.canCopy,isOwner:!ctx.delegation&&ctx.principalId===row.owner_id},{firstOnly});
   return fn(view,project,c);
  });
 }
 cover(p:CorporatePrincipal,tenant:string,id:string,expectedRevision:number){
  z.number().int().positive().parse(expectedRevision);
  return this.using(p,tenant,id,async view=>{
   if(view.revision!==expectedRevision)throw new OrganizationAccessError(409,'Презентация изменилась. Обновите список.');
   const slide=view.slides[0];return {format:'lanka-document-cover/v1' as const,id:view.id,title:view.title,revision:view.revision,width:view.width,height:view.height,slide:slide?{id:slide.id,label:slide.label,items:slide.items}:null};
  },true);
 }
 exportPlan(p:CorporatePrincipal,tenant:string,id:string,expectedRevision:number,format:'pdf'|'pptx'){
  return this.using(p,tenant,id,async(view,project)=>{
   if(view.revision!==expectedRevision)throw new OrganizationAccessError(409,'Версия изменилась. Прочитайте документ заново.');
   return {documentId:id,revision:view.revision,format,artifactCreated:false,capabilities:exportCapabilities(project.state.doc,format),limitations:format==='pptx'?['Fonts are not embedded.','External editors may change font metrics and layout.','This is a render plan, not proof a file was exported.']:['PDF content does not preserve editable chart or table data.','This is a render plan, not proof a file was exported.']};
  });
 }
 read(p:CorporatePrincipal,tenant:string,id:string){return this.using(p,tenant,id,async view=>view);}
 asset(p:CorporatePrincipal,tenant:string,id:string,sourceId:string,revision:number) {
  z.string().min(1).max(80).parse(sourceId);z.number().int().positive().parse(revision);
  return this.using(p,tenant,id,async(view,project,c)=>{
   if(view.revision!==revision)throw new OrganizationAccessError(409,'Презентация изменилась. Откройте текущую версию.');
   if(!viewAssetIds(view).has(sourceId))throw new OrganizationAccessError(404);
   const sources=project.state.sources.filter(s=>s.id===sourceId),source=sources[0];
   if(sources.length!==1||source.kind!=='image'||!['image/png','image/jpeg'].includes(source.contentType)||!/^([a-f0-9]{64})$/.test(source.sha256))throw new OrganizationAccessError(404);
   const result=await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[tenant,id,`materials/${source.sha256}.bin`]);
   const bytes=result.rows[0]?.bytes as Buffer|undefined;
   if(!bytes||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new OrganizationAccessError(404);
   return {bytes,contentType:source.contentType};
  });
 }
}
