import {EDITOR_CONTRACT} from '../../project/editor-contract';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {canonicalJson} from '../../domain/canonical-json';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
import {usingTransactionDatabase} from './transaction-database';
import {PostgresMcpRepository} from './mcp-repository';
import {humanCommand} from '../../../scripts/project-mcp/human';
const uuid=z.string().uuid(),expected=z.string().regex(/^[a-f0-9]{64}$/),title=z.string().trim().min(1).max(140);
export const libraryCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('rename_document'),id:uuid,title,expectedState:expected}).strict(),
 z.object({action:z.literal('rename_folder'),id:uuid,name:z.string().trim().min(1).max(180),expectedState:expected}).strict(),
 z.object({action:z.literal('move_document'),id:uuid,folderId:uuid.nullable(),expectedState:expected}).strict(),
 z.object({action:z.literal('duplicate_document'),id:uuid,title,folderId:uuid.nullable(),expectedState:expected}).strict(),
 z.object({action:z.literal('trash_document'),id:uuid,trashed:z.boolean(),expectedState:expected}).strict(),
]);
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
type Row={id:string;resource_id:string;title:string;revision:number|null;folder_id:string|null;parent_folder_id:string|null;trashed:boolean;pending?:number};
/** Metadata-only management of the issuer's own library. Sharing and permanent deletion are excluded. */
export class AgentLibrary {
 constructor(private resources:PostgresResourceAccess,private runtimeRoot:string){}
 private view(ctx:OrganizationContext,row:Row){const value={id:row.id,title:row.title,revision:row.revision,folderId:row.folder_id,parentResourceId:row.parent_folder_id,trashed:row.trashed};return {...value,...(row.pending!==undefined?{pending:row.pending}:{}),stateToken:hash({tenant:ctx.tenantId,owner:ctx.principalId,...value})};}
 private async rows(c:PoolClient,ctx:OrganizationContext,kind:'documents'|'folders',id?:string,cursor?:string,trashed=false,pendingOnly=false){
  const where=id?' AND x.id=$3':' AND ($3::uuid IS NULL OR x.id>$3)';
  const scoped=' AND ($4::uuid IS NULL OR n.id=$4 OR n.parent_folder_id IN (SELECT descendant_id FROM lanka.folder_closure WHERE tenant_id=$1 AND ancestor_id=$4))';
  const common=` JOIN lanka.resource_nodes n ON n.tenant_id=x.tenant_id AND n.owner_id=x.owner_id AND n.${kind==='documents'?'material_id':'folder_id'}=x.id WHERE x.tenant_id=$1 AND x.owner_id=$2${scoped}`;
  const query=kind==='documents'?`SELECT x.id,n.id AS resource_id,x.project->>'title' AS title,(x.project#>>'{state,revision}')::int AS revision,x.folder_id,n.parent_folder_id,x.trashed,(SELECT count(*)::int FROM jsonb_array_elements(x.project->'state'->'proposals') proposal WHERE proposal->>'status'='pending') AS pending FROM lanka.materials x${common}${id?'':' AND x.trashed=$5'}${pendingOnly?" AND EXISTS (SELECT 1 FROM jsonb_array_elements(x.project->'state'->'proposals') proposal WHERE proposal->>'status'='pending')":''}${where}`:`SELECT x.id,n.id AS resource_id,x.name AS title,NULL::int AS revision,NULL::uuid AS folder_id,n.parent_folder_id,false AS trashed FROM lanka.catalog_folders x${common} AND n.deleted_at IS NULL${where}`;
  return (await c.query<Row>(query+' ORDER BY x.id LIMIT 51',[ctx.tenantId,ctx.principalId,id??cursor??null,ctx.delegation?.folderResourceId??null,...(kind==='documents'&&!id?[trashed]:[])])).rows;
 }
 private async authorizeRow(c:PoolClient,ctx:OrganizationContext,row:Row){
  if(!row.trashed)await this.resources.permissionIn(c,ctx,row.resource_id,'manager');
  else if(ctx.delegation?.folderResourceId&&!row.parent_folder_id)throw new OrganizationAccessError(404);
  else if(row.parent_folder_id)await this.resources.permissionIn(c,ctx,row.parent_folder_id,'manager');
 }
 private async destination(c:PoolClient,ctx:OrganizationContext,id:string|null){if(!id){if(ctx.delegation?.folderResourceId)throw new OrganizationAccessError(403,'Выберите папку внутри области подключения.');return;}const [row]=await this.rows(c,ctx,'folders',id);if(!row)throw new OrganizationAccessError(404);await this.authorizeRow(c,ctx,row);}
 list(p:CorporatePrincipal,tenant:string,input:unknown){
  const a=z.object({kind:z.enum(['documents','folders']),id:uuid.optional(),cursor:uuid.optional(),trashed:z.boolean().default(false),pendingOnly:z.boolean().default(false)}).strict().refine(a=>!(a.id&&a.cursor),'Choose id or cursor').refine(a=>a.kind==='documents'||!a.trashed,'Folder trash is not supported').refine(a=>a.kind==='documents'||!a.pendingOnly,'Pending filter requires documents').parse(input);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   const rows=await this.rows(c,ctx,a.kind,a.id,a.cursor,a.trashed,a.pendingOnly),page=rows.slice(0,50),items=[];
   for(const row of page)try{await this.authorizeRow(c,ctx,row);items.push(this.view(ctx,row));}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}
   return {kind:a.kind,items,nextCursor:rows.length>50?page[page.length-1].id:null};
  },false,{workspace:true,capability:'organize'});
 }
 mutate(p:CorporatePrincipal,tenant:string,input:unknown){
  const a=z.object({requestId:uuid,command:libraryCommand}).strict().parse(input),cmd=a.command;
  return this.resources.organizations.withTenant(p,tenant,(c,ctx)=>usingTransactionDatabase(c,ctx,this.runtimeRoot,db=>db.tx(async()=>{
   const kind=cmd.action==='rename_folder'?'folders':'documents',[row]=await this.rows(c,ctx,kind,cmd.id);if(!row)throw new OrganizationAccessError(404);
   await this.authorizeRow(c,ctx,row);
   if('folderId' in cmd)await this.destination(c,ctx,cmd.folderId);
   if(cmd.action==='move_document'&&row.parent_folder_id)await this.resources.permissionIn(c,ctx,row.parent_folder_id,'manager');
   const payload={operation:'agent.library',actor:p.kind==='delegated'?p.tokenHash:p.userId,command:cmd},fingerprint=hash(payload);
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,ctx.principalId,a.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');if(cmd.action==='duplicate_document'){const [copy]=await this.rows(c,ctx,'documents',a.requestId);if(!copy)throw new OrganizationAccessError(404);await this.authorizeRow(c,ctx,copy);}return prior.rows[0].result;}
   const used=await c.query('SELECT 1 FROM lanka.catalog_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.imported_project_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[tenant,ctx.principalId,a.requestId]);if(used.rowCount)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');
   if(cmd.expectedState!==this.view(ctx,row).stateToken)throw new OrganizationAccessError(409,'Объект изменился. Обновите библиотеку перед новым действием.');
   if(row.trashed&&!(cmd.action==='trash_document'&&!cmd.trashed))throw new OrganizationAccessError(409,'Сначала восстановите презентацию из корзины.');
   let result:unknown;
   try{
    if(cmd.action==='rename_folder')result=await db.mutateFolder(a.requestId,{action:cmd.action,id:cmd.id,name:cmd.name});
    else if(cmd.action==='rename_document'){
     const repo=new PostgresMcpRepository(db,cmd.id),project=await repo.read();if(!project)throw new OrganizationAccessError(404);
     result=await humanCommand(repo,{requestId:a.requestId,deckId:cmd.id,expectedRevision:row.revision,command:{action:'save',editorContract:EDITOR_CONTRACT,doc:{...project.state.doc,title:cmd.title}}},{requireEditorContract:true});
    }else if(cmd.action==='duplicate_document')result=await db.duplicateIn(c,a.requestId,{action:cmd.action,id:cmd.id,title:cmd.title,folderId:cmd.folderId,expectedRevision:row.revision!});
    else result=await db.catalogCommand(a.requestId,cmd.id,cmd);
   }catch(e){if(e instanceof OrganizationAccessError)throw e;if(e instanceof Error&&/^(Конфликт|Ключ повтора|Документ недоступен|Папка недоступна)/.test(e.message))throw new OrganizationAccessError(409,e.message);throw e;}
   const targetId=cmd.action==='duplicate_document'?a.requestId:cmd.id,[after]=await this.rows(c,ctx,kind,targetId);
   const value={...(result as object),item:this.view(ctx,after),...(kind==='documents'?{url:`/organizations/${tenant}/documents/${targetId}`}:{})};
   const epoch=await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1 RETURNING authz_epoch',[tenant]);
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenant,ctx.principalId,a.requestId,fingerprint,JSON.stringify(value)]);
   await c.query('INSERT INTO lanka.resource_audit(tenant_id,sequence,actor_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',[tenant,epoch.rows[0].authz_epoch,ctx.principalId,'agent.'+cmd.action,after.resource_id,JSON.stringify({delegationId:ctx.delegation?.id??null,requestId:a.requestId})]);
   return value;
  })),true,{workspace:true,write:true,capability:'organize'});
 }
}
