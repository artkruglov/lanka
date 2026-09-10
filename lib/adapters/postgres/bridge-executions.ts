import {agentUsage} from './agent-usage';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {OrganizationContext} from '../../server/organization-access';
import {OrganizationAccessError} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
const uuid=z.string().uuid();
export const executionClaimSchema=z.object({messageId:uuid,executionId:uuid}).strict();
export const executionReportSchema=z.object({messageId:uuid,executionId:uuid,requestId:uuid,status:z.enum(['running','stopped','failed']),nativeThreadId:z.string().min(1).max(200).optional(),nativeTurnId:z.string().min(1).max(200).optional()}).strict();
const columns=`id,status,lease_expires_at AS "leaseExpiresAt",last_seen_at AS "lastSeenAt",lease_expires_at>clock_timestamp() AS live`;
const projection=(r:Record<string,unknown>)=>({id:r.id,state:!r.live&&['claimed','running'].includes(String(r.status))?'unknown':r.status,leaseExpiresAt:r.leaseExpiresAt,lastSeenAt:r.lastSeenAt,reportedBy:'external_mcp_client'});
/** Every caller already holds the bound private-session lock and current key authorization. */
export async function claimExecution(c:PoolClient,ctx:OrganizationContext,sessionId:string,input:unknown){
 const a=executionClaimSchema.parse(input);
 const existing=await c.query(`SELECT ${columns},delegation_id FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 FOR UPDATE`,[ctx.tenantId,sessionId,a.messageId]);
 if(existing.rowCount){if(existing.rows[0].id!==a.executionId||existing.rows[0].delegation_id!==ctx.delegation!.id)throw new OrganizationAccessError(409,'Поручение уже закреплено за другим исполнением. Автоматический повтор не разрешён.');return {execution:projection(existing.rows[0]),replayed:true};}
 const message=await c.query("SELECT task FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND role='user' AND delivery='received_by_mcp_client'",[ctx.tenantId,sessionId,a.messageId]);
 if(!message.rowCount||!message.rows[0].task)throw new OrganizationAccessError(409,'Сначала получите действующее поручение.');
 const key=await c.query('SELECT requires_task FROM lanka.agent_delegations WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,ctx.delegation!.id]);if(!key.rows[0]?.requires_task)throw new OrganizationAccessError(403,'Исполнитель требует подключения с ограничением поручениями.');
 const usage=await agentUsage(c,ctx.tenantId,ctx.principalId);if(!usage.remaining)throw new OrganizationAccessError(409,'Лимит Lanka: 20 запусков в сутки, включая локальный чат и companion. Новый запуск не зарезервирован.');
 const r=await c.query(`INSERT INTO lanka.agent_bridge_executions(tenant_id,session_id,message_id,id,delegation_id,status,lease_expires_at) VALUES($1,$2,$3,$4,$5,'claimed',clock_timestamp()+interval '60 seconds') ON CONFLICT DO NOTHING RETURNING ${columns}`,[ctx.tenantId,sessionId,a.messageId,a.executionId,ctx.delegation!.id]);
 if(!r.rowCount)throw new OrganizationAccessError(409,'Идентификатор исполнения уже использован.');
 return {execution:projection(r.rows[0]),replayed:false};
}
export async function reportExecution(c:PoolClient,ctx:OrganizationContext,sessionId:string,input:unknown){
 const a=executionReportSchema.parse(input),fp=createHash('sha256').update(canonicalJson(a)).digest('hex');
 const found=await c.query(`SELECT ${columns},delegation_id,native_thread_id,native_turn_id FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 AND id=$4 FOR UPDATE`,[ctx.tenantId,sessionId,a.messageId,a.executionId]);
 const row=found.rows[0];if(!row||row.delegation_id!==ctx.delegation!.id)throw new OrganizationAccessError(403);
 const message=await c.query('SELECT delivery FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND id=$3',[ctx.tenantId,sessionId,a.messageId]),stopRequested=message.rows[0]?.delivery!=='received_by_mcp_client'||!row.live||['stopped','failed'].includes(row.status);
 const old=await c.query('SELECT fingerprint FROM lanka.agent_bridge_execution_reports WHERE tenant_id=$1 AND execution_id=$2 AND request_id=$3',[ctx.tenantId,a.executionId,a.requestId]);
 if(old.rowCount){if(old.rows[0].fingerprint!==fp)throw new OrganizationAccessError(409,'Идентификатор отчёта использован повторно с другими данными.');return {execution:projection(row),stopRequested,replayed:true};}
 if(['stopped','failed'].includes(row.status))throw new OrganizationAccessError(409,'Исполнение завершено; новый запуск требует нового поручения.');
 const count=await c.query('SELECT count(*)::int AS n FROM lanka.agent_bridge_execution_reports WHERE tenant_id=$1 AND execution_id=$2',[ctx.tenantId,a.executionId]);if(count.rows[0].n>=2000&&a.status==='running')throw new OrganizationAccessError(409,'Превышен предел отчётов исполнения; остановите его.');
 if(row.native_thread_id&&((a.nativeThreadId&&row.native_thread_id!==a.nativeThreadId)||(a.nativeTurnId&&row.native_turn_id!==a.nativeTurnId)))throw new OrganizationAccessError(409,'Native-идентификаторы исполнения не совпадают.');
 if(a.status==='running'){
  if(!row.live)throw new OrganizationAccessError(409,'Связь с исполнителем потеряна. Автоматическое возобновление запрещено.');
  if(!a.nativeThreadId||!a.nativeTurnId)throw new OrganizationAccessError(409,'Укажите идентификаторы запущенной native-сессии и хода.');
  if(row.native_thread_id&&(row.native_thread_id!==a.nativeThreadId||row.native_turn_id!==a.nativeTurnId))throw new OrganizationAccessError(409,'Нельзя заменить native-ход действующего поручения.');
 }
 const resultRow=await c.query(`UPDATE lanka.agent_bridge_executions SET status=$5,last_seen_at=clock_timestamp(),lease_expires_at=CASE WHEN $5='running' AND NOT $8 THEN clock_timestamp()+interval '60 seconds' ELSE lease_expires_at END,native_thread_id=coalesce(native_thread_id,$6),native_turn_id=coalesce(native_turn_id,$7) WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 AND id=$4 RETURNING ${columns}`,[ctx.tenantId,sessionId,a.messageId,a.executionId,a.status,a.nativeThreadId??null,a.nativeTurnId??null,stopRequested]);
 const result={execution:projection(resultRow.rows[0]),stopRequested:stopRequested||a.status!=='running',replayed:false};
 await c.query('INSERT INTO lanka.agent_bridge_execution_reports(tenant_id,execution_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[ctx.tenantId,a.executionId,a.requestId,fp,result]);return result;
}
export async function requireExecution(c:PoolClient,tenant:string,session:string,message:string,executionId?:string){
 const r=await c.query(`SELECT ${columns} FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 FOR SHARE`,[tenant,session,message]);
 if(!r.rowCount){if(executionId)throw new OrganizationAccessError(403,'Исполнение не зарегистрировано.');return;}
 if(r.rows[0].id!==executionId||r.rows[0].status!=='running'||!r.rows[0].live)throw new OrganizationAccessError(403,'Нет действующего права исполнителя на запись.');
}
export async function executionViews(c:PoolClient,tenant:string,session:string,messageIds:string[]){
 const rows=await c.query(`SELECT ${columns},message_id FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND session_id=$2 AND message_id=ANY($3::uuid[])`,[tenant,session,messageIds]);return Object.fromEntries(rows.rows.map(r=>[r.message_id,projection(r)]));
}
