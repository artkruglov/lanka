import type {PoolClient} from 'pg';
import type {BridgeSelection} from '../../project/bridge-selection';
import type {FolderProject} from '../../project/package';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
async function resolve(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,sessionId:string,selection:BridgeSelection){
 const r=await c.query(`SELECT n.id,s.folder_resource_id FROM lanka.agent_sessions s
 JOIN lanka.agent_session_materials linked ON linked.tenant_id=s.tenant_id AND linked.session_id=s.id
 JOIN lanka.resource_nodes n ON n.tenant_id=linked.tenant_id AND n.material_id=linked.material_id
 WHERE s.tenant_id=$1 AND s.id=$2 AND linked.material_id=$3`,[ctx.tenantId,sessionId,selection.documentId]);
 if(!r.rowCount)throw new OrganizationAccessError(404);
 await resources.permissionIn(c,ctx,r.rows[0].id,'viewer');
 if(r.rows[0].folder_resource_id&&!(await resources.ancestryIn(c,ctx,r.rows[0].id)).some(n=>n.id===r.rows[0].folder_resource_id))throw new OrganizationAccessError(403);
 const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND NOT trashed FOR SHARE',[ctx.tenantId,selection.documentId]);
 if(!row.rowCount)throw new OrganizationAccessError(404);
 const project=row.rows[0].project as FolderProject,slide=project.state.doc.slides.find(s=>s.id===selection.slideId);
 const exists=!!slide&&(!selection.elementId||!!slide.canvas?.some(e=>e.id===selection.elementId))&&(!selection.field||!slide.canvas);
 return {project,exists};
}
export async function saveBridgeSelection(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,sessionId:string,messageId:string,selection:BridgeSelection){
 const {project,exists}=await resolve(c,resources,ctx,sessionId,selection);
 if(project.state.revision!==selection.revision)throw new OrganizationAccessError(409,'Документ изменился. Обновите слайд и повторно выберите объект перед отправкой.');
 if(!exists)throw new OrganizationAccessError(409,'Выбранный слайд или объект больше не существует.');
 await c.query('INSERT INTO lanka.agent_bridge_selections(tenant_id,session_id,message_id,material_id,revision,slide_id,element_id,field) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,sessionId,messageId,selection.documentId,selection.revision,selection.slideId,selection.elementId??null,selection.field??null]);
}
export async function readBridgeSelections(c:PoolClient,resources:PostgresResourceAccess,ctx:OrganizationContext,sessionId:string,messageIds:string[]){
 const rows=await c.query('SELECT message_id,material_id,revision,slide_id,element_id,field FROM lanka.agent_bridge_selections WHERE tenant_id=$1 AND session_id=$2 AND message_id=ANY($3::uuid[]) ORDER BY material_id,message_id',[ctx.tenantId,sessionId,messageIds]);
 const byMessage:Record<string,Record<string,unknown>>={};
 for(const row of rows.rows){const selection:BridgeSelection={documentId:row.material_id,revision:row.revision,slideId:row.slide_id,...(row.element_id?{elementId:row.element_id}:{}),...(row.field?{field:row.field}:{})};
  try{const {project,exists}=await resolve(c,resources,ctx,sessionId,selection);byMessage[row.message_id]={available:true,...selection,currentRevision:project.state.revision,stale:project.state.revision!==selection.revision,targetExists:exists};}
  catch(e){if(e instanceof OrganizationAccessError&&(e.status===403||e.status===404))byMessage[row.message_id]={available:false};else throw e;}
 }
 return byMessage;
}
