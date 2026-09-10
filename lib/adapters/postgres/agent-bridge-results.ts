import {proposalSummary} from '../../domain/proposal-summary';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {FolderProject} from '../../project/package';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
export const bridgeResultsSchema=z.array(z.object({documentId:z.string().uuid(),revision:z.number().int().positive(),proposalId:z.string().uuid().optional()}).strict()).max(8);
type Result=z.infer<typeof bridgeResultsSchema>[number];
async function target(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,folder:string|null,reference:Result){
 if(reference.proposalId&&ctx.delegation&&!ctx.delegation.capabilities.includes('propose'))throw new OrganizationAccessError(403);
 const n=await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[ctx.tenantId,reference.documentId]);if(!n.rowCount)throw new OrganizationAccessError(404);
 await resources.permissionIn(c,ctx,n.rows[0].id,reference.proposalId?'editor':'viewer');
 if(folder&&!(await resources.ancestryIn(c,ctx,n.rows[0].id)).some(n=>n.id===folder))throw new OrganizationAccessError(403,'Результат вне папки беседы.');
 const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND NOT trashed FOR SHARE',[ctx.tenantId,reference.documentId]);if(!row.rowCount)throw new OrganizationAccessError(404);
 const project=row.rows[0].project as FolderProject;
 const proposal=reference.proposalId?project.state.proposals.find(p=>p.id===reference.proposalId&&p.visibility==='shared'&&!p.briefChanges):undefined;
 if(reference.proposalId&&!proposal)throw new OrganizationAccessError(404,'Предложение недоступно.');
 return {project,proposal};
}
export async function saveBridgeResults(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,sessionId:string,messageId:string,results:Result[]){
 const session=await c.query('SELECT folder_resource_id FROM lanka.agent_sessions WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,sessionId]);
 // Stable lock order for responses containing several documents.
 for(const r of [...results].sort((a,b)=>a.documentId.localeCompare(b.documentId))){
  const {project,proposal}=await target(c,resources,ctx,session.rows[0].folder_resource_id,r);
  if(project.state.revision!==r.revision)throw new OrganizationAccessError(409,'Версия результата изменилась. Прочитайте документ и укажите актуальную версию.');
  if(proposal&&proposal.delegationId!==ctx.delegation?.id)throw new OrganizationAccessError(403,'Предложение создано другим подключением.');
 }
 for(const [position,r] of results.entries()){
  await c.query('INSERT INTO lanka.agent_bridge_results(tenant_id,session_id,message_id,position,material_id,revision,proposal_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,sessionId,messageId,position,r.documentId,r.revision,r.proposalId??null]);
  await c.query('INSERT INTO lanka.agent_session_materials(tenant_id,session_id,material_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.tenantId,sessionId,r.documentId]);
 }
}
export async function readBridgeResults(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,sessionId:string,messageIds:string[]){
 const session=await c.query('SELECT folder_resource_id FROM lanka.agent_sessions WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,sessionId]);
 const rows=await c.query('SELECT message_id,position,material_id,revision,proposal_id FROM lanka.agent_bridge_results WHERE tenant_id=$1 AND session_id=$2 AND message_id=ANY($3::uuid[]) ORDER BY material_id,message_id,position',[ctx.tenantId,sessionId,messageIds]);
 const byMessage:Record<string,Record<string,unknown>[]>={};
 for(const row of rows.rows){let value:Record<string,unknown>;
  try{
   const {project,proposal}=await target(c,resources,ctx,session.rows[0].folder_resource_id,{documentId:row.material_id,revision:row.revision,...(row.proposal_id?{proposalId:row.proposal_id}:{})});
   value={available:true,documentId:row.material_id,title:project.title,revision:row.revision,currentRevision:project.state.revision,...(proposal?{proposalId:proposal.id,proposalTitle:proposal.title,proposalStatus:proposal.status,proposalKind:proposalSummary(proposal).kind,proposalSlideCount:proposalSummary(proposal).slideCount,proposalDecision:proposalSummary(proposal).decision}:{}),url:`/organizations/${ctx.tenantId}/documents/${row.material_id}${proposal?'?review='+proposal.id:''}`};
  }catch(e){if(e instanceof OrganizationAccessError&&(e.status===403||e.status===404))value={available:false};else throw e;}
  (byMessage[row.message_id]??=[])[row.position]=value;
 }
 return byMessage;
}
