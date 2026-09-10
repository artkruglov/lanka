import {OrganizationColleagueReviews} from '../adapters/postgres/colleague-reviews';
import {canProposeDraft} from '../project/empty-draft';
import {DocumentAgentSources} from '../adapters/postgres/document-agent-sources';
import {PublicationCatalog} from '../adapters/postgres/publication-catalog';
import {OrganizationPublications} from '../adapters/postgres/publications';
import {renderPublication} from '../../scripts/project-mcp/publication-render';
import {ImagePlacementError} from '../domain/image-placement';
import {bridgeTaskSchema} from '../project/bridge-task';
import {bridgeSelectionSchema} from '../project/bridge-selection';
import {AgentBridge} from '../adapters/postgres/agent-bridge';
import {WorkspaceSessions} from '../adapters/postgres/workspace-sessions';
import {DocumentReactions} from '../adapters/postgres/document-reactions';
import {AgentWorkspace} from '../adapters/postgres/agent-workspace';
import {OrganizationDocumentCopy} from '../adapters/postgres/document-copy';
import {AgentSourceIntakes} from '../adapters/postgres/agent-source-intakes';
import {EditorUpgradeError} from '../project/editor-contract';
import {sourceDownload} from '../project/source-download';
import type {BrowserPrincipal} from './browser-identity';
import type {PostgresOrganizationAccess} from '../adapters/postgres/organization-access';
import {OrganizationAccessError} from './organization-access';
import {z} from 'zod';
import {OrganizationWorkspace} from '../adapters/postgres/organization-workspace';
import {humanCommand} from '../../scripts/project-mcp/human';
import {uploadImage} from '../../scripts/project-mcp/image-upload';
import {materialPath} from '../project/package';
import {OrganizationDocumentView} from '../adapters/postgres/document-view';
import {PostgresResourceAccess} from '../adapters/postgres/resource-access';
import {OrganizationDocumentSharing} from '../adapters/postgres/document-sharing';
import {OrganizationDocumentComments} from '../adapters/postgres/document-comments';
import {AgentDelegations} from '../adapters/postgres/agent-delegations';
/** Mount behind withBrowserIdentity; principal never comes from request JSON or headers. */
export function organizationApi(access:PostgresOrganizationAccess,runtimeRoot?:string) {
 const resources=new PostgresResourceAccess(access),reactions=new DocumentReactions(resources),shared=new OrganizationDocumentView(resources),sharing=new OrganizationDocumentSharing(resources),comments=new OrganizationDocumentComments(resources),delegations=new AgentDelegations(resources),publications=new OrganizationPublications(resources,renderPublication);
 const publicationCatalog=new PublicationCatalog(resources),colleagueReviews=new OrganizationColleagueReviews(resources);
 return async(req:Request,principal:BrowserPrincipal):Promise<Response>=>{
  const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  try {
   const url=new URL(req.url);
   const body=async(limit=40_000)=>{
    const reader=req.body?.getReader();if(!reader)throw new SyntaxError();
    let size=0;const chunks:Uint8Array[]=[];
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();return {tooLarge:true} as const;}chunks.push(value);}
    return {value:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
   };
   if(url.pathname==='/api/organizations'&&req.method==='GET')return json({organizations:await access.list(principal)});
   const catalogRoute=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/publication-catalog$/);
   if(catalogRoute){
    if(req.method!=='GET')return json({error:'Метод недоступен.'},405);
    return json(await publicationCatalog.list(principal,catalogRoute[1],{...Object.fromEntries(url.searchParams),...(url.searchParams.has('bookmarked')?{bookmarked:z.enum(['true','false']).parse(url.searchParams.get('bookmarked'))==='true'}:{})}));
   }
   const reviewInbox=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/review-inbox$/);
   if(reviewInbox){if(req.method!=='GET')return json({error:'Метод не поддерживается.'},405);return json(await colleagueReviews.inbox(principal,reviewInbox[1],{cursor:url.searchParams.get('cursor')??undefined,expectedEpoch:url.searchParams.get('expectedEpoch')??undefined}));}
   const reviewPeople=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/review-recipients$/);
   if(reviewPeople){if(req.method!=='GET')return json({error:'Метод недоступен.'},405);return json(await colleagueReviews.recipients(principal,reviewPeople[1],reviewPeople[2],Object.fromEntries(url.searchParams)));}
   const reviewRoute=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/review-requests(?:\/([a-f0-9-]{36})(?:\/(version|assets))?)?$/);
   if(reviewRoute){
    const [,tenant,document,id,part]=reviewRoute;
    if(req.method==='GET'&&!id)return json(await colleagueReviews.list(principal,tenant,document,Object.fromEntries(url.searchParams)));
    if(req.method==='POST'&&!id){
     const data=await body(12000);if(data.tooLarge)return json({error:'Запрос слишком большой.'},413);
     return json(await colleagueReviews.write(principal,tenant,document,data.value));
    }
    if(req.method==='GET'&&id){
     if(!part)return json(await colleagueReviews.read(principal,tenant,document,id));
     const prepared=await colleagueReviews.version(principal,tenant,document,id);
     if(part==='version')return json({review:prepared.review,headRevision:prepared.headRevision,hasNewVersion:prepared.hasNewVersion,version:prepared.version});
     const sourceId=z.string().min(1).max(180).parse(url.searchParams.get('id'));
     const source=prepared.version.sources.find(s=>s.kind==='image'&&s.id===sourceId);
     const blob=source&&prepared.blobs.find(b=>b.hash===source.sha256&&b.contentType===source.contentType);
     if(!blob)return json({error:'Изображение проверки недоступно.'},404);
     return new Response(new Uint8Array(blob.bytes),{headers:{'Content-Type':blob.contentType,'Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'}});
    }
    return json({error:'Метод недоступен.'},405);
   }
   const publication=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/publications(?:\/([a-f0-9-]{36})(?:\/artifacts)?)?$/);
   if(publication){
    const [,tenant,material,id]=publication;
    if(req.method==='GET'){
     if(id&&url.pathname.endsWith('/artifacts')){
      const kind=z.enum(['pdf','pptx','preview','dependencies']).parse(url.searchParams.get('kind')),page=z.coerce.number().int().min(0).max(40).parse(url.searchParams.get('page')??'0');
      const file=url.searchParams.get('prepared')==='true'?await publications.preparedArtifact(principal,tenant,material,id,kind,page):await publications.artifact(principal,tenant,material,id,kind,page);
      const contentType=kind==='pdf'?'application/pdf':kind==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':kind==='dependencies'?'application/zip':'image/png';
      return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':kind==='preview'?'inline':`attachment; filename="publication.${kind==='dependencies'?'dependencies.zip':kind}"`}});
     }
     if(!id&&url.searchParams.get('history')==='1')return json(await publications.history(principal,tenant,material,url.searchParams.has('before')?z.coerce.number().int().positive().parse(url.searchParams.get('before')):undefined));
     return json(id?await publications.read(principal,tenant,material,id):await publications.list(principal,tenant,material,{...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{}),...(url.searchParams.has('includeWithdrawn')?{includeWithdrawn:z.enum(['true','false']).parse(url.searchParams.get('includeWithdrawn'))==='true'}:{})}));
    }
    if(req.method!=='POST'||url.pathname.endsWith('/artifacts'))return json({error:'Операция недоступна.'},405);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    const data=await body();if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
    const a=z.discriminatedUnion('action',[
     z.object({action:z.literal('prepare'),expectedRevision:z.number().int().positive(),sourceRevision:z.number().int().positive().optional()}).strict(),
     z.object({action:z.literal('publish'),requestId:z.string().uuid(),preparedId:z.string().uuid(),expectedHash:z.string(),audience:z.literal('current-document-access')}).strict(),
     z.object({action:z.literal('withdraw'),requestId:z.string().uuid()}).strict()
    ]).parse(data.value);
    if(a.action==='withdraw'){if(!id)return json({error:'Выберите публикацию.'},400);return json(await publications.withdraw(principal,tenant,material,{requestId:a.requestId,publicationId:id}));}
    if(id)return json({error:'Операция недоступна.'},404);
    const {action,...input}=a;return json(action==='prepare'?await publications.prepare(principal,tenant,material,input):await publications.activate(principal,tenant,material,input));
   }
   const conversation=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/conversations(?:\/([a-f0-9-]{36}))?$/);
   if(conversation){
    const [,tenant,id]=conversation,bridge=new AgentBridge(resources),sessions=new WorkspaceSessions(resources);
    if(req.method==='GET')return json(id?await bridge.read(principal,tenant,id,{after:url.searchParams.get('after')??'0'}):await bridge.list(principal,tenant,{...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{}),...(url.searchParams.has('documentId')?{documentId:url.searchParams.get('documentId')}:{})}));
    if(req.method!=='POST')return json({error:'Операция недоступна.'},405);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    const data=await body(60_000);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
    if(!id)return json(await sessions.create(principal,tenant,data.value));
    const a=z.discriminatedUnion('action',[
     z.object({action:z.literal('bind'),delegationId:z.string().uuid(),expectedDelegationId:z.string().uuid().nullable(),taskBound:z.boolean().optional()}).strict(),
     z.object({action:z.literal('send'),requestId:z.string().uuid(),text:z.string(),selection:bridgeSelectionSchema.optional(),task:bridgeTaskSchema.optional()}).strict(),
     z.object({action:z.literal('cancel'),messageId:z.string().uuid()}).strict(),
     z.object({action:z.literal('link'),documentId:z.string().uuid()}).strict()
    ]).parse(data.value);
    if(a.action==='bind'){const {action,...input}=a;return json(await bridge.bind(principal,tenant,id,input));}
    if(a.action==='send'){const {action,...input}=a;return json(await bridge.send(principal,tenant,id,input));}
    if(a.action==='link')return json(await sessions.link(principal,tenant,id,a.documentId));
    return json(await bridge.cancel(principal,tenant,id,a.messageId));
   }
   const route=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/(members|library|shared-create|shared-library|folder-sharing|folder-sharing-subjects|agent-delegations|source-intakes|documents\/([a-f0-9-]{36})(?:\/(history|assets|sources|images|exports|export|cover|view|view-assets|sharing|sharing-subjects|shared-comments|reactions|copy|agent-delegations))?)$/);
   if(!route)return json({error:'Операция недоступна.'},404);
   const [,tenant,action,document,part]=route;
   if(action==='folder-sharing'||action==='folder-sharing-subjects'){
    const folderId=z.string().uuid().parse(url.searchParams.get('resourceId')),folders=new OrganizationDocumentSharing(resources,'folder');
    if(req.method==='GET')return json(action==='folder-sharing'?await folders.read(principal,tenant,folderId,url.searchParams.has('inheritance')?z.enum(['inherit','restricted']).parse(url.searchParams.get('inheritance')):undefined):await folders.search(principal,tenant,folderId,url.searchParams.get('search')??''));
    if(req.method==='POST'&&action==='folder-sharing'){
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
     const data=await body(4096);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
     return json(await folders.change(principal,tenant,folderId,data.value));
    }
    return json({error:'Операция недоступна.'},405);
   }
   if(action==='shared-create'){
    if(req.method!=='POST')return json({error:'Операция недоступна.'},405);
    if(!runtimeRoot)return json({error:'Хранилище недоступно.'},503);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    const data=await body(1_500_000);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
    const request=z.object({requestId:z.string().uuid(),command:z.object({action:z.enum(['create_document','create_folder'])}).passthrough()}).strict().parse(data.value);
    if(!(request.command.action==='create_document'?request.command.folderResourceId:request.command.parentFolderResourceId))return json({error:'Выберите общую папку.'},400);
    return json(await new AgentWorkspace(resources,runtimeRoot).create(principal,tenant,request));
   }
   if(action==='source-intakes'){
    if(!runtimeRoot)return json({error:'Хранилище недоступно.'},503);
    const intakes=new AgentSourceIntakes(access,runtimeRoot);
    if(req.method==='DELETE')return json(await intakes.remove(principal,tenant,{id:url.searchParams.get('id'),sha256:url.searchParams.get('sha256')}));
    if(req.method==='GET')return json(url.searchParams.has('id')?await intakes.read(principal,tenant,z.string().uuid().parse(url.searchParams.get('id'))):await intakes.list(principal,tenant));
    if(req.method==='POST'){
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
     const data=await body(7_000_000);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
     return json(await intakes.upload(principal,tenant,data.value));
    }
    return json({error:'Операция недоступна.'},405);
   }
   if(action==='agent-delegations'||document&&part==='agent-delegations') {
    if(req.method==='GET'){if(url.searchParams.get('sourcePreview')==='1'){if(!document)return json({error:'Выберите документ.'},400);return json(await new DocumentAgentSources(resources).list(principal,tenant,document));}return json(await delegations.list(principal,tenant,document??null));}
    if(req.method==='POST') {
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
     const data=await body(4096);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
     const request=z.discriminatedUnion('action',[
      z.object({action:z.literal('issue'),request:z.unknown()}).strict(),
      z.object({action:z.literal('revoke'),id:z.string().uuid()}).strict(),
     ]).parse(data.value);
     return json(request.action==='issue'?await delegations.issue(principal,tenant,document??null,request.request):await delegations.revoke(principal,tenant,document??null,request.id));
    }
    return json({error:'Операция недоступна.'},405);
   }
   if(document&&part==='shared-comments') {
    if(req.method==='GET')return json(await comments.read(principal,tenant,document));
    if(req.method==='POST') {
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
     const data=await body(16_384);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
     return json(await comments.add(principal,tenant,document,data.value));
    }
    return json({error:'Операция недоступна.'},405);
   }
   if(document&&part==='copy'){
    if(req.method!=='POST'||!runtimeRoot)return json({error:'Копирование недоступно.'},405);
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    const data=await body(4096);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
    const args=z.object({requestId:z.string().uuid(),publicationId:z.string().uuid().optional(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140),folderId:z.string().uuid().nullable()}).strict().parse(data.value);
    return json(await new OrganizationDocumentCopy(resources,runtimeRoot).copy(principal,tenant,{...args,sourceDocumentId:document}));
   }
   if(document&&(part==='sharing'||part==='sharing-subjects')) {
    if(req.method==='GET')return json(part==='sharing'?await sharing.read(principal,tenant,document,url.searchParams.has('inheritance')?z.enum(['inherit','restricted']).parse(url.searchParams.get('inheritance')):undefined):await sharing.search(principal,tenant,document,url.searchParams.get('search')??''));
    if(req.method==='POST'&&part==='sharing') {
     if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
     const data=await body(4096);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
     return json(await sharing.change(principal,tenant,document,data.value));
    }
    return json({error:'Операция недоступна.'},405);
   }
   if(document&&part==='reactions'){
    if(req.method==='GET')return json(await reactions.read(principal,tenant,document));
    if(req.method==='POST'){const data=await body(4096);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);return json(await reactions.set(principal,tenant,document,data.value));}
   }
   if(action==='shared-library') {
    if(req.method!=='GET')return json({error:'Каталог поддерживает только чтение.'},405);
    return json(await shared.list(principal,tenant,{search:url.searchParams.get('search')??'',cursor:url.searchParams.get('cursor')??undefined,folderResourceId:url.searchParams.get('folderResourceId')??undefined,bookmarked:url.searchParams.get('bookmarked')==='1'}));
   }
   if(document&&(part==='view'||part==='cover'||part==='view-assets')) {
    if(req.method!=='GET')return json({error:'Просмотр не поддерживает запись.'},405);
    if(part==='view')return json(await shared.read(principal,tenant,document));
    const revision=z.coerce.number().int().positive().parse(url.searchParams.get('revision'));
    if(part==='cover')return json(await shared.cover(principal,tenant,document,revision));
    const asset=await shared.asset(principal,tenant,document,url.searchParams.get('id')??'',revision);
    return new Response(new Uint8Array(asset.bytes),{headers:{'Content-Type':asset.contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
   }
   const workspace=runtimeRoot?new OrganizationWorkspace(access,principal,tenant,runtimeRoot):null;
   const repo=workspace&&document?workspace.repository(document):null;
   if(document&&part&&repo&&req.method==='GET') {
    if(part==='history') {
     const p=await repo.read(),revision=url.searchParams.get('revision');
     if(!revision)return json(p?.history??[]);
     const entry=p?.history?.find(h=>h.revision===Number(revision));if(!entry)throw new OrganizationAccessError(404);
     const doc=await repo.readSnapshot(entry.hash);
     if(url.searchParams.get('include')==='sources')return json({doc,sourceSnapshot:await repo.readRevisionSources(Number(revision))});
     return json(doc);
    }
    if(part==='sources') {
     const file=await sourceDownload(repo,url.searchParams.get('id')??'');
     return new Response(new Uint8Array(file.bytes),{headers:file.headers});
    }
    if(part==='assets') {
     if(url.searchParams.has('revision')){
      const revision=z.coerce.number().int().positive().parse(url.searchParams.get('revision'));
      const asset=await repo.readRevisionAsset(revision,url.searchParams.get('id')??'');
      return new Response(new Uint8Array(asset.bytes),{headers:{'Content-Type':asset.contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
     }
     const p=await repo.read(),source=p?.state.sources.find(s=>s.id===url.searchParams.get('id')&&s.kind==='image');
     if(!source||!['image/png','image/jpeg'].includes(source.contentType))throw new OrganizationAccessError(404);
     const bytes=await repo.readFile(materialPath(source.sha256));
     const {createHash}=await import('node:crypto');if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('Invalid source bytes');
     return new Response(new Uint8Array(bytes),{headers:{'Content-Type':source.contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(part==='exports') {
     const id=url.searchParams.get('artifactId');if(!id)return json(await repo.listExportArtifacts(url.searchParams.get('cursor')??undefined));
     const manifest=await repo.readExportManifest(id);
     if(url.searchParams.get('part')!=='file')return json(manifest);
     return new Response(new Uint8Array(await repo.readExportArtifact(id)),{headers:{'Content-Type':manifest.output.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation','Content-Disposition':`attachment; filename="presentation-v${manifest.revision}.${manifest.output.format}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
   }
   if(req.method==='POST'&&workspace&&(action==='library'||document)) {
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    const data=await body(part==='images'?7_000_000:document?1_500_000:250_000);if('tooLarge' in data)return json({error:'Слишком большой запрос.'},413);
    if(action==='library')return json(await workspace.mutate(data.value));
    if(repo&&!part){return json(await humanCommand(repo,data.value,{requireEditorContract:true}));}
    if(repo&&part==='images')return json(await uploadImage(repo,data.value));
    if(repo&&part==='export') {
     const a=z.object({deckId:z.string().uuid(),expectedRevision:z.number().int().positive(),format:z.enum(['pdf','pptx'])}).strict().parse(data.value);
     const p=await repo.read();if(!p||p.state.doc.id!==a.deckId||p.state.revision!==a.expectedRevision)throw new OrganizationAccessError(409,'Конфликт версии экспорта.');
     const {renderProjectExport}=await import('../../scripts/project-mcp/export');
     const artifact=await renderProjectExport(repo,p,a.format);
     return new Response(new Uint8Array(artifact.bytes),{headers:{'Content-Type':a.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation','Content-Disposition':`attachment; filename="presentation-v${artifact.revision}.${a.format}"`,'Cache-Control':'no-store','X-Lanka-Artifact':artifact.artifactId,'X-Lanka-Revision':String(artifact.revision)}});
    }
   }
   if(req.method==='GET') {
    if(action==='members')return json(await access.membershipView(principal,tenant,{search:url.searchParams.get('search')??'',cursor:url.searchParams.get('cursor')??undefined,expectedEpoch:url.searchParams.get('expectedEpoch')??undefined}));
    if(action==='library')return json(await access.personalLibrary(principal,tenant,url.searchParams.get('cursor')??undefined,{search:url.searchParams.get('search')??'',folderId:url.searchParams.get('folderId')??undefined,trashed:url.searchParams.get('trash')==='1',pendingOnly:url.searchParams.get('pending')==='1'}));
    if(document&&!part){const project=repo?await repo.read():await access.personalProject(principal,tenant,document);return json(project?{...project,canProposeDraft:canProposeDraft(project)}:project);}
   }
   if(action==='members'&&req.method==='POST') {
    if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'Ожидается JSON.'},415);
    // Bounded body: the handler is reusable with Node Request streams.
    const reader=req.body?.getReader();if(!reader)return json({error:'Пустой запрос.'},400);
    let size=0;const chunks:Uint8Array[]=[];
    for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return json({error:'Слишком большой запрос.'},413);}chunks.push(value);}
    return json(await access.setMembership(principal,tenant,JSON.parse(Buffer.concat(chunks).toString('utf8'))));
   }
   return json({error:'Операция недоступна.'},405);
  } catch(error) {
   if(error instanceof ImagePlacementError)return json({error:error.message},400);
   if(error instanceof EditorUpgradeError)return json({error:error.message,code:"EDITOR_UPGRADE_REQUIRED"},426);
   if(error instanceof OrganizationAccessError)return json({error:error.message},error.status);
   if(error instanceof z.ZodError||error instanceof SyntaxError)return json({error:'Неверные поля запроса.'},400);
   if(error instanceof Error&&/^(Конфликт версии|Версия изменилась|Ключ повтора|Общее обсуждение|Источник предложения изменился)/.test(error.message))return json({error:error.message},409);
   if(error instanceof Error&&/^(Документ недоступен\.|Папка недоступна\.)$/.test(error.message))return json({error:'Организация или документ недоступны.'},404);
   if(error instanceof Error&&/^(Нельзя подменять|Нельзя подменить|Пустая заготовка|Документ находится вне|Изображение вне)/.test(error.message))return json({error:error.message},400);
   return json({error:'Сервис временно недоступен.'},503);
  }
 };
}
