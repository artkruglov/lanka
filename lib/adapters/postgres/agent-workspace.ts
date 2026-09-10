import {sharedFoldersIn} from './shared-folders';
import {libraryFoldersIn} from './library-folders';
import {readCreationSources} from '../../project/creation-sources';
import {inspectNarrative} from '../../domain/narrative';
import {creationDesignProblems} from '../../project/empty-draft';
import {creationSlideInputSchema} from '../../project/structured-creation';
import {previewSlides} from '../../../scripts/project-mcp/preview';
import {lintDoc} from '../../domain/model';
import {designReview} from '../../domain/design-review';
import type {DeckDoc} from '../../domain/model';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
import {readFile} from 'node:fs/promises';
import {creationProfile,creationReferenceImages} from '../../agents/creation-profile';
import {PostgresResourceAccess} from './resource-access';
import {OrganizationDocumentView} from './document-view';
import {usingTransactionDatabase} from './transaction-database';
import {createDocumentCommand,createWorkspaceDocument,prepareWorkspaceDocument} from './organization-workspace';
const sharedDocumentCommand=createDocumentCommand.extend({folderResourceId:z.string().uuid().optional()});
const requestSchema=z.object({requestId:z.string().uuid(),command:z.discriminatedUnion('action',[
 sharedDocumentCommand,z.object({action:z.literal('create_folder'),name:z.string().trim().min(1).max(180),parentFolderId:z.string().uuid().optional(),parentFolderResourceId:z.string().uuid().optional()}).strict(),
])}).strict();
/** No owner package, notes, sessions or private proposal metadata are exposed to a workspace agent. */
export class AgentWorkspace {
 constructor(private resources:PostgresResourceAccess,private runtimeRoot:string){}
 private async destination(c:import('pg').PoolClient,ctx:import('../../server/organization-access').OrganizationContext,id:string|null|undefined,resourceId?:string){
  if(resourceId){
   if(id)throw new OrganizationAccessError(409,'Выберите один идентификатор папки.');
   if(ctx.delegation&&!ctx.delegation.capabilities.includes('create_shared'))throw new OrganizationAccessError(403,'Ключ не разрешает создание общих документов.');
   const folder=await this.resources.permissionIn(c,ctx,resourceId,'manager');if(folder.kind!=='folder')throw new OrganizationAccessError(404);
   if((await this.resources.ancestryIn(c,ctx,resourceId)).length>=66)throw new OrganizationAccessError(409,'Достигнута максимальная глубина папок.');return resourceId;
  }
  if(ctx.delegation?.capabilities.includes('create_shared'))throw new OrganizationAccessError(403,'Укажите folderResourceId или parentFolderResourceId для общего создания.');
  if(!id){if(ctx.delegation?.folderResourceId)throw new OrganizationAccessError(403,'Выберите папку внутри области подключения.');return null;}
  const n=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[ctx.tenantId,ctx.principalId,id]);
  if(!n.rowCount)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,n.rows[0].id,'manager');if((await this.resources.ancestryIn(c,ctx,n.rows[0].id)).length>=66)throw new OrganizationAccessError(409,'Достигнута максимальная глубина папок.');return n.rows[0].id as string;
 }

 reference(p:CorporatePrincipal,tenant:string,input:unknown){
  const a=z.object({profile:z.literal('focus-v3'),file:z.enum(['deck-01-cover.png','deck-02-content.png','deck-04-split.png'])}).strict().parse(input);
  return this.resources.organizations.withTenant(p,tenant,async()=>{
   const profile=await creationProfile(a.profile),paths=await creationReferenceImages(profile),index=profile.references.findIndex(r=>r.file===a.file);
   const bytes=await readFile(paths[index]),sha256=createHash('sha256').update(bytes).digest('hex');
   if(sha256!==profile.references[index].sha256)throw new OrganizationAccessError(409,'Эталон изменился. Прочитайте каталог заново.');
   return {file:a.file,sha256,data:bytes.toString('base64')};
  },false,{workspace:true,capability:'read'});
 }
 list(p:CorporatePrincipal,tenant:string,options:{search?:string;cursor?:string;folderResourceId?:string}={}){return new OrganizationDocumentView(this.resources).list(p,tenant,options,true);}
 context(p:CorporatePrincipal,tenant:string){return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
  const folders={rows:await libraryFoldersIn(c,ctx)};
  const available=[];for(const folder of folders.rows){const node=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND folder_id=$2 AND owner_id=$3',[tenant,folder.id,ctx.principalId]);
   try{await this.resources.permissionIn(c,ctx,node.rows[0].id,'manager');available.push(folder);}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}}
  return {format:'lanka-agent-workspace/v1',tenantId:tenant,scope:ctx.delegation?.folderResourceId?{kind:'folder',resourceId:ctx.delegation.folderResourceId}:{kind:'workspace'},folders:available,sharedFolders:await sharedFoldersIn(c,ctx),canCreateShared:!!ctx.delegation?.capabilities.includes('create_shared'),canOrganize:!!ctx.delegation?.capabilities.includes('organize'),canCreate:!!ctx.delegation?.capabilities.includes('create'),
   authoringInput:{slideSchema:creationSlideInputSchema,limits:{slides:40,previewBatch:2},example:{layout:'split',title:'Два способа обмена',comparison:{mode:'neutral',before:{label:'Личная встреча',text:'Устное обсуждение на месте.'},after:{label:'Запись',text:'Передача сообщения на расстоянии.'}}}},
   guide:'sharedFolders lists readable folders owned by colleagues. With canCreateShared and current manager role, pass folderResourceId (and folderId:null) for shared document creation, or parentFolderResourceId for a shared subfolder. New content belongs to the creator and inherits folder access; do not include private content in visible slides. Folder-scoped read/comment/propose keys may work on permitted documents there, but cannot create or organize library items. Each child has its own current permissions; restricted children can be absent. For reuse of the current draft, read lanka_get_document_view.permission.canCopy. For a reviewed frozen version use lanka_list_publications (follow nextCursor), lanka_get_publication and lanka_preview_publication with documentId/publicationId. A publication is independent of later draft edits. With workspace create authority, copy it using lanka_copy_shared_document with sourceDocumentId, publicationId and expectedRevision equal to its origin.revision. Activation and withdrawal remain human-only; never describe a draft or an agent proposal as a published version. With workspace create permission, lanka_copy_shared_document copies permitted shared slide content into your private library, preserving the visible composition as editable objects and recording the source version. It excludes original source files and private material; do not claim its snapshot proves the underlying data. If scope.kind is folder, all document operations are limited to that folder and its current descendants. Always supply an allowed folderId for document creation, moves and copies, and parentFolderId for folder creation; root is outside scope. Moving an item out immediately removes agent access, including retries. Selected source grants remain explicit. List documents before selecting one. Read its visible slides. Create new private documents in your issuer’s personal folders or at root; Only an explicitly issued create_shared key permits shared creation in its selected subtree. Changing sharing grants is not supported here. Only a separately issued organize key exposes lanka_list_library/lanka_manage_library for renaming, moving, copying and reversible trash of your issuer’s own documents; ordinary create keys cannot do this. Read template recipes and lanka_get_template_reference images before authoring structured slides; reference facts are examples, not source material. Prefer slides with explicit semantic layout and title; the application supplies IDs, optional empty fields and geometry. Use lanka_preview_creation with the same requestId, input and up to two slideNumbers; inspect all slides and fix problems before lanka_create_document. Never change the job just to pass checks. Markdown is a compatibility input: first section cover, later sections content. Upload user-supplied source files with lanka_upload_source, then read lanka_get_source_intake. Start with lanka_list_source_intakes: the owner may have explicitly selected materials for this key. Other owner uploads remain private. Uploads expire after seven days; use selected snapshots before their expiry. Select sources by exact id and sha256; acknowledge partial extraction with acceptPartial only after explaining its limits. Use those IDs in slides; never invent references or evidence. Briefing records audience, decision and keyMessage with origin user or assumption; do not label guesses as user-confirmed. After creation read lanka_get_edit_context and its designReview; inspect the visual result before calling it ready. Use one requestId per intent and the identical request on retries. Propose edits for human review; never describe a proposal as accepted. Private chats and notes are excluded from library tools. For a conversation explicitly bound by the owner to this key, use lanka_list_conversations, lanka_receive_message and lanka_reply_message. Messages may include selection: an exact slide/object/field address frozen at send time. If available is false, do not use the old address. If stale is true or targetExists is false, read the current edit context and resolve the change with the user; never silently retarget. Selection is context unless task.limitToSelection is true. With that flag, proposals must preserve every other slide, object and field, and use the frozen selection revision. A changed revision needs a new user instruction; do not broaden scope to get past a rejection. Attach verified documentId/revision results and your own shared proposalId to the reply so the user can open the result and review it. For a task-bound connection, every document/library/source mutation must include the ordinary tool argument task={sessionId,messageId} (programmatic clients may instead use tools/call params._meta.lankaTask) from the received instruction. Its task.mode permits only the matching operation (discuss permits no mutations); task.documentId narrows the destination. Reuse the same task address on retries. Conflicting argument and metadata addresses are rejected. Cancellation or final reply fences subsequent writes, including retries, but does not roll back committed results or stop your native process. The key remains restricted after rebinding. Read-only inspection remains available within existing key permissions. A runtime adapter may use the Lanka-Runtime-Protocol: 1 HTTP header to discover lifecycle tools. Ordinary model connections must not use that header or invent runtime reports. A claimed runtime supplies task.executionId for writes and executionId for the final reply, sends fresh heartbeats every 20 seconds, and stops on cancellation or lease loss. Unknown execution state never authorizes automatic replay. Lifecycle status is client-reported, not independent proof. This mailbox does not mirror native chats or start an offline agent.',
   templates:await Promise.all((['focus-v2','focus-v3'] as const).map(async id=>(await creationProfile(id))))};
 },false,{workspace:true,capability:'read'});}
 preview(p:CorporatePrincipal,tenant:string,input:unknown){
  const a=z.object({requestId:z.string().uuid(),command:sharedDocumentCommand,slideNumbers:z.array(z.number().int().min(1).max(40)).min(1).max(2).refine(n=>new Set(n).size===n.length)}).strict().parse(input);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(!a.command.slides)throw new OrganizationAccessError(409,'Предпросмотр создания принимает структурированные slides.');
   await this.destination(c,ctx,a.command.folderId,a.command.folderResourceId);
   const selected=await usingTransactionDatabase(c,ctx,this.runtimeRoot,db=>readCreationSources(db,c,a.command.sources,p.kind==='delegated'?{delegationHash:p.tokenHash}:undefined));
   const project=await prepareWorkspaceDocument(a.requestId,a.command,false,selected.sources),doc=project.state.doc;
   if(a.slideNumbers.some(n=>n>doc.slides.length))throw new OrganizationAccessError(409,'Номер слайда вне презентации.');
   const problems=creationDesignProblems(doc),review=designReview(doc),lint=lintDoc(doc);
   const report={storyReview:inspectNarrative(doc),requestId:a.requestId,canCreate:problems.length===0,problems,designReview:review,lint,slideIds:doc.slides.map(s=>s.id),persisted:false};
   try{const rendered=await previewSlides({readFile:async path=>{const blob=selected.blobs.find(b=>path===`materials/${b.hash}.bin`);if(!blob)throw Error('Источник недоступен.');return blob.bytes;}},project,a.slideNumbers.map(n=>doc.slides[n-1].id));return {...report,...rendered};}
   catch(e){return {...report,images:[],renderError:(e as Error).message};}
  },false,{workspace:true,capability:'create'});
 }
 create(p:CorporatePrincipal,tenant:string,input:unknown){
  const a=requestSchema.parse(input),cmd=a.command;
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>usingTransactionDatabase(c,ctx,this.runtimeRoot,db=>db.tx(async()=>{
   const payload={operation:'agent.workspace.create',actor:p.kind==='delegated'?p.tokenHash:p.userId,command:cmd};
   const fingerprint=createHash('sha256').update(canonicalJson(payload)).digest('hex');
   // Check current scope before any receipt replay; a folder that was removed is not a valid destination.
   const destination=await this.destination(c,ctx,cmd.action==='create_document'?cmd.folderId:cmd.parentFolderId,cmd.action==='create_document'?cmd.folderResourceId:cmd.parentFolderResourceId);
   if(cmd.action==='create_folder'&&destination&&(await this.resources.ancestryIn(c,ctx,destination)).length>=65)throw new OrganizationAccessError(409,'Достигнута максимальная глубина папок.');
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,ctx.principalId,a.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');const current=await c.query(`SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND ${cmd.action==='create_document'?'material_id':'folder_id'}=$3`,[tenant,ctx.principalId,a.requestId]);if(!current.rowCount)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,current.rows[0].id,'manager');return prior.rows[0].result;}
   const used=await c.query('SELECT 1 FROM lanka.catalog_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.imported_project_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[tenant,ctx.principalId,a.requestId]);
   if(used.rowCount)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');
   await c.query("INSERT INTO lanka.workspace_catalogs(tenant_id,owner_id,origin) VALUES($1,$2,'native') ON CONFLICT DO NOTHING",[tenant,ctx.principalId]);
   let value:unknown;try{value=cmd.action==='create_document'?await createWorkspaceDocument(db,c,a.requestId,cmd,payload,p.kind==='delegated'?{delegationHash:p.tokenHash}:undefined):await db.mutateFolder(a.requestId,{action:cmd.action,name:cmd.name});}catch(e){if(e instanceof Error&&/^(Исправьте оформление|Нельзя подменять формат|Ссылка на недоступный источник|Изображение)/.test(e.message))throw new OrganizationAccessError(409,e.message);throw e;}
   const sharedDestination=cmd.action==='create_document'?cmd.folderResourceId:cmd.parentFolderResourceId;
   if(sharedDestination){
    const created=await c.query(`SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND ${cmd.action==='create_document'?'material_id':'folder_id'}=$3`,[tenant,ctx.principalId,a.requestId]);
    await c.query("UPDATE lanka.resource_nodes SET parent_folder_id=$3,inheritance='inherit' WHERE tenant_id=$1 AND id=$2",[tenant,created.rows[0].id,destination]);
   }
   if(cmd.action==='create_folder'&&destination){
    const created=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[tenant,ctx.principalId,a.requestId]);
    await c.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[tenant,created.rows[0].id,destination]);
    await c.query('INSERT INTO lanka.folder_closure(tenant_id,ancestor_id,descendant_id,depth) SELECT tenant_id,ancestor_id,$3,depth+1 FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=$2',[tenant,destination,created.rows[0].id]);
   }
   const epoch=await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1 RETURNING authz_epoch',[tenant]);
   const quality=cmd.action==='create_document'?await c.query("SELECT project#>'{state,doc}' AS doc FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[tenant,ctx.principalId,a.requestId]):null;
   const result={...(value as {id:string;revision?:number}),...(sharedDestination?{folderResourceId:destination,inheritance:'inherit'}:{}),...(cmd.action==='create_document'?{url:`/organizations/${tenant}/documents/${a.requestId}`,designReview:designReview(quality!.rows[0].doc as DeckDoc),storyReview:inspectNarrative(quality!.rows[0].doc as DeckDoc)}:{})};
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenant,ctx.principalId,a.requestId,fingerprint,JSON.stringify(result)]);
   const node=await c.query(`SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND ${cmd.action==='create_document'?'material_id':'folder_id'}=$3`,[tenant,ctx.principalId,a.requestId]);
   await c.query('INSERT INTO lanka.resource_audit(tenant_id,sequence,actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[tenant,epoch.rows[0].authz_epoch,ctx.principalId,'agent.'+cmd.action,node.rows[0].id,JSON.stringify({delegationId:ctx.delegation?.id??null,sharedFolderResourceId:sharedDestination??null})]);
   return result;
  })),true,{workspace:true,write:true,capability:'create'});
 }
}
