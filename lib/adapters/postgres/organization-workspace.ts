import {saveInstalledDesignIn} from './design-package-resolver';
import {bindRevisionDesignIn} from './revision-design-package';
import {fingerprint} from './chat-database';
import {creationSourcesSchema,readCreationSources} from '../../project/creation-sources';
import type {SourceIntakeScope} from '../../agents/source-intake';
import {briefingInputSchema,resolveBriefing,briefFromBriefing} from '../../domain/briefing';
import {OrganizationAccessError} from '../../server/organization-access';
import {duplicateCommandSchema} from '../../project/duplicate';
import {z} from 'zod';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {PostgresOrganizationAccess} from './organization-access';
import {usingTransactionDatabase} from './transaction-database';
import {OrganizationProjectRepository} from './organization-project';
import {PostgresResourceAccess} from './resource-access';
import {creationSlidesSchema,structuredSlides} from '../../project/structured-creation';
import {initialState,validateDoc,validateReferences} from '../../domain/model';
import type {FolderProject} from '../../project/package';
import {emptyDraft,assertCreationDesign} from '../../project/empty-draft';
import {fromMarkdown} from '../../domain/intake';
import {creationProfile} from '../../agents/creation-profile';
const id=z.string().uuid(),name=z.string().trim().min(1).max(180);
export const createDocumentCommand=z.object({action:z.literal('create_document'),title:z.string().trim().min(1).max(140),folderId:id.nullable(),markdown:z.string().max(30000).optional(),slides:creationSlidesSchema.optional(),sources:creationSourcesSchema.optional(),briefing:briefingInputSchema.optional(),empty:z.literal(true).optional(),profile:z.enum(['focus-v2','focus-v3']).default('focus-v2')}).strict();
const command=z.discriminatedUnion('action',[
 duplicateCommandSchema,
 z.object({action:z.literal('create_folder'),name}).strict(),
 z.object({action:z.literal('rename_folder'),id,name}).strict(),
 createDocumentCommand,
 z.object({action:z.literal('move_document'),id,folderId:id.nullable()}).strict(),
 z.object({action:z.literal('trash_document'),id,trashed:z.boolean()}).strict(),
]);
export class OrganizationWorkspace {
 constructor(readonly access:PostgresOrganizationAccess,readonly principal:BrowserPrincipal,readonly tenantId:string,readonly runtimeRoot:string) {}
 listing(cursor?:string){return this.access.personalLibrary(this.principal,this.tenantId,cursor);}
 repository(documentId:string){return new OrganizationProjectRepository(this.access,this.principal,this.tenantId,documentId,this.runtimeRoot);}
 async mutate(input:unknown){
  const a=z.object({requestId:id,command}).strict().parse(input),cmd=a.command;
  return this.access.withTenant(this.principal,this.tenantId,(c,ctx)=>usingTransactionDatabase(c,ctx,this.runtimeRoot,db=>db.tx(async()=>{
   await c.query("INSERT INTO lanka.workspace_catalogs(tenant_id,owner_id,origin) VALUES($1,$2,'native') ON CONFLICT DO NOTHING",[ctx.tenantId,ctx.principalId]);
   if(cmd.action==='move_document') {
    const nodes=await c.query('SELECT id,parent_folder_id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[ctx.tenantId,cmd.id]);
    if(!nodes.rowCount)throw Error('Документ недоступен.');
    const acl=new PostgresResourceAccess(this.access);await acl.permissionIn(c,ctx,nodes.rows[0].id,'manager');
    if(nodes.rows[0].parent_folder_id)await acl.permissionIn(c,ctx,nodes.rows[0].parent_folder_id,'manager');
   }
   const prior=await db.catalogReceipt(a.requestId,cmd);if(prior)return prior.result;
   // Catalogue move/trash changes affect inherited access too; use the same epoch as ACL mutations.
   await c.query('UPDATE lanka.tenants SET authz_epoch=authz_epoch+1 WHERE id=$1',[ctx.tenantId]);
   if(cmd.action==='create_folder'||cmd.action==='rename_folder')return db.mutateFolder(a.requestId,cmd);
   if(cmd.action==='duplicate_document')return db.duplicateIn(c,a.requestId,cmd);
   if(cmd.action==='create_document') {
    return createWorkspaceDocument(db,c,a.requestId,cmd);
   }
   // Folder moves / restore-from-trash also require actual ownership before returning a receipt.
   if(!await db.owns(cmd.id))throw Error('Документ недоступен.');
   const result=await db.catalogCommand(a.requestId,cmd.id,cmd);
   if(cmd.action==='move_document'){
    const destination=cmd.folderId?await c.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[ctx.tenantId,ctx.principalId,cmd.folderId]):null;
    await c.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND material_id=$2',[ctx.tenantId,cmd.id,destination?.rows[0]?.id??null]);
   }
   return result;
  })),true);
 }
}

/** Shared creation pipeline for browser and explicitly delegated workspace operations. */
export async function createWorkspaceDocument(db:import('./chat-database').ChatDatabase,c:import('./chat-database').DbTx,requestId:string,cmd:z.infer<typeof createDocumentCommand>,payload:unknown=cmd,scope?:SourceIntakeScope){
 const prior=await db.receipt(c,requestId,requestId,payload);if(prior)return prior.result;
 const selected=await readCreationSources(db,c,cmd.sources,scope);
 const p=await prepareWorkspaceDocument(requestId,cmd,true,selected.sources);
 const pack=await saveInstalledDesignIn(c,db.tenant,cmd.profile);
 const result=await db.createProjectIn(c,requestId,p,cmd.folderId,selected.blobs,payload,{id:requestId,revision:1});
 await bindRevisionDesignIn(c,db.tenant,{documentId:requestId,revision:1,documentHash:fingerprint(p.state.doc)},pack.digest);
 return result;
}
/** Pure preparation; preview never creates a material, receipt, folder or agent run. */
export async function prepareWorkspaceDocument(requestId:string,cmd:z.infer<typeof createDocumentCommand>,checkDesign=true,sources:FolderProject['state']['sources']=[]):Promise<FolderProject>{
 if([cmd.empty===true,cmd.markdown!==undefined,cmd.slides!==undefined].filter(Boolean).length>1)throw Error('Нельзя подменять формат: выберите slides, markdown или empty.');
 if(cmd.empty){if(cmd.briefing)throw new OrganizationAccessError(409,'Добавьте бриф после создания пустой заготовки.');const draft=await emptyDraft(requestId,cmd.title,cmd.profile);draft.state.sources=structuredClone(sources);validateReferences(draft.state);return draft;}
 const design=await creationProfile(cmd.profile),doc=cmd.slides?validateDoc({schemaVersion:1,id:requestId,title:cmd.title,design:design.design,brand:design.brand,slides:structuredSlides(requestId,cmd.slides)}):fromMarkdown(cmd.markdown||`# ${cmd.title}\n\n## Главная мысль\nДобавьте содержание.`);
 doc.id=requestId;doc.title=cmd.title;doc.design=design.design;doc.brand=design.brand;
 const briefing=cmd.briefing===undefined?undefined:resolveBriefing(cmd.briefing);
 if(briefing)doc.brief=briefFromBriefing(briefing);
 const state=initialState(validateDoc(doc));state.sources=sources;
 try{validateReferences(state);if(cmd.slides&&checkDesign)assertCreationDesign(state.doc);}catch(e){if(e instanceof z.ZodError)throw e;throw new OrganizationAccessError(409,(e as Error).message);}
 return {format:'lanka-project/v1',title:cmd.title,state,receipts:[],...(briefing?{briefing}:{})};
}
