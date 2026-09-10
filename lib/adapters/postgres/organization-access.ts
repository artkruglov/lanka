import {authorizeBridgeTask} from './agent-task-authorization';
import {permissionIn} from './resource-permission';
import {libraryFoldersIn} from './library-folders';
import type {DatabasePool} from './database-pool';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {CorporatePrincipal,DelegationScope} from '../../server/agent-delegation';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {OrganizationAccessError,membershipCommand,type OrganizationContext} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
import {validateDoc,validateReferences} from '../../domain/model';
import type {FolderProject} from '../../project/package';
const fingerprint=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const uuid=z.string().uuid();

/** A server-only port. Its transaction callback is trusted application code, not an MCP/HTTP input. */
export class PostgresOrganizationAccess {
 constructor(readonly pool:DatabasePool) {}
 private async transaction<T>(fn:(c:PoolClient)=>Promise<T>) {
  const c=await this.pool.connect();
  try {await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
 }
 private async identity(c:PoolClient,p:BrowserPrincipal) {
  uuid.parse(p.userId);uuid.parse(p.sessionId);
  // Match the authenticated subject as well as its UUID. No email/header lookup.
  const identity=await c.query(`SELECT auth_epoch FROM lanka.auth_identities
   WHERE id=$1 AND issuer=$2 AND subject=$3 AND NOT disabled FOR SHARE`,[p.userId,p.issuer,p.subject]);
  if(!identity.rowCount)throw new OrganizationAccessError(401,'Войдите в аккаунт.');
  const session=await c.query(`SELECT 1 FROM lanka.browser_sessions WHERE id=$1 AND identity_id=$2
   AND auth_epoch=$3 AND expires_at>now() AND idle_expires_at>now() FOR SHARE`,[p.sessionId,p.userId,identity.rows[0].auth_epoch]);
  if(!session.rowCount)throw new OrganizationAccessError(401,'Войдите в аккаунт.');
 }
 async list(p:BrowserPrincipal) {
  return this.transaction(async c=>{
   await this.identity(c,p);
   const r=await c.query(`SELECT t.id,t.slug,t.name,m.role FROM lanka.tenants t
    JOIN lanka.principals p ON p.tenant_id=t.id JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
    WHERE p.user_id=$1 AND p.status='active' AND m.status='active' AND t.status='active' ORDER BY t.name,t.id`,[p.userId]);
   return r.rows as {id:string;slug:string;name:string;role:string}[];
  });
 }
 /** Reads/writes and permission checks share one transaction. Revoke takes the exclusive tenant lock. */
 async withTenant<T>(p:CorporatePrincipal,tenantId:string,fn:(c:PoolClient,context:OrganizationContext)=>Promise<T>,changeAccess=false,scope?:DelegationScope) {
  uuid.parse(tenantId);
  return this.transaction(async c=>{
   if(p.kind==='oidc')await this.identity(c,p);
   else if(!scope||(changeAccess&&!(('workspace' in scope)&&['create','organize'].includes(scope.capability))))throw new OrganizationAccessError(403,'Операция вне области доступа агента.');
   const tenant=await c.query(`SELECT authz_epoch FROM lanka.tenants WHERE id=$1 AND status='active' FOR ${changeAccess?'UPDATE':'SHARE'}`,[tenantId]);
   if(!tenant.rowCount)throw new OrganizationAccessError(404);
   let userId:string,delegation:OrganizationContext['delegation'],taskSelection:OrganizationContext['taskSelection'];
   if(p.kind==='oidc')userId=p.userId;
   else {
    const issued=await c.query(`SELECT d.id,d.name,d.capabilities,d.folder_resource_id,d.requires_task,p.user_id FROM lanka.agent_delegations d
     JOIN lanka.principals p ON p.tenant_id=d.tenant_id AND p.id=d.issuer_id
     JOIN lanka.auth_identities i ON i.id=p.user_id
     WHERE d.token_hash=$1 AND d.tenant_id=$2 AND ($3::uuid IS NOT NULL AND (d.scope_kind='workspace' OR d.material_id=$3) OR $3::uuid IS NULL AND d.scope_kind='workspace') AND $4=ANY(d.capabilities)
      AND d.revoked_at IS NULL AND d.expires_at>now() AND NOT i.disabled AND i.auth_epoch=d.auth_epoch
     FOR SHARE OF d,i`,[p.tokenHash,tenantId,'documentId' in scope! ? scope.documentId : null,scope!.capability]);
    if(!issued.rowCount)throw new OrganizationAccessError(401,'Доступ агента истёк, отозван или не подходит для операции.');
    taskSelection=await authorizeBridgeTask(c,tenantId,issued.rows[0].id,issued.rows[0].requires_task,p,scope!);
    userId=issued.rows[0].user_id;delegation={folderResourceId:issued.rows[0].folder_resource_id??undefined,id:issued.rows[0].id,name:issued.rows[0].name,capabilities:issued.rows[0].capabilities};
   }
   const member=await c.query(`SELECT p.id,m.role FROM lanka.principals p JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
    WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.status='active' AND m.status='active'`,[tenantId,userId]);
   if(!member.rowCount)throw new OrganizationAccessError(404);
   const context:OrganizationContext={...(taskSelection?{taskSelection}:{}),tenantId,principalId:member.rows[0].id,userId,...(delegation?{delegation}:{}),role:member.rows[0].role,authzEpoch:String(tenant.rows[0].authz_epoch)};
   await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id',$2,true)",[tenantId,context.principalId]);
   if(delegation?.folderResourceId){
    const anchor=await permissionIn(c,context,delegation.folderResourceId);
    if(anchor.kind!=='folder')throw new OrganizationAccessError(403,'Папка подключения недоступна.');
    if(delegation.capabilities.some(c=>c==='create'||c==='organize')&&anchor.ownerId!==context.principalId&&!delegation.capabilities.includes('create_shared'))throw new OrganizationAccessError(403,'Ключ не разрешает создание в общей папке.');
   }
   return fn(c,context);
  });
 }
 async members(p:BrowserPrincipal,tenantId:string) { return (await this.membershipView(p,tenantId)).members; }
 async membershipView(p:BrowserPrincipal,tenantId:string,input:unknown={}) {
  const filter=z.object({search:z.string().trim().max(140).default(''),cursor:uuid.optional(),expectedEpoch:z.string().regex(/^\d+$/).optional()}).strict().parse(input);
  return this.withTenant(p,tenantId,async(c,ctx)=>{
   if(ctx.role==='member')throw new OrganizationAccessError(403);
   if(filter.expectedEpoch!==undefined&&filter.expectedEpoch!==ctx.authzEpoch)throw new OrganizationAccessError(409,'Состав команды или права изменились. Обновите список участников.');
   const r=await c.query(`WITH people AS (SELECT p.id,p.user_id AS "userId",COALESCE(NULLIF(i.display_name,''),'Участник '||left(p.id::text,8)) AS name,m.role,m.status,i.disabled AS "identityDisabled"
    FROM lanka.principals p JOIN lanka.auth_identities i ON i.id=p.user_id
    JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
    WHERE p.tenant_id=$1)
    SELECT * FROM people WHERE ($2::uuid IS NULL OR (name COLLATE "und-x-icu",id)>(SELECT name COLLATE "und-x-icu",id FROM people WHERE id=$2))
      AND strpos(lower(name COLLATE "und-x-icu"),lower($3 COLLATE "und-x-icu"))>0
    ORDER BY name COLLATE "und-x-icu",id LIMIT 51`,[tenantId,filter.cursor??null,filter.search]);const members=r.rows.slice(0,50);return {members,nextCursor:r.rows.length>50?members[49].id:null,role:ctx.role,userId:ctx.userId,authzEpoch:ctx.authzEpoch};
  });
 }
 async setMembership(p:BrowserPrincipal,tenantId:string,input:unknown) {
  const command=membershipCommand.parse(input);
  return this.withTenant(p,tenantId,async(c,ctx)=>{
   if(ctx.role==='member')throw new OrganizationAccessError(403);
   const target=await c.query(`SELECT p.id,m.role,m.status FROM lanka.principals p JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
    WHERE p.tenant_id=$1 AND p.user_id=$2`,[tenantId,command.userId]);
   const before=target.rows[0]??null;
   if(ctx.role!=='owner'&&(command.role!=='member'||(before&&before.role!=='member')))throw new OrganizationAccessError(403);
   const old=await c.query('SELECT fingerprint,result FROM lanka.organization_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenantId,ctx.principalId,command.requestId]);
   if(old.rowCount){if(old.rows[0].fingerprint!==fingerprint(command))throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');return old.rows[0].result;}
   if(command.expectedEpoch!==undefined&&command.expectedEpoch!==ctx.authzEpoch)throw new OrganizationAccessError(409,'Состав команды или права изменились. Обновите список и подтвердите действие заново.');
   const identity=await c.query('SELECT 1 FROM lanka.auth_identities WHERE id=$1 AND NOT disabled',[command.userId]);
   if(!identity.rowCount)throw new OrganizationAccessError(404);
   if(before?.role==='owner'&&before.status==='active'&&(command.role!=='owner'||command.status!=='active')) {
    const others=await c.query(`SELECT 1 FROM lanka.organization_memberships m JOIN lanka.principals p ON p.tenant_id=m.tenant_id AND p.id=m.principal_id
     JOIN lanka.auth_identities i ON i.id=p.user_id WHERE m.tenant_id=$1 AND m.principal_id<>$2 AND m.role='owner' AND m.status='active' AND p.status='active' AND NOT i.disabled LIMIT 1`,[tenantId,before.id]);
    if(!others.rowCount)throw new OrganizationAccessError(409,'Назначьте ещё одного активного владельца организации.');
   }
   const principalId=before?.id??randomUUID();
   if(!before)await c.query("INSERT INTO lanka.principals(tenant_id,id,kind,user_id) VALUES($1,$2,'human',$3)",[tenantId,principalId,command.userId]);
   await c.query(`INSERT INTO lanka.organization_memberships(tenant_id,principal_id,role,status) VALUES($1,$2,$3,$4)
    ON CONFLICT(tenant_id,principal_id) DO UPDATE SET role=excluded.role,status=excluded.status`,[tenantId,principalId,command.role,command.status]);
   const changed=await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1 RETURNING authz_epoch',[tenantId]);
   const result={principalId,authzEpoch:String(changed.rows[0].authz_epoch)};
   await c.query('INSERT INTO lanka.organization_audit(tenant_id,sequence,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId,result.authzEpoch,ctx.principalId,'membership.set',principalId,JSON.stringify({before:before?{role:before.role,status:before.status}:null,after:{role:command.role,status:command.status}})]);
   await c.query('INSERT INTO lanka.organization_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenantId,ctx.principalId,command.requestId,fingerprint(command),JSON.stringify(result)]);
   return result;
  },true);
 }
 /** Personal projection only. Organization owner/admin does not imply access to other authors' projects. */
 async personalLibrary(p:BrowserPrincipal,tenantId:string,cursor?:string,options:{search?:string;folderId?:string;trashed?:boolean;pendingOnly?:boolean}={}) {
  if(cursor)uuid.parse(cursor);
  const filter=z.object({search:z.string().trim().max(140).default(''),folderId:uuid.optional(),trashed:z.boolean().default(false),pendingOnly:z.boolean().default(false)}).strict().parse(options);
  return this.withTenant(p,tenantId,async(c,ctx)=>{
   const folders={rows:await libraryFoldersIn(c,ctx)};
   if(filter.folderId&&!folders.rows.some(f=>f.id===filter.folderId))throw new OrganizationAccessError(404);
   const documents=await c.query(`SELECT id,project,folder_id,trashed,updated_at,(SELECT json_build_object('likes',count(*) FILTER(WHERE kind='like'),'liked',coalesce(bool_or(principal_id=$2 AND kind='like'),false),'bookmarked',coalesce(bool_or(principal_id=$2 AND kind='bookmark'),false)) FROM lanka.document_reactions WHERE tenant_id=$1 AND material_id=materials.id) AS reactions,EXISTS(SELECT 1 FROM lanka.resource_nodes n JOIN lanka.resource_nodes parent ON parent.tenant_id=n.tenant_id AND parent.id=n.parent_folder_id WHERE n.tenant_id=$1 AND n.material_id=materials.id AND parent.owner_id<>$2) AS in_shared_folder
    FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND trashed=$6
    AND (NOT $7::boolean OR EXISTS (SELECT 1 FROM jsonb_array_elements(project->'state'->'proposals') proposal WHERE proposal->>'status'='pending'))
    AND strpos(lower((project->>'title') COLLATE "und-x-icu"),lower($4 COLLATE "und-x-icu"))>0 AND ($5::uuid IS NULL OR folder_id=$5)
    AND ($3::uuid IS NULL OR (updated_at,id)<(SELECT updated_at,id FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND trashed=$6))
    ORDER BY updated_at DESC,id DESC LIMIT 51`,[tenantId,ctx.principalId,cursor??null,filter.search,filter.folderId??null,filter.trashed,filter.pendingOnly]);
   const items=documents.rows.slice(0,50).map(r=>{const project=r.project as FolderProject,doc=project.state.doc;return {id:r.id,title:project.title,folderId:r.folder_id,inSharedFolder:!!r.in_shared_folder,reactions:r.reactions,trashed:r.trashed,updatedAt:r.updated_at.toISOString(),revision:project.state.revision,slideCount:doc.slides.length,design:doc.design,pending:project.state.proposals.filter(p=>p.status==='pending').length,preview:doc.slides[0]?{slide:doc.slides[0],brand:doc.brand}:null};});
   return {folders:folders.rows,documents:items,nextCursor:documents.rows.length>50?items[49].id:null};
  });
 }
 async personalProject(p:BrowserPrincipal,tenantId:string,materialId:string) {
  uuid.parse(materialId);
  return this.withTenant(p,tenantId,async(c,ctx)=>{
   const r=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND NOT trashed',[tenantId,ctx.principalId,materialId]);
   if(!r.rowCount)throw new OrganizationAccessError(404);
   const project=r.rows[0].project as FolderProject;project.state.doc=validateDoc(project.state.doc);validateReferences(project.state);return project;
  });
 }
}

/** Operator provisioning, deliberately absent from browser/MCP routes. Owner identity must already exist. */
export async function provisionOrganization(pool:DatabasePool,input:unknown) {
 const command=z.object({requestId:uuid,slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),name:z.string().trim().min(1).max(180),ownerUserId:uuid}).strict().parse(input);
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('lanka:organization-provision',0))");
  const old=await c.query('SELECT provision_hash FROM lanka.tenants WHERE id=$1',[command.requestId]);
  if(old.rowCount){if(old.rows[0].provision_hash!==fingerprint(command))throw new OrganizationAccessError(409);await c.query('COMMIT');return {tenantId:command.requestId};}
  const identity=await c.query('SELECT 1 FROM lanka.auth_identities WHERE id=$1 AND NOT disabled FOR SHARE',[command.ownerUserId]);
  if(!identity.rowCount)throw new OrganizationAccessError(404);
  await c.query('INSERT INTO lanka.tenants(id,slug,name,created_by,provision_hash) VALUES($1,$2,$3,$4,$5)',[command.requestId,command.slug,command.name,command.ownerUserId,fingerprint(command)]);
  const id=randomUUID();await c.query("INSERT INTO lanka.principals(tenant_id,id,kind,user_id) VALUES($1,$2,'human',$3)",[command.requestId,id,command.ownerUserId]);
  await c.query("INSERT INTO lanka.organization_memberships(tenant_id,principal_id,role,status) VALUES($1,$2,'owner','active')",[command.requestId,id]);
  await c.query("INSERT INTO lanka.organization_audit(tenant_id,sequence,actor_id,action,target_id,metadata) VALUES($1,1,NULL,'organization.provisioned',$2,'{}')",[command.requestId,id]);
  await c.query('COMMIT');return {tenantId:command.requestId};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
