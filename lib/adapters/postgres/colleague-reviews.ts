import {readColleagueReviewVersionIn} from './revision-dependencies';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {colleagueReviewCommandSchema,colleagueReviewSchema,createColleagueReview,ColleagueReviewConflict,ColleagueReviewForbidden,type ColleagueReview} from '../../domain/colleague-review';
import {PostgresResourceAccess} from './resource-access';
import {writeColleagueReviewIn} from './colleague-review-storage';
const uuid=z.string().uuid();
const pageInput=z.object({cursor:uuid.optional(),expectedEpoch:z.string().regex(/^\d+$/).max(30).optional()}).strict();
// $1 tenant, $2 eligible resource IDs, $3 eligible owner IDs. All fragments below
// are fixed application SQL; caller input remains bound parameters.
const eligiblePerson=(person:string,roles:string,resources='$2::uuid[]',owners='$3::uuid[]')=>`EXISTS (
 SELECT 1 FROM lanka.principals ep
 JOIN lanka.organization_memberships em ON em.tenant_id=ep.tenant_id AND em.principal_id=ep.id
 JOIN lanka.auth_identities ei ON ei.id=ep.user_id
 WHERE ep.tenant_id=$1 AND ep.id=${person} AND ep.status='active' AND em.status='active' AND NOT ei.disabled
 AND (ep.id=ANY(${owners}) OR EXISTS (
  SELECT 1 FROM lanka.acl_grants ag WHERE ag.tenant_id=$1 AND ag.resource_id=ANY(${resources}) AND ag.role IN (${roles})
  AND (ag.principal_id=ep.id OR ag.group_id IN (SELECT gm.group_id FROM lanka.group_members gm JOIN lanka.groups g ON g.tenant_id=gm.tenant_id AND g.id=gm.group_id WHERE gm.tenant_id=$1 AND gm.principal_id=ep.id AND g.status='active')))))`;
/** Authorized request metadata and a sanitized visible-version projection.
 * The raw archive, original source files and private conversation are never returned. */
export class OrganizationColleagueReviews {
 constructor(private resources:PostgresResourceAccess){}
 private human(p:CorporatePrincipal){if(p.kind!=='oidc')throw new OrganizationAccessError(403,'Запрос проверки и ответ подтверждает участник компании.');}
 private async participant(c:PoolClient,ctx:OrganizationContext,resource:string,principal:string,minimum:'commenter'|'editor'){
  const row=(await c.query(`SELECT p.user_id,m.role FROM lanka.principals p
   JOIN lanka.organization_memberships m ON m.tenant_id=p.tenant_id AND m.principal_id=p.id
   JOIN lanka.auth_identities i ON i.id=p.user_id
   WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='active' AND m.status='active' AND NOT i.disabled FOR SHARE OF p,m,i`,[ctx.tenantId,principal])).rows[0];
  if(!row)throw new OrganizationAccessError(404);
  await this.resources.permissionIn(c,{tenantId:ctx.tenantId,principalId:principal,userId:row.user_id,role:row.role,authzEpoch:ctx.authzEpoch},resource,minimum);
 }
 private async participants(c:PoolClient,ctx:OrganizationContext,resource:string,sender:string,recipient:string){
  // Stable locking order for requests between the same people in opposite directions.
  for(const [person,role] of ([[sender,'editor'],[recipient,'commenter']] as const).slice().sort((a,b)=>a[0].localeCompare(b[0])))
   await this.participant(c,ctx,resource,person,role);
 }
 private async pageScope(c:PoolClient,ctx:OrganizationContext,resource:string,input:z.infer<typeof pageInput>){
  if((input.cursor&&!input.expectedEpoch)||(input.expectedEpoch&&input.expectedEpoch!==ctx.authzEpoch))throw new OrganizationAccessError(409,'Права изменились. Обновите список.');
  const nodes=(await this.resources.ancestryIn(c,ctx,resource)).filter(n=>n.eligible);
  return [ctx.tenantId,nodes.map(n=>n.id),nodes.map(n=>n.owner_id)];
 }
 inbox(p:CorporatePrincipal,tenant:string,input:unknown={}){
  this.human(p);const filter=pageInput.parse(input);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if((filter.cursor&&!filter.expectedEpoch)||(filter.expectedEpoch&&filter.expectedEpoch!==ctx.authzEpoch))throw new OrganizationAccessError(409,'Права изменились. Обновите список.');
   const rows=(await c.query(`SELECT r.id,r.material_id AS "documentId",m.project->>'title' AS title,r.state,
    COALESCE(NULLIF(i.display_name,''),'Участник') AS "senderName"
    FROM lanka.colleague_reviews r
    JOIN lanka.materials m ON m.tenant_id=r.tenant_id AND m.id=r.material_id AND NOT m.trashed
    JOIN lanka.resource_nodes n ON n.tenant_id=r.tenant_id AND n.material_id=r.material_id
    JOIN lanka.principals p ON p.tenant_id=r.tenant_id AND p.id=r.sender_id
    JOIN lanka.auth_identities i ON i.id=p.user_id
    CROSS JOIN LATERAL (
     WITH RECURSIVE ancestry AS (
      SELECT n.*,0 AS depth,true AS eligible,ARRAY[n.id] AS visited
      UNION ALL SELECT parent.*,a.depth+1,a.eligible AND a.inheritance='inherit',a.visited||parent.id
      FROM ancestry a JOIN lanka.resource_nodes parent ON parent.tenant_id=a.tenant_id AND parent.id=a.parent_folder_id
      WHERE a.depth<65 AND NOT parent.id=ANY(a.visited)
     ) SELECT array_agg(id) FILTER (WHERE eligible) AS resources,array_agg(owner_id) FILTER (WHERE eligible) AS owners,
      bool_and(deleted_at IS NULL) AND (array_agg(parent_folder_id ORDER BY depth DESC))[1] IS NULL AS valid FROM ancestry
    ) scope
    WHERE r.tenant_id=$1 AND r.recipient_id=$2 AND r.state->>'status'='pending' AND scope.valid
    AND ($3::uuid IS NULL OR r.id>$3)
    AND ${eligiblePerson('r.sender_id',"'editor','manager'",'scope.resources','scope.owners')}
    AND ${eligiblePerson('r.recipient_id',"'commenter','editor','manager'",'scope.resources','scope.owners')}
    ORDER BY r.id LIMIT 51`,[tenant,ctx.principalId,filter.cursor??null])).rows;
   const items=rows.slice(0,50).map(row=>{const review=colleagueReviewSchema.parse(row.state);return {id:review.id,documentId:row.documentId,title:row.title,senderName:row.senderName,target:review.target,note:review.note,createdAt:review.createdAt};});
   return {items,nextCursor:rows.length>50?items[49].id:null,authzEpoch:ctx.authzEpoch};
  });
 }
 recipients(p:CorporatePrincipal,tenant:string,document:string,input:unknown={}){
  this.human(p);const filter=pageInput.extend({search:z.string().trim().max(140).default('')}).parse(input);
  return this.resources.withMaterial(p,tenant,document,'editor',async(c,ctx,permission)=>{
   await this.material(c,tenant,document);const scope=await this.pageScope(c,ctx,permission.resourceId,filter);
   const rows=(await c.query(`SELECT p.id,COALESCE(NULLIF(i.display_name,''),'Участник') AS name FROM lanka.principals p JOIN lanka.auth_identities i ON i.id=p.user_id
    WHERE p.tenant_id=$1 AND p.id<>$4 AND ($5::uuid IS NULL OR p.id>$5) AND strpos(lower(COALESCE(i.display_name,'')),lower($6))>0
    AND ${eligiblePerson('p.id',"'commenter','editor','manager'")} ORDER BY p.id LIMIT 51`,[...scope,ctx.principalId,filter.cursor??null,filter.search])).rows as {id:string;name:string}[];
   const items=rows.slice(0,50);return {items,nextCursor:rows.length>50?items[49].id:null,authzEpoch:ctx.authzEpoch};
  });
 }
 list(p:CorporatePrincipal,tenant:string,document:string,input:unknown={}){this.human(p);return this.listAuthorized(p,tenant,document,input,'commenter');}
 async agentList(p:CorporatePrincipal,tenant:string,document:string,input:unknown={}){
  if(p.kind!=='delegated')throw new OrganizationAccessError(403);
  const {items,nextCursor,authzEpoch,headRevision}=await this.listAuthorized(p,tenant,document,input,'viewer');
  return {items,nextCursor,authzEpoch,headRevision};
 }
 private listAuthorized(p:CorporatePrincipal,tenant:string,document:string,input:unknown,minimum:'viewer'|'commenter'){
  const filter=pageInput.extend({status:z.enum(['pending','responded','cancelled','all']).default('pending')}).parse(input);
  return this.resources.withMaterial(p,tenant,document,minimum,async(c,ctx,permission)=>{
   const headRevision=await this.material(c,tenant,document),scope=await this.pageScope(c,ctx,permission.resourceId,filter);
   const rows=(await c.query(`SELECT r.id,r.state FROM lanka.colleague_reviews r WHERE r.tenant_id=$1 AND r.material_id=$4 AND (r.sender_id=$5 OR r.recipient_id=$5)
    AND ($6::uuid IS NULL OR r.id>$6) AND ($7='all' OR r.state->>'status'=$7)
    AND ${eligiblePerson('r.sender_id',"'editor','manager'")} AND ${eligiblePerson('r.recipient_id',"'commenter','editor','manager'")}
    ORDER BY r.id LIMIT 51`,[...scope,document,ctx.principalId,filter.cursor??null,filter.status])).rows;
   const items=rows.slice(0,50).map(row=>colleagueReviewSchema.parse(row.state));
   const names=(await c.query("SELECT p.id,COALESCE(NULLIF(i.display_name,''),'Участник') AS name FROM lanka.principals p JOIN lanka.auth_identities i ON i.id=p.user_id WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[])",[tenant,[...new Set(items.flatMap(item=>[item.senderId,item.recipientId]))]])).rows;
   const name=(id:string)=>names.find(row=>row.id===id)?.name??'Участник';
   const archive=(await c.query('SELECT hash FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3',[tenant,document,headRevision])).rows[0];
   return {items:items.map(item=>({...item,senderName:name(item.senderId),recipientName:name(item.recipientId)})),nextCursor:rows.length>50?items[49].id:null,authzEpoch:ctx.authzEpoch,headRevision,actorId:ctx.principalId,canRequest:['editor','manager'].includes(permission.role),target:archive?{revision:headRevision,documentHash:archive.hash}:null};
  });
 }
 private async stored(c:PoolClient,tenant:string,document:string,id:string){
  const row=(await c.query('SELECT state FROM lanka.colleague_reviews WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[tenant,document,id])).rows[0];
  if(!row)throw new OrganizationAccessError(404);return colleagueReviewSchema.parse(row.state);
 }
 private async material(c:PoolClient,tenant:string,document:string){
  const row=(await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND NOT trashed FOR SHARE',[tenant,document])).rows[0];
  if(!row)throw new OrganizationAccessError(404);return row.project.state.revision as number;
 }
 read(p:CorporatePrincipal,tenant:string,document:string,id:string){this.human(p);return this.readAuthorized(p,tenant,document,id,'commenter');}
 agentRead(p:CorporatePrincipal,tenant:string,document:string,id:string){
  if(p.kind!=='delegated')throw new OrganizationAccessError(403);
  return this.readAuthorized(p,tenant,document,id,'viewer');
 }
 private readAuthorized(p:CorporatePrincipal,tenant:string,document:string,id:string,minimum:'viewer'|'commenter'){
  uuid.parse(id);
  return this.resources.withMaterial(p,tenant,document,minimum,async(c,ctx,permission)=>{
   const review=await this.stored(c,tenant,document,id);
   if(![review.senderId,review.recipientId].includes(ctx.principalId))throw new OrganizationAccessError(404);
   await this.participants(c,ctx,permission.resourceId,review.senderId,review.recipientId);
   const headRevision=await this.material(c,tenant,document);
   return {review,headRevision,hasNewVersion:headRevision!==review.target.revision};
  });
 }
 /** Visible, pinned version only, prepared inside the current authorization transaction. */
 version(p:CorporatePrincipal,tenant:string,document:string,id:string){
  this.human(p);uuid.parse(id);
  return this.resources.withMaterial(p,tenant,document,'commenter',async(c,ctx,permission)=>{
   const review=await this.stored(c,tenant,document,id);
   if(![review.senderId,review.recipientId].includes(ctx.principalId))throw new OrganizationAccessError(404);
   await this.participants(c,ctx,permission.resourceId,review.senderId,review.recipientId);
   const headRevision=await this.material(c,tenant,document);
   const prepared=await readColleagueReviewVersionIn(c,review);
   return {review,headRevision,hasNewVersion:headRevision!==review.target.revision,...prepared};
  });
 }
 write(p:CorporatePrincipal,tenant:string,document:string,input:unknown):Promise<ColleagueReview>{
  this.human(p);const command=colleagueReviewCommandSchema.parse(input);
  return this.resources.withMaterial(p,tenant,document,command.action==='respond'?'commenter':'editor',async(c,ctx,permission)=>{
   await this.material(c,tenant,document);
   const existing=command.action==='create'?null:await this.stored(c,tenant,document,command.id);
   const sender=existing?.senderId??ctx.principalId,recipient=existing?.recipientId??(command.action==='create'?command.recipientId:'');
   if(existing&&ctx.principalId!==(command.action==='respond'?recipient:sender))throw new OrganizationAccessError(404);
   await this.participants(c,ctx,permission.resourceId,sender,recipient);
   const target=existing?.target??(command.action==='create'?command.target:null)!;
   const archive=await c.query('SELECT 1 FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3 AND hash=$4',[tenant,document,target.revision,target.documentHash]);
   if(!archive.rowCount)throw new OrganizationAccessError(409,'Выбранная версия недоступна.');
   // Do not create or answer a request whose visible archived version cannot be read.
   if(command.action!=='cancel')await readColleagueReviewVersionIn(c,existing??createColleagueReview(command,{id:command.requestId,tenantId:tenant,documentId:document,senderId:ctx.principalId,now:new Date().toISOString()}));
   // Every retry reaches these live access checks before the stored receipt is read.
   try{return await writeColleagueReviewIn(c,{tenantId:tenant,documentId:document,actorId:ctx.principalId},command);}
   catch(e){if(e instanceof ColleagueReviewConflict)throw new OrganizationAccessError(409,e.message);if(e instanceof ColleagueReviewForbidden)throw new OrganizationAccessError(403,e.message);throw e;}
  });
 }
}
