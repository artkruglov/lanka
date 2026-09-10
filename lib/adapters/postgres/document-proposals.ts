import {proposalSummary} from '../../domain/proposal-summary';
import {canProposeDraft,assertCreationDesign} from '../../project/empty-draft';
import {creationSlidesSchema,structuredSlides} from '../../project/structured-creation';
import {documentAgentSourcesIn} from './document-agent-sources';
import {authoringGuide} from '../../domain/authoring';
import {assertSelectionChanges} from '../../domain/selection-changes';
import {inspectNarrative} from '../../domain/narrative';
import {designReview} from '../../domain/design-review';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError,type OrganizationContext} from '../../server/organization-access';
import {PostgresResourceAccess} from './resource-access';
import type {FolderProject} from '../../project/package';
import type {PoolClient} from 'pg';
import {compileCommands,semanticCommandsSchema} from '../../domain/commands';
import {propose,validateDoc,validateReferences,type Slide} from '../../domain/model';
import {assertEditDesign,EditDesignError} from '../../agents/edit-design';
import {canonicalJson} from '../../domain/canonical-json';
import {documentView} from '../../project/document-view';
const commandSchema=z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140),commands:semanticCommandsSchema,feedbackIds:z.array(z.string().uuid()).max(12).default([])}).strict();
const draftSchema=commandSchema.omit({commands:true}).extend({slides:creationSlidesSchema}).strict();
const schema=z.union([commandSchema,draftSchema]);
/** Editable content only: no speaker notes, briefing, source excerpts or other private proposals. */
const content=(s:Slide)=>s.canvas?{id:s.id,canvas:structuredClone(s.canvas),...(s.intent?{takeaway:s.intent.takeaway}:{})}:{id:s.id,layout:s.layout,title:s.title,eyebrow:s.eyebrow,body:s.body,metrics:s.metrics,chart:s.chart,chartUnit:s.chartUnit,sourceIds:s.sourceIds,...(s.assetId?{assetId:s.assetId}:{}),...(s.table?{table:s.table}:{}),...(s.comparison?{comparison:s.comparison}:{}),...(s.intent?{takeaway:s.intent.takeaway}:{})};
const references=(s:Slide)=>s.canvas?s.canvas.flatMap(e=>e.kind==='image'?[e.assetId]:(e.kind==='chart'||e.kind==='table')&&e.data.sourceId?[e.data.sourceId]:[]):[...s.sourceIds,...s.metrics.flatMap(m=>m.sourceId?[m.sourceId]:[]),...(s.table?.sourceId?[s.table.sourceId]:[]),...(s.assetId?[s.assetId]:[])];
export class OrganizationDocumentProposals {
 constructor(private resources:PostgresResourceAccess){}
 private using<T>(p:CorporatePrincipal,tenant:string,id:string,write:boolean,fn:(c:PoolClient,ctx:OrganizationContext,project:FolderProject)=>Promise<T>){
  return this.resources.withMaterial(p,tenant,id,'editor',async(c,ctx,permission)=>{
   const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND NOT trashed'+(write?' FOR UPDATE':' FOR SHARE'),[tenant,id,permission.ownerId]);
   if(!row.rowCount)throw new OrganizationAccessError(404);
   return fn(c,ctx,row.rows[0].project as FolderProject);
  },{capability:'propose',write});
 }
 context(p:CorporatePrincipal,tenant:string,id:string){return this.using(p,tenant,id,false,async(c,ctx,project)=>({revision:project.state.revision,documentId:id,canProposeDraft:canProposeDraft(project),editingGuide:{creationRecipes:authoringGuide.recipes,creationDesign:authoringGuide.designContracts[project.state.doc.design as keyof typeof authoringGuide.designContracts]??null,draftCreation:'When canProposeDraft is true, use lanka_propose_draft with concise semantic slides. It keeps this document, title and brand and waits for human acceptance. First read sources and inspect the candidate preview. Inspect proposals.kind, slideCount and decision before creating another candidate; pending draft proposals already contain a complete alternative. Do not create a second document.',documentSources:'Document-scoped keys can read explicitly permitted text with lanka_list_document_sources and lanka_get_document_source. Referencing a source is not fact verification. Text consent does not grant image or original-byte access.',canvasBasicInsertion:authoringGuide.directEditing.basicInsertion,canvasImageInsertion:authoringGuide.directEditing.imageInsertion+' Corporate scoped proposals may only reuse image sources already referenced by this document’s slides.',canvasAlignment:authoringGuide.directEditing.alignment,canvasText:authoringGuide.directEditing.textEditing,canvasLayers:authoringGuide.directEditing.layers},brand:project.state.doc.brand,design:project.state.doc.design,designReview:designReview(project.state.doc),storyReview:inspectNarrative(project.state.doc),slides:project.state.doc.slides.map(content),proposals:project.state.proposals.filter(p=>p.visibility==='shared'&&!p.briefChanges).map(p=>({...proposalSummary(p),id:p.id,title:p.title,author:p.author,status:p.status,baseRevision:p.baseRevision,changes:p.changes.map(c=>({id:c.id,slideId:c.slideId,status:c.status,objectDecisions:c.objectDecisions}))}))}));}
 create(p:CorporatePrincipal,tenant:string,id:string,input:unknown){
  const request=schema.parse(input),fingerprint=createHash('sha256').update(canonicalJson({operation:'shared-proposal',id,actor:p.kind==='delegated'?p.tokenHash:p.userId,request})).digest('hex');
  return this.using(p,tenant,id,true,async(c,ctx,project)=>{
   if(ctx.taskSelection){if('slides' in request)throw new OrganizationAccessError(403,'Заполнение требует поручения на всю презентацию.');if(project.state.revision!==ctx.taskSelection.revision)throw new OrganizationAccessError(409,'Версия выбранной области изменилась. Отправьте новое поручение с актуальным выделением.');
    try{assertSelectionChanges(project.state.doc,('commands' in request?compileCommands(project.state.doc,request.commands):[]),ctx.taskSelection);}catch(e){throw new OrganizationAccessError(403,(e as Error).message);}}
   const granted=await documentAgentSourcesIn(c,ctx,id,project);
   const prior=await c.query('SELECT fingerprint,result FROM lanka.resource_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,ctx.principalId,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другого действия.');const result=prior.rows[0].result;for(const consent of result.sourceConsents??[]){if(!granted.some(g=>g.id===consent.id&&g.contentHash===consent.contentHash))throw new OrganizationAccessError(403,'Разрешение на источник изменилось.');}return result;}
   if(project.state.revision!==request.expectedRevision)throw new OrganizationAccessError(409,'Версия изменилась. Прочитайте актуальный контекст.');
   if(project.state.proposals.filter(p=>p.status==='pending').length>=12)throw new OrganizationAccessError(409,'Сначала рассмотрите ожидающие предложения.');
   if(request.feedbackIds.some(id=>!project.state.comments.some(c=>c.id===id&&!c.replyTo&&c.visibility==='shared')))throw new OrganizationAccessError(404,'Обсуждение недоступно.');
   let draftDoc:ReturnType<typeof validateDoc>|undefined;
   let changes;try{
    if('slides' in request){
     if(!canProposeDraft(project))throw Error('Заготовка уже изменена. Используйте предложения правок существующих слайдов.');
     const slides=structuredSlides(request.requestId,request.slides);slides[0].id=project.state.doc.slides[0].id;
     draftDoc=validateDoc({...project.state.doc,slides});assertCreationDesign(draftDoc);validateReferences({...project.state,doc:draftDoc});
     changes=slides.map(after=>({slideId:after.id,after}));
    }else changes=compileCommands(project.state.doc,request.commands);
   }catch(e){if(e instanceof z.ZodError)throw e;throw new OrganizationAccessError(409,(e as Error).message);}
   const allowed=new Set(project.state.doc.slides.flatMap(references));
   const added=new Set(changes.flatMap(c=>references(c.after)).filter(id=>!allowed.has(id)));
   if([...added].some(id=>!granted.some(g=>g.id===id)))throw new OrganizationAccessError(403,'Источник не разрешён этому подключению.');
   const imageIds=(s:Slide)=>s.canvas?s.canvas.filter(e=>e.kind==='image').map(e=>e.assetId):s.assetId?[s.assetId]:[];
   if(changes.some(c=>imageIds(c.after).some(id=>added.has(id))))throw new OrganizationAccessError(403,'Текстовое разрешение не открывает изображения.');
   try{if(!draftDoc)assertEditDesign(project.state.doc,changes);}catch(e){if(e instanceof EditDesignError)throw new OrganizationAccessError(409,e.message);throw e;}
   const identity=await c.query('SELECT display_name FROM lanka.auth_identities WHERE id=$1',[ctx.userId]);
   const author=ctx.delegation?`${ctx.delegation.name} · агент (${identity.rows[0]?.display_name||'Участник'})`:identity.rows[0]?.display_name||'Участник';
   const proposal=propose(project.state,draftDoc?changes.slice(0,1):changes,request.title,author);
   if(draftDoc)proposal.draftCandidate={before:structuredClone(project.state.doc),after:draftDoc};
   for(const change of proposal.changes){
    const refs=new Set(draftDoc?draftDoc.slides.flatMap(references):references(change.after));
    change.sourceDependencies=granted.filter(g=>refs.has(g.id)).map(g=>({id:g.id,contentHash:g.contentHash}));
   }
   proposal.visibility='shared';proposal.authorPrincipalId=ctx.principalId;if(ctx.delegation)proposal.delegationId=ctx.delegation.id;proposal.feedbackIds=request.feedbackIds;
   project.state.proposals.push(proposal);
   const bytes=JSON.stringify(project);if(Buffer.byteLength(bytes)>1_500_000)throw new OrganizationAccessError(409,'Документ достиг предельного размера.');
   await c.query('UPDATE lanka.materials SET project=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenant,id,bytes]);
   const result={...proposalSummary(proposal),sourceConsents:proposal.changes.flatMap(c=>c.sourceDependencies??[]),proposalId:proposal.id,revision:project.state.revision,status:proposal.status,changes:proposal.changes.map(c=>({id:c.id,slideId:c.slideId}))};
   await c.query('INSERT INTO lanka.resource_receipts(tenant_id,actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[tenant,ctx.principalId,request.requestId,fingerprint,JSON.stringify(result)]);
   return result;
  });
 }
 preview(p:CorporatePrincipal,tenant:string,id:string,proposalId:string){
  z.string().uuid().parse(proposalId);
  return this.using(p,tenant,id,false,async(c,ctx,project)=>{
   const proposal=project.state.proposals.find(p=>p.id===proposalId&&p.visibility==='shared'&&!p.briefChanges);if(!proposal)throw new OrganizationAccessError(404);
   const snapshot=await c.query('SELECT doc FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3',[tenant,id,proposal.baseRevision]);
   if(!snapshot.rowCount)throw new OrganizationAccessError(409,'Основа предложения недоступна.');
   const baseDoc=validateDoc(snapshot.rows[0].doc);
   const render=(side:'before'|'after')=>documentView({...project,state:{...project.state,doc:proposal.draftCandidate?.[side]??{...baseDoc,slides:baseDoc.slides.map(s=>proposal.changes.find(c=>c.slideId===s.id)?.[side]??s)}}},{role:'viewer',canCopy:false,isOwner:false});
   const before=render('before'),after=render('after'),ids=new Set(proposal.changes.map(c=>c.slideId));if(!proposal.draftCandidate){before.slides=before.slides.filter(s=>ids.has(s.id));after.slides=after.slides.filter(s=>ids.has(s.id));}
   const proposedDoc=proposal.draftCandidate?.after??{...baseDoc,slides:baseDoc.slides.map(s=>proposal.changes.find(c=>c.slideId===s.id)?.after??s)};
   return {...proposalSummary(proposal),designReview:{before:designReview(baseDoc),after:designReview(proposedDoc)},proposalId,status:proposal.status,baseRevision:proposal.baseRevision,currentRevision:project.state.revision,changes:proposal.changes.map(c=>({id:c.id,slideId:c.slideId,status:c.status,objectDecisions:c.objectDecisions})),before,after};
  });
 }
}
