import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {commentAnchor} from '../../domain/comment-anchor';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import type {FolderProject} from '../../project/package';
import type {SharedComment,SharedCommentsView} from '../../project/shared-comments';
import {PostgresResourceAccess} from './resource-access';
const requestSchema=z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),slideId:z.string().uuid(),text:z.string().trim().min(1).max(2000),replyTo:z.string().uuid().optional(),elementId:z.string().min(1).max(160).optional()}).strict();
const statusSchema=z.object({requestId:z.string().uuid(),action:z.literal("set_status"),commentId:z.string().uuid(),expectedStatusVersion:z.number().int().nonnegative(),resolved:z.boolean()}).strict();
/** Explicit projection: old notes, proposal references and object quotes remain private. */
function sharedComments(p:FolderProject):SharedComment[] {
 const visible=p.state.comments.filter(c=>c.visibility==='shared'&&c.authorPrincipalId&&c.revision);
 const ids=new Set(visible.filter(c=>!c.replyTo).map(c=>c.id));
 return visible.filter(c=>!c.replyTo||ids.has(c.replyTo)).map(c=>({id:c.id,slideId:c.slideId,text:c.text,author:c.author,authorPrincipalId:c.authorPrincipalId!,createdAt:c.createdAt,...(c.delegationId?{delegationId:c.delegationId}:{}),resolved:c.resolved,revision:c.revision!,statusVersion:c.statusVersion??0,statusHistory:(c.statusHistory??[]).map(e=>({version:e.version,resolved:e.resolved,actorPrincipalId:e.actorPrincipalId,author:e.author,createdAt:e.createdAt,...(e.delegationId?{delegationId:e.delegationId}:{})})),...(c.anchor?{anchor:{elementId:c.anchor.elementId,quote:c.anchor.quote,revision:c.anchor.revision}}:{}),...(c.replyTo?{replyTo:c.replyTo}:{})}));
}
export class OrganizationDocumentComments {
 constructor(private resources:PostgresResourceAccess){}
 read(p:CorporatePrincipal,tenant:string,document:string):Promise<SharedCommentsView> {
  return this.resources.withMaterial(p,tenant,document,'viewer',async(c,ctx,permission)=>{
   const r=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed FOR SHARE',[tenant,document,permission.ownerId]);
   if(!r.rowCount)throw new OrganizationAccessError(404);
   const project=r.rows[0].project as FolderProject;
   return {revision:project.state.revision,canComment:permission.role!=='viewer',manageableIds:sharedComments(project).filter(c=>!c.replyTo&&permission.role!=='viewer'&&(c.authorPrincipalId===ctx.principalId||['editor','manager'].includes(permission.role))).map(c=>c.id),comments:sharedComments(project)};
  });
 }
 add(p:CorporatePrincipal,tenant:string,document:string,input:unknown) {
  const request=z.union([requestSchema,statusSchema]).parse(input),fingerprint=createHash('sha256').update(JSON.stringify({operation:'shared-comment',document,...(p.kind==='delegated'?{delegatedToken:p.tokenHash}:{}),...request})).digest('hex');
  return this.resources.withMaterial(p,tenant,document,'commenter',async(c,ctx,permission)=>{
   // The material row lock also serializes with owner edits; retain the current package verbatim.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${tenant}:${ctx.principalId}:comment:${request.requestId}`]);
   const r=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed FOR UPDATE',[tenant,document,permission.ownerId]);
   if(!r.rowCount)throw new OrganizationAccessError(404);
   const project=r.rows[0].project as FolderProject;
   const statusTarget='action' in request?project.state.comments.find(c=>c.id===request.commentId&&c.visibility==='shared'&&!c.replyTo):null;
   if('action' in request){
    if(!statusTarget)throw new OrganizationAccessError(404,'Обсуждение недоступно.');
    if(statusTarget.authorPrincipalId!==ctx.principalId&&!['editor','manager'].includes(permission.role))throw new OrganizationAccessError(403,'Закрыть обсуждение может его автор или редактор.');
   }
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,ctx.principalId,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');return prior.rows[0].result as {comment:SharedComment};}
   let comment:SharedComment;
   if('action' in request&&statusTarget){
    if((statusTarget.statusVersion??0)!==request.expectedStatusVersion)throw new OrganizationAccessError(409,'Обсуждение изменилось. Проверьте актуальный статус.');
    if(statusTarget.resolved!==request.resolved){
     if((statusTarget.statusHistory?.length??0)>=1000)throw new OrganizationAccessError(409,'Достигнут предел истории обсуждения.');
     const author=await c.query('SELECT i.display_name FROM lanka.principals p JOIN lanka.auth_identities i ON i.id=p.user_id WHERE p.tenant_id=$1 AND p.id=$2',[tenant,ctx.principalId]);
     statusTarget.resolved=request.resolved;statusTarget.statusVersion=(statusTarget.statusVersion??0)+1;
     (statusTarget.statusHistory??=[]).push({version:statusTarget.statusVersion,resolved:request.resolved,actorPrincipalId:ctx.principalId,author:ctx.delegation?`${ctx.delegation.name} · агент (${author.rows[0]?.display_name||'Участник'})`:author.rows[0]?.display_name||'Участник',...(ctx.delegation?{delegationId:ctx.delegation.id}:{}),createdAt:new Date().toISOString()});
    }
    comment=sharedComments(project).find(c=>c.id===statusTarget.id)!;
   }else if(!('action' in request)){
   if(project.state.revision!==request.expectedRevision)throw new OrganizationAccessError(409,'Версия изменилась. Обновите слайд перед отправкой комментария.');
   if(!project.state.doc.slides.some(s=>s.id===request.slideId))throw new OrganizationAccessError(404,'Слайд недоступен.');
   if(request.replyTo&&!sharedComments(project).some(c=>c.id===request.replyTo&&c.slideId===request.slideId&&!c.replyTo))throw new OrganizationAccessError(404,'Обсуждение недоступно.');
   const parent=request.replyTo?sharedComments(project).find(c=>c.id===request.replyTo):undefined;
   if(parent&&request.elementId&&request.elementId!==parent.anchor?.elementId)throw new OrganizationAccessError(409,'Ответ должен относиться к исходному обсуждению.');
   if(!parent&&request.elementId&&!project.state.doc.slides.find(s=>s.id===request.slideId)?.canvas?.some(e=>e.id===request.elementId))throw new OrganizationAccessError(404,'Объект недоступен. Выберите его заново.');
   const anchor=parent?.anchor??(!parent?commentAnchor(project.state,request.slideId,request.elementId):undefined);
   if(project.state.comments.length>=300)throw new OrganizationAccessError(409,'Достигнут предел 300 комментариев в документе.');
   const author=await c.query('SELECT i.display_name FROM lanka.principals p JOIN lanka.auth_identities i ON i.id=p.user_id WHERE p.tenant_id=$1 AND p.id=$2',[tenant,ctx.principalId]);
   comment={statusVersion:0,statusHistory:[],...(anchor?{anchor}:{}),id:randomUUID(),slideId:request.slideId,text:request.text,author:ctx.delegation?`${ctx.delegation.name} · агент (${author.rows[0]?.display_name||'Участник'})`:author.rows[0]?.display_name||'Участник',...(ctx.delegation?{delegationId:ctx.delegation.id}:{}),authorPrincipalId:ctx.principalId,createdAt:new Date().toISOString(),revision:project.state.revision,resolved:false,...(request.replyTo?{replyTo:request.replyTo}:{})};
   project.state.comments.push({...comment,visibility:'shared'});
   }else throw new OrganizationAccessError(404);
   const bytes=JSON.stringify(project);if(Buffer.byteLength(bytes)>1_500_000)throw new OrganizationAccessError(409,'Документ достиг предельного размера.');
   await c.query('UPDATE lanka.materials SET project=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND owner_id=$3',[tenant,document,permission.ownerId,bytes]);
   const result={comment};
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenant,ctx.principalId,request.requestId,fingerprint,JSON.stringify(result)]);
   return result;
  },{write:true});
 }
}
