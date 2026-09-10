import {claimExecution,reportExecution,executionViews,requireExecution} from './bridge-executions';
import {bridgeTaskSchema} from '../../project/bridge-task';
import {bridgeSelectionSchema} from '../../project/bridge-selection';
import {saveBridgeSelection,readBridgeSelections} from './agent-bridge-selection';
import {bridgeResultsSchema,saveBridgeResults,readBridgeResults} from './agent-bridge-results';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {BrowserPrincipal} from '../../server/browser-identity';
import type {CorporatePrincipal,DelegatedPrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
import {PostgresResourceAccess} from './resource-access';
import {WorkspaceSessions} from './workspace-sessions';
const uuid=z.string().uuid(),body=z.string().trim().min(1).max(12000);
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const publicFields='id,sequence::text,role,text,origin,actor_id AS "actorId",reply_to AS "replyTo",delivery,task,created_at AS "createdAt"';
/** MCP-only mailbox. A tool call does not attest native-runtime delivery or mirror another chat. */
export class AgentBridge {
 private sessions:WorkspaceSessions;
 constructor(private resources:PostgresResourceAccess){this.sessions=new WorkspaceSessions(resources);}
 private tx<T>(p:CorporatePrincipal,tenant:string,sessionId:string,fn:(c:PoolClient,ctx:OrganizationContext)=>Promise<T>,lockOwner=false){
  uuid.parse(sessionId);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(lockOwner)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':'+ctx.principalId]);
   await this.sessions.ownedIn(c,ctx,sessionId);
   await c.query('SELECT id FROM lanka.agent_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,sessionId]);
   if(ctx.delegation){const b=await c.query('SELECT 1 FROM lanka.agent_bindings WHERE tenant_id=$1 AND session_id=$2 AND delegation_id=$3',[tenant,sessionId,ctx.delegation.id]);if(!b.rowCount)throw new OrganizationAccessError(403,'Ключ не подключён к этой беседе.');}
   return fn(c,ctx);
  },false,{workspace:true,capability:'read'});
 }
 claim(p:DelegatedPrincipal,tenant:string,sessionId:string,input:unknown){if(p.kind!=='delegated')throw new OrganizationAccessError(403);return this.tx(p,tenant,sessionId,(c,ctx)=>claimExecution(c,ctx,sessionId,input),true);}
 report(p:DelegatedPrincipal,tenant:string,sessionId:string,input:unknown){if(p.kind!=='delegated')throw new OrganizationAccessError(403);return this.tx(p,tenant,sessionId,(c,ctx)=>reportExecution(c,ctx,sessionId,input));}
 list(p:CorporatePrincipal,tenant:string,input:unknown={}){
  const a=z.object({after:uuid.optional(),documentId:uuid.optional()}).strict().parse(input);
  return this.resources.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(a.documentId){const n=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,a.documentId]);if(!n.rowCount)throw new OrganizationAccessError(404);await this.resources.permissionIn(c,ctx,n.rows[0].id);}
   const rows=await c.query(`SELECT s.id,s.title,s.scope_kind AS scope,s.folder_resource_id AS "folderResourceId" FROM lanka.agent_sessions s
    WHERE s.tenant_id=$1 AND s.owner_id=$2 AND s.scope_kind IN ('workspace','folder') AND ($3::uuid IS NULL OR s.id>$3)
    AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM lanka.agent_session_materials a WHERE a.tenant_id=s.tenant_id AND a.session_id=s.id AND a.material_id=$5))
    AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM lanka.agent_bindings b WHERE b.tenant_id=s.tenant_id AND b.session_id=s.id AND b.delegation_id=$4)) ORDER BY s.id LIMIT 51`,[tenant,ctx.principalId,a.after??null,ctx.delegation?.id??null,a.documentId??null]);
   const sessions=[];for(const row of rows.rows.slice(0,50))try{await this.sessions.ownedIn(c,ctx,row.id);sessions.push(row);}catch(e){if(!(e instanceof OrganizationAccessError))throw e;}
   return {sessions,nextCursor:rows.rows.length>50?rows.rows[49].id:null,mode:'mcp_only'};
  },false,{workspace:true,capability:'read'});
 }
 bind(p:BrowserPrincipal,tenant:string,sessionId:string,input:unknown){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);
  const a=z.object({delegationId:uuid,expectedDelegationId:uuid.nullable(),taskBound:z.boolean().optional()}).strict().parse(input);
  return this.tx(p,tenant,sessionId,async(c,ctx)=>{
   const s=await this.sessions.ownedIn(c,ctx,sessionId);
   const key=await c.query(`SELECT d.folder_resource_id FROM lanka.agent_delegations d JOIN lanka.auth_identities i ON i.id=$4
    WHERE d.tenant_id=$1 AND d.id=$2 AND d.issuer_id=$3 AND d.scope_kind='workspace'
    AND d.revoked_at IS NULL AND d.expires_at>now() AND d.auth_epoch=i.auth_epoch AND NOT i.disabled`,[tenant,a.delegationId,ctx.principalId,ctx.userId]);
   if(!key.rowCount)throw new OrganizationAccessError(404,'Подключение недоступно.');
   // Exact scope avoids exposing a workspace transcript to a key restricted to one folder.
   if((key.rows[0].folder_resource_id??null)!==(s.folder_resource_id??null))throw new OrganizationAccessError(403,'Область ключа должна совпадать с областью беседы.');
   const current=await c.query('SELECT delegation_id FROM lanka.agent_bindings WHERE tenant_id=$1 AND session_id=$2',[tenant,sessionId]);
   const id=current.rows[0]?.delegation_id??null;
   if(a.taskBound)await c.query('UPDATE lanka.agent_delegations SET requires_task=true WHERE tenant_id=$1 AND id=$2',[tenant,a.delegationId]);
   if(id===a.delegationId)return {delegationId:id,mode:'mcp_only'};
   if(id!==a.expectedDelegationId)throw new OrganizationAccessError(409,'Подключение изменилось. Обновите беседу.');
   const active=await c.query("SELECT 1 FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND delivery='received_by_mcp_client'",[tenant,sessionId]);
   if(active.rowCount)throw new OrganizationAccessError(409,'Сначала завершите или отмените полученное агентом сообщение.');
   await c.query('INSERT INTO lanka.agent_bindings(tenant_id,session_id,delegation_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,session_id) DO UPDATE SET delegation_id=excluded.delegation_id,created_at=now()',[tenant,sessionId,a.delegationId]);
   return {delegationId:a.delegationId,mode:'mcp_only'};
  });
 }
 send(p:BrowserPrincipal,tenant:string,sessionId:string,input:unknown){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);
  const a=z.object({requestId:uuid,text:body,selection:bridgeSelectionSchema.optional(),task:bridgeTaskSchema.optional()}).strict().parse(input);
  return this.tx(p,tenant,sessionId,async(c,ctx)=>{
   const fp=hash({role:'user',...a}),old=await c.query('SELECT fingerprint FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3',[tenant,sessionId,a.requestId]);
   if(old.rowCount){if(old.rows[0].fingerprint!==fp)throw new OrganizationAccessError(409,'Ключ повтора использован для другого сообщения.');return {id:a.requestId};}
   const pending=await c.query("SELECT count(*)::int AS n FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND delivery IN ('waiting','received_by_mcp_client')",[tenant,sessionId]);
   if(pending.rows[0].n>=20)throw new OrganizationAccessError(409,'В очереди уже 20 сообщений.');
   await this.insert(c,tenant,sessionId,a.requestId,'user',a.text,ctx.principalId,null,fp);
   if(a.task?.documentId){const allowed=await this.sessions.readIn(c,ctx,sessionId);if(!allowed.documents.some(d=>d.id===a.task!.documentId))throw new OrganizationAccessError(403,'Документ поручения недоступен в беседе.');}
   if(a.task&&a.selection&&a.task.documentId!==a.selection.documentId)throw new OrganizationAccessError(409,'Контекст и область поручения относятся к разным документам.');
   if(a.task?.limitToSelection&&(!a.selection||a.task.mode!=='propose'||a.task.documentId!==a.selection.documentId))throw new OrganizationAccessError(409,'Ограничение правки требует выбранного слайда или объекта в документе поручения.');
   if(a.task)await c.query('UPDATE lanka.agent_bridge_messages SET task=$4 WHERE tenant_id=$1 AND session_id=$2 AND id=$3',[tenant,sessionId,a.requestId,a.task]);
   if(a.selection)await saveBridgeSelection(c,this.resources,ctx,sessionId,a.requestId,a.selection);
   return {id:a.requestId};
  });
 }
 private async insert(c:PoolClient,tenant:string,session:string,id:string,role:'user'|'assistant',text:string,actor:string,reply:string|null,fp:string){
  const s=await c.query('UPDATE lanka.agent_sessions SET next_message_seq=next_message_seq+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING next_message_seq',[tenant,session]);
  await c.query('INSERT INTO lanka.agent_bridge_messages(tenant_id,session_id,id,sequence,role,text,origin,actor_id,reply_to,fingerprint,delivery) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[tenant,session,id,s.rows[0].next_message_seq,role,text,role==='user'?'lanka':'mcp',actor,reply,fp,role==='user'?'waiting':'completed']);
 }
 read(p:CorporatePrincipal,tenant:string,sessionId:string,input:unknown={}){
  const a=z.object({after:z.string().regex(/^\d{1,18}$/).default('0')}).strict().parse(input);
  return this.tx(p,tenant,sessionId,async(c,ctx)=>{
   const rows=await c.query(`SELECT ${publicFields} FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 101`,[tenant,sessionId,a.after]);
   const messages=rows.rows.slice(0,100);
   const results=await readBridgeResults(c,this.resources,ctx,sessionId,messages.map(m=>m.id));
   const selections=await readBridgeSelections(c,this.resources,ctx,sessionId,messages.map(m=>m.id));
   const executions=await executionViews(c,tenant,sessionId,messages.map(m=>m.id));
   for(const m of messages){if(executions[m.id])m.execution=executions[m.id];m.results=results[m.id]??[];if(selections[m.id])m.selection=selections[m.id];}
   const b=await c.query(`SELECT d.id,d.name,d.requires_task AS "taskBound",d.revoked_at IS NULL AND d.expires_at>now() AND d.auth_epoch=i.auth_epoch AND NOT i.disabled AS active
    FROM lanka.agent_bindings b JOIN lanka.agent_delegations d ON d.tenant_id=b.tenant_id AND d.id=b.delegation_id
    JOIN lanka.principals p ON p.tenant_id=d.tenant_id AND p.id=d.issuer_id JOIN lanka.auth_identities i ON i.id=p.user_id WHERE b.tenant_id=$1 AND b.session_id=$2`,[tenant,sessionId]);
   const session=await this.sessions.readIn(c,ctx,sessionId);
   for(const m of messages)if(m.task?.documentId&&!session.documents.some(d=>d.id===m.task.documentId))m.task={mode:m.task.mode,available:false};
   return {sessionId,session:{id:session.id,title:session.title,scope:session.scope,folderResourceId:session.folderResourceId},documents:session.documents,unavailableDocumentCount:session.unavailableDocumentCount,mode:'mcp_only',binding:b.rows[0]??null,messages,nextCursor:messages.at(-1)?.sequence??a.after,hasMore:rows.rows.length>100};
  });
 }
 receive(p:DelegatedPrincipal,tenant:string,sessionId:string){
  if(p.kind!=='delegated')throw new OrganizationAccessError(403);
  return this.tx(p,tenant,sessionId,async(c,ctx)=>{
   // Retry returns the same outstanding item; no automatic re-execution after a disconnect.
   let r=await c.query(`SELECT ${publicFields} FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND delivery='received_by_mcp_client' ORDER BY sequence LIMIT 1`,[tenant,sessionId]);
   if(!r.rowCount){r=await c.query(`UPDATE lanka.agent_bridge_messages SET delivery='received_by_mcp_client' WHERE tenant_id=$1 AND session_id=$2 AND id=(SELECT id FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND delivery='waiting' ORDER BY sequence LIMIT 1) RETURNING ${publicFields}`,[tenant,sessionId]);}
   if(r.rows[0]){const selections=await readBridgeSelections(c,this.resources,ctx,sessionId,[r.rows[0].id]);if(selections[r.rows[0].id])r.rows[0].selection=selections[r.rows[0].id];}
   if(r.rows[0]){const executions=await executionViews(c,tenant,sessionId,[r.rows[0].id]);if(executions[r.rows[0].id])r.rows[0].execution=executions[r.rows[0].id];}
   const context=await this.sessions.readIn(c,ctx,sessionId);
   if(r.rows[0]?.task?.documentId&&!context.documents.some(d=>d.id===r.rows[0].task.documentId))r.rows[0].task={mode:r.rows[0].task.mode,available:false};
   return {message:r.rows[0]??null,documents:context.documents,mode:'mcp_only'};
  });
 }
 reply(p:DelegatedPrincipal,tenant:string,sessionId:string,input:unknown){
  if(p.kind!=='delegated')throw new OrganizationAccessError(403);
  const a=z.object({requestId:uuid,replyTo:uuid,text:body,results:bridgeResultsSchema.optional(),executionId:uuid.optional()}).strict().parse(input);
  return this.tx(p,tenant,sessionId,async(c,ctx)=>{
   const fp=hash({role:'assistant',actor:ctx.delegation!.id,...a}),old=await c.query('SELECT fingerprint FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3',[tenant,sessionId,a.requestId]);
   if(old.rowCount){if(old.rows[0].fingerprint!==fp)throw new OrganizationAccessError(409,'Ключ повтора использован для другого ответа.');return {id:a.requestId};}
   const m=await c.query("SELECT 1 FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND role='user' AND delivery='received_by_mcp_client'",[tenant,sessionId,a.replyTo]);
   if(!m.rowCount)throw new OrganizationAccessError(409,'Сообщение не ожидает ответа этого подключения.');
   await requireExecution(c,tenant,sessionId,a.replyTo,a.executionId);
   await this.insert(c,tenant,sessionId,a.requestId,'assistant',a.text,ctx.delegation!.id,a.replyTo,fp);
   await saveBridgeResults(c,this.resources,ctx,sessionId,a.requestId,a.results??[]);
   await c.query("UPDATE lanka.agent_bridge_messages SET delivery='completed' WHERE tenant_id=$1 AND session_id=$2 AND id=$3",[tenant,sessionId,a.replyTo]);
   return {id:a.requestId};
  });
 }
 cancel(p:BrowserPrincipal,tenant:string,sessionId:string,messageId:string){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);uuid.parse(messageId);
  return this.tx(p,tenant,sessionId,async c=>{
   const r=await c.query("UPDATE lanka.agent_bridge_messages SET delivery='cancelled' WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND role='user' AND delivery IN ('waiting','received_by_mcp_client','cancelled') RETURNING id",[tenant,sessionId,messageId]);
   if(!r.rowCount)throw new OrganizationAccessError(409,'Сообщение уже завершено или недоступно.');
   return {id:messageId,delivery:'cancelled',documentAccessRevoked:false};
  });
 }
}
