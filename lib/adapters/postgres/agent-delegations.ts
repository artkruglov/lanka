import {documentSourceSelectionSchema,selectedDocumentSource} from '../../project/document-source-grant';
import type {FolderProject} from '../../project/package';
import {sharedFoldersIn} from './shared-folders';
import {libraryFoldersIn} from './library-folders';
import {creationSourcesSchema,readCreationSources} from '../../project/creation-sources';
import {usingTransactionDatabase} from './transaction-database';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {delegatedPrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
const issueSchema=z.object({sourceDocumentId:z.string().uuid().optional(),documentSources:documentSourceSelectionSchema.optional(),expectedRevision:z.number().int().positive().optional(),folderResourceId:z.string().uuid().optional(),folderId:z.string().uuid().optional(),sources:creationSourcesSchema.optional(),requestId:z.string().uuid(),secret:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().trim().min(1).max(100),capability:z.enum(['read','comment','propose','create','organize','create_shared']),minutes:z.number().int().min(1).max(60)}).strict().refine(r=>!(r.folderId&&r.folderResourceId),'Choose one folder identifier');
const fields="id,name,scope_kind,folder_resource_id,capabilities,created_at,expires_at,revoked_at,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.source_id,'sha256',g.sha256,'acceptPartial',g.accept_partial)),'[]'::jsonb) FROM lanka.agent_source_grants g WHERE g.tenant_id=agent_delegations.tenant_id AND g.delegation_id=agent_delegations.id) AS source_grants,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.source_id,'sha256',g.sha256,'contentHash',g.content_hash,'acceptPartial',g.accept_partial)),'[]'::jsonb) FROM lanka.document_source_grants g WHERE g.tenant_id=agent_delegations.tenant_id AND g.delegation_id=agent_delegations.id) AS document_source_grants";
/** Issuance/revocation is a human browser operation; an agent cannot delegate further. */
export class AgentDelegations {
 constructor(private resources:PostgresResourceAccess){}
 issue(p:BrowserPrincipal,tenant:string,document:string|null,input:unknown){
  const request=issueSchema.parse(input),tokenHash=delegatedPrincipal(request.secret).tokenHash;
  const fingerprint=createHash('sha256').update(JSON.stringify({...request,secret:tokenHash})).digest('hex');
  if(document!==null&&['create','organize','create_shared'].includes(request.capability))throw new OrganizationAccessError(403,'Разрешение не подходит для выбранной области.');
  if(request.sources?.length&&(document!==null||!['create','organize','create_shared'].includes(request.capability)))throw new OrganizationAccessError(403,'Материалы можно передать только ключу создания в библиотеке.');
  const sourceDocument=document??request.sourceDocumentId;
  if(document&&request.sourceDocumentId&&document!==request.sourceDocumentId)throw new OrganizationAccessError(403,'Источник вне области документа.');
  if(request.documentSources?.length&&(!sourceDocument||request.expectedRevision===undefined))throw new OrganizationAccessError(403,'Выберите документ и его текущую версию.');
  if(request.capability==='create_shared'&&!request.folderId&&!request.folderResourceId)throw new OrganizationAccessError(403,'Выберите папку для общего создания.');
  const write=async(c:import('pg').PoolClient,ctx:import('../../server/organization-access').OrganizationContext)=>{
   if(ctx.delegation)throw new OrganizationAccessError(403);
   let folderResourceId:string|null=null;
   if(request.folderId||request.folderResourceId){
    if(document!==null)throw new OrganizationAccessError(403,'Папку можно выбрать только для подключения к библиотеке.');
    const folder=request.folderResourceId?await c.query("SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND id=$2 AND kind='folder'",[tenant,request.folderResourceId]):await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[tenant,ctx.principalId,request.folderId]);
    if(!folder.rowCount)throw new OrganizationAccessError(404);
    const permission=await this.resources.permissionIn(c,ctx,folder.rows[0].id,request.capability==='read'?'viewer':request.capability==='comment'?'commenter':request.capability==='propose'?'editor':'manager');
    if(['create','organize'].includes(request.capability)&&permission.ownerId!==ctx.principalId)throw new OrganizationAccessError(403,'Для общей папки выберите просмотр, комментарии или предложения.');folderResourceId=folder.rows[0].id;
   }
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${tenant}:${ctx.principalId}:delegations`]);
   let sourceProject:FolderProject|undefined;
   if(request.documentSources?.length){const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed FOR SHARE',[tenant,sourceDocument,ctx.principalId]);if(!row.rowCount)throw new OrganizationAccessError(403,'Источники передаёт владелец документа.');sourceProject=row.rows[0].project;if(folderResourceId){const node=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,sourceDocument]);if(!node.rowCount||!(await this.resources.ancestryIn(c,ctx,node.rows[0].id)).some(n=>n.id===folderResourceId))throw new OrganizationAccessError(403,'Источник вне папки подключения.');}}
   const prior=await c.query(`SELECT ${fields},fingerprint,issuer_id,material_id FROM lanka.agent_delegations WHERE tenant_id=$1 AND id=$2`,[tenant,request.requestId]);
   if(prior.rowCount){const row=prior.rows[0];if(row.issuer_id!==ctx.principalId||row.material_id!==document||row.fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');return this.public(row);}
   if(sourceProject){if(sourceProject.state.revision!==request.expectedRevision)throw new OrganizationAccessError(409,'Документ изменился. Проверьте материалы заново.');for(const selection of request.documentSources!){const source=sourceProject.state.sources.find(s=>s.id===selection.id);if(!source)throw new OrganizationAccessError(409,'Источник недоступен.');try{selectedDocumentSource(source,selection);}catch(e){throw new OrganizationAccessError(409,(e as Error).message);}}}
   const count=await c.query('SELECT count(*)::int AS n FROM lanka.agent_delegations WHERE tenant_id=$1 AND issuer_id=$2 AND revoked_at IS NULL AND expires_at>now()',[tenant,ctx.principalId]);
   if(count.rows[0].n>=20)throw new OrganizationAccessError(409,'Отзовите неиспользуемые подключения: доступно до 20 активных ключей.');
   await usingTransactionDatabase(c,ctx,'.',db=>readCreationSources(db,c,request.sources));
   const epoch=await c.query('SELECT auth_epoch FROM lanka.auth_identities WHERE id=$1',[ctx.userId]);
   const row=await c.query(`INSERT INTO lanka.agent_delegations(tenant_id,id,issuer_id,material_id,token_hash,name,capabilities,auth_epoch,fingerprint,expires_at,scope_kind,folder_resource_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(mins=>$10),$11,$12) RETURNING ${fields}`,[tenant,request.requestId,ctx.principalId,document,tokenHash,request.name,request.capability==='create_shared'?['read','comment','propose','create','create_shared']:request.capability==='organize'?['read','comment','propose','create','organize']:request.capability==='create'?['read','comment','propose','create']:request.capability==='propose'?['read','comment','propose']:request.capability==='read'?['read']:['read','comment'],epoch.rows[0].auth_epoch,fingerprint,request.minutes,document===null?'workspace':'document',folderResourceId]);
   for(const source of request.sources??[])await c.query('INSERT INTO lanka.agent_source_grants(tenant_id,owner_id,source_id,delegation_id,sha256,accept_partial) VALUES($1,$2,$3,$4,$5,$6)',[tenant,ctx.principalId,source.id,request.requestId,source.sha256,source.acceptPartial]);
   for(const source of request.documentSources??[])await c.query('INSERT INTO lanka.document_source_grants(tenant_id,delegation_id,material_id,source_id,sha256,content_hash,accept_partial) VALUES($1,$2,$3,$4,$5,$6,$7)',[tenant,request.requestId,sourceDocument,source.id,source.sha256,source.contentHash,source.acceptPartial]);
   return this.public({...row.rows[0],source_grants:request.sources??[],document_source_grants:request.documentSources??[]});
  };
  return document===null?this.resources.organizations.withTenant(p,tenant,write):this.resources.withMaterial(p,tenant,document,request.capability==='propose'?'editor':request.capability==='read'?'viewer':'commenter',write,request.capability==='propose'?{capability:'propose'}:undefined);
 }
 private public(row:Record<string,unknown>){return {folderResourceId:row.folder_resource_id??null,sources:row.source_grants??[],documentSources:row.document_source_grants??[],id:row.id,name:row.name,scope:row.scope_kind,capabilities:row.capabilities,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at};}
 list(p:BrowserPrincipal,tenant:string,document:string|null){
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   const rows=await c.query(`SELECT ${fields} FROM lanka.agent_delegations WHERE tenant_id=$1 AND issuer_id=$2 AND material_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC,id LIMIT 100`,[tenant,ctx.principalId,z.string().uuid().nullable().parse(document)]);
   const folders=document===null?{rows:await libraryFoldersIn(c,ctx)}:null;
   const available=[];for(const f of folders?.rows??[])try{await this.resources.permissionIn(c,ctx,f.resourceId,'manager');available.push(f);}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}
   return {delegations:rows.rows.map(r=>this.public(r)),folders:available,sharedFolders:document===null?await sharedFoldersIn(c,ctx):[]};
  });
 }
 revoke(p:BrowserPrincipal,tenant:string,document:string|null,id:string){
  z.string().uuid().parse(id);z.string().uuid().nullable().parse(document);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   const row=await c.query(`UPDATE lanka.agent_delegations SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND issuer_id=$2 AND material_id IS NOT DISTINCT FROM $3::uuid AND id=$4 RETURNING ${fields}`,[tenant,ctx.principalId,document,id]);
   if(!row.rowCount)throw new OrganizationAccessError(404);
   return this.public(row.rows[0]);
  },true);
 }
}
