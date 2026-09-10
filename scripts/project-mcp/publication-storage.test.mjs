import test from 'node:test';import {PDFDocument} from 'pdf-lib';import JSZip from 'jszip';import assert from 'node:assert/strict';
import {Pool} from 'pg';import {readFile,readdir,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:`export {readRevisionDependenciesIn} from './lib/adapters/postgres/revision-dependencies';export {PublicationCatalog} from './lib/adapters/postgres/publication-catalog';export {humanCommand} from './scripts/project-mcp/human';export {ChatDatabase,fingerprint} from './lib/adapters/postgres/chat-database';export {prepareWorkspaceDocument} from './lib/adapters/postgres/organization-workspace';export {corporateMcp} from './lib/server/corporate-mcp';export {OrganizationDocumentCopy} from './lib/adapters/postgres/document-copy';export {organizationApi} from './lib/server/organization-api';export {OrganizationPublications} from './lib/adapters/postgres/publications';export {renderPublication} from './scripts/project-mcp/publication-render';export {applySelfHostedMigrations,assertSelfHostedSchema} from './lib/adapters/postgres/schema';export {PostgresBrowserIdentityStore} from './lib/adapters/postgres/browser-identity';export {PostgresOrganizationAccess,provisionOrganization} from './lib/adapters/postgres/organization-access';export {OrganizationWorkspace} from './lib/adapters/postgres/organization-workspace';export {PostgresResourceAccess} from './lib/adapters/postgres/resource-access';export {AgentDelegations} from './lib/adapters/postgres/agent-delegations';export {preparePublicationPackage} from './lib/project/publication-package';`,resolveDir:process.cwd()},outfile:'.test-build/publication-storage.mjs',bundle:true,platform:'node',format:'esm',packages:'external',define:{__LANKA_EXPORT_BUILD__:JSON.stringify({buildHash:'0'.repeat(64),packageVersion:'test'})}});
const {PublicationCatalog,humanCommand,ChatDatabase,readRevisionDependenciesIn,fingerprint,prepareWorkspaceDocument,corporateMcp,OrganizationDocumentCopy,organizationApi,OrganizationPublications,renderPublication,applySelfHostedMigrations,assertSelfHostedSchema,PostgresBrowserIdentityStore,PostgresOrganizationAccess,provisionOrganization,OrganizationWorkspace,PostgresResourceAccess,AgentDelegations,preparePublicationPackage}=await import('../../.test-build/publication-storage.mjs');
const base=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
test('publication lifecycle preserves versions and authority across 0028 upgrade, rendering, activation and withdrawal',async()=>{
 const name='lanka_publication_'+randomUUID().replaceAll('-',''),admin=new Pool(base.connection),root=await mkdtemp(join(tmpdir(),'lanka-publications-'));let db,created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;db=new Pool({...base.connection,database:name});
  await db.query('CREATE SCHEMA lanka; CREATE TABLE lanka.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of (await readdir('db/self-hosted')).filter(n=>/^00\d\d_.*\.sql$/.test(n)&&n<'0029').sort()){
   const sql=await readFile('db/self-hosted/'+file,'utf8');await db.query(sql);await db.query('INSERT INTO lanka.schema_migrations(version,checksum) VALUES($1,$2)',[file.slice(0,-4),hash(sql)]);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lanka.schema_migrations')).rows[0].n,28);
  const identities=new PostgresBrowserIdentityStore(db),deployment=randomUUID(),token=randomBytes(32).toString('base64url');
  await identities.establish(deployment,{issuer:'https://publication.test',subject:'owner',name:'Owner'},token,null,new Date(Date.now()+3600000));
  const user=await identities.authenticate(deployment,token),tenant=randomUUID();
  await provisionOrganization(db,{requestId:tenant,slug:'publication-'+tenant,name:'Publication test',ownerUserId:user.userId});
  const orgs=new PostgresOrganizationAccess(db),resources=new PostgresResourceAccess(orgs),workspace=new OrganizationWorkspace(orgs,user,tenant,root),materialId=randomUUID();
  // Seed the old schema directly; running today's writer would require today's migration.
  const legacy=await prepareWorkspaceDocument(materialId,{action:'create_document',title:'Frozen version',folderId:null,profile:'focus-v2'});
  const legacyOwner=await orgs.withTenant(user,tenant,async(c,ctx)=>ctx.principalId);
  await db.query('INSERT INTO lanka.materials(tenant_id,id,owner_id,project) VALUES($1,$2,$3,$4)',[tenant,materialId,legacyOwner,JSON.stringify(legacy)]);
  await db.query('INSERT INTO lanka.material_revisions(tenant_id,material_id,revision,hash,doc,action) VALUES($1,$2,1,$3,$4,$5)',[tenant,materialId,fingerprint(legacy.state.doc),JSON.stringify(legacy.state.doc),'Legacy fixture']);
  const project=await workspace.repository(materialId).read(),node=(await db.query('SELECT id,owner_id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,materialId])).rows[0],actor=node.owner_id;
  const keys=new AgentDelegations(resources);await db.query("INSERT INTO lanka.agent_delegations(tenant_id,id,issuer_id,material_id,token_hash,name,capabilities,auth_epoch,fingerprint,expires_at,scope_kind) SELECT $1,$2,$3,$4,$5,'Upgrade key',ARRAY['read','comment','propose'],auth_epoch,'legacy-fixture',now()+interval '15 minutes','document' FROM lanka.auth_identities WHERE id=$6",[tenant,randomUUID(),actor,materialId,hash(randomBytes(32)),user.userId]);
  const session=randomUUID();await db.query("INSERT INTO lanka.agent_connections(tenant_id,owner_id,id) VALUES($1,$2,'test')",[tenant,actor]);
  await db.query("INSERT INTO lanka.agent_sessions(tenant_id,id,material_id,owner_id,connection_id) VALUES($1,$2,$3,$4,'test')",[tenant,session,materialId,actor]);
  await db.query("INSERT INTO lanka.agent_messages(tenant_id,id,session_id,sequence,role,text,status,mode,selection) VALUES($1,$2,$3,1,'user','Keep this chat','complete','discuss','{}')",[tenant,randomUUID(),session]);
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='lanka' AND tablename<>'schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`SELECT coalesce(jsonb_agg(row_data ORDER BY row_data::text),'[]'::jsonb) AS data FROM (SELECT to_jsonb(t) AS row_data FROM lanka.${table} t) q`)).rows[0].data])));
  const before=await snapshot();await assert.rejects(()=>assertSelfHostedSchema(db),/0029_publications/);await applySelfHostedMigrations(db);
  assert.deepEqual(await snapshot(),before);assert.equal((await assertSelfHostedSchema(db)).latest,'0036_revision_design_packages');await applySelfHostedMigrations(db);assert.deepEqual(await snapshot(),before);
  const pkg=await preparePublicationPackage(project,{tenantId:tenant,materialId,publicationId:randomUUID(),expectedRevision:project.state.revision,createdAt:new Date().toISOString()},async()=>{assert.fail('no images expected');});
  const id=pkg.payload.id,args=[tenant,id,node.id,materialId,project.state.revision,pkg.payload.origin.documentHash,actor,pkg.payload.createdAt,JSON.stringify(pkg.payload),pkg.bytes,pkg.hash];
  const insert='INSERT INTO lanka.publications(tenant_id,id,resource_id,material_id,source_revision,document_hash,actor_id,created_at,payload,payload_bytes,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
  await assert.rejects(()=>db.query(insert,[...args.slice(0,10),'0'.repeat(64)]),e=>e.code==='23514');
  const wrongOrigin=structuredClone(pkg.payload);wrongOrigin.origin.documentHash='0'.repeat(64);const wrongBytes=Buffer.from(JSON.stringify(wrongOrigin));
  const wrongArgs=[...args];wrongArgs[5]=wrongOrigin.origin.documentHash;wrongArgs[8]=JSON.stringify(wrongOrigin);wrongArgs[9]=wrongBytes;wrongArgs[10]=hash(wrongBytes);
  await assert.rejects(()=>db.query(insert,wrongArgs),e=>e.code==='23503');
  await db.query(insert,args);
  for(const b of pkg.blobs)await db.query('INSERT INTO lanka.publication_blobs(tenant_id,publication_id,hash,content_type,bytes) VALUES($1,$2,$3,$4,$5)',[tenant,id,b.hash,b.contentType,b.bytes]);
  const artifact=Buffer.from('synthetic PDF storage fixture');await db.query("INSERT INTO lanka.publication_artifacts(tenant_id,publication_id,kind,bytes,hash) VALUES($1,$2,'pdf',$3,$4)",[tenant,id,artifact,hash(artifact)]);
  await db.query('INSERT INTO lanka.publication_withdrawals(tenant_id,publication_id,actor_id) VALUES($1,$2,$3)',[tenant,id,actor]);
  await db.query("INSERT INTO lanka.publication_audit(tenant_id,publication_id,actor_id,action) VALUES($1,$2,$3,'withdraw')",[tenant,id,actor]);
  await db.query("INSERT INTO lanka.publication_receipts(tenant_id,publication_id,actor_id,request_id,fingerprint,operation,result) VALUES($1,$2,$3,$4,$5,'withdraw','{}')",[tenant,id,actor,randomUUID(),hash('request')]);
  for(const table of ['publications','publication_blobs','publication_artifacts','publication_withdrawals','publication_receipts','publication_audit']){
   await assert.rejects(()=>db.query(`UPDATE lanka.${table} SET tenant_id=tenant_id`),e=>e.code==='55000');
   await assert.rejects(()=>db.query(`DELETE FROM lanka.${table}`),e=>e.code==='55000');
  }
  await assert.rejects(()=>db.query('INSERT INTO lanka.publication_withdrawals(tenant_id,publication_id,actor_id) VALUES($1,$2,$3)',[tenant,id,actor]),e=>e.code==='23505');
  await assert.rejects(()=>db.query('INSERT INTO lanka.publication_blobs(tenant_id,publication_id,hash,content_type,bytes) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,hash('foreign'),'image/png',Buffer.from('foreign')]),e=>e.code==='23503');
  const frozen=(await db.query('SELECT payload_bytes FROM lanka.publications WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0].payload_bytes;assert.deepEqual(frozen,pkg.bytes);
  assert.deepEqual((await db.query('SELECT bytes FROM lanka.publication_artifacts WHERE tenant_id=$1 AND publication_id=$2',[tenant,id])).rows[0].bytes,artifact);
  // Real renderer and repository operations; no model or browser is substituted here.
  // Exercise 0029 -> 0030 with a populated legacy publication in this disposable database.
  await db.query("ALTER TABLE lanka.publication_artifacts DROP CONSTRAINT publication_artifacts_kind_check; ALTER TABLE lanka.publication_artifacts ADD CONSTRAINT publication_artifacts_kind_check CHECK(kind IN ('pdf','pptx','preview')); DELETE FROM lanka.schema_migrations WHERE version='0030_publication_dependencies'");
  const publicationRows=async()=>{const result={};for(const table of ['publications','publication_blobs','publication_artifacts','publication_withdrawals','publication_receipts','publication_audit'])result[table]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM lanka.${table} t`)).rows[0].data;return result;};
  const oldPublicationRows=await publicationRows();await assert.rejects(()=>assertSelfHostedSchema(db),/0030_publication_dependencies/);await applySelfHostedMigrations(db);assert.deepEqual(await publicationRows(),oldPublicationRows);
  // Reproduce the exact locally applied 0031 variant in this disposable DB.
  const original31=(await readFile('db/self-hosted/0031_revision_dependencies.sql','utf8')).replace('BETWEEN 1 AND 3000000','BETWEEN 1 AND 1500000');
  assert.equal(hash(original31),'41fbed0778f8bf124e12d3b670ab04b027119dd5299a5f4a089a9e42564818fc');
  await db.query("ALTER TABLE lanka.revision_dependency_snapshots DROP CONSTRAINT revision_dependency_snapshots_bytes_check, ADD CONSTRAINT revision_dependency_snapshots_bytes_check CHECK(octet_length(bytes) BETWEEN 1 AND 1500000)");
  await db.query("UPDATE lanka.schema_migrations SET checksum=$1 WHERE version='0031_revision_dependencies'",[hash(original31)]);
  await db.query("DELETE FROM lanka.schema_migrations WHERE version='0032_revision_dependency_limit'");
  await assert.rejects(()=>assertSelfHostedSchema(db),/0032_revision_dependency_limit/);
  const prior31=(await db.query("SELECT * FROM lanka.schema_migrations WHERE version='0031_revision_dependencies'")).rows[0];
  await applySelfHostedMigrations(db);assert.deepEqual((await db.query("SELECT * FROM lanka.schema_migrations WHERE version='0031_revision_dependencies'")).rows[0],prior31);
  assert.match((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='lanka.revision_dependency_snapshots'::regclass AND conname='revision_dependency_snapshots_bytes_check'")).rows[0].definition,/3000000/);
  await db.query("UPDATE lanka.schema_migrations SET checksum=$1 WHERE version='0031_revision_dependencies'",['f'.repeat(64)]);
  await assert.rejects(()=>applySelfHostedMigrations(db),/Applied migration changed/);
  await db.query("UPDATE lanka.schema_migrations SET checksum=$1 WHERE version='0031_revision_dependencies'",[hash(original31)]);
  const service=new OrganizationPublications(resources,renderPublication),repo=workspace.repository(materialId);
  const bobToken=randomBytes(32).toString('base64url');await identities.establish(deployment,{issuer:'https://publication.test',subject:'reader',name:'Reader'},bobToken,null,new Date(Date.now()+3600000));
  const bob=await identities.authenticate(deployment,bobToken);await orgs.setMembership(user,tenant,{requestId:randomUUID(),userId:bob.userId,role:'member',status:'active'});
  const bobId=await orgs.withTenant(bob,tenant,async(c,ctx)=>ctx.principalId);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:true}});
  await assert.rejects(()=>service.prepare(bob,tenant,materialId,{expectedRevision:1}),e=>e.status===403);
  await assert.rejects(()=>service.prepare({kind:'delegated',tokenHash:'0'.repeat(64)},tenant,materialId,{expectedRevision:1}),e=>e.status===403);
  const prepared=await service.prepare(user,tenant,materialId,{expectedRevision:1});
  const publish={requestId:randomUUID(),preparedId:prepared.id,expectedHash:prepared.hash,audience:'current-document-access'};
  await assert.rejects(()=>service.read(bob,tenant,materialId,prepared.id),e=>e.status===404);
  const published=await service.activate(user,tenant,materialId,publish);assert.equal(published.withdrawn,false);assert.deepEqual(await service.activate(user,tenant,materialId,publish),published);
  const frozenPayload=await service.read(bob,tenant,materialId,published.id);assert.equal(frozenPayload.origin.revision,1);
  const mcp=corporateMcp(resources,'http://lanka.test',root),readSecret=randomBytes(32).toString('hex'),createSecret=randomBytes(32).toString('hex');
  const readKey=await keys.issue(user,tenant,materialId,{requestId:randomUUID(),secret:readSecret,name:'Publication read',capability:'read',minutes:15});
  await keys.issue(user,tenant,null,{requestId:randomUUID(),secret:createSecret,name:'Publication copy',capability:'create',minutes:15});
  const rpc=async(secret,document,method,params)=>{const response=await mcp(new Request('http://lanka.test/mcp',{method:'POST',headers:{Authorization:'Bearer '+secret,Accept:'application/json, text/event-stream','Content-Type':'application/json','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),tenant,document);return {status:response.status,body:await response.json()};};
  const tool=(secret,document,name,args={})=>rpc(secret,document,'tools/call',{name,arguments:args});
  const value=r=>{assert.equal(r.status,200);assert.ok(r.body.result&&!r.body.result.isError,JSON.stringify(r.body));return JSON.parse(r.body.result.content[0].text);};
  const tools=(await rpc(readSecret,materialId,'tools/list',{})).body.result.tools;
  for(const name of ['lanka_list_publications','lanka_get_publication','lanka_preview_publication'])assert.ok(tools.some(t=>t.name===name));
  assert.equal(tools.some(t=>t.name==='lanka_copy_shared_document'),false);assert.equal(tools.some(t=>/publish$|withdraw/.test(t.name)),false);
  const versions=value(await tool(readSecret,materialId,'lanka_list_publications'));assert.equal(versions.items.length,1);assert.equal(versions.items[0].id,published.id);assert.equal(versions.nextCursor,null);
  const readFrozen=value(await tool(readSecret,materialId,'lanka_get_publication',{publicationId:published.id}));assert.equal(readFrozen.origin.revision,1);assert.equal(readFrozen.permission.canCopy,false);
  const picture=await tool(readSecret,materialId,'lanka_preview_publication',{publicationId:published.id,page:1});assert.equal(picture.body.result.content[1].type,'image');assert.equal(picture.body.result.content[1].mimeType,'image/png');
  const workspaceTools=(await rpc(createSecret,undefined,'tools/list',{})).body.result.tools;assert.ok(workspaceTools.find(t=>t.name==='lanka_copy_shared_document').inputSchema.properties.publicationId);
  assert.ok(workspaceTools.find(t=>t.name==='lanka_get_publication').inputSchema.required.includes('documentId'));
  assert.equal(value(await tool(createSecret,undefined,'lanka_get_publication',{documentId:materialId,publicationId:published.id})).permission.canCopy,true);
  const mcpCopyRequest={requestId:randomUUID(),sourceDocumentId:materialId,publicationId:published.id,expectedRevision:1,title:'MCP publication copy',folderId:null};
  const mcpCopy=value(await tool(createSecret,undefined,'lanka_copy_shared_document',mcpCopyRequest));assert.equal(mcpCopy.sourcePublicationId,published.id);
  assert.deepEqual(value(await tool(createSecret,undefined,'lanka_copy_shared_document',mcpCopyRequest)),mcpCopy);
  await keys.revoke(user,tenant,materialId,readKey.id);assert.ok([401,403].includes((await tool(readSecret,materialId,'lanka_get_publication',{publicationId:published.id})).status));

  const pdf=await service.artifact(bob,tenant,materialId,published.id,'pdf'),pptx=await service.artifact(bob,tenant,materialId,published.id,'pptx'),preview=await service.artifact(bob,tenant,materialId,published.id,'preview',1);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(),project.state.doc.slides.length);assert.equal(preview.bytes.subarray(1,4).toString(),'PNG');
  await mkdir('out',{recursive:true});await writeFile('out/publication-service-preview.png',preview.bytes);await writeFile('out/publication-service.pdf',pdf.bytes);await writeFile('out/publication-service.pptx',pptx.bytes);
  const dependencies=await service.artifact(bob,tenant,materialId,published.id,'dependencies');const bundle=await JSZip.loadAsync(dependencies.bytes),manifest=JSON.parse(await bundle.file('manifest.json').async('string'));
  assert.equal(manifest.publicationId,published.id);assert.equal(manifest.payloadHash,published.hash);assert.equal(manifest.sourceRevision,1);assert.equal(manifest.fontsEmbeddedIn.pptx,false);
  for(const file of manifest.files){const bytes=await bundle.file(file.path).async('nodebuffer');assert.equal(hash(bytes),file.sha256);assert.equal(bytes.length,file.bytes);assert.deepEqual(bytes,await readFile('public/fonts/'+file.path.split('/').at(-1)));}
  assert.equal(manifest.artifacts.find(a=>a.kind==='pdf').sha256,pdf.hash);assert.equal(manifest.artifacts.find(a=>a.kind==='pptx').sha256,pptx.hash);
  assert.equal(JSON.stringify(manifest).includes('PRIVATE_'),false);
  const zip=await JSZip.loadAsync(pptx.bytes);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<a:t>/);
  await repo.mutate(randomUUID(),{test:'source edited'},old=>{old.state.doc.slides[0].notes='PRIVATE_NEW_NOTES';old.state.revision++;return {project:old,result:{}};});
  assert.deepEqual(await service.read(bob,tenant,materialId,published.id),frozenPayload);assert.deepEqual((await service.artifact(bob,tenant,materialId,published.id,'pdf')).bytes,pdf.bytes);
  const copier=new OrganizationDocumentCopy(resources,root),copyRequest={requestId:randomUUID(),sourceDocumentId:materialId,publicationId:published.id,expectedRevision:1,title:'Reader copy',folderId:null};
  const copyResult=await copier.copy(bob,tenant,copyRequest);assert.equal(copyResult.sourcePublicationId,published.id);assert.deepEqual(await copier.copy(bob,tenant,copyRequest),copyResult);
  const readerWorkspace=new OrganizationWorkspace(orgs,bob,tenant,root),readerCopy=await readerWorkspace.repository(copyResult.id).read();
  const archive=async rev=>(await db.query('SELECT payload,bytes,hash FROM lanka.revision_dependency_snapshots WHERE tenant_id=$1 AND material_id=$2 AND revision=$3',[tenant,copyResult.id,rev])).rows[0];
  const captured=await archive(1);assert.ok(captured);assert.deepEqual(captured.payload.sources,readerCopy.state.sources);assert.equal(hash(captured.bytes),captured.hash);
  const retainedHash=readerCopy.state.sources[0].sha256,retained=(await db.query('SELECT bytes FROM lanka.revision_dependency_blobs WHERE tenant_id=$1 AND material_id=$2 AND hash=$3',[tenant,copyResult.id,retainedHash])).rows[0].bytes;
  await readerWorkspace.repository(copyResult.id).mutate(randomUUID(),{test:'source metadata changes'},old=>{old.state.sources[0].name='Later source name';old.state.revision++;return {project:old,result:{}};});
  assert.deepEqual(await archive(1),captured);assert.equal((await archive(2)).payload.sources[0].name,'Later source name');
  await db.query('DELETE FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[tenant,copyResult.id,'materials/'+retainedHash+'.bin']);
  assert.deepEqual((await db.query('SELECT bytes FROM lanka.revision_dependency_blobs WHERE tenant_id=$1 AND material_id=$2 AND hash=$3',[tenant,copyResult.id,retainedHash])).rows[0].bytes,retained);
  await readerWorkspace.repository(copyResult.id).mutate(randomUUID(),{test:'missing current source'},old=>{old.state.revision++;return {project:old,result:{}};});assert.ok((await archive(3)).payload.unavailable.some(f=>f.sha256===retainedHash&&f.reason==='missing'));assert.deepEqual(await archive(1),captured);
  await assert.rejects(()=>db.query('UPDATE lanka.revision_dependency_snapshots SET payload=payload WHERE tenant_id=$1 AND material_id=$2',[tenant,copyResult.id]),e=>e.code==='55000');
  await assert.rejects(()=>db.query('UPDATE lanka.revision_dependency_blobs SET bytes=bytes WHERE tenant_id=$1 AND material_id=$2',[tenant,copyResult.id]),e=>e.code==='55000');
  await db.query("CREATE FUNCTION lanka.fail_revision_capture_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'capture unavailable' USING ERRCODE='23514'; END; $$; CREATE TRIGGER fail_revision_capture_test BEFORE INSERT ON lanka.revision_dependency_snapshots FOR EACH ROW EXECUTE FUNCTION lanka.fail_revision_capture_test()");
  await assert.rejects(()=>readerWorkspace.repository(copyResult.id).mutate(randomUUID(),{test:'archive failure'},old=>{old.state.revision++;return {project:old,result:{}};}),/capture unavailable/);
  assert.equal((await readerWorkspace.repository(copyResult.id).read()).state.revision,3);assert.equal((await db.query('SELECT 1 FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=4',[tenant,copyResult.id])).rowCount,0);
  await db.query('DROP TRIGGER fail_revision_capture_test ON lanka.revision_dependency_snapshots; DROP FUNCTION lanka.fail_revision_capture_test()');
  const historical=await readRevisionDependenciesIn(db,tenant,copyResult.id,1);assert.deepEqual(historical.project.state.sources,readerCopy.state.sources);assert.deepEqual(await historical.read(retainedHash),retained);
  await assert.rejects(()=>readRevisionDependenciesIn(db,randomUUID(),copyResult.id,1),e=>e.status===409);
  await assert.rejects(()=>(readRevisionDependenciesIn(db,tenant,copyResult.id,3)).then(h=>h.read(retainedHash)),e=>e.status===409);
  await assert.rejects(()=>service.prepare(user,tenant,materialId,{expectedRevision:2,sourceRevision:1}),e=>e.status===409); // legacy has no captured sources
  const oldPrepared=await service.prepare(bob,tenant,copyResult.id,{expectedRevision:3,sourceRevision:1});assert.equal(oldPrepared.sourceRevision,1);assert.equal(oldPrepared.headRevision,3);
  const oldPublication=await service.activate(bob,tenant,copyResult.id,{requestId:randomUUID(),preparedId:oldPrepared.id,expectedHash:oldPrepared.hash,audience:'current-document-access'});assert.equal(oldPublication.revision,1);
  const staleOld=await service.prepare(bob,tenant,copyResult.id,{expectedRevision:3,sourceRevision:1});
  await readerWorkspace.repository(copyResult.id).mutate(randomUUID(),{test:'head changes after old preview'},old=>{old.state.revision++;return {project:old,result:{}};});
  await assert.rejects(()=>service.activate(bob,tenant,copyResult.id,{requestId:randomUUID(),preparedId:staleOld.id,expectedHash:staleOld.hash,audience:'current-document-access'}),e=>e.status===409);
  await service.withdraw(bob,tenant,copyResult.id,{requestId:randomUUID(),publicationId:oldPublication.id});

  const restoreApi=organizationApi(orgs,root),copyUrl='http://lanka.test/api/organizations/'+tenant+'/documents/'+copyResult.id;
  const historyResponse=await restoreApi(new Request(copyUrl+'/history?revision=1&include=sources'),bob);assert.equal(historyResponse.status,200);const historyView=await historyResponse.json();assert.deepEqual(historyView.doc,readerCopy.state.doc);assert.deepEqual(historyView.sourceSnapshot.sources,readerCopy.state.sources);
  assert.ok([403,404].includes((await restoreApi(new Request(copyUrl+'/history?revision=1&include=sources'),user)).status));
  const legacyHistory=await restoreApi(new Request('http://lanka.test/api/organizations/'+tenant+'/documents/'+materialId+'/history?revision=1&include=sources'),user);assert.equal(legacyHistory.status,200);assert.equal((await legacyHistory.json()).sourceSnapshot,null);
  const restoreCall=(revision,requestId=randomUUID(),principal=bob)=>restoreApi(new Request(copyUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,deckId:copyResult.id,expectedRevision:4,command:{action:'restore',revision}})}),principal);
  assert.ok([403,404].includes((await restoreCall(1,randomUUID(),user)).status));
  assert.equal((await restoreCall(3)).status,409);assert.equal((await readerWorkspace.repository(copyResult.id).read()).state.revision,4);
  await db.query("CREATE TRIGGER fail_revision_capture_test BEFORE INSERT ON lanka.revision_dependency_snapshots FOR EACH ROW EXECUTE FUNCTION lanka.reject_publication_mutation()");
  assert.ok((await restoreCall(1)).status>=400);
  assert.equal((await readerWorkspace.repository(copyResult.id).read()).state.revision,4);
  assert.equal((await db.query('SELECT 1 FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[tenant,copyResult.id,'materials/'+retainedHash+'.bin'])).rowCount,0);
  await db.query('DROP TRIGGER fail_revision_capture_test ON lanka.revision_dependency_snapshots');
  const restoreRequest=randomUUID(),restoredResponse=await restoreCall(1,restoreRequest);assert.equal(restoredResponse.status,200);assert.equal((await restoredResponse.json()).revision,5);
  assert.equal((await restoreCall(1,restoreRequest)).status,200);
  const restoredCopy=await readerWorkspace.repository(copyResult.id).read();assert.equal(restoredCopy.state.revision,5);assert.deepEqual(restoredCopy.state.sources,readerCopy.state.sources);assert.deepEqual(restoredCopy.state.doc,readerCopy.state.doc);
  assert.deepEqual(await readerWorkspace.repository(copyResult.id).readFile('materials/'+retainedHash+'.bin'),retained);
  assert.deepEqual((await archive(5)).payload.sources,captured.payload.sources);assert.deepEqual(await archive(1),captured);
  assert.equal((await restoreCall(1)).status,409); // stale expectedRevision cannot create another revision
  const localDb=new ChatDatabase({connection:{...base.connection,database:name},tenantId:tenant,ownerId:bobId,runtimeRoot:root});
  try{
   const localRepo=localDb.repository(copyResult.id);
   await assert.rejects(()=>localRepo.restoreRevision(1),/внутри операции/);
   const result=await humanCommand(localRepo,{requestId:randomUUID(),deckId:copyResult.id,expectedRevision:5,command:{action:'restore',revision:1}});
   assert.equal(result.revision,6);assert.deepEqual((await localRepo.read()).state.sources,readerCopy.state.sources);
  }finally{await localDb.close();}


  assert.equal((await db.query('SELECT 1 FROM lanka.revision_dependency_snapshots WHERE tenant_id=$1 AND material_id=$2 AND revision=1',[tenant,materialId])).rowCount,0); // legacy revision was not invented from current state
  assert.equal(readerCopy.state.revision,1);assert.equal(readerCopy.state.doc.title,'Reader copy');assert.equal(JSON.stringify(readerCopy).includes('PRIVATE_NEW_NOTES'),false);
  assert.notEqual(readerCopy.state.doc.slides[0].id,frozenPayload.document.slides[0].id);
  const objects=c=>c.map(({id,...rest})=>rest.kind==='image'?{...rest,assetId:'image'}:rest.kind==='chart'||rest.kind==='table'?{...rest,data:{...rest.data,sourceId:'source'}}:rest);assert.deepEqual(objects(readerCopy.state.doc.slides[0].canvas),objects(frozenPayload.document.slides[0].canvas));
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:false}});
  await assert.rejects(()=>copier.copy(bob,tenant,copyRequest),e=>e.status===403);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:true}});
  const next=await service.prepare(user,tenant,materialId,{expectedRevision:2});
  await repo.mutate(randomUUID(),{test:'source changed again'},old=>{old.state.doc.slides[0].notes='PRIVATE_LATER';old.state.revision++;return {project:old,result:{}};});
  await assert.rejects(()=>service.activate(user,tenant,materialId,{...publish,requestId:randomUUID(),preparedId:next.id,expectedHash:next.hash}),e=>e.status===409);
  const racing=new OrganizationPublications(resources,async pkg=>{await repo.mutate(randomUUID(),{test:'during render'},old=>{old.state.doc.slides[0].notes='PRIVATE_RACE';old.state.revision++;return {project:old,result:{}};});return renderPublication(pkg);});
  await assert.rejects(()=>racing.prepare(user,tenant,materialId,{expectedRevision:3}),e=>e.status===409);
  const partial=new OrganizationPublications(resources,async()=>[]);await assert.rejects(()=>partial.prepare(user,tenant,materialId,{expectedRevision:4}),e=>e.status===409);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:null,canCopy:false}});
  await assert.rejects(()=>service.read(bob,tenant,materialId,published.id),e=>[403,404].includes(e.status));
  await assert.rejects(()=>service.artifact(bob,tenant,materialId,published.id,'pdf'),e=>[403,404].includes(e.status));
  const withdrawn=await service.withdraw(user,tenant,materialId,{requestId:randomUUID(),publicationId:published.id});assert.equal(withdrawn.withdrawn,true);
  assert.equal((await service.activate(user,tenant,materialId,publish)).withdrawn,true);
  assert.ok(!(await service.list(user,tenant,materialId)).items.some(item=>item.id===published.id));
  const ownerAudit=await service.list(user,tenant,materialId,{includeWithdrawn:true});
  assert.equal(ownerAudit.canReadWithdrawn,true);assert.equal(ownerAudit.items.find(item=>item.id===published.id).withdrawn,true);
  await assert.rejects(()=>service.list({kind:'delegated',tokenHash:hash(createSecret)},tenant,materialId,{includeWithdrawn:true}),e=>e.status===403);
  await assert.rejects(()=>service.artifact(user,tenant,materialId,published.id,'pdf'),e=>e.status===404);

  const withdrawnMcp=await tool(createSecret,undefined,'lanka_get_publication',{documentId:materialId,publicationId:published.id});assert.ok(withdrawnMcp.body.result?.isError||withdrawnMcp.body.error);
  const withdrawnCopy=await tool(createSecret,undefined,'lanka_copy_shared_document',mcpCopyRequest);assert.ok(withdrawnCopy.body.result?.isError||withdrawnCopy.body.error);

  await assert.rejects(()=>service.read(user,tenant,materialId,published.id),e=>e.status===404);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lanka.publications')).rows[0].n,3);
  const api=organizationApi(orgs,root),url='http://lanka.test/api/organizations/'+tenant+'/documents/'+materialId+'/publications';
  const apiPost=(suffix,value,principal=user)=>api(new Request(url+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),principal);
  const apiGet=(suffix,principal=user)=>api(new Request(url+suffix),principal);
  const apiPreparedResponse=await apiPost('',{action:'prepare',expectedRevision:4});assert.equal(apiPreparedResponse.status,200);const apiPrepared=await apiPreparedResponse.json();
  assert.equal(JSON.stringify(apiPrepared).includes('PRIVATE_'),false);
  assert.equal(apiPrepared.audienceEpoch,(await (await api(new Request(url.replace(/\/publications$/,'/sharing')),user)).json()).authzEpoch);
  const previewResponse=await apiGet('/'+apiPrepared.id+'/artifacts?kind=preview&page=1&prepared=true');assert.equal(previewResponse.status,200);assert.equal(previewResponse.headers.get('cache-control'),'no-store');assert.equal(previewResponse.headers.get('content-type'),'image/png');
  assert.equal((await apiGet('/'+apiPrepared.id+'/artifacts?kind=preview&page=1&prepared=true',bob)).status,404);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:true}});
  const apiPublish={action:'publish',requestId:randomUUID(),preparedId:apiPrepared.id,expectedHash:apiPrepared.hash,audience:'current-document-access'};
  assert.equal((await apiPost('',apiPublish)).status,409); // audience changed after preview
  const currentPrepared=await (await apiPost('',{action:'prepare',expectedRevision:4})).json();
  const currentPublish={...apiPublish,preparedId:currentPrepared.id,expectedHash:currentPrepared.hash};
  const apiPublishedResponse=await apiPost('',currentPublish);assert.equal(apiPublishedResponse.status,200);const apiPublished=await apiPublishedResponse.json();
  await assert.rejects(()=>copier.copy(bob,tenant,copyRequest),e=>e.status===404);
  const listed=await (await apiGet('',bob)).json();assert.equal(listed.items.length,1);assert.equal(listed.items[0].id,apiPublished.id);
  const apiPayload=await (await apiGet('/'+apiPublished.id,bob)).json();assert.equal(JSON.stringify(apiPayload).includes('PRIVATE_'),false);assert.equal(apiPayload.origin.revision,4);
  const download=await apiGet('/'+apiPublished.id+'/artifacts?kind=pdf',bob);assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/pdf');assert.match(download.headers.get('content-disposition'),/attachment/);
  const apiWithdraw={action:'withdraw',requestId:randomUUID()};assert.equal((await apiPost('/'+apiPublished.id,apiWithdraw,bob)).status,403);
  assert.equal((await apiPost('/'+apiPublished.id,apiWithdraw)).status,200);
  assert.equal((await (await apiPost('',currentPublish)).json()).withdrawn,true);
  assert.equal((await apiGet('/'+apiPublished.id,bob)).status,404);assert.equal((await apiGet('/'+apiPublished.id+'/artifacts?kind=pdf',bob)).status,404);
  assert.deepEqual((await (await apiGet('',bob)).json()).items,[]);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'manager',canCopy:true}});
  const bobPrepared=await (await apiPost('',{action:'prepare',expectedRevision:4},bob)).json();assert.ok(bobPrepared.id);
  const bobPublish={...currentPublish,requestId:randomUUID(),preparedId:bobPrepared.id,expectedHash:bobPrepared.hash};
  assert.equal((await apiPost('',bobPublish,user)).status,409); // another manager cannot use this actor's handle
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:true}});
  assert.equal((await apiPost('',bobPublish,bob)).status,403);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'manager',canCopy:true}});
  assert.equal((await apiGet('?history=1',bob)).status,200);assert.equal((await (await apiGet('?history=1',bob)).json()).canReadHistory,false);
  assert.equal((await apiPost('',{action:'prepare',expectedRevision:4,sourceRevision:2},bob)).status,403);
  await resources.mutate(user,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:'viewer',canCopy:true}});
  // Pagination uses reused real export bytes; this checks ordering, not 51 distinct renders.
  const paged=new OrganizationPublications(resources,async pkg=>{const copy=await JSZip.loadAsync(dependencies.bytes);copy.file('manifest.json',JSON.stringify({...manifest,publicationId:pkg.payload.id,payloadHash:pkg.hash,sourceRevision:pkg.payload.origin.revision,documentDependencies:pkg.payload.dependencies}));return [{kind:'dependencies',page:0,bytes:await copy.generateAsync({type:'nodebuffer'})},{kind:'pdf',page:0,bytes:pdf.bytes},{kind:'pptx',page:0,bytes:pptx.bytes},{kind:'preview',page:1,bytes:preview.bytes}];});
  for(let n=0;n<51;n++){const prep=await paged.prepare(user,tenant,materialId,{expectedRevision:4});await paged.activate(user,tenant,materialId,{requestId:randomUUID(),preparedId:prep.id,expectedHash:prep.hash,audience:'current-document-access'});}
  const firstPage=value(await tool(createSecret,undefined,'lanka_list_publications',{documentId:materialId}));assert.equal(firstPage.items.length,50);assert.ok(firstPage.nextCursor);
  const secondPage=value(await tool(createSecret,undefined,'lanka_list_publications',{documentId:materialId,cursor:firstPage.nextCursor}));assert.equal(secondPage.items.length,1);assert.equal(secondPage.nextCursor,null);
  assert.equal(new Set([...firstPage.items,...secondPage.items].map(p=>p.id)).size,51);
  const catalogUrl='http://lanka.test/api/organizations/'+tenant+'/publication-catalog';
  const catalogGet=(query='',principal=bob)=>api(new Request(catalogUrl+query),principal);
  const catalogPage=await (await catalogGet()).json();assert.equal(catalogPage.items.length,50);assert.ok(catalogPage.nextCursor);
  assert.deepEqual(catalogPage.items.map(p=>p.id),firstPage.items.map(p=>p.id));
  assert.equal(catalogPage.items[0].publishedBy,'Owner');assert.equal(catalogPage.items[0].canCopy,true);
  assert.equal(catalogPage.items[0].documentId,materialId);
  const catalogTail=await (await catalogGet('?cursor='+encodeURIComponent(catalogPage.nextCursor))).json();assert.equal(catalogTail.items.length,1);
  const mcpCatalog=value(await tool(createSecret,undefined,'lanka_search_publications'));
  assert.deepEqual(mcpCatalog.items.map(p=>p.id),catalogPage.items.map(p=>p.id));
  assert.equal(workspaceTools.find(t=>t.name==='lanka_search_publications').inputSchema.required.includes('documentId'),false);
  assert.equal(tools.some(t=>t.name==='lanka_search_publications'),false);
  await paged.withdraw(user,tenant,materialId,{requestId:randomUUID(),publicationId:firstPage.items.at(-1).id});
  assert.deepEqual(value(await tool(createSecret,undefined,'lanka_list_publications',{documentId:materialId,cursor:firstPage.nextCursor})),secondPage);
  assert.deepEqual(await (await catalogGet('?cursor='+encodeURIComponent(catalogPage.nextCursor))).json(),catalogTail);
  assert.equal((await catalogGet('?cursor=invalid')).status,400);
  assert.equal((await catalogGet('?unknown=1')).status,400);
  assert.equal((await api(new Request(catalogUrl,{method:'POST'}),user)).status,405);
  const react=async(kind,active,principal=bob,requestId=randomUUID())=>api(new Request('http://lanka.test/api/organizations/'+tenant+'/documents/'+materialId+'/reactions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,kind,active})}),principal);
  assert.deepEqual((await(await catalogGet('?bookmarked=true')).json()).items,[]);
  const reactionRequest=randomUUID();assert.equal((await react('like',true,bob,reactionRequest)).status,200);assert.equal((await react('like',true,bob,reactionRequest)).status,200);
  assert.equal((await react('bookmark',true)).status,200);
  const favoritePage=await(await catalogGet('?bookmarked=true')).json();assert.equal(favoritePage.items.length,50);assert.ok(favoritePage.items.every(p=>p.reactions.likes===1&&p.reactions.liked&&p.reactions.bookmarked));
  assert.deepEqual((await(await catalogGet('?bookmarked=true',user)).json()).items,[]);
  assert.ok(value(await tool(createSecret,undefined,'lanka_search_publications')).items.every(p=>!('reactions' in p)));
  assert.equal((await catalogGet('?bookmarked=not-boolean')).status,400);
  await assert.rejects(()=>new PublicationCatalog(resources).list({kind:'delegated',tokenHash:hash(createSecret)},tenant,{bookmarked:true}),e=>e.status===403);
  // Newer private publications must not consume a reader's first page or leak a cursor.
  const privateId=randomUUID();await workspace.mutate({requestId:privateId,command:{action:'create_document',title:'PRIVATE_CATALOG_SENTINEL',folderId:null}});
  for(let n=0;n<51;n++){const prep=await paged.prepare(user,tenant,privateId,{expectedRevision:1});await paged.activate(user,tenant,privateId,{requestId:randomUUID(),preparedId:prep.id,expectedHash:prep.hash,audience:'current-document-access'});}
  const visible=await (await catalogGet()).json();assert.equal(visible.items.length,50);assert.equal(visible.nextCursor,null);assert.ok(visible.items.every(p=>p.documentId===materialId));
  assert.equal(JSON.stringify(visible).includes('PRIVATE_CATALOG_SENTINEL'),false);
  assert.deepEqual((await (await catalogGet('?search=PRIVATE_CATALOG_SENTINEL')).json()).items,[]);
  assert.equal((await (await catalogGet('?search=private_catalog_sentinel',user)).json()).items.length,50);
  assert.equal((await react('bookmark',true,user)).status,200);
  const ownerFavorites=await(await catalogGet('?bookmarked=true',user)).json();assert.equal(ownerFavorites.items.length,50);assert.ok(ownerFavorites.items.every(p=>p.documentId===materialId));
  const otherTenant=randomUUID();await provisionOrganization(db,{requestId:otherTenant,slug:'other-'+otherTenant,name:'Other',ownerUserId:bob.userId});
  const otherResponse=await api(new Request(catalogUrl.replace(tenant,otherTenant)),bob);assert.equal(otherResponse.status,200);assert.deepEqual((await otherResponse.json()).items,[]);
  assert.ok([403,404].includes((await api(new Request(catalogUrl.replace(tenant,otherTenant)),user)).status));
  // Search uses the frozen title even after the current draft is renamed.
  const frozenTitle=visible.items[0].title;
  await repo.mutate(randomUUID(),{test:'rename current draft'},old=>{old.title='New draft title';old.state.doc.title='New draft title';old.state.revision++;return {project:old,result:{}};});
  assert.equal((await (await catalogGet('?search='+encodeURIComponent(frozenTitle))).json()).items.length,50);
  assert.deepEqual((await (await catalogGet('?search=New%20draft%20title')).json()).items,[]);
  const folderId=randomUUID();await workspace.mutate({requestId:folderId,command:{action:'create_folder',name:'Publications'}});
  const folderNode=(await db.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND folder_id=$2',[tenant,folderId])).rows[0].id;
  const mutate=command=>resources.mutate(user,tenant,{requestId:randomUUID(),command});
  await mutate({action:'move',resourceId:node.id,parentFolderId:folderNode});
  const scopedSecret=randomBytes(32).toString('hex');const scopedKey=await keys.issue(user,tenant,null,{requestId:randomUUID(),secret:scopedSecret,name:'Publication folder',capability:'read',minutes:15,folderId});
  const scoped=value(await tool(scopedSecret,undefined,'lanka_search_publications'));assert.deepEqual(scoped.folders.map(f=>f.id),[folderNode]);assert.equal(scoped.folder,null);assert.equal(scoped.items.length,50);assert.equal(scoped.nextCursor,null);assert.ok(scoped.items.every(p=>p.documentId===materialId&&!p.canCopy));
  assert.deepEqual((await (await catalogGet()).json()).folders,[]); // direct document access does not disclose its private parent
  const explicitFolder=value(await tool(createSecret,undefined,'lanka_search_publications',{folderResourceId:folderNode}));assert.equal(explicitFolder.folder.id,folderNode);assert.equal(explicitFolder.folder.name,'Publications');assert.equal(explicitFolder.items.length,50);assert.equal(explicitFolder.nextCursor,null);
  const otherFolder=randomUUID();await workspace.mutate({requestId:otherFolder,command:{action:'create_folder',name:'Outside'}});
  const otherFolderNode=(await db.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND folder_id=$2',[tenant,otherFolder])).rows[0].id;
  const outside=await tool(scopedSecret,undefined,'lanka_search_publications',{folderResourceId:otherFolderNode});assert.ok(outside.body.result?.isError||outside.body.error);
  await mutate({action:'grant',resourceId:node.id,subject:{kind:'principal',id:bobId},role:null,canCopy:false});
  assert.deepEqual((await (await catalogGet()).json()).items,[]);
  const group=randomUUID();await mutate({action:'group_set',id:group,name:'Readers',status:'active'});
  await mutate({action:'group_member',groupId:group,principalId:bobId,present:true});
  await mutate({action:'grant',resourceId:folderNode,subject:{kind:'group',id:group},role:'viewer',canCopy:false});
  await mutate({action:'inheritance',resourceId:node.id,inheritance:'inherit'});
  const inheritedCatalog=await (await catalogGet()).json();assert.deepEqual(inheritedCatalog.folders.map(f=>f.id),[folderNode]);assert.equal(inheritedCatalog.items.length,50);
  await mutate({action:'inheritance',resourceId:node.id,inheritance:'restricted'});assert.deepEqual((await (await catalogGet()).json()).items,[]);
  await mutate({action:'inheritance',resourceId:node.id,inheritance:'inherit'});
  await mutate({action:'group_member',groupId:group,principalId:bobId,present:false});assert.deepEqual((await (await catalogGet()).json()).items,[]);
  await mutate({action:'group_member',groupId:group,principalId:bobId,present:true});
  await mutate({action:'group_set',id:group,name:'Readers',status:'suspended'});assert.deepEqual((await (await catalogGet()).json()).items,[]);
  await mutate({action:'group_set',id:group,name:'Readers',status:'active'});
  await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id:materialId,trashed:true}});assert.deepEqual((await (await catalogGet()).json()).items,[]);
  await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id:materialId,trashed:false}});assert.equal((await (await catalogGet()).json()).items.length,50);
  await mutate({action:'move',resourceId:node.id,parentFolderId:null});
  assert.deepEqual(value(await tool(scopedSecret,undefined,'lanka_search_publications')).items,[]);assert.deepEqual((await (await catalogGet()).json()).items,[]);
  assert.deepEqual((await(await catalogGet('?bookmarked=true')).json()).items,[]);
  await keys.revoke(user,tenant,null,scopedKey.id);assert.ok([401,403].includes((await tool(scopedSecret,undefined,'lanka_search_publications')).status));
  for(let n=0;n<55;n++)await repo.mutate(randomUUID(),{test:'history page',n},old=>{old.state.revision++;return {project:old,result:{}};});
  const historyPage=await service.history(user,tenant,materialId);assert.equal(historyPage.items.length,50);assert.ok(historyPage.nextCursor);
  const historyTail=await service.history(user,tenant,materialId,historyPage.nextCursor);assert.ok(historyTail.items.length>0);assert.equal(historyTail.nextCursor,null);
  const historyIds=[...historyPage.items,...historyTail.items].map(item=>item.revision);assert.equal(new Set(historyIds).size,historyIds.length);assert.ok(!historyIds.includes(1));






 }finally{await db?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(root,{recursive:true,force:true});}
});
