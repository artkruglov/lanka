import {requireExecution} from './bridge-executions';
import {bridgeSelectionSchema} from '../../project/bridge-selection';
import type {PoolClient} from 'pg';
import {bridgeTaskAddressSchema,bridgeTaskSchema} from '../../project/bridge-task';
import type {DelegatedPrincipal,DelegationScope} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
/** Called under the tenant authorization lock; message and binding row locks fence cancellation, completion and rebinding. */
export async function authorizeBridgeTask(c:PoolClient,tenantId:string,delegationId:string,required:boolean,p:DelegatedPrincipal,scope:DelegationScope){
 if(!scope.write)return;
 if(!p.task){if(required)throw new OrganizationAccessError(403,'Для изменения передайте аргумент task с sessionId и messageId полученного поручения.');return;}
 const address=bridgeTaskAddressSchema.parse(p.task);
 const r=await c.query(`SELECT m.task,m.delivery FROM lanka.agent_bridge_messages m JOIN lanka.agent_bindings b
 ON b.tenant_id=m.tenant_id AND b.session_id=m.session_id
 WHERE m.tenant_id=$1 AND m.session_id=$2 AND m.id=$3 AND b.delegation_id=$4 AND m.role='user' FOR SHARE OF m,b`,[tenantId,address.sessionId,address.messageId,delegationId]);
 if(!r.rowCount||r.rows[0].delivery!=='received_by_mcp_client'||!r.rows[0].task)throw new OrganizationAccessError(403,'Поручение не получено, завершено, отменено или принадлежит другому подключению.');
 await requireExecution(c,tenantId,address.sessionId,address.messageId,address.executionId);
 const task=bridgeTaskSchema.parse(r.rows[0].task);
 if(task.mode!==scope.capability)throw new OrganizationAccessError(403,'Режим поручения не разрешает эту операцию.');
 if(task.documentId&&(!('documentId' in scope)||scope.documentId!==task.documentId))throw new OrganizationAccessError(403,'Операция вне документа поручения.');
 if('documentId' in scope){const linked=await c.query('SELECT 1 FROM lanka.agent_session_materials WHERE tenant_id=$1 AND session_id=$2 AND material_id=$3',[tenantId,address.sessionId,scope.documentId]);if(!linked.rowCount)throw new OrganizationAccessError(403,'Документ не связан с поручением.');}
 if(task.limitToSelection){
  if(task.mode!=='propose'||!task.documentId)throw new OrganizationAccessError(403,'Некорректная область поручения.');
  const selected=await c.query('SELECT material_id AS "documentId",revision,slide_id AS "slideId",element_id AS "elementId",field FROM lanka.agent_bridge_selections WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3',[tenantId,address.sessionId,address.messageId]);
  if(!selected.rowCount)throw new OrganizationAccessError(403,'Область поручения недоступна.');
  const row=selected.rows[0];if(!row.elementId)delete row.elementId;if(!row.field)delete row.field;
  const selection=bridgeSelectionSchema.parse(row);if(selection.documentId!==task.documentId)throw new OrganizationAccessError(403);return selection;
 }
}
