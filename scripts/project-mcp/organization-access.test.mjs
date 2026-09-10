import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile,copyFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
await mkdir('.test-build',{recursive:true});
await copyFile('.project-runtime/export-build.json','.test-build/export-build.json');
await build({stdin:{contents:`export {ChatDatabase} from './lib/adapters/postgres/chat-database';
 export {PostgresBrowserIdentityStore} from './lib/adapters/postgres/browser-identity';
 export {PostgresOrganizationAccess,provisionOrganization} from './lib/adapters/postgres/organization-access';
 export {organizationApi} from './lib/server/organization-api';
 export {OrganizationWorkspace} from './lib/adapters/postgres/organization-workspace';
 export {usingTransactionDatabase} from './lib/adapters/postgres/transaction-database';
 export {humanCommand} from './scripts/project-mcp/human';
 export {uploadImage} from './scripts/project-mcp/image-upload';
 export {renderProjectExport} from './scripts/project-mcp/export';
 export {fromMarkdown} from './lib/domain/intake';`,resolveDir:process.cwd()},outfile:'.test-build/organization-access.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {ChatDatabase,PostgresBrowserIdentityStore,PostgresOrganizationAccess,provisionOrganization,organizationApi,fromMarkdown,OrganizationWorkspace,usingTransactionDatabase,humanCommand,uploadImage,renderProjectExport}=await import('../../.test-build/organization-access.mjs');
const base=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
const denied=fn=>assert.rejects(fn,e=>[401,403,404,409].includes(e.status));
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'lanka-org-')),app='lanka-org-test-'+randomUUID(),issuer='https://org-idp.test/'+randomUUID();
 const db=new ChatDatabase({...base,connection:{...base.connection,application_name:app},runtimeRoot:root,tenantId:randomUUID(),ownerId:randomUUID()});
 const tenants=[],clients=[];
 t.after(async()=>{
  for(const tenant of tenants) {
   for(const table of ['organization_receipts','organization_audit','organization_memberships','principals','export_artifacts','command_receipts','blobs','material_revisions','materials','catalog_receipts','catalog_folders','workspace_catalogs','agent_connections'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[tenant]);
   await db.pool.query('DELETE FROM lanka.tenants WHERE id=$1',[tenant]);
  }
  await db.pool.query('DELETE FROM lanka.auth_identities WHERE issuer=$1',[issuer]);
  await db.pool.query('DELETE FROM lanka.agent_connections WHERE tenant_id=$1',[db.tenant]);
  await Promise.all(clients.map(c=>c.close()));await db.close();await rm(root,{recursive:true,force:true});
 });
 await db.init();const store=new PostgresBrowserIdentityStore(db.pool),access=new PostgresOrganizationAccess(db.pool);
 const users={};
 for(const subject of ['alice','bob','carol']) {
  const token=randomBytes(32).toString('base64url');await store.establish(app,{issuer,subject,name:subject,email:'same@example.test'},token,null,new Date(Date.now()+3600000));
  users[subject]=await store.authenticate(app,token);
 }
 const provision=async(owner,name)=>{
  const input={requestId:randomUUID(),slug:'org-'+randomUUID(),name,ownerUserId:owner.userId};
  tenants.push(input.requestId);await provisionOrganization(db.pool,input);return input;
 };
 const a=await provision(users.alice,'Alpha'),b=await provision(users.bob,'Beta');
 const membership=(actor,tenant,user,role='member',status='active',requestId=randomUUID())=>access.setMembership(actor,tenant,{requestId,userId:user.userId,role,status});
 const project=async(user,tenant,title)=>{
  const ctx=await access.withTenant(user,tenant,async(c,ctx)=>ctx);
  const writer=new ChatDatabase({...base,tenantId:tenant,ownerId:ctx.principalId,runtimeRoot:root});clients.push(writer);
  const doc=fromMarkdown('# '+title+'\n\n## Главная мысль\nУчебная презентация.');doc.id=randomUUID();await writer.create(doc.id,doc,null,[],[],{fixture:true});
  return {doc,writer};
 };
 return {db,store,access,users,a:a.requestId,b:b.requestId,app,provisionA:a,provision,project,membership,root,tenants};
}

test('operator provision is explicit and idempotent; discovery checks current membership and identity',async t=>{
 const f=await fixture(t),{alice,bob,carol}=f.users;
 assert.deepEqual(await provisionOrganization(f.db.pool,f.provisionA),{tenantId:f.a});
 await denied(()=>provisionOrganization(f.db.pool,{...f.provisionA,name:'Changed'}));
 assert.deepEqual((await f.access.list(alice)).map(x=>x.id),[f.a]);assert.deepEqual((await f.access.list(bob)).map(x=>x.id),[f.b]);assert.deepEqual(await f.access.list(carol),[]);
 await denied(()=>f.access.personalLibrary(bob,f.a));
 await denied(()=>f.access.list({...alice,userId:bob.userId}));
 await denied(()=>f.access.list({...alice,subject:'bob'}));
 await f.membership(alice,f.a,bob);
 assert.equal((await f.access.list(bob)).length,2);
 await f.membership(alice,f.a,bob,'member','suspended');
 assert.deepEqual((await f.access.list(bob)).map(x=>x.id),[f.b]);
});

test('admin and member privileges, last-owner protection, audit and receipts are enforced',async t=>{
 const f=await fixture(t),{alice,bob,carol}=f.users;
 await f.membership(alice,f.a,bob,'admin');
 await denied(()=>f.membership(bob,f.a,carol,'owner'));
 await denied(()=>f.membership(bob,f.a,alice,'member'));
 const id=randomUUID(),added=await f.membership(bob,f.a,carol,'member','active',id);
 assert.deepEqual(await f.membership(bob,f.a,carol,'member','active',id),added);
 await denied(()=>f.membership(bob,f.a,carol,'member','suspended',id));
 await denied(()=>f.access.members(carol,f.a));await denied(()=>f.membership(carol,f.a,carol,'owner'));
 await denied(()=>f.membership(alice,f.a,alice,'member'));
 await f.membership(alice,f.a,bob,'owner');await f.membership(bob,f.a,alice,'admin');
 // Replay of an owner-only grant is denied after the actor loses that authority.
 const old=await f.db.pool.query("SELECT request_id FROM lanka.organization_receipts WHERE tenant_id=$1 AND result->>'principalId'=$2 ORDER BY request_id",[f.a,added.principalId]);
 assert.equal(old.rowCount,1);
 const audit=await f.db.pool.query('SELECT sequence,action,metadata FROM lanka.organization_audit WHERE tenant_id=$1 ORDER BY sequence',[f.a]);
 assert.deepEqual(audit.rows.map(x=>Number(x.sequence)),[1,2,3,4,5]);
 assert.equal(audit.rows[2].metadata.after.role,'member');assert.equal(audit.rows[0].action,'organization.provisioned');
});

test('receipt replay rechecks current role and membership',async t=>{
 const f=await fixture(t),{alice,bob,carol}=f.users;
 await f.membership(alice,f.a,bob,'owner');const requestId=randomUUID();
 await f.membership(alice,f.a,carol,'admin','active',requestId);
 await f.membership(bob,f.a,alice,'admin');
 await denied(()=>f.membership(alice,f.a,carol,'admin','active',requestId));
 await f.membership(bob,f.a,alice,'member','suspended');
 await denied(()=>f.membership(alice,f.a,carol,'admin','active',requestId));
});

test('concurrent owner demotions leave one active owner',async t=>{
 const f=await fixture(t),{alice,bob}=f.users;await f.membership(alice,f.a,bob,'owner');
 const results=await Promise.allSettled([f.membership(alice,f.a,alice,'member'),f.membership(bob,f.a,bob,'member')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const r=await f.db.pool.query("SELECT count(*) FROM lanka.organization_memberships WHERE tenant_id=$1 AND role='owner' AND status='active'",[f.a]);assert.equal(r.rows[0].count,'1');
});

test('personal library and direct reads deny another author even to organization owner',async t=>{
 const f=await fixture(t),{alice,bob}=f.users;await f.membership(alice,f.a,bob);
 const own=await f.project(alice,f.a,'Alice private'),other=await f.project(bob,f.a,'Bob private'),foreign=await f.project(bob,f.b,'Other tenant');
 assert.deepEqual((await f.access.personalLibrary(alice,f.a)).documents.map(x=>x.id),[own.doc.id]);
 assert.equal((await f.access.personalProject(bob,f.a,other.doc.id)).state.doc.title,'Bob private');
 await denied(()=>f.access.personalProject(alice,f.a,other.doc.id));
 await denied(()=>f.access.personalProject(bob,f.a,foreign.doc.id));
 await denied(()=>f.access.personalProject(alice,f.b,foreign.doc.id));
 await f.db.pool.query('UPDATE lanka.materials SET trashed=true WHERE tenant_id=$1 AND id=$2',[f.a,own.doc.id]);
 assert.equal((await f.access.personalLibrary(alice,f.a)).documents.length,0);await denied(()=>f.access.personalProject(alice,f.a,own.doc.id));
});

test('library pagination stays within owner and tenant, including a forged cursor',async t=>{
 const f=await fixture(t),{alice,bob}=f.users,first=await f.project(alice,f.a,'Page item'),foreign=await f.project(bob,f.b,'Private cursor');
 await f.db.pool.query(`WITH copies AS (SELECT tenant_id,gen_random_uuid() AS id,owner_id,project FROM lanka.materials CROSS JOIN generate_series(1,52) WHERE tenant_id=$1 AND id=$2)
  INSERT INTO lanka.materials(tenant_id,id,owner_id,project) SELECT tenant_id,id,owner_id,jsonb_set(project,'{state,doc,id}',to_jsonb(id::text)) FROM copies`,[f.a,first.doc.id]);
 const page=await f.access.personalLibrary(alice,f.a);assert.equal(page.documents.length,50);assert.ok(page.nextCursor);
 const next=await f.access.personalLibrary(alice,f.a,page.nextCursor);assert.equal(next.documents.length,3);assert.equal(next.nextCursor,null);
 assert.equal(new Set([...page.documents,...next.documents].map(x=>x.id)).size,53);
 assert.equal((await f.access.personalLibrary(alice,f.a,foreign.doc.id)).documents.length,0);
 // Pending selection happens before LIMIT, so an old unresolved proposal is still found.
 await f.db.pool.query(`UPDATE lanka.materials SET updated_at='2020-01-01',project=jsonb_set(project,'{state,proposals}','[{"status":"pending"}]'::jsonb) WHERE (tenant_id=$1 AND id=$2) OR (tenant_id=$3 AND id=$4)`,[f.a,first.doc.id,f.b,foreign.doc.id]);
 assert.ok(!(await f.access.personalLibrary(alice,f.a)).documents.some(d=>d.id===first.doc.id));
 const pending=await f.access.personalLibrary(alice,f.a,undefined,{pendingOnly:true});
 assert.deepEqual(pending.documents.map(d=>d.id),[first.doc.id]);assert.equal(pending.documents[0].pending,1);
 assert.equal((await f.access.personalLibrary(alice,f.a,foreign.doc.id,{pendingOnly:true})).documents.length,0);
 await f.db.pool.query(`UPDATE lanka.materials SET project=jsonb_set(project,'{state,proposals}','[{"status":"pending"}]'::jsonb) WHERE tenant_id=$1`,[f.a]);
 const pendingPage=await f.access.personalLibrary(alice,f.a,undefined,{pendingOnly:true});
 assert.equal(pendingPage.documents.length,50);
 assert.equal((await f.access.personalLibrary(alice,f.a,pendingPage.nextCursor,{pendingOnly:true})).documents.length,3);
 await f.db.pool.query(`UPDATE lanka.materials SET project=jsonb_set(project,'{state,proposals}','[{"status":"closed"}]'::jsonb) WHERE tenant_id=$1 AND id=$2`,[f.a,first.doc.id]);
 const closed=await f.access.personalLibrary(alice,f.a,undefined,{pendingOnly:true});
 const closedNext=await f.access.personalLibrary(alice,f.a,closed.nextCursor,{pendingOnly:true});
 assert.equal(closed.documents.length+closedNext.documents.length,52);

});

test('revoke waits for an authorized transaction, then prevents another write',async t=>{
 const f=await fixture(t),{alice,bob}=f.users;await f.membership(alice,f.a,bob);const project=await f.project(bob,f.a,'Before');
 let release,entered;const held=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
 const write=f.access.withTenant(bob,f.a,async(c,ctx)=>{await c.query("UPDATE lanka.materials SET project=jsonb_set(project,'{title}','\"Committed before revoke\"') WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[f.a,ctx.principalId,project.doc.id]);entered();await held;});
 await ready;const revoke=f.membership(alice,f.a,bob,'member','suspended');
 try {
  const deadline=Date.now()+5000;let waiting=false;
  while(Date.now()<deadline){const r=await f.db.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[f.app]);if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.ok(waiting,'the actual revoke transaction must be waiting on the lock');
 }finally{release();}
 await write;await revoke;
 await denied(()=>f.access.withTenant(bob,f.a,async c=>{await c.query("UPDATE lanka.materials SET project='{}' WHERE tenant_id=$1",[f.a]);}));
 const saved=await f.db.pool.query("SELECT project->>'title' AS title FROM lanka.materials WHERE tenant_id=$1 AND id=$2",[f.a,project.doc.id]);assert.equal(saved.rows[0].title,'Committed before revoke');
});

test('rollback resets pooled scope; suspension, expired session and foreign membership FK fail closed',async t=>{
 const f=await fixture(t),{alice}=f.users;
 await assert.rejects(f.access.withTenant(alice,f.a,async(c,ctx)=>{assert.equal((await c.query("SELECT current_setting('app.tenant_id') AS tenant")).rows[0].tenant,f.a);throw Error('rollback');}),/rollback/);
 const c=await f.db.pool.connect();try{assert.ok(!(await c.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant);}finally{c.release();}
 const member=(await f.access.members(alice,f.a))[0];
 await assert.rejects(f.db.pool.query("INSERT INTO lanka.organization_memberships(tenant_id,principal_id,role,status) VALUES($1,$2,'member','active')",[f.b,member.id]),e=>e.code==='23503');
 await f.db.pool.query("UPDATE lanka.tenants SET status='suspended' WHERE id=$1",[f.a]);await denied(()=>f.access.personalLibrary(alice,f.a));
 await f.db.pool.query("UPDATE lanka.browser_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[alice.sessionId]);await denied(()=>f.access.list(alice));
});

test('organization HTTP controller bounds input and rejects unknown or foreign scopes',async t=>{
 const f=await fixture(t),{alice,bob}=f.users,api=organizationApi(f.access);
 const req=(path,body)=>new Request('https://lanka.test'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body});
 assert.equal((await api(req('/api/organizations'),alice)).status,200);
 assert.equal((await api(req(`/api/organizations/${f.a}/library`),bob)).status,404);
 assert.equal((await api(req(`/api/organizations/${f.a}/members`,JSON.stringify({requestId:randomUUID(),userId:bob.userId,role:'member',status:'active',tenantId:f.b})),alice)).status,400);
 assert.equal((await api(req(`/api/organizations/${f.a}/members`,'x'.repeat(5000)),alice)).status,413);
 assert.equal((await api(req('/api/organizations/create','{}'),alice)).status,404);
});

test('operator CLI provisions and replays a tenant without creating a local agent identity or leaking config errors',async t=>{
 const f=await fixture(t),id=randomUUID();f.tenants.push(id);
 const configPath=join(f.root,'database.json'),requestPath=join(f.root,'organization.json');
 await writeFile(configPath,JSON.stringify({connection:base.connection}),{mode:0o600});
 await writeFile(requestPath,JSON.stringify({requestId:id,slug:'cli-'+id,name:'Operator organization',ownerUserId:f.users.alice.userId}),{mode:0o600});
 const args=['.project-runtime/provision-organization.mjs','--config',configPath,'--request',requestPath];
 for(let i=0;i<2;i++){const r=await promisify(execFile)(process.execPath,args,{cwd:process.cwd(),timeout:15000});assert.deepEqual(JSON.parse(r.stdout),{tenantId:id});assert.equal(r.stderr,'');}
 assert.ok((await f.access.list(f.users.alice)).some(t=>t.id===id));
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.agent_connections WHERE tenant_id=$1',[id])).rowCount,0);
 await writeFile(configPath,'{"connection":{"password":"PRIVATE_TEST_SECRET');
 await assert.rejects(promisify(execFile)(process.execPath,args,{cwd:process.cwd(),timeout:15000}),e=>e.code===1&&!e.stderr.includes('PRIVATE_TEST_SECRET'));
});

async function nativeProject(f,user=f.users.bob){
 if(user!==f.users.alice)await f.membership(f.users.alice,f.a,user);
 const workspace=new OrganizationWorkspace(f.access,user,f.a,f.root),id=randomUUID();
 const create={requestId:id,command:{action:'create_document',title:'Команда',folderId:null,markdown:'# Команда\n\n## Вместе\nОбсудим план.',profile:'focus-v3'}};
 await workspace.mutate(create);return {workspace,repo:workspace.repository(id),id,create};
}
const imageInput=async(p)=>({requestId:randomUUID(),deckId:p.state.doc.id,expectedRevision:p.state.revision,slideId:p.state.doc.slides[0].id,name:'Example.png',contentType:'image/png',base64:(await sharp({create:{width:40,height:30,channels:3,background:'#80aacc'}}).png().toBuffer()).toString('base64')});

test('native workspace creates folders and documents, preserves profile, CAS and nested history restore',async t=>{
 const f=await fixture(t),{workspace,repo,id,create}=await nativeProject(f),p=await repo.read();
 assert.equal(p.state.doc.design,'focus-v3');assert.deepEqual(await workspace.mutate(create),{id,revision:1});
 const folderId=randomUUID();await workspace.mutate({requestId:folderId,command:{action:'create_folder',name:'Планы'}});
 await workspace.mutate({requestId:randomUUID(),command:{action:'move_document',id,folderId}});
 assert.equal((await workspace.listing()).documents[0].folderId,folderId);
 const save=title=>humanCommand(repo,{requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'save',doc:{...p.state.doc,title}}});
 const edits=await Promise.allSettled([save('Первый'),save('Второй')]);assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.equal(edits.filter(r=>r.status==='rejected').length,1);
 const current=await repo.read();assert.equal(current.state.revision,2);
 await humanCommand(repo,{requestId:randomUUID(),deckId:id,expectedRevision:2,command:{action:'restore',revision:1}});
 const restored=await repo.read();assert.equal(restored.state.doc.title,'Команда');assert.equal(restored.state.revision,3);
 const catalogue=await f.db.pool.query('SELECT origin,source_root,migration_id FROM lanka.workspace_catalogs WHERE tenant_id=$1',[f.a]);assert.equal(catalogue.rows[0].origin,'native');assert.equal(catalogue.rows[0].source_root,null);assert.equal(catalogue.rows[0].migration_id,null);
 await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id,trashed:true}});await assert.rejects(repo.read());
 await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id,trashed:false}});assert.equal((await repo.read()).state.revision,3);
});

test('image bytes and references commit atomically; failed mutation and a foreign author cannot access them',async t=>{
 const f=await fixture(t),{repo,id}=await nativeProject(f),p=await repo.read(),input=await imageInput(p);
 const uploaded=await uploadImage(repo,input);assert.deepEqual(await uploadImage(repo,input),uploaded);
 const saved=await repo.read(),source=saved.state.sources.find(s=>s.id===uploaded.sourceId),path=`materials/${source.sha256}.bin`;
 assert.deepEqual(await repo.readFile(path),Buffer.from(input.base64,'base64'));
 await assert.rejects(repo.writeMaterial(Buffer.from('outside')));
 const count=await f.db.pool.query('SELECT count(*) FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.a,id]);
 await assert.rejects(repo.mutate(randomUUID(),{test:'rollback'},async()=>{await repo.writeMaterial(Buffer.from('must roll back'));throw Error('injected failure');}),/injected/);
 assert.equal((await f.db.pool.query('SELECT count(*) FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.a,id])).rows[0].count,count.rows[0].count);
 const replacement=await uploadImage(repo,{...input,requestId:randomUUID(),expectedRevision:saved.state.revision,elementId:uploaded.elementId});
 const replaced=await repo.read();const originalImage=saved.state.doc.slides[0].canvas.find(e=>e.id===uploaded.elementId),newImage=replaced.state.doc.slides[0].canvas.find(e=>e.id===replacement.elementId);
 assert.deepEqual({x:newImage.x,y:newImage.y,w:newImage.w,h:newImage.h},{x:originalImage.x,y:originalImage.y,w:originalImage.w,h:originalImage.h});
 const full=structuredClone(replaced.state.doc);full.slides[0].canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#ffffff'},{id:'occupied',kind:'rect',x:0,y:0,w:1600,h:900,color:'#123456'}];
 await humanCommand(repo,{requestId:randomUUID(),deckId:id,expectedRevision:replaced.state.revision,command:{action:'save',doc:full}});
 const filled=await repo.read();
 await assert.rejects(uploadImage(repo,{...input,requestId:randomUUID(),expectedRevision:filled.state.revision}),/нет свободного места/);
 assert.deepEqual(await repo.read(),filled);
 assert.equal((await f.db.pool.query('SELECT count(*) FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.a,id])).rows[0].count,count.rows[0].count);
 const stranger=new OrganizationWorkspace(f.access,f.users.alice,f.a,f.root).repository(id);
 await assert.rejects(stranger.readFile(path));await assert.rejects(uploadImage(stranger,{...input,requestId:randomUUID(),expectedRevision:saved.state.revision}));
});

test('PDF/PPTX artifacts and all repository surfaces recheck membership after revoke',async t=>{
 const f=await fixture(t),{repo,id}=await nativeProject(f),p=await repo.read();
 const files=[];for(const format of ['pdf','pptx']){const output=await renderProjectExport(repo,p,format);files.push(output);assert.deepEqual(await repo.readExportArtifact(output.artifactId),Buffer.from(output.bytes));}
 assert.equal((await repo.listExportArtifacts()).items.length,2);
 const input={requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'comment',slideId:p.state.doc.slides[0].id,text:'Проверить'}};await humanCommand(repo,input);
 await f.membership(f.users.alice,f.a,f.users.bob,'member','suspended');
 for(const operation of [()=>repo.read(),()=>repo.readSnapshot(p.history[0].hash),()=>repo.readFile('materials/'+'a'.repeat(64)+'.bin'),()=>repo.listExportArtifacts(),()=>repo.readExportManifest(files[0].artifactId),()=>repo.readExportArtifact(files[0].artifactId),()=>repo.writeExport('presentation.pdf',files[0].bytes),()=>repo.saveExportArtifact(files[0].manifest,files[0].bytes),()=>humanCommand(repo,input)])await denied(operation);
});

test('revocation during export blocks final artifact persistence and result delivery',async t=>{
 const f=await fixture(t),{repo,id}=await nativeProject(f),p=await repo.read();
 const save=repo.saveExportArtifact.bind(repo);
 repo.saveExportArtifact=async(...args)=>{await f.membership(f.users.alice,f.a,f.users.bob,'member','suspended');return save(...args);};
 await denied(()=>renderProjectExport(repo,p,'pdf'));
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2',[f.a,id])).rowCount,0);
});

test('transaction database cannot be reused after scope ends or open a second connection',async t=>{
 const f=await fixture(t);
 const db=await f.access.withTenant(f.users.alice,f.a,(c,ctx)=>usingTransactionDatabase(c,ctx,f.root,async db=>{
  assert.throws(()=>db.pool.connect(),/borrow/);await assert.rejects(db.init(),/initialize/);return db;
 }));
 assert.throws(()=>db.pool.query('SELECT 1'),/ended/);await assert.rejects(db.tx(async()=>1),/ended/);
 assert.equal((await f.db.pool.query('SELECT 1 AS alive')).rows[0].alive,1);
});

test('document HTTP endpoints create, save, upload, read history, export and deny another owner',async t=>{
 const f=await fixture(t),api=organizationApi(f.access,f.root),actor=f.users.alice,tenant=f.a;
 const call=(path,payload,user=actor)=>api(new Request('https://lanka.test'+path,{method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json'}:{},body:payload?JSON.stringify(payload):undefined}),user);
 const base=`/api/organizations/${tenant}`,id=randomUUID(),path=base+'/documents/'+id;
 const create=await call(base+'/library',{requestId:id,command:{action:'create_document',title:'Планы',markdown:'# Планы\n\n## Команда\nПростой пример.',folderId:null,profile:'focus-v2'}});assert.equal(create.status,200);
 const p=await (await call(path)).json();
 const crowdedUpload=await call(path+'/images',await imageInput(p));assert.equal(crowdedUpload.status,400);assert.match((await crowdedUpload.json()).error,/нет свободного места/);assert.deepEqual((await (await call(path)).json()).state,p.state);
 const save={requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:{...p.state.doc,title:'Новый план',slides:p.state.doc.slides.map((s,i)=>i===0?{...s,canvas:[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#ffffff',locked:true}]}:s)}}};
 assert.equal((await call(path,save)).status,200);assert.equal((await call(path,{...save,requestId:randomUUID()})).status,409);
 const image=await imageInput(await (await call(path)).json()),uploaded=await call(path+'/images',image);assert.equal(uploaded.status,200);const source=await uploaded.json();
 const bytes=await call(path+'/assets?id='+source.sourceId);assert.equal(bytes.status,200);assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),Buffer.from(image.base64,'base64'));
 const original=await call(path+'/sources?id='+source.sourceId);assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from(image.base64,'base64'));assert.match(original.headers.get('content-disposition'),/^attachment;/);assert.equal(original.headers.get('content-type'),'application/octet-stream');assert.equal(original.headers.get('cache-control'),'no-store');
 assert.equal((await call(path+'/sources?id=unknown')).status,404);
 const copyId=randomUUID(),copyCommand={requestId:copyId,command:{action:'duplicate_document',id,expectedRevision:3,title:'Копия',folderId:null}};
 const copied=await call(base+'/library',copyCommand);assert.equal(copied.status,200);assert.equal((await copied.json()).id,copyId);assert.equal((await call(base+'/library',copyCommand)).status,200);
 const copiedDoc=await (await call(base+'/documents/'+copyId)).json();assert.equal(copiedDoc.state.revision,1);assert.equal(copiedDoc.state.doc.title,'Копия');assert.deepEqual(copiedDoc.state.sources,(await (await call(path)).json()).state.sources);
 const copiedSource=await call(base+'/documents/'+copyId+'/sources?id='+source.sourceId);assert.deepEqual(Buffer.from(await copiedSource.arrayBuffer()),Buffer.from(image.base64,'base64'));
 assert.equal((await call(base+'/library',{...copyCommand,requestId:randomUUID(),command:{...copyCommand.command,expectedRevision:999}})).status,409);
 assert.equal((await (await call(path+'/history')).json()).length,3);assert.equal((await call(path+'/history?revision=1')).status,200);
 const out=await call(path+'/export',{deckId:id,expectedRevision:3,format:'pdf'});assert.equal(out.status,200);const artifact=out.headers.get('x-lanka-artifact');
 assert.equal((await call(path+'/exports?artifactId='+artifact)).status,200);assert.equal((await call(path+'/exports?artifactId='+artifact+'&part=file')).status,200);
 await f.membership(actor,tenant,f.users.bob);
 assert.equal((await call(base+'/library',{...copyCommand,requestId:randomUUID()},f.users.bob)).status,404);
 for(const tail of ['', '/history','/assets?id='+source.sourceId,'/sources?id='+source.sourceId,'/exports?artifactId='+artifact])assert.equal((await call(path+tail,undefined,f.users.bob)).status,404);
 assert.equal((await call(path,save,f.users.bob)).status,404);
});

test('corporate library paginates personal cards, searches literal titles and isolates folder/trash filters',async t=>{
 const f=await fixture(t),{workspace}=await nativeProject(f,f.users.alice),folder=randomUUID(),ids=[];
 await workspace.mutate({requestId:folder,command:{action:'create_folder',name:'Планы'}});
 for(let i=0;i<52;i++){const id=randomUUID();ids.push(id);await workspace.mutate({requestId:id,command:{action:'create_document',title:`План ${i}%`,folderId:folder}});}
 // Equal timestamps exercise the UUID tiebreaker instead of timing-dependent ordering.
 await f.db.pool.query("UPDATE lanka.materials SET updated_at='2026-01-01T00:00:00Z' WHERE tenant_id=$1",[f.a]);
 const get=(cursor,options)=>f.access.personalLibrary(f.users.alice,f.a,cursor,options);
 const first=await get(undefined,{folderId:folder}),second=await get(first.nextCursor,{folderId:folder});
 assert.equal(first.documents.length,50);assert.equal(second.documents.length,2);assert.equal(second.nextCursor,null);
 assert.deepEqual([...first.documents,...second.documents].map(x=>x.id).sort(),ids.sort());
 assert.ok(first.documents.every(d=>d.preview.slide&&d.design==='focus-v2'&&d.updatedAt.endsWith('Z')&&d.pending===0));
 assert.equal((await get(undefined,{search:'ПЛАН 51%'})).documents.length,1);assert.equal((await get(undefined,{search:'%'})).documents.length,50);assert.equal((await get(undefined,{search:'_'})).documents.length,0);
 await denied(()=>get(undefined,{folderId:randomUUID()}));
 const foreign=await f.project(f.users.bob,f.b,'План 51%');assert.equal((await get(foreign.doc.id,{folderId:folder})).documents.length,0);
 const id=first.documents[0].id;await workspace.mutate({requestId:randomUUID(),command:{action:'trash_document',id,trashed:true}});
 assert.deepEqual((await get(undefined,{trashed:true,folderId:folder})).documents.map(x=>x.id),[id]);
 assert.ok(!(await get(undefined,{folderId:folder})).documents.some(x=>x.id===id));
});

test('schema bootstrap CLI runs independently of local owner and verified browser identity',async t=>{
 const f=await fixture(t),path=join(f.root,'database.json');await writeFile(path,JSON.stringify({connection:base.connection}),{mode:0o600});
 const args=['.project-runtime/migrate-self-hosted.mjs','--config',path];
 const before=await f.db.pool.query('SELECT count(*)::int AS count FROM lanka.principals WHERE tenant_id=$1',[f.a]);
 const result=await promisify(execFile)(process.execPath,args,{cwd:process.cwd(),timeout:15000});assert.match(result.stdout,/No identity, organization or document was created/);
 assert.deepEqual((await f.db.pool.query('SELECT count(*)::int AS count FROM lanka.principals WHERE tenant_id=$1',[f.a])).rows,before.rows);
 await writeFile(path,'{"connection":{"password":"PRIVATE_CONFIG_FRAGMENT');
 await assert.rejects(promisify(execFile)(process.execPath,args,{cwd:process.cwd(),timeout:15000}),e=>e.code===1&&!e.stderr.includes('PRIVATE_CONFIG_FRAGMENT'));
});

test('membership UI snapshot rejects stale edits, preserves exact retry and denies former admins',async t=>{
 const f=await fixture(t),{alice,bob,carol}=f.users;await f.membership(alice,f.a,bob,'admin');await f.membership(alice,f.a,carol);
 await f.db.pool.query('UPDATE lanka.auth_identities SET display_name=NULL WHERE id=$1',[carol.userId]);
 const api=organizationApi(f.access,f.root),url='http://local/api/organizations/'+f.a+'/members';
 const response=await api(new Request(url),alice),snapshot=await response.json();assert.equal(response.status,200);assert.equal(snapshot.role,'owner');assert.equal(snapshot.userId,alice.userId);assert.equal(snapshot.members.length,3);assert.match(snapshot.authzEpoch,/^\d+$/);
 assert.match(snapshot.members.find(m=>m.userId===carol.userId).name,/^Участник /);
 assert.equal((await api(new Request(url),carol)).status,403);
 const command={requestId:randomUUID(),expectedEpoch:snapshot.authzEpoch,userId:carol.userId,role:'member',status:'suspended'};
 await f.membership(alice,f.a,bob,'member');
 const post=(p,cmd)=>api(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cmd)}),p);
 assert.equal((await post(alice,command)).status,409);assert.ok((await f.access.list(carol)).some(v=>v.id===f.a));
 const current=await f.access.membershipView(alice,f.a);command.expectedEpoch=current.authzEpoch;
 const saved=await post(alice,command);assert.equal(saved.status,200);const receipt=await saved.json();assert.equal((await f.access.list(carol)).some(v=>v.id===f.a),false);
 assert.deepEqual(await (await post(alice,command)).json(),receipt);
 await f.membership(alice,f.a,carol);assert.equal((await post(alice,command)).status,200);assert.ok((await f.access.list(carol)).some(v=>v.id===f.a),'exact replay must not reapply a suspension after restore');
 assert.equal((await post(bob,{...command,requestId:randomUUID(),expectedEpoch:undefined})).status,403);
 const self={requestId:randomUUID(),expectedEpoch:(await f.access.membershipView(alice,f.a)).authzEpoch,userId:alice.userId,role:'member',status:'active'};assert.equal((await post(alice,self)).status,409);
});

test('member directory is bounded, searches beyond the first page and rejects stale continuation',async t=>{
 const f=await fixture(t),{alice,bob}=f.users;await f.membership(alice,f.a,bob,'admin');
 for(let n=0;n<103;n++){
  const user=randomUUID(),principal=randomUUID();
  await f.db.pool.query('INSERT INTO lanka.auth_identities(id,issuer,subject,display_name) VALUES($1,$2,$3,$4)',[user,alice.issuer,'directory-'+n,n===102?'Особая команда 100%_':'Сотрудник '+n]);
  await f.db.pool.query("INSERT INTO lanka.principals(tenant_id,id,kind,user_id) VALUES($1,$2,'human',$3)",[f.a,principal,user]);
  await f.db.pool.query("INSERT INTO lanka.organization_memberships(tenant_id,principal_id,role,status) VALUES($1,$2,'member','active')",[f.a,principal]);
 }
 const first=await f.access.membershipView(alice,f.a);assert.equal(first.members.length,50);assert.ok(first.nextCursor);assert.deepEqual(first.members.slice(0,2).map(m=>m.name),['alice','bob']);
 const second=await f.access.membershipView(alice,f.a,{cursor:first.nextCursor,expectedEpoch:first.authzEpoch});assert.equal(second.members.length,50);
 const third=await f.access.membershipView(alice,f.a,{cursor:second.nextCursor,expectedEpoch:first.authzEpoch});assert.equal(third.members.length,5);assert.equal(third.nextCursor,null);
 assert.equal(new Set([...first.members,...second.members,...third.members].map(m=>m.id)).size,105);
 const found=await f.access.membershipView(alice,f.a,{search:'ОСОБАЯ КОМАНДА 100%_'});assert.equal(found.members.length,1);assert.equal(found.members[0].name,'Особая команда 100%_');
 assert.equal((await f.access.membershipView(alice,f.a,{search:'100%_'})).members.length,1);assert.equal((await f.access.membershipView(alice,f.b,{search:'100%_'}).catch(e=>({status:e.status}))).status,404);
 assert.equal((await f.access.membershipView(alice,f.a,{search:'несуществующая команда'})).members.length,0);
 await f.membership(alice,f.a,bob,'member');await denied(()=>f.access.membershipView(alice,f.a,{cursor:first.nextCursor,expectedEpoch:first.authzEpoch}));await denied(()=>f.access.membershipView(bob,f.a,{cursor:first.nextCursor}));
 const api=organizationApi(f.access,f.root),url='http://local/api/organizations/'+f.a+'/members?search='+encodeURIComponent('100%_');const result=await api(new Request(url),alice);assert.equal(result.status,200);assert.equal((await result.json()).members.length,1);
 assert.equal((await api(new Request(url+'&cursor=bad'),alice)).status,400);
});
