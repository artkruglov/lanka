import {createServer} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
await mkdir('.test-build',{recursive:true});
await build({stdin:{contents:`export {proposeBrief} from './lib/domain/model';export {DocumentAgentSources} from './lib/adapters/postgres/document-agent-sources';export {agentUsage} from './lib/adapters/postgres/agent-usage';export {AgentBridge} from './lib/adapters/postgres/agent-bridge';export {WorkspaceSessions} from './lib/adapters/postgres/workspace-sessions';export {OrganizationDocumentCopy} from './lib/adapters/postgres/document-copy';export {AgentLibrary} from './lib/adapters/postgres/agent-library';export {AgentSourceIntakes} from './lib/adapters/postgres/agent-source-intakes';export {AgentWorkspace} from './lib/adapters/postgres/agent-workspace';export {OrganizationDocumentProposals} from './lib/adapters/postgres/document-proposals';export {createCorporateApplication,corporateNodeHandler} from './lib/server/corporate-http';export {AgentDelegations} from './lib/adapters/postgres/agent-delegations';export {delegatedPrincipal} from './lib/server/agent-delegation';export {OrganizationDocumentComments} from './lib/adapters/postgres/document-comments';export {ChatDatabase} from './lib/adapters/postgres/chat-database';export {PostgresBrowserIdentityStore} from './lib/adapters/postgres/browser-identity';export {PostgresOrganizationAccess,provisionOrganization} from './lib/adapters/postgres/organization-access';export {OrganizationWorkspace} from './lib/adapters/postgres/organization-workspace';export {PostgresResourceAccess} from './lib/adapters/postgres/resource-access';export {applySelfHostedMigrations,assertSelfHostedSchema} from './lib/adapters/postgres/schema';export {fromMarkdown} from './lib/domain/intake';export {OrganizationDocumentView} from './lib/adapters/postgres/document-view';export {OrganizationDocumentSharing} from './lib/adapters/postgres/document-sharing';export {documentView} from './lib/project/document-view';export {organizationApi} from './lib/server/organization-api';export {scene} from './lib/domain/scene';`,resolveDir:process.cwd()},outfile:'.test-build/resource-access.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {proposeBrief,DocumentAgentSources,agentUsage,AgentBridge,WorkspaceSessions,OrganizationDocumentCopy,AgentLibrary,AgentSourceIntakes,AgentWorkspace,OrganizationDocumentProposals,createCorporateApplication,corporateNodeHandler,AgentDelegations,delegatedPrincipal,OrganizationDocumentComments,ChatDatabase,PostgresBrowserIdentityStore,PostgresOrganizationAccess,provisionOrganization,OrganizationWorkspace,PostgresResourceAccess,applySelfHostedMigrations,assertSelfHostedSchema,fromMarkdown,OrganizationDocumentView,OrganizationDocumentSharing,documentView,organizationApi,scene}=await import('../../.test-build/resource-access.mjs');
const base=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
const denied=fn=>assert.rejects(fn,e=>[401,403,404,409].includes(e.status));
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'lanka-resources-')),issuer='https://resources.test/'+randomUUID(),deployment=randomUUID(),tenants=[];
 const db=new ChatDatabase({...base,tenantId:randomUUID(),ownerId:randomUUID(),runtimeRoot:root});await db.init();
 t.after(async()=>{for(const tenant of tenants){
  for(const table of ['agent_sessions','agent_connections','source_intake_deletions','source_intakes','organization_receipts','organization_audit','organization_memberships','principals','command_receipts','blobs','export_artifacts','material_revisions','materials','catalog_receipts','catalog_folders','workspace_catalogs'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[tenant]);
  await db.pool.query('DELETE FROM lanka.tenants WHERE id=$1',[tenant]);
 }await db.pool.query('DELETE FROM lanka.auth_identities WHERE issuer=$1',[issuer]);await db.pool.query('DELETE FROM lanka.agent_connections WHERE tenant_id=$1',[db.tenant]);await db.close();await rm(root,{recursive:true,force:true});});
 const identities=new PostgresBrowserIdentityStore(db.pool),orgs=new PostgresOrganizationAccess(db.pool),resources=new PostgresResourceAccess(orgs),users={},principals={};
 for(const name of ['alice','bob','carol']) {const token=randomBytes(32).toString('base64url');await identities.establish(deployment,{issuer,subject:name,name},token,null,new Date(Date.now()+3600000));users[name]=await identities.authenticate(deployment,token);}
 const tenant=randomUUID(),other=randomUUID();tenants.push(tenant,other);
 for(const [id,user] of [[tenant,users.alice],[other,users.bob]])await provisionOrganization(db.pool,{requestId:id,slug:'r-'+id,name:'Resources',ownerUserId:user.userId});
 for(const name of ['bob','carol'])await orgs.setMembership(users.alice,tenant,{requestId:randomUUID(),userId:users[name].userId,role:'member',status:'active'});
 for(const name of Object.keys(users))principals[name]=await orgs.withTenant(users[name],tenant,async(c,ctx)=>ctx.principalId);
 const ws=name=>new OrganizationWorkspace(orgs,users[name],tenant,root);
 const node=async(kind,legacyId,owner=principals.alice)=>{const r=await db.pool.query(`SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND ${kind==='folder'?'folder_id':'material_id'}=$2 AND owner_id=$3`,[tenant,legacyId,owner]);return r.rows[0]?.id;};
 const folder=async(name='alice',requestId=randomUUID())=>{await ws(name).mutate({requestId,command:{action:'create_folder',name:'Folder'}});return {legacyId:requestId,id:await node('folder',requestId,principals[name])};};
 const material=async(name='alice',folderId=null)=>{const legacyId=randomUUID();await ws(name).mutate({requestId:legacyId,command:{action:'create_document',title:'Document',folderId}});return {legacyId,id:await node('material',legacyId,principals[name])};};
 const mutate=(command,name='alice',requestId=randomUUID())=>resources.mutate(users[name],tenant,{requestId,command});
 const permission=(resourceId,name='alice',minimum='viewer')=>resources.withResource(users[name],tenant,resourceId,minimum,async(c,ctx,p)=>p);
 const grant=(resourceId,name,role,canCopy=false,actor='alice')=>mutate({action:'grant',resourceId,subject:{kind:'principal',id:principals[name]},role,canCopy},actor);
 return {db,users,principals,orgs,resources,tenant,other,ws,node,folder,material,mutate,permission,grant,root};
}

test('corporate resources are private, preserve legacy IDs, and separate identically named folder IDs by owner',async t=>{
 const f=await fixture(t),id=randomUUID(),a=await f.folder('alice',id),b=await f.folder('bob',id),doc=await f.material('alice',a.legacyId);
 assert.notEqual(a.id,b.id);assert.notEqual(a.id,id);
 const p=await f.permission(doc.id);assert.equal(p.role,'manager');assert.equal(p.canCopy,true);assert.equal(p.inheritance,'restricted');assert.equal(p.parentFolderId,a.id);
 await denied(()=>f.permission(doc.id,'bob'));await denied(()=>f.resources.withResource(f.users.alice,f.other,doc.id,'viewer',async()=>{}));
 // Tenant owner is not a manager of Bob's private node.
 await denied(()=>f.permission(b.id,'alice'));
 assert.equal((await f.db.pool.query('SELECT count(*)::int AS n FROM lanka.resource_nodes WHERE tenant_id=$1',[f.db.tenant])).rows[0].n,0);
});
test('effective roles combine direct and group grants, while copy remains an independent capability',async t=>{
 const f=await fixture(t),doc=await f.material(),groupId=randomUUID();
 await f.grant(doc.id,'bob','viewer');assert.equal((await f.permission(doc.id,'bob')).canCopy,false);await denied(()=>f.permission(doc.id,'bob','commenter'));
 await f.mutate({action:'group_set',id:groupId,name:'Design',status:'active'});
 await f.mutate({action:'group_member',groupId,principalId:f.principals.bob,present:true});
 await f.mutate({action:'grant',resourceId:doc.id,subject:{kind:'group',id:groupId},role:'editor',canCopy:true});
 const p=await f.permission(doc.id,'bob','editor');assert.equal(p.role,'editor');assert.equal(p.canCopy,true);assert.equal(p.sources.length,2);
 assert.equal((await f.resources.inspect(f.users.bob,f.tenant,doc.id)).grants,undefined);
 await f.mutate({action:'group_member',groupId,principalId:f.principals.bob,present:false});assert.equal((await f.permission(doc.id,'bob')).role,'viewer');
 await f.mutate({action:'group_member',groupId,principalId:f.principals.bob,present:true});await f.mutate({action:'group_set',id:groupId,name:'Design',status:'suspended'});
 assert.equal((await f.permission(doc.id,'bob')).role,'viewer');
 await denied(()=>f.mutate({action:'group_set',id:groupId,name:'Hijack',status:'active'},'bob'));
});
test('restricted boundaries stop inheritance; subtree moves rebuild closure and revoke old inherited rights',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder(),child=await f.folder(),doc=await f.material('alice',child.legacyId);
 await f.mutate({action:'move',resourceId:child.id,parentFolderId:a.id});await f.grant(a.id,'bob','editor');await f.grant(b.id,'carol','commenter');
 await denied(()=>f.permission(doc.id,'bob'));await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});await denied(()=>f.permission(doc.id,'bob'));
 await f.mutate({action:'inheritance',resourceId:child.id,inheritance:'inherit'});assert.equal((await f.permission(doc.id,'bob')).role,'editor');
 await f.mutate({action:'move',resourceId:child.id,parentFolderId:b.id});await denied(()=>f.permission(doc.id,'bob'));assert.equal((await f.permission(doc.id,'carol')).role,'commenter');
 const closure=await f.db.pool.query('SELECT ancestor_id,depth FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=$2 ORDER BY depth',[f.tenant,child.id]);assert.deepEqual(closure.rows,[{ancestor_id:child.id,depth:0},{ancestor_id:b.id,depth:1}]);
 await f.mutate({action:'inheritance',resourceId:child.id,inheritance:'restricted'});await denied(()=>f.permission(doc.id,'carol'));
});
test('moves reject cycles, wrong kinds and foreign tenants and require source plus destination management',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder(),doc=await f.material();
 await f.mutate({action:'move',resourceId:b.id,parentFolderId:a.id});await denied(()=>f.mutate({action:'move',resourceId:a.id,parentFolderId:b.id}));
 await denied(()=>f.mutate({action:'move',resourceId:doc.id,parentFolderId:doc.id}));
 await f.grant(doc.id,'bob','manager');await denied(()=>f.mutate({action:'move',resourceId:doc.id,parentFolderId:a.id},'bob'));
 await f.grant(a.id,'bob','manager');await f.mutate({action:'move',resourceId:doc.id,parentFolderId:a.id},'bob');assert.equal((await f.permission(doc.id)).parentFolderId,a.id);
 await f.grant(a.id,'bob',null);await denied(()=>f.mutate({action:'move',resourceId:doc.id,parentFolderId:null},'bob'));
 const remote=new OrganizationWorkspace(f.orgs,f.users.bob,f.other,'/tmp/lanka-resource-unused');const fid=randomUUID();await remote.mutate({requestId:fid,command:{action:'create_folder',name:'Other'}});
 const foreign=(await f.db.pool.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND folder_id=$2',[f.other,fid])).rows[0].id;
 await denied(()=>f.mutate({action:'move',resourceId:doc.id,parentFolderId:foreign}));
});
test('grant receipts are actor-bound, recheck present authority and cannot remove implicit owner access',async t=>{
 const f=await fixture(t),doc=await f.material(),requestId=randomUUID();await f.grant(doc.id,'bob','manager');
 const command={action:'grant',resourceId:doc.id,subject:{kind:'principal',id:f.principals.carol},role:'viewer',canCopy:false};
 const result=await f.mutate(command,'bob',requestId);assert.deepEqual(await f.mutate(command,'bob',requestId),result);
 await denied(()=>f.mutate({...command,role:'editor'},'bob',requestId));
 await denied(()=>f.grant(doc.id,'alice',null,false,'bob'));
 await f.grant(doc.id,'bob',null);await denied(()=>f.mutate(command,'bob',requestId));
 const rows=await f.db.pool.query('SELECT actor_id,action FROM lanka.resource_audit WHERE tenant_id=$1 AND sequence=$2',[f.tenant,result.authzEpoch]);assert.deepEqual(rows.rows,[{actor_id:f.principals.bob,action:'grant'}]);
});
test('revocation serializes after an authorized transaction and blocks the next callback on the same service',async t=>{
 const f=await fixture(t),doc=await f.material();await f.grant(doc.id,'bob','editor');let release,started;
 const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const active=f.resources.withResource(f.users.bob,f.tenant,doc.id,'editor',async(c)=>{started(c.processID);await hold;await c.query('SELECT 1');return 'committed';});const holder=await ready;
 let revoked=false;const revoke=f.grant(doc.id,'bob',null).then(()=>{revoked=true;});
 // Observe the actual PostgreSQL lock wait, not a timer assumption.
 let waiting=false;for(let i=0;i<60;i++){const r=await f.db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%authz_epoch FROM lanka.tenants%' AND pid<>pg_backend_pid() AND $1::int=ANY(pg_blocking_pids(pid))",[holder]);if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
 try{assert.equal(waiting,true);assert.equal(revoked,false);}finally{release();}
 assert.equal(await active,'committed');await revoke;
 await denied(()=>f.resources.withResource(f.users.bob,f.tenant,doc.id,'editor',async()=>assert.fail('Callback must not run')));
});
test('membership suspension and identity disable override cached grants and group membership',async t=>{
 const f=await fixture(t),doc=await f.material();await f.grant(doc.id,'bob','editor');
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'suspended'});await denied(()=>f.permission(doc.id,'bob'));
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'active'});assert.equal((await f.permission(doc.id,'bob')).role,'editor');
 await f.db.pool.query('UPDATE lanka.auth_identities SET disabled=true WHERE id=$1',[f.users.bob.userId]);await denied(()=>f.permission(doc.id,'bob'));
});
test('catalogue changes update resource parent/trash atomically and advance the authorization epoch',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder(),doc=await f.material('alice',a.legacyId);await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});await f.grant(a.id,'bob','viewer');
 const before=(await f.db.pool.query('SELECT authz_epoch FROM lanka.tenants WHERE id=$1',[f.tenant])).rows[0].authz_epoch;
 await f.ws('alice').mutate({requestId:randomUUID(),command:{action:'move_document',id:doc.legacyId,folderId:b.legacyId}});await denied(()=>f.permission(doc.id,'bob'));assert.equal((await f.permission(doc.id)).parentFolderId,b.id);
 const after=(await f.db.pool.query('SELECT authz_epoch FROM lanka.tenants WHERE id=$1',[f.tenant])).rows[0].authz_epoch;assert.ok(BigInt(after)>BigInt(before));
 await f.ws('alice').mutate({requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:true}});await denied(()=>f.permission(doc.id));
 await f.ws('alice').mutate({requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:false}});assert.equal((await f.permission(doc.id)).role,'manager');
});

test('concurrent reciprocal folder moves cannot commit a cycle',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder();
 const result=await Promise.allSettled([f.mutate({action:'move',resourceId:a.id,parentFolderId:b.id}),f.mutate({action:'move',resourceId:b.id,parentFolderId:a.id})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);
 const p=await f.permission(a.id),q=await f.permission(b.id);assert.ok(!(p.parentFolderId===b.id&&q.parentFolderId===a.id));
 assert.equal((await f.db.pool.query('SELECT count(*)::int AS n FROM lanka.folder_closure WHERE tenant_id=$1',[f.tenant])).rows[0].n,3);
});
test('failed ACL transactions do not leak a grant, receipt, audit entry or incremented epoch',async t=>{
 const f=await fixture(t),doc=await f.material(),requestId=randomUUID();
 const before=(await f.db.pool.query('SELECT authz_epoch FROM lanka.tenants WHERE id=$1',[f.tenant])).rows[0].authz_epoch;
 // The receipt write is deliberately broken after grant + audit writes, on this one test connection.
 const connect=f.db.pool.connect.bind(f.db.pool);let injected=false;
 f.db.pool.connect=async()=>{const c=await connect(),query=c.query.bind(c),release=c.release.bind(c);c.query=(text,...args)=>{if(typeof text==='string'&&text.startsWith('INSERT INTO lanka.resource_receipts')){injected=true;return Promise.reject(Error('Injected receipt failure'));}return query(text,...args);};c.release=(...args)=>{c.query=query;c.release=release;return release(...args);};return c;};
 try{await assert.rejects(f.mutate({action:'grant',resourceId:doc.id,subject:{kind:'principal',id:f.principals.bob},role:'editor'},'alice',requestId),/Injected/);}finally{f.db.pool.connect=connect;}
 assert.equal(injected,true);await denied(()=>f.permission(doc.id,'bob'));
 assert.equal((await f.db.pool.query('SELECT authz_epoch FROM lanka.tenants WHERE id=$1',[f.tenant])).rows[0].authz_epoch,before);
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.resource_receipts WHERE tenant_id=$1 AND request_id=$2',[f.tenant,requestId])).rowCount,0);
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.resource_audit WHERE tenant_id=$1',[f.tenant])).rowCount,0);
});
test('node ancestry validates physical deletion and malformed cycles even beyond a restricted boundary',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder(),doc=await f.material('alice',a.legacyId);
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',[f.tenant,a.id]);await denied(()=>f.permission(doc.id));
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=NULL,parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,a.id,b.id]);
 await f.db.pool.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,b.id,a.id]);await denied(()=>f.permission(doc.id));
});

test('upgrade backfills corporate resources without modifying content or exposing legacy local ownership',async()=>{
 const name='lanka_resource_upgrade_'+randomUUID().replaceAll('-',''),admin=new Pool(base.connection);let database,created=false;
 try {
  // Dedicated ephemeral database; never drop or replace the installation database.
  await admin.query(`CREATE DATABASE "${name}"`);created=true;database=new Pool({...base.connection,database:name});
  await database.query('CREATE SCHEMA lanka; CREATE TABLE lanka.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const version of ['0001_chat','0002_chat_creation','0003_export_artifacts','0004_workspace_catalog','0005_revision_import_aliases','0006_browser_identity','0007_organization_membership','0008_native_catalog']) {
   const sql=await readFile('db/self-hosted/'+version+'.sql','utf8');await database.query(sql);await database.query('INSERT INTO lanka.schema_migrations(version,checksum) VALUES($1,$2)',[version,createHash('sha256').update(sql).digest('hex')]);
  }
  const identity=new PostgresBrowserIdentityStore(database),orgs=new PostgresOrganizationAccess(database),tenant=randomUUID(),principals=[];
  for(const [i,name] of ['alice','bob'].entries()) {
   const token=randomBytes(32).toString('base64url');await identity.establish('upgrade',{issuer:'https://upgrade.test',subject:name,name},token,null,new Date(Date.now()+3600000));
   const user=await identity.authenticate('upgrade',token);
   if(!i)await provisionOrganization(database,{requestId:tenant,slug:'upgrade',name:'Upgrade',ownerUserId:user.userId});
   else {const id=randomUUID();await database.query("INSERT INTO lanka.principals(tenant_id,id,kind,user_id) VALUES($1,$2,'human',$3)",[tenant,id,user.userId]);await database.query("INSERT INTO lanka.organization_memberships(tenant_id,principal_id,role,status) VALUES($1,$2,'member','active')",[tenant,id]);}
   principals.push(await orgs.withTenant(user,tenant,async(c,ctx)=>ctx.principalId));
  }
  const localOwner=randomUUID(),folderId=randomUUID(),documents=[];
  for(const [i,owner] of [...principals,localOwner].entries()) {
   await database.query("INSERT INTO lanka.workspace_catalogs(tenant_id,owner_id,origin) VALUES($1,$2,'native')",[tenant,owner]);
   await database.query('INSERT INTO lanka.catalog_folders(tenant_id,owner_id,id,name) VALUES($1,$2,$3,$4)',[tenant,owner,folderId,'Folder']);
   const doc=fromMarkdown('# Old content\n\n## Preserve\nUnchanged.');doc.id=randomUUID();documents.push(doc.id);
   const project={format:'lanka-project/v1',title:doc.title,state:{doc,revision:1,sources:[],proposals:[],comments:[],grants:[],approvedRevision:null,approvedBy:null},receipts:[]};
   await database.query('INSERT INTO lanka.materials(tenant_id,id,owner_id,folder_id,trashed,project) VALUES($1,$2,$3,$4,$5,$6)',[tenant,doc.id,owner,folderId,i===1,JSON.stringify(project)]);
  }
  const before=(await database.query('SELECT id,project::text,folder_id,trashed FROM lanka.materials ORDER BY id')).rows;
  await applySelfHostedMigrations(database);await applySelfHostedMigrations(database);
  assert.deepEqual((await database.query('SELECT id,project::text,folder_id,trashed FROM lanka.materials ORDER BY id')).rows,before);
  const nodes=(await database.query('SELECT * FROM lanka.resource_nodes ORDER BY kind,id')).rows;assert.equal(nodes.length,4);assert.equal(nodes.filter(n=>n.owner_id===localOwner).length,0);
  for(const owner of principals){const folder=nodes.find(n=>n.owner_id===owner&&n.kind==='folder'),doc=nodes.find(n=>n.owner_id===owner&&n.kind==='material');assert.equal(folder.folder_id,folderId);assert.equal(doc.parent_folder_id,folder.id);assert.equal(doc.inheritance,'restricted');}
  assert.ok(nodes.find(n=>n.material_id===documents[1]).deleted_at);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM lanka.acl_grants')).rows[0].n,0);
 }finally{await database?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});

test('moving a multi-level subtree preserves internal closure and replaces every outside ancestor',async t=>{
 const f=await fixture(t),a=await f.folder(),b=await f.folder(),c=await f.folder(),d=await f.folder();
 await f.mutate({action:'move',resourceId:b.id,parentFolderId:a.id});await f.mutate({action:'move',resourceId:c.id,parentFolderId:b.id});
 await f.mutate({action:'move',resourceId:b.id,parentFolderId:d.id});
 const rows=(await f.db.pool.query('SELECT ancestor_id,depth FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=$2 ORDER BY depth',[f.tenant,c.id])).rows;
 assert.deepEqual(rows,[{ancestor_id:c.id,depth:0},{ancestor_id:b.id,depth:1},{ancestor_id:d.id,depth:2}]);
 await f.mutate({action:'move',resourceId:b.id,parentFolderId:null});
 assert.deepEqual((await f.db.pool.query('SELECT ancestor_id,depth FROM lanka.folder_closure WHERE tenant_id=$1 AND descendant_id=$2 ORDER BY depth',[f.tenant,c.id])).rows,rows.slice(0,2));
});
test('database constraints prevent foreign-tenant subjects, mixed grant subjects and non-folder parents',async t=>{
 const f=await fixture(t),doc=await f.material(),other=await f.orgs.withTenant(f.users.bob,f.other,async(c,ctx)=>ctx.principalId),group=randomUUID();await f.mutate({action:'group_set',id:group,name:'Team',status:'active'});
 await assert.rejects(f.db.pool.query("INSERT INTO lanka.acl_grants(tenant_id,resource_id,principal_id,role) VALUES($1,$2,$3,'viewer')",[f.tenant,doc.id,other]),e=>e.code==='23503');
 await assert.rejects(f.db.pool.query("INSERT INTO lanka.acl_grants(tenant_id,resource_id,principal_id,group_id,role) VALUES($1,$2,$3,$4,'viewer')",[f.tenant,doc.id,f.principals.bob,group]),e=>e.code==='23514');
 const folder=await f.folder();await assert.rejects(f.db.pool.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,folder.id,doc.id]),e=>e.code==='23503');
 await denied(()=>f.mutate({action:'group_member',groupId:group,principalId:other,present:true}));
});

test('maximum folder depth still permits its material while a deeper move is rejected',async t=>{
 const f=await fixture(t);let parent=await f.folder();
 for(let depth=1;depth<=64;depth++){const child=await f.folder();await f.mutate({action:'move',resourceId:child.id,parentFolderId:parent.id});parent=child;}
 const material=await f.material('alice',parent.legacyId);assert.equal((await f.permission(material.id)).role,'manager');
 const copy=await new OrganizationDocumentCopy(f.resources,f.root).copy(f.users.alice,f.tenant,{requestId:randomUUID(),sourceDocumentId:material.legacyId,expectedRevision:1,title:'Глубокая копия',folderId:parent.legacyId});assert.equal((await f.permission(await f.node('material',copy.id))).role,'manager');
 await denied(()=>new AgentWorkspace(f.resources,f.root).create(f.users.alice,f.tenant,{requestId:randomUUID(),command:{action:'create_folder',name:'Too deep',parentFolderId:parent.legacyId}}));
 const excess=await f.folder();await denied(()=>f.mutate({action:'move',resourceId:excess.id,parentFolderId:parent.id}));assert.equal((await f.permission(excess.id)).parentFolderId,null);
});
test('new ACL permission does not silently open the old owner-only project projection',async t=>{
 const f=await fixture(t),doc=await f.material();await f.grant(doc.id,'bob','editor');
 assert.equal(await f.resources.withMaterial(f.users.bob,f.tenant,doc.legacyId,'editor',async(c,ctx,p)=>p.role),'editor');
 await assert.rejects(f.ws('bob').repository(doc.legacyId).read(),/Документ недоступен/);
 // Wiring shared reads requires the next explicit visibility projection, never this full private repository.
});


async function sharedFixture(t) {
 const f=await fixture(t),doc=await f.material(),project=await f.ws('alice').repository(doc.legacyId).read();
 const visibleBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XkAAAAASUVORK5CYII=','base64'),hiddenBytes=Buffer.from('PRIVATE_ORIGINAL_IMAGE');
 const source=(id,bytes)=>({id,name:'PRIVATE_SOURCE_NAME',kind:'image',contentType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),excerpt:'PRIVATE_EXCERPT',createdAt:new Date().toISOString()});
 project.state.sources=[source('visible',visibleBytes),source('old-image',hiddenBytes)];
 const slide=project.state.doc.slides[0];slide.title='PRIVATE_OLD_TITLE';slide.body='PRIVATE_OLD_BODY';slide.notes='PRIVATE_NOTES';slide.assetId='old-image';
 slide.canvas=[{id:'text',kind:'text',x:100,y:100,w:1200,h:100,size:40,bold:false,color:'#20243B',lineHeight:1.3,text:'Visible current text',sourceField:'PRIVATE_PROVENANCE'},
  {id:'image',kind:'image',x:100,y:300,w:200,h:200,assetId:'visible'}];
 project.state.doc.brief={audience:'PRIVATE_AUDIENCE',decision:'PRIVATE_DECISION',keyMessage:'PRIVATE_BRIEF'};
 project.state.proposals=[{private:'PRIVATE_PROPOSAL'}];project.state.comments=[{private:'PRIVATE_COMMENT'}];project.receipts=[{private:'PRIVATE_RECEIPT'}];project.briefing={private:'PRIVATE_BRIEFING'};project.history=[{private:'PRIVATE_HISTORY'}];
 await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,project]);
 for(const [id,bytes] of [['visible',visibleBytes],['old-image',hiddenBytes]])await f.db.pool.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4)',[f.tenant,doc.legacyId,'materials/'+project.state.sources.find(s=>s.id===id).sha256+'.bin',bytes]);
 return {...f,doc,project,visibleBytes,view:new OrganizationDocumentView(f.resources)};
}
test('shared view exposes current visual content only and keeps owner-only APIs closed after a grant',async t=>{
 const f=await sharedFixture(t),{bob}=f.users;
 await denied(()=>f.view.read(bob,f.tenant,f.doc.legacyId));await f.grant(f.doc.id,'bob','viewer');
 const view=await f.view.read(bob,f.tenant,f.doc.legacyId),json=JSON.stringify(view);
 assert.equal(view.format,'lanka-document-view/v1');assert.match(json,/Visible current text/);assert.doesNotMatch(json,/PRIVATE_|sha256|sourceField|editField|blockId|old-image/);
 assert.deepEqual(view.permission,{role:'viewer',canCopy:false,isOwner:false});
 assert.deepEqual(Object.keys(view).sort(),['format','height','id','permission','revision','slides','title','width']);
 assert.deepEqual((await f.view.asset(bob,f.tenant,f.doc.legacyId,'visible',view.revision)).bytes,f.visibleBytes);
 await denied(()=>f.view.asset(bob,f.tenant,f.doc.legacyId,'old-image',view.revision));
 await denied(()=>f.view.asset(bob,f.tenant,f.doc.legacyId,f.project.state.sources[1].sha256,view.revision));
 await denied(()=>f.view.read(bob,f.other,f.doc.legacyId));
 const api=organizationApi(f.orgs,f.root),path=`/api/organizations/${f.tenant}/documents/${f.doc.legacyId}`;
 const get=path=>api(new Request('https://lanka.test'+path),bob);
 assert.equal((await get(path+'/view')).status,200);
 for(const suffix of ['','/history','/exports','/assets?id=old-image'])assert.equal((await get(path+suffix)).status,404,suffix);
 const asset=await get(path+'/view-assets?id=visible&revision='+view.revision);assert.equal(asset.status,200);assert.equal(asset.headers.get('cache-control'),'no-store');assert.equal(asset.headers.get('x-content-type-options'),'nosniff');
 assert.equal((await get(path+'/view-assets?id=visible')).status,400);
 assert.equal((await api(new Request('https://lanka.test'+path+'/view',{method:'POST',body:'{}'}),bob)).status,405);
 const stored=(await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,f.doc.legacyId])).rows[0].project;
 assert.deepEqual(stored,f.project,'projection must not rewrite private owner data');
});
test('shared image requests bind the current revision and visible dependency, validate bytes, and recheck revoked access',async t=>{
 const f=await sharedFixture(t),{bob}=f.users;await f.grant(f.doc.id,'bob','editor',true);
 const view=await f.view.read(bob,f.tenant,f.doc.legacyId);
 await denied(()=>f.view.asset(bob,f.tenant,f.doc.legacyId,'visible',view.revision+1));
 await f.db.pool.query("UPDATE lanka.blobs SET bytes=$3 WHERE tenant_id=$1 AND material_id=$2 AND key=$4",[f.tenant,f.doc.legacyId,Buffer.from('corrupt'),'materials/'+f.project.state.sources[0].sha256+'.bin']);
 await denied(()=>f.view.asset(bob,f.tenant,f.doc.legacyId,'visible',view.revision));
 await f.grant(f.doc.id,'bob',null);await denied(()=>f.view.read(bob,f.tenant,f.doc.legacyId));await denied(()=>f.view.asset(bob,f.tenant,f.doc.legacyId,'visible',view.revision));
});
test('shared view honors inherited permissions, deletion of physical ancestors and identity suspension',async t=>{
 const f=await fixture(t),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),view=new OrganizationDocumentView(f.resources);
 await f.grant(folder.id,'bob','viewer');await denied(()=>view.read(f.users.bob,f.tenant,doc.legacyId));
 await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});assert.equal((await view.read(f.users.bob,f.tenant,doc.legacyId)).permission.role,'viewer');
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',[f.tenant,folder.id]);await denied(()=>view.read(f.users.bob,f.tenant,doc.legacyId));
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=NULL WHERE tenant_id=$1 AND id=$2',[f.tenant,folder.id]);
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'suspended'});await denied(()=>view.read(f.users.bob,f.tenant,doc.legacyId));
});
test('view projection preserves rendered typography and geometry for template and freeform scenes without rendering metadata',async t=>{
 const f=await fixture(t),doc=await f.material(),project=await f.ws('alice').repository(doc.legacyId).read();
 for(const design of ['classic-v1','focus-v2','focus-v3']) {
  project.state.doc.design=design;
  const original=scene(project.state.doc.slides[0],project.state.doc.brand,0,project.state.doc.slides.length,design);
  const view=documentView(project,{role:'viewer',canCopy:false,isOwner:false});
  assert.deepEqual(view.slides[0].items,original.items.map(p=>{const {editField,blockId,binding,...visible}=p;return visible;}));
  assert.doesNotMatch(JSON.stringify(view),/dataObjects|dataRange|editField|blockId|binding|authzEpoch/);
 }
});

test('shared asset authorization and byte read stay in one transaction that serializes with revoke',async t=>{
 const f=await sharedFixture(t);await f.grant(f.doc.id,'bob','viewer');let release,entered;
 const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const pool={connect:async()=>{
  const client=await f.db.pool.connect();
  return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args)=>{if(typeof args[0]==='string'&&args[0].startsWith('SELECT bytes FROM lanka.blobs')){entered(client.processID);await hold;}return client.query(...args);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 }};
 const reader=new OrganizationDocumentView(new PostgresResourceAccess(new PostgresOrganizationAccess(pool)));
 const reading=reader.asset(f.users.bob,f.tenant,f.doc.legacyId,'visible',1);const holder=await ready;
 let revoked=false;const revoking=f.grant(f.doc.id,'bob',null).then(()=>revoked=true);
 try{
  let blocked=false;for(let i=0;i<60;i++){const q=await f.db.pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND $1::int=ANY(pg_blocking_pids(pid))',[holder]);if(q.rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(blocked,true);assert.equal(revoked,false);
 }finally{release();}
 assert.deepEqual((await reading).bytes,f.visibleBytes);await revoking;
 await denied(()=>reader.read(f.users.bob,f.tenant,f.doc.legacyId));
});

test('shared catalogue exposes only granted metadata, separates personal documents and searches Cyrillic literally',async t=>{
 const f=await sharedFixture(t),view=f.view,own=await f.material('bob'),privateDoc=await f.material();
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{title}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",[f.tenant,f.doc.legacyId,'ПЛАН 100%_ — команда']);
 assert.deepEqual((await view.list(f.users.bob,f.tenant)).documents,[]);
 await f.grant(f.doc.id,'bob','viewer');
 const listed=await view.list(f.users.bob,f.tenant,{search:'план 100%_'});
 assert.equal(listed.format,'lanka-shared-library/v1');assert.equal(listed.nextCursor,null);
 assert.deepEqual(listed.documents.map(d=>d.id),[f.doc.legacyId]);assert.equal(listed.documents[0].role,'viewer');
 assert.deepEqual(Object.keys(listed.documents[0]).sort(),['id','reactions','revision','role','title','updatedAt']);
 assert.doesNotMatch(JSON.stringify(listed),/PRIVATE_|Visible current text|source|history|proposal|receipt|preview|canvas/);
 assert.deepEqual((await view.list(f.users.alice,f.tenant)).documents,[],'org owner does not see colleagues private documents');
 assert.deepEqual((await view.list(f.users.bob,f.other)).documents,[]);
 assert.deepEqual((await view.list(f.users.bob,f.tenant,{search:'100_'})).documents,[],'wildcard characters are literal');
 const api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/shared-library`;
 assert.equal((await api(new Request(path),f.users.bob)).status,200);
 for(const query of ['?cursor=invalid','?search='+('a'.repeat(141))])assert.equal((await api(new Request(path+query),f.users.bob)).status,400);
 assert.equal((await api(new Request(path,{method:'POST',body:'{}'}),f.users.bob)).status,405);
 await f.grant(f.doc.id,'bob',null);assert.deepEqual((await view.list(f.users.bob,f.tenant)).documents,[]);
 await denied(()=>view.read(f.users.bob,f.tenant,f.doc.legacyId));
 assert.ok(own.legacyId!==privateDoc.legacyId);
});

test('shared catalogue follows inheritance, active groups, moves, restricted boundaries and trash',async t=>{
 const f=await fixture(t),view=new OrganizationDocumentView(f.resources),a=await f.folder(),b=await f.folder(),doc=await f.material('alice',a.legacyId),groupId=randomUUID();
 const list=async()=> (await view.list(f.users.bob,f.tenant)).documents;
 await f.grant(a.id,'bob','viewer');assert.deepEqual(await list(),[]);
 await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});assert.deepEqual((await list()).map(d=>d.id),[doc.legacyId]);
 await f.mutate({action:'group_set',id:groupId,name:'Review',status:'active'});await f.mutate({action:'group_member',groupId,principalId:f.principals.bob,present:true});
 await f.mutate({action:'grant',resourceId:doc.id,subject:{kind:'group',id:groupId},role:'editor',canCopy:false});assert.equal((await list())[0].role,'editor');
 await f.mutate({action:'move',resourceId:doc.id,parentFolderId:b.id});assert.equal((await list())[0].role,'editor');
 await f.mutate({action:'group_set',id:groupId,name:'Review',status:'suspended'});assert.deepEqual(await list(),[]);
 await f.mutate({action:'group_set',id:groupId,name:'Review',status:'active'});assert.equal((await list()).length,1);
 await f.mutate({action:'group_member',groupId,principalId:f.principals.bob,present:false});assert.deepEqual(await list(),[]);
 await f.grant(doc.id,'bob','viewer');assert.equal((await list()).length,1);
 await f.ws('alice').mutate({requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:true}});assert.deepEqual(await list(),[]);
 await f.ws('alice').mutate({requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:false}});assert.equal((await list()).length,1);
});

test('shared catalogue rejects physically deleted ancestors and disconnected cycles even with a direct grant',async t=>{
 const f=await fixture(t),view=new OrganizationDocumentView(f.resources),a=await f.folder(),b=await f.folder(),doc=await f.material('alice',a.legacyId);
 await f.grant(doc.id,'bob','viewer');assert.equal((await view.list(f.users.bob,f.tenant)).documents.length,1);
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',[f.tenant,a.id]);
 assert.deepEqual((await view.list(f.users.bob,f.tenant)).documents,[]);await denied(()=>f.permission(doc.id,'bob'));
 await f.db.pool.query('UPDATE lanka.resource_nodes SET deleted_at=NULL,parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,a.id,b.id]);
 await f.db.pool.query('UPDATE lanka.resource_nodes SET parent_folder_id=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,b.id,a.id]);
 assert.deepEqual((await view.list(f.users.bob,f.tenant)).documents,[]);await denied(()=>f.permission(doc.id,'bob'));
});

test('shared catalogue rechecks membership and identity on every request',async t=>{
 const f=await fixture(t),view=new OrganizationDocumentView(f.resources),doc=await f.material();await f.grant(doc.id,'bob','viewer');
 assert.equal((await view.list(f.users.bob,f.tenant)).documents.length,1);
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'suspended'});
 await denied(()=>view.list(f.users.bob,f.tenant));
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'active'});
 await f.db.pool.query('UPDATE lanka.auth_identities SET disabled=true WHERE id=$1',[f.users.bob.userId]);await denied(()=>view.list(f.users.bob,f.tenant));
});

test('shared catalogue paginates without duplicate grants or timestamp rounding and survives anchor revocation',async t=>{
 const f=await fixture(t),view=new OrganizationDocumentView(f.resources),folder=await f.folder(),docs=[];
 await f.grant(folder.id,'bob','viewer');
 for(let i=0;i<53;i++) {const doc=await f.material('alice',folder.legacyId);docs.push(doc);await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});}
 // Every timestamp differs only in PostgreSQL's microsecond range; millisecond cursors lose rows.
 for(let i=0;i<docs.length;i++)await f.db.pool.query("UPDATE lanka.materials SET updated_at='2026-09-08T10:00:00.123400Z'::timestamptz+$3::int*interval '1 microsecond' WHERE tenant_id=$1 AND id=$2",[f.tenant,docs[i].legacyId,i]);
 await f.grant(docs[0].id,'bob','editor');
 const first=await view.list(f.users.bob,f.tenant);assert.equal(first.documents.length,50);assert.ok(first.nextCursor);assert.equal(new Set(first.documents.map(d=>d.id)).size,50);
 assert.deepEqual(first.documents.map(d=>d.id),docs.slice(3).reverse().map(d=>d.legacyId));
 await f.mutate({action:'inheritance',resourceId:docs[3].id,inheritance:'restricted'});
 const next=await view.list(f.users.bob,f.tenant,{cursor:first.nextCursor});assert.equal(next.nextCursor,null);
 assert.deepEqual(next.documents.map(d=>d.id),docs.slice(0,3).reverse().map(d=>d.legacyId));
 const refreshed=await view.list(f.users.bob,f.tenant);assert.equal(refreshed.documents.some(d=>d.id===docs[3].legacyId),false);
});

test('shared catalogue permission and projection serialize with a concurrent revoke',async t=>{
 const f=await fixture(t),doc=await f.material();await f.grant(doc.id,'bob','viewer');let release,entered;
 const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const pool={connect:async()=>{
  const client=await f.db.pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args)=>{if(typeof args[0]==='string'&&args[0].includes('WITH RECURSIVE\n    nodes AS MATERIALIZED')){entered(client.processID);await hold;}return client.query(...args);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 }};
 const reader=new OrganizationDocumentView(new PostgresResourceAccess(new PostgresOrganizationAccess(pool)));
 const reading=reader.list(f.users.bob,f.tenant),holder=await ready;let revoked=false;
 const revoking=f.grant(doc.id,'bob',null).then(()=>revoked=true);
 try {
  let blocked=false;for(let i=0;i<60;i++){const q=await f.db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))",[holder]);if(q.rowCount){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(blocked,true);assert.equal(revoked,false);
 }finally{release();}
 assert.deepEqual((await reading).documents.map(d=>d.id),[doc.legacyId]);await revoking;
 assert.deepEqual((await reader.list(f.users.bob,f.tenant)).documents,[]);
});

test('sharing UI service restricts audience and recipient directory to document managers, not organization admins',async t=>{
 const f=await fixture(t),sharing=new OrganizationDocumentSharing(f.resources),doc=await f.material('bob');
 await denied(()=>sharing.read(f.users.alice,f.tenant,doc.legacyId));
 await denied(()=>sharing.search(f.users.alice,f.tenant,doc.legacyId,'ca'));
 await f.grant(doc.id,'alice','viewer',false,'bob');await assert.rejects(sharing.read(f.users.alice,f.tenant,doc.legacyId),e=>e.status===403);
 await f.grant(doc.id,'alice','manager',false,'bob');
 const data=await sharing.read(f.users.alice,f.tenant,doc.legacyId);assert.equal(data.format,'lanka-document-sharing/v1');assert.equal(data.audienceCount,2);
 assert.deepEqual(data.audience.map(p=>p.role),['manager','manager']);
 await denied(()=>sharing.read(f.users.alice,f.other,doc.legacyId));
 await f.grant(doc.id,'alice',null,false,'bob');await denied(()=>sharing.search(f.users.alice,f.tenant,doc.legacyId,'ca'));
});

test('sharing directory searches active people and groups in the document tenant, preserves duplicates and bounds results',async t=>{
 const f=await fixture(t),sharing=new OrganizationDocumentSharing(f.resources),doc=await f.material(),group=randomUUID();
 await f.grant(doc.id,'bob','manager');
 await f.db.pool.query('UPDATE lanka.auth_identities SET display_name=$2 WHERE id=$1',[f.users.carol.userId,'КОМАНДА 100%_']);
 await f.mutate({action:'group_set',id:group,name:'КОМАНДА 100%_',status:'active'});
 await f.mutate({action:'group_member',groupId:group,principalId:f.principals.carol,present:true});
 let found=await sharing.search(f.users.bob,f.tenant,doc.legacyId,'команда 100%_');
 assert.equal(found.subjects.length,2);assert.deepEqual(new Set(found.subjects.map(s=>s.kind)),new Set(['principal','group']));
 assert.equal(found.subjects.find(s=>s.kind==='group').memberCount,1);assert.equal(found.hasMore,false);
 assert.deepEqual((await sharing.search(f.users.bob,f.tenant,doc.legacyId,'100_')).subjects,[]);
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.carol.userId,role:'member',status:'suspended'});
 found=await sharing.search(f.users.bob,f.tenant,doc.legacyId,'команда');assert.equal(found.subjects.length,1);assert.equal(found.subjects[0].memberCount,0);
 await f.mutate({action:'group_set',id:group,name:'КОМАНДА 100%_',status:'suspended'});assert.deepEqual((await sharing.search(f.users.bob,f.tenant,doc.legacyId,'команда')).subjects,[]);
 for(let i=0;i<22;i++)await f.mutate({action:'group_set',id:randomUUID(),name:'Test group '+i,status:'active'});
 found=await sharing.search(f.users.bob,f.tenant,doc.legacyId,'Test group');assert.equal(found.subjects.length,20);assert.equal(found.hasMore,true);
});

test('sharing audience shows inherited owners and direct/group sources, with effective role and copy capability',async t=>{
 const f=await fixture(t),sharing=new OrganizationDocumentSharing(f.resources),folder=await f.folder('bob'),doc=await f.material(),group=randomUUID();
 // Alice manages Bob's folder; its owner remains an inherited manager of a new child.
 await f.grant(folder.id,'alice','manager',false,'bob');
 await f.mutate({action:'move',resourceId:doc.id,parentFolderId:folder.id});await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});
 await f.grant(doc.id,'carol','viewer');
 await f.mutate({action:'group_set',id:group,name:'Editors',status:'active'});await f.mutate({action:'group_member',groupId:group,principalId:f.principals.carol,present:true});
 await f.mutate({action:'grant',resourceId:folder.id,subject:{kind:'group',id:group},role:'editor',canCopy:true});
 const before=await sharing.read(f.users.alice,f.tenant,doc.legacyId);assert.equal(before.audienceCount,3);
 assert.equal(before.entries.find(e=>e.subject.id===group).origin,'folder');
 const carol=before.audience.find(p=>p.id===f.principals.carol);assert.equal(carol.role,'editor');assert.equal(carol.canCopy,true);
 const request={requestId:randomUUID(),expectedEpoch:before.authzEpoch,subject:{kind:'principal',id:f.principals.carol},role:null,canCopy:false};
 await sharing.change(f.users.alice,f.tenant,doc.legacyId,request);
 const after=await sharing.read(f.users.alice,f.tenant,doc.legacyId);assert.equal(after.audienceCount,3);assert.equal(after.audience.find(p=>p.id===carol.id).role,'editor');
 assert.equal(after.entries.some(e=>e.origin==='direct'&&e.subject.id===carol.id),false);
 for(const person of after.audience)assert.equal(person.role,(await f.permission(doc.id,Object.keys(f.principals).find(n=>f.principals[n]===person.id))).role);
});

test('sharing changes reject stale reviewed audiences, keep retry receipts, and recheck authority before replay',async t=>{
 const f=await fixture(t),sharing=new OrganizationDocumentSharing(f.resources),doc=await f.material(),group=randomUUID();
 await f.mutate({action:'group_set',id:group,name:'Team',status:'active'});
 const before=await sharing.read(f.users.alice,f.tenant,doc.legacyId);
 const input={requestId:randomUUID(),expectedEpoch:before.authzEpoch,subject:{kind:'group',id:group},role:'viewer',canCopy:false};
 await f.mutate({action:'group_member',groupId:group,principalId:f.principals.bob,present:true});
 await assert.rejects(sharing.change(f.users.alice,f.tenant,doc.legacyId,input),e=>e.status===409);
 await denied(()=>f.permission(doc.id,'bob'));
 assert.equal((await f.db.pool.query('SELECT count(*)::int AS n FROM lanka.resource_receipts WHERE tenant_id=$1 AND request_id=$2',[f.tenant,input.requestId])).rows[0].n,0);
 input.expectedEpoch=(await sharing.read(f.users.alice,f.tenant,doc.legacyId)).authzEpoch;
 const changed=await sharing.change(f.users.alice,f.tenant,doc.legacyId,input);
 assert.deepEqual(await sharing.change(f.users.alice,f.tenant,doc.legacyId,input),changed);
 await assert.rejects(sharing.change(f.users.alice,f.tenant,doc.legacyId,{...input,role:'manager'}),e=>e.status===409);
 await f.grant(doc.id,'bob','manager');
 const self={requestId:randomUUID(),expectedEpoch:(await sharing.read(f.users.bob,f.tenant,doc.legacyId)).authzEpoch,subject:{kind:'principal',id:f.principals.bob},role:null,canCopy:false};
 await sharing.change(f.users.bob,f.tenant,doc.legacyId,self);assert.equal((await f.permission(doc.id,'bob')).role,'viewer');
 await denied(()=>sharing.change(f.users.bob,f.tenant,doc.legacyId,self));
});

test('sharing API binds the URL material, requires an epoch, rejects unrelated commands and does not alter the project',async t=>{
 const f=await fixture(t),doc=await f.material(),other=await f.material(),api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}/sharing`;
 const before=await f.ws('alice').repository(doc.legacyId).read();
 const get=await api(new Request(path),f.users.alice);assert.equal(get.status,200);assert.equal(get.headers.get('cache-control'),'no-store');
 const snap=await get.json(),input={requestId:randomUUID(),expectedEpoch:snap.authzEpoch,subject:{kind:'principal',id:f.principals.bob},role:'viewer',canCopy:false};
 const post=value=>api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),f.users.alice);
 assert.equal((await post({...input,expectedEpoch:undefined})).status,400);
 assert.equal((await post({...input,resourceId:other.id})).status,400);
 assert.equal((await post({...input,command:{action:'group_set'}})).status,400);
 assert.equal((await post({...input,padding:'x'.repeat(5000)})).status,413);
 assert.equal((await post({...input,subject:{kind:'principal',id:f.principals.alice}})).status,409);
 assert.equal((await post(input)).status,200);assert.equal((await f.permission(doc.id,'bob')).role,'viewer');await denied(()=>f.permission(other.id,'bob'));
 assert.equal((await api(new Request(path),f.users.bob)).status,403);
 assert.equal((await api(new Request(path+'-subjects?search=bo'),f.users.bob)).status,403);
 assert.equal((await api(new Request(path+'-subjects?search=b'),f.users.alice)).status,400);
 assert.equal((await api(new Request(path+'-subjects?search=bo'),f.users.alice)).status,200);
 assert.deepEqual(await f.ws('alice').repository(doc.legacyId).read(),before);
});

test('shared comments enforce current roles, private notes, authorship and exact retry across revisions and revocation',async t=>{
 const f=await fixture(t),doc=await f.material(),api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}/shared-comments`;
 const project=await f.ws('alice').repository(doc.legacyId).read(),slideId=project.state.doc.slides[0].id,revision=project.state.revision,privateId=randomUUID();
 project.state.comments.push({id:privateId,slideId,text:'PRIVATE_NOTE_SENTINEL',author:'Owner',createdAt:new Date().toISOString(),resolved:false});
 await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,JSON.stringify(project)]);
 const get=async(name='bob')=>api(new Request(path),f.users[name]);
 const post=async(value,name='bob')=>api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),f.users[name]);
 const input={requestId:randomUUID(),expectedRevision:revision,slideId,text:'Уточните вывод'};
 await f.grant(doc.id,'bob','viewer');assert.equal((await get()).status,200);assert.deepEqual((await (await get()).json()).comments,[]);
 assert.equal((await post(input)).status,403);
 await f.grant(doc.id,'bob','commenter');
 assert.equal((await post({...input,author:'alice'})).status,400);
 assert.equal((await post({...input,replyTo:privateId})).status,404);
 const results=await Promise.all([post(input),post(input)]);assert.deepEqual(results.map(r=>r.status),[200,200]);
 const first=await results[0].json();assert.deepEqual(await results[1].json(),first);assert.equal(first.comment.author,'bob');assert.equal(first.comment.authorPrincipalId,f.principals.bob);
 const after=await f.ws('alice').repository(doc.legacyId).read();assert.equal(after.state.comments.length,2);assert.equal(after.state.revision,revision);assert.deepEqual(after.state.doc,project.state.doc);
 assert.equal(after.state.comments[0].text,'PRIVATE_NOTE_SENTINEL');
 assert.equal((await post({...input,text:'Other'})).status,409);
 const reply=await post({...input,text:'Добавлю цифры',replyTo:first.comment.id},'alice');assert.equal(reply.status,200);
 const view=await (await get()).json();assert.equal(view.comments.length,2);assert.equal(view.comments[1].author,'alice');assert.ok(!JSON.stringify(view).includes('PRIVATE_NOTE_SENTINEL'));assert.equal(view.canComment,true);
 // Concurrent owner updates retain discussions; stored receipts replay after content advances.
 await f.ws('alice').repository(doc.legacyId).mutate(randomUUID(),{test:'owner edit'},old=>{old.state.doc.slides[0].notes='Owner update';old.state.revision++;return {project:old,result:{}};});
 assert.deepEqual(await (await post(input)).json(),first);
 assert.equal((await post({...input,requestId:randomUUID()})).status,409);
 assert.equal((await f.ws('alice').repository(doc.legacyId).read()).state.comments.length,3);
 await f.grant(doc.id,'bob',null);
 assert.equal((await get()).status,404);assert.equal((await post(input)).status,404);
 assert.equal((await get('carol')).status,404);
 const foreign=path.replace(f.tenant,f.other);assert.equal((await api(new Request(foreign),f.users.bob)).status,404);
});

test('shared discussion status has actor history, compare-and-set, exact retries and current authority',async t=>{
 const f=await fixture(t),doc=await f.material(),api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}/shared-comments`;
 const project=await f.ws('alice').repository(doc.legacyId).read();
 const post=(body,name='bob')=>api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),f.users[name]);
 await f.grant(doc.id,'bob','commenter');await f.grant(doc.id,'carol','commenter');
 const added=await(await post({requestId:randomUUID(),slideId:project.state.doc.slides[0].id,expectedRevision:project.state.revision,text:'Проверить вывод'})).json();
 const request={requestId:randomUUID(),action:'set_status',commentId:added.comment.id,expectedStatusVersion:0,resolved:true};
 assert.equal((await post(request,'carol')).status,403);
 const results=await Promise.all([post(request),post(request)]);assert.deepEqual(results.map(r=>r.status),[200,200]);const done=await results[0].json();assert.deepEqual(await results[1].json(),done);
 assert.equal(done.comment.statusVersion,1);assert.equal(done.comment.statusHistory.length,1);assert.equal(done.comment.statusHistory[0].actorPrincipalId,f.principals.bob);
 const reopened=await(await post({...request,requestId:randomUUID(),expectedStatusVersion:1,resolved:false},'alice')).json();assert.equal(reopened.comment.resolved,false);assert.equal(reopened.comment.statusVersion,2);assert.equal(reopened.comment.statusHistory[1].author,'alice');
 assert.deepEqual(await(await post(request)).json(),done); // replay does not close again
 assert.equal((await post({...request,requestId:randomUUID()})).status,409); // ABA: false is not the original state
 await f.grant(doc.id,'carol','editor');const editor={...request,requestId:randomUUID(),expectedStatusVersion:2};assert.equal((await post(editor,'carol')).status,200);
 await f.grant(doc.id,'carol','commenter');assert.equal((await post(editor,'carol')).status,403); // authority before receipt
 const after=await f.ws('alice').repository(doc.legacyId).read();assert.equal(after.state.revision,project.state.revision);assert.deepEqual(after.state.doc,project.state.doc);assert.equal(after.state.comments[0].statusHistory.length,3);
 const legacy=await api(new Request(path.replace('/shared-comments',''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:project.state.revision,command:{action:'resolve_comment',commentId:added.comment.id}})}),f.users.alice);assert.equal(legacy.status,409);
 const privateId=randomUUID();await f.ws('alice').repository(doc.legacyId).mutate(randomUUID(),{test:'private'},old=>{old.state.comments.push({id:privateId,slideId:project.state.doc.slides[0].id,text:'Private',author:'Alice',createdAt:new Date().toISOString(),resolved:false});return {project:old,result:{}};});
 assert.equal((await post({...request,commentId:privateId},'alice')).status,404);
 const view=await(await api(new Request(path),f.users.carol)).json();assert.deepEqual(view.manageableIds,[]);
 await f.grant(doc.id,'bob','viewer');assert.equal((await post(request)).status,403);
});

test('shared object anchors use saved content, survive removal and inherit the original target on replies',async t=>{
 const f=await fixture(t),doc=await f.material(),api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}/shared-comments`;
 const repo=f.ws('alice').repository(doc.legacyId),project=await repo.read(),slideId=project.state.doc.slides[0].id,elementId=randomUUID();
 await repo.mutate(randomUUID(),{test:'canvas'},old=>{old.state.doc.slides[0].canvas=[{id:elementId,kind:'text',x:100,y:100,w:500,h:100,text:'Видимый заголовок',size:40,color:'#222222',bold:true,lineHeight:1.2}];old.state.revision++;return {project:old,result:{}};});
 project.state.revision++;
 await f.grant(doc.id,'bob','commenter');
 const post=(body)=>api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),f.users.bob);
 const req={requestId:randomUUID(),expectedRevision:project.state.revision,slideId,text:'Уточнить заголовок',elementId};
 assert.equal((await post({...req,anchor:{quote:'Поддельная цитата'}})).status,400);
 assert.equal((await post({...req,elementId:'missing'})).status,404);
 const added=await(await post(req)).json();assert.deepEqual(added.comment.anchor,{elementId,quote:'Видимый заголовок',revision:project.state.revision});
 const view=await(await api(new Request(path.replace('/shared-comments','/view')),f.users.bob)).json();assert.equal(view.slides[0].targets[0].id,elementId);assert.equal(view.slides[0].targets[0].label,'Видимый заголовок');
 await repo.mutate(randomUUID(),{test:'delete target'},old=>{old.state.doc.slides[0].canvas=[{id:randomUUID(),kind:'rect',x:0,y:0,w:1600,h:900,color:'#ffffff'}];old.state.revision++;return {project:old,result:{}};});
 const reply={requestId:randomUUID(),expectedRevision:project.state.revision+1,slideId,text:'Объект уже удалён',replyTo:added.comment.id};
 assert.equal((await post({...reply,elementId:'other'})).status,409);
 const response=await(await post(reply)).json();assert.deepEqual(response.comment.anchor,added.comment.anchor);
 const read=await(await api(new Request(path),f.users.bob)).json();assert.deepEqual(read.comments[0].anchor,added.comment.anchor);
 assert.equal((await post({...req,requestId:randomUUID(),expectedRevision:project.state.revision+1})).status,404);
});

test('agent document delegation stores only a hash, limits scope, attributes writes and rechecks live authority',async t=>{
 const f=await fixture(t),doc=await f.material(),other=await f.material(),keys=new AgentDelegations(f.resources),comments=new OrganizationDocumentComments(f.resources),views=new OrganizationDocumentView(f.resources);
 await f.grant(doc.id,'bob','commenter');const secret=randomBytes(32).toString('hex'),actor=delegatedPrincipal(secret),request={requestId:randomUUID(),secret,name:'QA agent',capability:'comment',minutes:30};
 const issued=await keys.issue(f.users.bob,f.tenant,doc.legacyId,request);assert.equal(issued.id,request.requestId);assert.deepEqual(await keys.issue(f.users.bob,f.tenant,doc.legacyId,request),issued);assert.ok(!JSON.stringify(issued).includes(secret));
 const row=(await f.db.pool.query('SELECT * FROM lanka.agent_delegations WHERE tenant_id=$1 AND id=$2',[f.tenant,issued.id])).rows[0];assert.equal(row.token_hash,createHash('sha256').update(secret).digest('hex'));assert.ok(!JSON.stringify(row).includes(secret));
 await denied(()=>keys.issue(f.users.bob,f.tenant,doc.legacyId,{...request,name:'Changed'}));
 await denied(()=>views.read(actor,f.tenant,other.legacyId));await denied(()=>views.read(actor,f.other,doc.legacyId));
 await denied(()=>f.orgs.withTenant(actor,f.tenant,async()=>{}));await denied(async()=>f.resources.withMaterial(actor,f.tenant,doc.legacyId,'editor',async()=>{}));
 await denied(()=>keys.issue(actor,f.tenant,doc.legacyId,{...request,requestId:randomUUID()}));
 const view=await views.read(actor,f.tenant,doc.legacyId);assert.equal(view.permission.role,'commenter');assert.equal(view.permission.canCopy,false);assert.equal(view.permission.isOwner,false);
 const p=await f.ws('alice').repository(doc.legacyId).read(),input={requestId:randomUUID(),slideId:p.state.doc.slides[0].id,expectedRevision:p.state.revision,text:'Agent comment'};
 const added=await comments.add(actor,f.tenant,doc.legacyId,input);assert.equal(added.comment.delegationId,issued.id);assert.match(added.comment.author,/QA agent.*агент.*bob/);
 assert.deepEqual(await comments.add(actor,f.tenant,doc.legacyId,input),added);
 await denied(()=>comments.add(f.users.bob,f.tenant,doc.legacyId,input)); // agent receipt cannot be replayed as a human
 await f.grant(doc.id,'bob','viewer');await denied(()=>comments.add(actor,f.tenant,doc.legacyId,input));assert.equal((await comments.read(actor,f.tenant,doc.legacyId)).canComment,false);
 await f.grant(doc.id,'bob',null);await denied(()=>comments.read(actor,f.tenant,doc.legacyId));
 const revoked=await keys.revoke(f.users.bob,f.tenant,doc.legacyId,issued.id);assert.ok(revoked.revokedAt);assert.deepEqual(await keys.revoke(f.users.bob,f.tenant,doc.legacyId,issued.id),revoked);
 await f.grant(doc.id,'bob','commenter');await denied(()=>comments.read(actor,f.tenant,doc.legacyId));await denied(()=>keys.revoke(f.users.alice,f.tenant,doc.legacyId,issued.id));
});

test('read-only, expired and invalidated delegations cannot write or survive identity revocation',async t=>{
 const f=await fixture(t),doc=await f.material(),keys=new AgentDelegations(f.resources),comments=new OrganizationDocumentComments(f.resources);
 const issue=async(capability='read')=>{const secret=randomBytes(32).toString('hex');const key=await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'QA read agent',capability,minutes:1});return {key,actor:delegatedPrincipal(secret)};};
 const a=await issue(),p=await f.ws('alice').repository(doc.legacyId).read();assert.equal((await comments.read(a.actor,f.tenant,doc.legacyId)).canComment,false);
 await denied(()=>comments.add(a.actor,f.tenant,doc.legacyId,{requestId:randomUUID(),slideId:p.state.doc.slides[0].id,expectedRevision:p.state.revision,text:'Denied'}));
 await f.db.pool.query("UPDATE lanka.agent_delegations SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2",[f.tenant,a.key.id]);await denied(()=>comments.read(a.actor,f.tenant,doc.legacyId));
 const b=await issue();await f.db.pool.query('UPDATE lanka.auth_identities SET auth_epoch=auth_epoch+1 WHERE id=$1',[f.users.alice.userId]);await denied(()=>comments.read(b.actor,f.tenant,doc.legacyId));
});

test('delegation management HTTP requires real membership, returns no credential and cannot revive a revoked key',async t=>{
 const f=await fixture(t),doc=await f.material(),api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}/agent-delegations`;
 const secret=randomBytes(32).toString('hex'),request={requestId:randomUUID(),secret,name:'Agent HTTP',capability:'read',minutes:10};
 const post=(value,user='alice')=>api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),f.users[user]);
 assert.equal((await post({action:'issue',request},'bob')).status,404);
 assert.equal((await post({action:'issue',request:{...request,minutes:61}})).status,400);
 assert.equal((await post({action:'issue',request:{...request,capability:'edit'}})).status,400);
 const issued=await post({action:'issue',request});assert.equal(issued.status,200);assert.equal(issued.headers.get('cache-control'),'no-store');assert.ok(!(await issued.text()).includes(secret));
 const listed=await api(new Request(path),f.users.alice);const content=await listed.json();assert.equal(content.delegations.length,1);assert.ok(!JSON.stringify(content).includes(secret));assert.ok(!JSON.stringify(content).includes('token_hash'));
 const revoked=await post({action:'revoke',id:request.requestId});assert.equal(revoked.status,200);
 const replay=await(await post({action:'issue',request})).json();assert.ok(replay.revokedAt);
 assert.equal((await post({action:'revoke',id:request.requestId},'bob')).status,404);
});

test('parallel issuance respects the active-key quota and revocation waits for an authorized operation',async t=>{
 const f=await fixture(t),doc=await f.material(),keys=new AgentDelegations(f.resources);
 const requests=Array.from({length:21},()=>({requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Quota agent',capability:'read',minutes:1}));
 const results=await Promise.allSettled(requests.map(r=>keys.issue(f.users.alice,f.tenant,doc.legacyId,r)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,20);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 const index=results.findIndex(r=>r.status==='fulfilled'),request=requests[index],actor=delegatedPrincipal(request.secret);
 let release,entered;const hold=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const operation=f.resources.withMaterial(actor,f.tenant,doc.legacyId,'viewer',async()=>{entered();await hold;return 'read completed';});
 await ready;
 const revocation=keys.revoke(f.users.alice,f.tenant,doc.legacyId,request.requestId);
 try {
  const deadline=Date.now()+3000;let waiting=false;
  while(Date.now()<deadline){const r=await f.db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%authz_epoch%FOR UPDATE%' AND pid<>pg_backend_pid()");if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(waiting,true,'revoke waits for the in-flight authorization transaction');
 }finally{release();}
 assert.equal(await operation,'read completed');await revocation;
 await denied(()=>f.resources.withMaterial(actor,f.tenant,doc.legacyId,'viewer',async()=>{}));
});

test('external HTTP MCP uses delegated bearer, exposes scoped tools, publishes visibly and stops after revoke',async t=>{
 const f=await fixture(t),doc=await f.material(),keys=new AgentDelegations(f.resources),secret=randomBytes(32).toString('hex');
 const key=await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'External QA',capability:'comment',minutes:15});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port;
 const auth={config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice};
 handler=corporateNodeHandler(createCorporateApplication(auth,f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const endpoint=origin+`/mcp/organizations/${f.tenant}/documents/${doc.legacyId}`;
 const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
 let id=0;const rpc=(method,params={},extra={})=>fetch(endpoint,{method:'POST',headers:{...headers,...extra},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 assert.equal((await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'QA',version:'1'}})).status,200);
 assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})})).status,202);
 assert.equal((await rpc('ping',{}, {Origin:'https://foreign.test'})).status,403);
 assert.equal((await rpc('ping',{}, {Authorization:''})).status,401); // authenticated browser fallback is deliberately unavailable
 assert.equal((await rpc('ping',{}, {'MCP-Protocol-Version':'wrong'})).status,400);
 assert.equal((await fetch(endpoint,{headers})).status,405);
 const tools=await(await rpc('tools/list')).json();assert.deepEqual(tools.result.tools.map(t=>t.name).sort(),['lanka_list_document_sources','lanka_get_document_source','lanka_get_export_plan','lanka_get_document_view','lanka_get_shared_comments','lanka_comment','lanka_set_comment_status','lanka_list_publications','lanka_get_publication','lanka_preview_publication'].sort());assert.ok(tools.result.tools.some(t=>t.name==='lanka_get_export_plan'&&t.annotations.readOnlyHint));
 const current=await(await rpc('tools/call',{name:'lanka_get_document_view',arguments:{}})).json();const view=JSON.parse(current.result.content[0].text);assert.equal(view.id,doc.legacyId);assert.equal(view.permission.isOwner,false);
 const planResponse=await(await rpc('tools/call',{name:'lanka_get_export_plan',arguments:{format:'pptx',expectedRevision:view.revision}})).json();assert.notEqual(planResponse.result.isError,true);assert.equal(JSON.parse(planResponse.result.content[0].text).artifactCreated,false);
 const input={requestId:randomUUID(),expectedRevision:view.revision,slideId:view.slides[0].id,text:'Комментарий внешнего клиента'};
 const call={name:'lanka_comment',arguments:input},first=await(await rpc('tools/call',call)).json(),repeat=await(await rpc('tools/call',call)).json();assert.deepEqual(first.result,repeat.result);assert.notEqual(first.result.isError,true);
 const browser=await new OrganizationDocumentComments(f.resources).read(f.users.alice,f.tenant,doc.legacyId);assert.equal(browser.comments.length,1);assert.equal(browser.comments[0].delegationId,key.id);assert.match(browser.comments[0].author,/External QA.*агент/);
 const wrong=await(await rpc('tools/call',{name:'lanka_comment',arguments:{...input,action:'set_status'}})).json();assert.equal(wrong.result.isError,true);
 await keys.revoke(f.users.alice,f.tenant,doc.legacyId,key.id);
 assert.equal((await rpc('tools/list')).status,401);assert.equal((await rpc('tools/call',call)).status,401);
 assert.equal((await new OrganizationDocumentComments(f.resources).read(f.users.alice,f.tenant,doc.legacyId)).comments.length,1);
});

test('delegated proposals reuse review and design checks, keep main/private content intact and require explicit scope',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources);
 await repo.mutate(randomUUID(),{test:'private note'},old=>{old.state.doc.slides[0].notes='PRIVATE_NOTES_SENTINEL';old.state.revision++;return {project:old,result:{}};});
 const before=await repo.read();await f.grant(doc.id,'bob','commenter');
 const secret=randomBytes(32).toString('hex'),request={requestId:randomUUID(),secret,name:'Proposal agent',capability:'propose',minutes:15};
 await denied(()=>keys.issue(f.users.bob,f.tenant,doc.legacyId,request));await f.grant(doc.id,'bob','editor');await keys.issue(f.users.bob,f.tenant,doc.legacyId,request);
 const actor=delegatedPrincipal(secret),context=await proposals.context(actor,f.tenant,doc.legacyId);assert.ok(!JSON.stringify(context).includes('PRIVATE_NOTES_SENTINEL'));assert.equal(context.revision,before.state.revision);
 const readSecret=randomBytes(32).toString('hex');await keys.issue(f.users.bob,f.tenant,doc.legacyId,{...request,requestId:randomUUID(),secret:readSecret,capability:'comment'});await denied(()=>proposals.context(delegatedPrincipal(readSecret),f.tenant,doc.legacyId));
 const input={requestId:randomUUID(),expectedRevision:context.revision,title:'Уточнить заголовок',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Рабочий план'}]};
 const [first,repeat]=await Promise.all([proposals.create(actor,f.tenant,doc.legacyId,input),proposals.create(actor,f.tenant,doc.legacyId,input)]);assert.deepEqual(first,repeat);
 const pending=await repo.read();assert.deepEqual(pending.state.doc,before.state.doc);assert.equal(pending.state.revision,before.state.revision);assert.equal(pending.state.proposals.length,1);assert.equal(pending.state.proposals[0].delegationId,request.requestId);
 const preview=await proposals.preview(actor,f.tenant,doc.legacyId,first.proposalId);assert.ok(!JSON.stringify(preview).includes('PRIVATE_NOTES_SENTINEL'));assert.equal(preview.after.slides.length,1);assert.ok(Array.isArray(preview.designReview.after.issues));
 const api=organizationApi(f.orgs,f.root),path=`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}`;
 const accepted=await api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:before.state.revision,command:{action:'accept',proposalId:first.proposalId,changeIds:first.changes.map(c=>c.id)}})}),f.users.alice);
 assert.equal(accepted.status,200);const after=await repo.read();assert.equal(after.state.doc.slides[0].title,'Рабочий план');assert.equal(after.state.doc.slides[0].notes,'PRIVATE_NOTES_SENTINEL');assert.equal(after.state.revision,before.state.revision+1);
 assert.deepEqual(await proposals.create(actor,f.tenant,doc.legacyId,input),first);await denied(()=>proposals.create(actor,f.tenant,doc.legacyId,{...input,requestId:randomUUID()}));
 await f.grant(doc.id,'bob','commenter');await denied(()=>proposals.create(actor,f.tenant,doc.legacyId,input));await denied(()=>proposals.context(actor,f.tenant,doc.legacyId));
});

test('delegated canvas proposals protect locks and unused sources, then support partial human acceptance',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources);
 await repo.mutate(randomUUID(),{test:'two canvas slides'},old=>{
  const first=old.state.doc.slides[0];first.canvas=[{id:randomUUID(),kind:'rect',x:0,y:0,w:1600,h:900,color:'#ffffff',locked:true},{id:randomUUID(),kind:'text',x:120,y:220,w:1200,h:100,text:'Первый план',size:50,lineHeight:1.2,bold:true,color:'#222222'}];
  old.state.doc.slides.push({...structuredClone(first),id:randomUUID(),canvas:first.canvas.map(e=>({...e,id:randomUUID()}))});old.state.revision++;return {project:old,result:{}};
 });
 const before=await repo.read(),secret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Canvas agent',capability:'propose',minutes:15});const actor=delegatedPrincipal(secret),slides=before.state.doc.slides;
 const base={requestId:randomUUID(),expectedRevision:before.state.revision,title:'Два уточнения'};
 await denied(()=>proposals.create(actor,f.tenant,doc.legacyId,{...base,commands:[{op:'set_element',slideId:slides[0].id,value:{...slides[0].canvas[0],x:10}}]}));
 await denied(()=>proposals.create(actor,f.tenant,doc.legacyId,{...base,commands:[{op:'add_element',slideId:slides[0].id,value:{id:randomUUID(),kind:'image',x:100,y:400,w:300,h:200,assetId:'unseen-source'}}]}));
 const created=await proposals.create(actor,f.tenant,doc.legacyId,{...base,commands:slides.map((s,i)=>({op:'set_element',slideId:s.id,value:{...s.canvas[1],text:i?'Второй план':'Новый план'}}))});
 const api=organizationApi(f.orgs,f.root);const response=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:before.state.revision,command:{action:'accept',proposalId:created.proposalId,changeIds:[created.changes[0].id]}})}),f.users.alice);assert.equal(response.status,200);
 const after=await repo.read();assert.equal(after.state.doc.slides[0].canvas[1].text,'Новый план');assert.deepEqual(after.state.doc.slides[1],before.state.doc.slides[1]);assert.equal(after.state.proposals[0].changes[1].status,'pending');
});

test('workspace grants are explicit, list only current permitted documents and cannot expose private packages',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),views=new OrganizationDocumentView(f.resources);
 const own=await f.material(),shared=await f.material('bob'),hidden=await f.material('carol');await f.grant(shared.id,'alice','viewer',false,'bob');
 const repo=f.ws('alice').repository(own.legacyId);await repo.mutate(randomUUID(),{test:'private'},p=>{p.state.doc.slides[0].notes='PRIVATE_WORKSPACE_NOTE';p.state.revision++;return {project:p,result:{}};});
 const secret=randomBytes(32).toString('hex'),actor=delegatedPrincipal(secret),request={requestId:randomUUID(),secret,name:'Workspace reader',capability:'read',minutes:15};
 const issued=await keys.issue(f.users.alice,f.tenant,null,request);assert.equal(issued.scope,'workspace');
 const context=await workspace.context(actor,f.tenant);assert.equal(context.canCreate,false);assert.equal(context.templates.length,2);assert.equal(context.templates[1].design,'focus-v3');assert.ok(context.templates[1].authoring.recipes.content);
 const listing=await workspace.list(actor,f.tenant);assert.deepEqual(new Set(listing.documents.map(d=>d.id)),new Set([own.legacyId,shared.legacyId]));assert.ok(!JSON.stringify(listing).includes('PRIVATE_WORKSPACE_NOTE'));
 assert.ok(!JSON.stringify(await views.read(actor,f.tenant,own.legacyId)).includes('PRIVATE_WORKSPACE_NOTE'));await denied(()=>views.read(actor,f.tenant,hidden.legacyId));
 await denied(()=>f.orgs.personalProject(actor,f.tenant,own.legacyId));await denied(()=>f.orgs.personalLibrary(actor,f.tenant));await denied(()=>workspace.context(actor,f.other));
 await denied(()=>workspace.create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_folder',name:'Denied'}}));
 const docSecret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,own.legacyId,{...request,requestId:randomUUID(),secret:docSecret,capability:'propose'});
 await denied(()=>workspace.context(delegatedPrincipal(docSecret),f.tenant));await denied(()=>workspace.list(delegatedPrincipal(docSecret),f.tenant));
 await denied(async()=>keys.issue(f.users.alice,f.tenant,own.legacyId,{...request,requestId:randomUUID(),capability:'create'}));
 const proposer=await keys.issue(f.users.alice,f.tenant,null,{...request,requestId:randomUUID(),secret:randomBytes(32).toString('hex'),capability:'propose'});assert.deepEqual(proposer.capabilities,['read','comment','propose']);
 await f.grant(shared.id,'alice',null,false,'bob');assert.deepEqual((await workspace.list(actor,f.tenant)).documents.map(d=>d.id),[own.legacyId]);await denied(()=>views.read(actor,f.tenant,shared.legacyId));
 await keys.revoke(f.users.alice,f.tenant,null,issued.id);await denied(()=>workspace.context(actor,f.tenant));
});

test('workspace creation shares browser persistence, preserves retry identity and does not inherit sharing',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),secret=randomBytes(32).toString('hex'),actor=delegatedPrincipal(secret);
 const key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Workspace author',capability:'create',minutes:15});
 const folderRequest={requestId:randomUUID(),command:{action:'create_folder',name:'История'}};
 const [folder,folderReplay]=await Promise.all([workspace.create(actor,f.tenant,folderRequest),workspace.create(actor,f.tenant,folderRequest)]);assert.deepEqual(folder,folderReplay);
 const request={requestId:randomUUID(),command:{action:'create_document',title:'Письмо и города',folderId:folder.id,profile:'focus-v3',markdown:'# Письмо и города\n\n## Города\nПоселения связывают ремесло и обмен.\n\n## Письмо\nЗаписи помогают хранить знания.'}};
 const [created,replay]=await Promise.all([workspace.create(actor,f.tenant,request),workspace.create(actor,f.tenant,request)]);assert.deepEqual(created,replay);assert.equal(created.id,request.requestId);assert.ok(Array.isArray(created.designReview.issues));assert.match(created.url,/\/documents\//);
 const p=await f.ws('alice').repository(created.id).read();assert.equal(p.state.doc.design,'focus-v3');assert.equal(p.state.doc.slides.length,2);assert.equal(p.state.revision,1);
 const node=await f.node('material',created.id);await denied(()=>f.permission(node,'bob'));assert.equal((await f.permission(node)).inheritance,'restricted');
 const context=await new OrganizationDocumentProposals(f.resources).context(actor,f.tenant,created.id);assert.equal(context.revision,1);assert.ok(Array.isArray(context.designReview.issues));
 await denied(()=>workspace.create(actor,f.tenant,{...request,command:{...request.command,title:'Другой запрос'}}));
 const secondSecret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret:secondSecret,name:'Other key',capability:'create',minutes:15});
 await denied(()=>workspace.create(delegatedPrincipal(secondSecret),f.tenant,request));await denied(()=>workspace.create(delegatedPrincipal(secondSecret),f.tenant,folderRequest));
 const otherFolder=await f.folder('bob');await denied(()=>workspace.create(actor,f.tenant,{...request,requestId:randomUUID(),command:{...request.command,folderId:otherFolder.legacyId}}));
 const humanFolder=await f.folder();await denied(()=>workspace.create(actor,f.tenant,{requestId:humanFolder.legacyId,command:{action:'create_folder',name:'Folder'}}));
 const records=await f.db.pool.query('SELECT count(*)::int AS n FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,created.id]);assert.equal(records.rows[0].n,1);
 const audit=await f.db.pool.query("SELECT metadata FROM lanka.resource_audit WHERE tenant_id=$1 AND action='agent.create_document'",[f.tenant]);assert.equal(audit.rows.length,1);assert.equal(audit.rows[0].metadata.delegationId,key.id);
 await keys.revoke(f.users.alice,f.tenant,null,key.id);await denied(()=>workspace.create(actor,f.tenant,request));
});

test('workspace HTTP MCP creates a presentation through a browser-issued key and reads it with explicit documentId',async t=>{
 const f=await fixture(t),api=organizationApi(f.orgs,f.root),secret=randomBytes(32).toString('hex'),request={requestId:randomUUID(),secret,name:'Wire workspace',capability:'create',minutes:15};
 const path=`https://lanka.test/api/organizations/${f.tenant}/agent-delegations`,issued=await api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'issue',request})}),f.users.alice);assert.equal(issued.status,200);assert.ok(!(await issued.text()).includes(secret));
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port,auth={config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice};handler=corporateNodeHandler(createCorporateApplication(auth,f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};let id=0;
 const rpc=async(method,params={})=>(await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})})).json();
 const initialized=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'QA',version:'1'}});assert.equal(initialized.result.serverInfo.name,'lanka-corporate-workspace');
 const tools=(await rpc('tools/list')).result.tools;assert.ok(tools.some(t=>t.name==='lanka_create_document'));assert.ok(tools.find(t=>t.name==='lanka_get_edit_context').inputSchema.required.includes('documentId'));
 const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).result;
 const guide=await call('lanka_get_workspace_context');assert.notEqual(guide.isError,true);assert.ok(JSON.parse(guide.content[0].text).templates.length);
 const reference=await call('lanka_get_template_reference',{profile:'focus-v3',file:'deck-01-cover.png'});assert.equal(reference.content[1].type,'image');const png=Buffer.from(reference.content[1].data,'base64');assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(createHash('sha256').update(png).digest('hex'),JSON.parse(reference.content[0].text).sha256);assert.equal((await call('lanka_get_template_reference',{profile:'focus-v3',file:'../../work/agent-chat/config.json'})).isError,true);
 const args={requestId:randomUUID(),title:'Пути обмена',folderId:null,profile:'focus-v3',markdown:'# Пути обмена\n\n## Связи\nТовары и знания путешествуют между городами.'};
 const first=await call('lanka_create_document',args);assert.notEqual(first.isError,true);assert.deepEqual(await call('lanka_create_document',args),first);const doc=JSON.parse(first.content[0].text);
 const read=await call('lanka_get_document_view',{documentId:doc.id});assert.equal(JSON.parse(read.content[0].text).id,doc.id);
 assert.equal((await call('lanka_get_document_view')).isError,true);assert.equal((await call('lanka_get_document_view',{documentId:randomUUID()})).isError,true);
 assert.equal((await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.id}`),f.users.alice)).status,200);
 await api(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'revoke',id:request.requestId})}),f.users.alice);
 const revoked=await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})});assert.equal(revoked.status,401);
});

test('workspace write credentials follow shared roles, membership and expiry on every operation',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),proposals=new OrganizationDocumentProposals(f.resources),doc=await f.material('bob');
 const request={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Scoped author',capability:'create',minutes:15};await keys.issue(f.users.alice,f.tenant,null,request);const actor=delegatedPrincipal(request.secret);
 await f.grant(doc.id,'alice','viewer',false,'bob');await denied(()=>proposals.context(actor,f.tenant,doc.legacyId));
 await f.grant(doc.id,'alice','editor',false,'bob');assert.equal((await proposals.context(actor,f.tenant,doc.legacyId)).documentId,doc.legacyId);
 await f.grant(doc.id,'alice','commenter',false,'bob');await denied(()=>proposals.context(actor,f.tenant,doc.legacyId));
 await f.db.pool.query("UPDATE lanka.agent_delegations SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2",[f.tenant,request.requestId]);await denied(()=>workspace.list(actor,f.tenant));
 const fresh={...request,requestId:randomUUID(),secret:randomBytes(32).toString('hex')};await keys.issue(f.users.bob,f.tenant,null,fresh);const bob=delegatedPrincipal(fresh.secret);
 const input={requestId:randomUUID(),command:{action:'create_folder',name:'Before suspension'}};await workspace.create(bob,f.tenant,input);
 await f.orgs.setMembership(f.users.alice,f.tenant,{requestId:randomUUID(),userId:f.users.bob.userId,role:'member',status:'suspended'});
 await denied(()=>workspace.list(bob,f.tenant));await denied(()=>workspace.create(bob,f.tenant,input));
});

test('structured creation previews without persistence and rejects weak layouts before atomic creation',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),secret=randomBytes(32).toString('hex');
 await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Structured author',capability:'create',minutes:15});const actor=delegatedPrincipal(secret);
 const fixtureInput=JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8'));
 const input={requestId:randomUUID(),command:{action:'create_document',...fixtureInput}};delete input.command.slides[2].comparison.mode;
 const preview=await workspace.preview(actor,f.tenant,{...input,slideNumbers:[1,4]});assert.equal(preview.canCreate,true);assert.equal(preview.persisted,false);assert.ok(preview.storyReview.length>0);assert.equal(preview.images.length,2,preview.renderError);assert.equal(preview.renderedFrom,'canonical-pdf');assert.deepEqual(preview.designReview.issues,[]);assert.equal(Buffer.from(preview.images[0].data,'base64').subarray(1,4).toString(),'PNG');
 assert.equal((await workspace.list(actor,f.tenant)).documents.length,0);
 const bad=structuredClone(input);bad.command.slides[2].comparison.before.text='Помогает быстро уточнить контекст и договориться о следующем шаге.';bad.command.slides[2].comparison.after.text='Сохраняет принятое решение и позволяет коллегам вернуться к нему позже.';
 const rejectedPreview=await workspace.preview(actor,f.tenant,{...bad,slideNumbers:[3]});assert.equal(rejectedPreview.canCreate,false);assert.ok(rejectedPreview.problems.some(p=>p.includes('перегружен')));
 await assert.rejects(()=>workspace.create(actor,f.tenant,bad),e=>e.status===409&&e.message.includes('оформление'));
 assert.equal((await workspace.list(actor,f.tenant)).documents.length,0);
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.resource_receipts WHERE tenant_id=$1 AND request_id=$2',[f.tenant,input.requestId])).rowCount,0);
 const created=await workspace.create(actor,f.tenant,input),p=await f.ws('alice').repository(created.id).read();assert.equal(p.state.revision,1);assert.deepEqual(p.state.doc.slides.map(s=>s.id),preview.slideIds);assert.deepEqual(p.state.doc.slides.map(s=>s.layout),['cover','content','split','table','statement','closing']);assert.ok(!p.state.doc.slides.some(s=>s.canvas));assert.deepEqual(p.state.doc.slides[3].table,fixtureInput.slides[3].table);assert.equal(p.state.doc.slides[0].notes,fixtureInput.slides[0].notes);assert.equal(p.state.doc.slides[2].comparison.mode,'neutral');
 assert.deepEqual(await workspace.create(actor,f.tenant,input),created);
 const same=await new OrganizationDocumentView(f.resources).read(actor,f.tenant,created.id);assert.ok(!JSON.stringify(same).includes(fixtureInput.slides[0].notes));
 const api=organizationApi(f.orgs,f.root),humanId=randomUUID(),response=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/library`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,requestId:humanId})}),f.users.alice);assert.equal(response.status,200);const invalidHuman=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/library`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...bad,requestId:randomUUID()})}),f.users.alice);assert.equal(invalidHuman.status,409);const human=await f.ws('alice').repository(humanId).read();assert.deepEqual(human.state.doc.slides.map(({id,...s})=>s),p.state.doc.slides.map(({id,...s})=>s));
 await assert.rejects(()=>workspace.preview(actor,f.tenant,{...input,slideNumbers:[7]}),e=>e.status===409);
 await assert.rejects(()=>workspace.create(actor,f.tenant,{...input,requestId:randomUUID(),command:{...input.command,markdown:'# Ambiguous'}}),e=>e.status===409);
 const unknown=structuredClone(input);unknown.requestId=randomUUID();unknown.command.slides[3].table.sourceId='private-source';await assert.rejects(()=>workspace.create(actor,f.tenant,unknown),e=>e.status===409);
 const coordinates=structuredClone(input);coordinates.requestId=randomUUID();coordinates.command.slides[0].canvas=[];await assert.rejects(async()=>workspace.create(actor,f.tenant,coordinates));
});

test('HTTP structured preflight returns real images and creation preserves their slide IDs',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),secret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Structured HTTP',capability:'create',minutes:15});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};let id=0;
 const call=async(name,args)=>(await(await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const uploaded=await call('lanka_upload_source',{requestId:randomUUID(),name:'http-source.txt',base64:Buffer.from('Пилот базы знаний: собрать материалы команды.').toString('base64')});assert.notEqual(uploaded.isError,true);
 const source=JSON.parse(uploaded.content[0].text);assert.equal(source.extraction.status,'extracted');assert.equal(JSON.parse((await call('lanka_get_source_intake',{id:source.id})).content[0].text).sha256,source.sha256);assert.equal(JSON.parse((await call('lanka_list_source_intakes',{})).content[0].text).length,1);
 const input={requestId:randomUUID(),...JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8')),sources:[{id:source.id,sha256:source.sha256}],briefing:{audience:{value:'Команда',origin:'user'}}};input.slides[3].table.sourceId=source.id;
 const preview=await call('lanka_preview_creation',{...input,slideNumbers:[2,4]});assert.notEqual(preview.isError,true);assert.equal(preview.content.filter(c=>c.type==='image').length,2);const report=JSON.parse(preview.content[0].text);assert.equal(report.persisted,false);assert.equal(report.canCreate,true);
 const result=await call('lanka_create_document',input);assert.notEqual(result.isError,true);const created=JSON.parse(result.content[0].text);const context=JSON.parse((await call('lanka_get_edit_context',{documentId:created.id})).content[0].text);assert.deepEqual(context.slides.map(s=>s.id),report.slideIds);
 assert.equal((await call('lanka_preview_creation',{...input,slideNumbers:[1,1]})).isError,true);assert.equal((await call('lanka_preview_creation',{...input,markdown:'# Ambiguous',slideNumbers:[1]})).isError,true);assert.equal((await call('lanka_create_document',{...input,requestId:randomUUID(),markdown:'# Ambiguous'})).isError,true);
 const guide=JSON.parse((await call('lanka_get_workspace_context',{})).content[0].text);assert.ok(guide.templates[1].authoring.recipes.table);assert.ok(guide.templates[1].authoring.recipes.metrics);assert.ok(guide.authoringInput.slideSchema.properties.comparison);
});

test('corporate source creation binds uploads to keys, preserves exact snapshots and briefing origins',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),intakes=new AgentSourceIntakes(f.orgs,f.root),workspace=new AgentWorkspace(f.resources,f.root);
 const issue=async(capability='create')=>{const input={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Source QA',capability,minutes:15};await keys.issue(f.users.alice,f.tenant,null,input);return {...input,actor:delegatedPrincipal(input.secret)};};
 const a=await issue(),b=await issue(),reader=await issue('read');
 const bytes=Buffer.from('Вымышленная команда ведёт общую базу знаний. Пилот длится один месяц.'),upload={requestId:randomUUID(),name:'brief.txt',base64:bytes.toString('base64')};
 const personal=await intakes.upload(f.users.alice,f.tenant,{...upload,requestId:randomUUID()});
 const staged=await intakes.upload(a.actor,f.tenant,upload);assert.equal(staged.extraction.status,'extracted');assert.deepEqual(await intakes.upload(a.actor,f.tenant,upload),staged);
 assert.deepEqual((await intakes.list(a.actor,f.tenant)).map(s=>s.id),[staged.id]);assert.deepEqual(await intakes.list(b.actor,f.tenant),[]);
 await denied(()=>intakes.read(a.actor,f.tenant,personal.id));await denied(()=>intakes.read(b.actor,f.tenant,staged.id));await denied(()=>intakes.read(a.actor,f.other,staged.id));await denied(()=>intakes.upload(reader.actor,f.tenant,upload));
 const command={action:'create_document',...JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8')),sources:[{id:staged.id,sha256:staged.sha256}],briefing:{audience:{value:'Команда пилота',origin:'user'}}};command.slides[3].table.sourceId=staged.id;
 const input={requestId:randomUUID(),command};await denied(()=>workspace.create(b.actor,f.tenant,input));
 await denied(()=>workspace.create(a.actor,f.tenant,{...input,command:{...command,sources:[{id:staged.id,sha256:'0'.repeat(64)}]}}));
 assert.equal((await workspace.list(a.actor,f.tenant)).documents.length,0);
 const bad=structuredClone(input);bad.command.slides[2].comparison.before.text='Помогает быстро уточнить контекст и договориться о следующем шаге.';bad.command.slides[2].comparison.after.text='Сохраняет принятое решение и позволяет коллегам вернуться к нему позже.';
 await assert.rejects(()=>workspace.create(a.actor,f.tenant,bad),e=>e.status===409&&e.message.includes('оформление'));
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.tenant,input.requestId])).rowCount,0);
 const preview=await workspace.preview(a.actor,f.tenant,{...input,slideNumbers:[4]});assert.equal(preview.canCreate,true);assert.equal(preview.images.length,1,preview.renderError);
 const result=await workspace.create(a.actor,f.tenant,input),repo=f.ws('alice').repository(result.id),project=await repo.read();assert.deepEqual(await workspace.create(a.actor,f.tenant,input),result);
 assert.equal(project.state.sources[0].sha256,staged.sha256);assert.equal(project.state.doc.slides[3].table.sourceId,staged.id);assert.equal(project.state.doc.brief.origins.audience,'user');assert.equal(project.state.doc.brief.origins.decision,'assumption');assert.equal(project.briefing.audience.value,'Команда пилота');
 const stored=await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.tenant,result.id,`materials/${staged.sha256}.bin`]);assert.deepEqual(stored.rows[0].bytes,bytes);
 const api=organizationApi(f.orgs,f.root),download=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${result.id}/sources?id=${staged.id}`),f.users.alice);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 await f.db.pool.query("UPDATE lanka.source_intakes SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,staged.id]);await denied(()=>intakes.read(a.actor,f.tenant,staged.id));assert.deepEqual(await workspace.create(a.actor,f.tenant,input),result);assert.equal((await repo.read()).state.sources[0].sha256,staged.sha256);
 const partial=await intakes.upload(a.actor,f.tenant,{requestId:randomUUID(),name:'long.txt',base64:Buffer.from('Исходный текст. '.repeat(2000)).toString('base64')});assert.equal(partial.extraction.status,'partial');
 const next={requestId:randomUUID(),command:{...command,sources:[{id:partial.id,sha256:partial.sha256}],slides:command.slides.map(s=>({...s,...(s.table?{table:{...s.table,sourceId:partial.id}}:{})}))}};
 await assert.rejects(()=>workspace.create(a.actor,f.tenant,next),e=>e.status===409&&e.message.includes('частично'));next.command.sources[0].acceptPartial=true;assert.ok((await workspace.create(a.actor,f.tenant,next)).id);
 let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const paused=new AgentSourceIntakes(f.orgs,f.root,async()=>{started();await hold;return staged.extraction;});const pendingId=randomUUID(),pending=paused.upload(b.actor,f.tenant,{...upload,requestId:pendingId});await ready;
 try{await keys.revoke(f.users.alice,f.tenant,null,b.requestId);}finally{release();}
 await denied(()=>pending);assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.source_intakes WHERE tenant_id=$1 AND id=$2',[f.tenant,pendingId])).rowCount,0);
 await keys.revoke(f.users.alice,f.tenant,null,a.requestId);await denied(()=>intakes.list(a.actor,f.tenant));await denied(()=>workspace.create(a.actor,f.tenant,input));
});

test('human selected sources are granted atomically with one key and remain private to other keys',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),intakes=new AgentSourceIntakes(f.orgs,f.root),workspace=new AgentWorkspace(f.resources,f.root),api=organizationApi(f.orgs,f.root);
 const upload=async(text,name='material.txt')=>{const response=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/source-intakes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),name,base64:Buffer.from(text).toString('base64')})}),f.users.alice);assert.equal(response.status,200);return response.json();};
 const selected=await upload('Учебная команда создаёт базу знаний.'),privateSource=await upload('Личные заметки, не передавать.'),partial=await upload('Большой материал. '.repeat(2000));
 const input={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Selected materials',capability:'create',minutes:15,sources:[{id:selected.id,sha256:selected.sha256}]};
 await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...input,sources:[{id:selected.id,sha256:'0'.repeat(64)}]}));assert.equal((await keys.list(f.users.alice,f.tenant,null)).delegations.length,0);
 await denied(()=>keys.issue(f.users.bob,f.tenant,null,input));await denied(async()=>keys.issue(f.users.alice,f.tenant,null,{...input,capability:'read'}));
 await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...input,sources:[{id:partial.id,sha256:partial.sha256}]}));
 const granted=await keys.issue(f.users.alice,f.tenant,null,input);assert.deepEqual(await keys.issue(f.users.alice,f.tenant,null,input),granted);assert.equal(granted.sources.length,1);
 assert.deepEqual((await keys.list(f.users.alice,f.tenant,null)).delegations[0].sources,granted.sources);
 const actor=delegatedPrincipal(input.secret);assert.deepEqual((await intakes.list(actor,f.tenant)).map(s=>s.id),[selected.id]);await denied(()=>intakes.read(actor,f.tenant,privateSource.id));await denied(()=>intakes.read(actor,f.tenant,partial.id));
 const fresh={...input,requestId:randomUUID(),secret:randomBytes(32).toString('hex'),sources:[]};await keys.issue(f.users.alice,f.tenant,null,fresh);assert.deepEqual(await intakes.list(delegatedPrincipal(fresh.secret),f.tenant),[]);
 const command={action:'create_document',...JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8')),sources:input.sources};command.slides[3].table.sourceId=selected.id;
 const created=await workspace.create(actor,f.tenant,{requestId:randomUUID(),command});assert.equal((await f.ws('alice').repository(created.id).read()).state.sources[0].sha256,selected.sha256);
 await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...input,sources:[{id:privateSource.id,sha256:privateSource.sha256}]}));
 await keys.revoke(f.users.alice,f.tenant,null,input.requestId);await denied(()=>intakes.read(actor,f.tenant,selected.id));
 const partialKey={...input,requestId:randomUUID(),secret:randomBytes(32).toString('hex'),sources:[{id:partial.id,sha256:partial.sha256,acceptPartial:true}]};await keys.issue(f.users.alice,f.tenant,null,partialKey);assert.equal((await intakes.read(delegatedPrincipal(partialKey.secret),f.tenant,partial.id)).extraction.status,'partial');
});

test('temporary source deletion revokes snapshot grants, preserves documents and blocks delayed resurrection',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),intakes=new AgentSourceIntakes(f.orgs,f.root),workspace=new AgentWorkspace(f.resources,f.root),api=organizationApi(f.orgs,f.root);
 const upload={requestId:randomUUID(),name:'delete-test.md',base64:Buffer.from('Учебный материал команды.').toString('base64')};const source=await intakes.upload(f.users.alice,f.tenant,upload);
 const key={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Selected source',capability:'create',minutes:15,sources:[{id:source.id,sha256:source.sha256}]};await keys.issue(f.users.alice,f.tenant,null,key);const actor=delegatedPrincipal(key.secret);
 const command={action:'create_document',...JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8')),sources:key.sources};command.slides[3].table.sourceId=source.id;
 const created=await workspace.create(actor,f.tenant,{requestId:randomUUID(),command});
 await denied(()=>intakes.remove(f.users.alice,f.tenant,{id:source.id,sha256:'0'.repeat(64)}));await denied(async()=>intakes.remove(actor,f.tenant,{id:source.id,sha256:source.sha256}));
 await intakes.remove(f.users.bob,f.tenant,{id:source.id,sha256:source.sha256});assert.equal((await intakes.read(actor,f.tenant,source.id)).id,source.id);
 const url=`https://lanka.test/api/organizations/${f.tenant}/source-intakes?id=${source.id}&sha256=${source.sha256}`;
 assert.equal((await api(new Request(url,{method:'DELETE'}),f.users.alice)).status,200);assert.equal((await api(new Request(url,{method:'DELETE'}),f.users.alice)).status,200);
 await denied(()=>intakes.read(actor,f.tenant,source.id));await denied(()=>intakes.upload(f.users.alice,f.tenant,upload));assert.deepEqual((await keys.list(f.users.alice,f.tenant,null)).delegations[0].sources,[]);
 const original=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${created.id}/sources?id=${source.id}`),f.users.alice);assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from(upload.base64,'base64'));
 let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);const paused=new AgentSourceIntakes(f.orgs,f.root,async()=>{started();await hold;return source.extraction;});
 const late={...upload,requestId:randomUUID()},pending=paused.upload(f.users.alice,f.tenant,late);await ready;
 try{const saved=await intakes.upload(f.users.alice,f.tenant,late);await intakes.remove(f.users.alice,f.tenant,{id:saved.id,sha256:saved.sha256});}finally{release();}
 await assert.rejects(()=>pending,e=>e.status===409&&e.message.includes('удалён'));assert.deepEqual(await intakes.list(f.users.alice,f.tenant),[]);
 const seed=await intakes.upload(f.users.alice,f.tenant,{...upload,requestId:randomUUID()});
 await f.db.pool.query('INSERT INTO lanka.source_intakes(tenant_id,owner_id,id,fingerprint,name,content_type,sha256,bytes,extraction) SELECT tenant_id,owner_id,gen_random_uuid(),fingerprint,name,content_type,sha256,bytes,extraction FROM lanka.source_intakes CROSS JOIN generate_series(1,29) WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[f.tenant,f.principals.alice,seed.id]);
 const overQuota={...upload,requestId:randomUUID()};await assert.rejects(()=>intakes.upload(f.users.alice,f.tenant,overQuota),e=>e.status===409&&e.message.includes('лимит'));
 await intakes.remove(f.users.alice,f.tenant,{id:seed.id,sha256:seed.sha256});assert.equal((await intakes.upload(f.users.alice,f.tenant,overQuota)).id,overQuota.requestId);assert.equal((await intakes.list(f.users.alice,f.tenant)).length,30);

});

test('explicit library management preserves private content, checks state and supports reversible organization',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),library=new AgentLibrary(f.resources,f.root),doc=await f.material(),folder=await f.folder(),foreign=await f.material('bob');await f.grant(foreign.id,'alice','manager',true,'bob');
 const issue=async(capability)=>{const request={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Library QA',capability,minutes:15};await keys.issue(f.users.alice,f.tenant,null,request);return {...request,actor:delegatedPrincipal(request.secret)};};
 const creator=await issue('create');await denied(()=>library.list(creator.actor,f.tenant,{kind:'documents'}));const manager=await issue('organize');
 const repo=f.ws('alice').repository(doc.legacyId);await repo.mutate(randomUUID(),{seed:'private context'},p=>{p.state.doc.slides[0].notes='Private speaker note';p.state.comments.push({id:randomUUID(),slideId:p.state.doc.slides[0].id,text:'Private discussion',author:'Owner',createdAt:new Date().toISOString(),resolved:false});p.state.revision++;return {project:p,result:{}};});
 let listed=await library.list(manager.actor,f.tenant,{kind:'documents'});assert.deepEqual(listed.items.map(x=>x.id),[doc.legacyId]);assert.ok(!JSON.stringify(listed).includes('Private'));let item=listed.items[0];
 const rename={requestId:randomUUID(),command:{action:'rename_document',id:doc.legacyId,title:'Обновлённый план',expectedState:item.stateToken}};
 await denied(()=>library.mutate(creator.actor,f.tenant,rename));await denied(()=>library.mutate(manager.actor,f.other,rename));await denied(()=>library.mutate(manager.actor,f.tenant,{...rename,command:{...rename.command,id:foreign.legacyId}}));
 const renamed=await library.mutate(manager.actor,f.tenant,rename);assert.equal(renamed.item.title,'Обновлённый план');assert.equal(renamed.item.revision,item.revision+1);assert.deepEqual(await library.mutate(manager.actor,f.tenant,rename),renamed);
 await denied(()=>library.mutate(manager.actor,f.tenant,{...rename,requestId:randomUUID()}));assert.equal((await repo.read()).state.doc.slides[0].notes,'Private speaker note');
 const folderItem=(await library.list(manager.actor,f.tenant,{kind:'folders'})).items[0];const renamedFolder=await library.mutate(manager.actor,f.tenant,{requestId:randomUUID(),command:{action:'rename_folder',id:folder.legacyId,name:'Пилот',expectedState:folderItem.stateToken}});assert.equal(renamedFolder.item.title,'Пилот');
 const moved=await library.mutate(manager.actor,f.tenant,{requestId:randomUUID(),command:{action:'move_document',id:doc.legacyId,folderId:folder.legacyId,expectedState:renamed.item.stateToken}});assert.equal(moved.item.folderId,folder.legacyId);
 const copyRequest={requestId:randomUUID(),command:{action:'duplicate_document',id:doc.legacyId,title:'Копия плана',folderId:null,expectedState:moved.item.stateToken}};const copied=await library.mutate(manager.actor,f.tenant,copyRequest);assert.deepEqual(await library.mutate(manager.actor,f.tenant,copyRequest),copied);const copy=await f.ws('alice').repository(copied.item.id).read();assert.equal(copy.state.comments.length,0);assert.equal(copy.state.doc.slides[0].notes,'Private speaker note');assert.equal(copy.state.revision,1);
 const trash={requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:true,expectedState:moved.item.stateToken}};const trashed=await library.mutate(manager.actor,f.tenant,trash);assert.deepEqual(await library.mutate(manager.actor,f.tenant,trash),trashed);assert.equal(trashed.item.trashed,true);assert.deepEqual((await library.list(manager.actor,f.tenant,{kind:'documents',trashed:true})).items.map(i=>i.id),[doc.legacyId]);
 await denied(()=>library.mutate(manager.actor,f.tenant,{requestId:randomUUID(),command:{...rename.command,expectedState:trashed.item.stateToken}}));
 const restored=await library.mutate(manager.actor,f.tenant,{requestId:randomUUID(),command:{action:'trash_document',id:doc.legacyId,trashed:false,expectedState:trashed.item.stateToken}});assert.equal(restored.item.trashed,false);assert.equal((await repo.read()).state.comments[0].text,'Private discussion');
 const second=await issue('organize');await denied(()=>library.mutate(second.actor,f.tenant,rename));
 await keys.revoke(f.users.alice,f.tenant,null,manager.requestId);await denied(()=>library.list(manager.actor,f.tenant,{kind:'documents'}));await denied(()=>library.mutate(manager.actor,f.tenant,rename));
 const actions=await f.db.pool.query("SELECT action FROM lanka.resource_audit WHERE tenant_id=$1 AND action LIKE 'agent.%'",[f.tenant]);assert.ok(actions.rows.some(r=>r.action==='agent.trash_document'));assert.ok(actions.rows.some(r=>r.action==='agent.duplicate_document'));
});

test('HTTP exposes library management only for explicit organize keys and inspects exact IDs',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),doc=await f.material(),secrets={};
 for(const capability of ['create','organize']){secrets[capability]=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret:secrets[capability],name:capability,capability,minutes:15});}
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const rpc=async(cap,method,params={})=>(await(await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers:{Authorization:'Bearer '+secrets[cap],'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());
 assert.ok(!(await rpc('create','tools/list')).result.tools.some(t=>t.name==='lanka_manage_library'));assert.ok((await rpc('organize','tools/list')).result.tools.some(t=>t.name==='lanka_manage_library'));
 const invoke=async(name,args)=>(await rpc('organize','tools/call',{name,arguments:args})).result;
 const read=await invoke('lanka_list_library',{kind:'documents',id:doc.legacyId});assert.notEqual(read.isError,true);const item=JSON.parse(read.content[0].text).items[0];assert.equal(item.id,doc.legacyId);
 const command={action:'rename_document',id:doc.legacyId,title:'HTTP переименование',expectedState:item.stateToken},args={requestId:randomUUID(),command};assert.ok((await rpc('create','tools/call',{name:'lanka_manage_library',arguments:args})).error);
 const saved=await invoke('lanka_manage_library',args);assert.notEqual(saved.isError,true);assert.deepEqual(await invoke('lanka_manage_library',args),saved);assert.equal((await f.ws('alice').repository(doc.legacyId).read()).title,command.title);
 assert.equal((await invoke('lanka_list_library',{kind:'documents',id:doc.legacyId,cursor:doc.legacyId})).isError,true);
 const project=await f.ws('alice').repository(doc.legacyId).read(),slide=project.state.doc.slides[0];
 const proposal={id:randomUUID(),title:'Проверить',author:'local-agent',createdAt:new Date().toISOString(),baseRevision:project.state.revision,status:'pending',changes:[{id:randomUUID(),slideId:slide.id,before:slide,after:{...slide,title:'Предложенный заголовок'},status:'pending'}]};
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,proposals}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,doc.legacyId,JSON.stringify([proposal])]);
 const pending=await invoke('lanka_list_library',{kind:'documents',pendingOnly:true});assert.notEqual(pending.isError,true);assert.deepEqual(JSON.parse(pending.content[0].text).items.map(d=>[d.id,d.pending]),[[doc.legacyId,1]]);
 const browserPending=await fetch(origin+`/api/organizations/${f.tenant}/library?pending=1`,{headers:{'x-lanka-page-user':f.users.alice.userId}});assert.equal(browserPending.status,200);assert.deepEqual((await browserPending.json()).documents.map(d=>[d.id,d.pending]),JSON.parse(pending.content[0].text).items.map(d=>[d.id,d.pending]));
 assert.equal((await invoke('lanka_list_library',{kind:'folders',pendingOnly:true})).isError,true);
 proposal.status='closed';proposal.changes[0].status='rejected';
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,proposals}',$3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,doc.legacyId,JSON.stringify([proposal])]);
 assert.deepEqual(JSON.parse((await invoke('lanka_list_library',{kind:'documents',pendingOnly:true})).content[0].text).items,[]);

});

test('library move rechecks inherited access and folder metadata is paginated without notes',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),library=new AgentLibrary(f.resources,f.root),left=await f.folder(),right=await f.folder(),doc=await f.material('alice',left.legacyId);
 await f.grant(left.id,'bob','viewer');await f.grant(right.id,'carol','viewer');await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});assert.equal((await f.permission(doc.id,'bob')).role,'viewer');await denied(()=>f.permission(doc.id,'carol'));
 const secret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Organizer',capability:'organize',minutes:15});const actor=delegatedPrincipal(secret);
 const item=(await library.list(actor,f.tenant,{kind:'documents',id:doc.legacyId})).items[0];await library.mutate(actor,f.tenant,{requestId:randomUUID(),command:{action:'move_document',id:doc.legacyId,folderId:right.legacyId,expectedState:item.stateToken}});
 await denied(()=>f.permission(doc.id,'bob'));assert.equal((await f.permission(doc.id,'carol')).role,'viewer');
 for(let i=0;i<50;i++)await f.folder();const page=await library.list(actor,f.tenant,{kind:'folders'});assert.equal(page.items.length,50);assert.ok(page.nextCursor);const next=await library.list(actor,f.tenant,{kind:'folders',cursor:page.nextCursor});assert.equal(next.items.length,2);assert.equal(next.nextCursor,null);assert.equal(new Set([...page.items,...next.items].map(i=>i.id)).size,52);
});

test('folder key bounds discovery, creation, management and replay to current subtree',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),library=new AgentLibrary(f.resources,f.root),view=new OrganizationDocumentView(f.resources);
 const a=await f.folder(),b=await f.folder(),inside=await f.material('alice',a.legacyId),outside=await f.material('alice',b.legacyId),root=await f.material();
 const secret=randomBytes(32).toString('hex'),issue={requestId:randomUUID(),secret,name:'Project only',capability:'organize',minutes:15,folderId:a.legacyId};const key=await keys.issue(f.users.alice,f.tenant,null,issue),actor=delegatedPrincipal(secret);assert.equal(key.folderResourceId,a.id);
 assert.deepEqual(await keys.issue(f.users.alice,f.tenant,null,issue),key);await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...issue,folderId:b.legacyId}));
 const context=await workspace.context(actor,f.tenant);assert.deepEqual(context.scope,{kind:'folder',resourceId:a.id});assert.deepEqual(context.folders.map(f=>f.id),[a.legacyId]);
 assert.deepEqual((await workspace.list(actor,f.tenant)).documents.map(d=>d.id),[inside.legacyId]);assert.deepEqual((await library.list(actor,f.tenant,{kind:'documents'})).items.map(d=>d.id),[inside.legacyId]);
 for(const doc of [outside,root]){await denied(()=>view.read(actor,f.tenant,doc.legacyId));assert.deepEqual((await library.list(actor,f.tenant,{kind:'documents',id:doc.legacyId})).items,[]);}
 assert.equal((await view.read(actor,f.tenant,inside.legacyId)).id,inside.legacyId);
 const item=(await library.list(actor,f.tenant,{kind:'documents',id:inside.legacyId})).items[0];
 for(const folderId of [null,b.legacyId])for(const action of ['move_document','duplicate_document'])await denied(()=>library.mutate(actor,f.tenant,{requestId:randomUUID(),command:{action,id:inside.legacyId,folderId,expectedState:item.stateToken,...(action==='duplicate_document'?{title:'Copy'}:{})}}));
 await denied(()=>workspace.create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_folder',name:'Escape'}}));
 const nestedId=randomUUID(),nestedRequest={requestId:nestedId,command:{action:'create_folder',name:'Nested',parentFolderId:a.legacyId}};await workspace.create(actor,f.tenant,nestedRequest);assert.deepEqual(await workspace.create(actor,f.tenant,nestedRequest),{id:nestedId});
 const nestedNode=await f.node('folder',nestedId);assert.equal((await f.permission(nestedNode)).parentFolderId,a.id);
 const createdId=randomUUID(),create={requestId:createdId,command:{action:'create_document',title:'Scoped draft',folderId:nestedId}};await workspace.create(actor,f.tenant,create);assert.ok((await workspace.list(actor,f.tenant)).documents.some(d=>d.id===createdId));
 for(const folderId of [null,b.legacyId])await denied(()=>workspace.create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_document',title:'Escape',folderId}}));
 const copy={requestId:randomUUID(),command:{action:'duplicate_document',id:inside.legacyId,title:'Scoped copy',folderId:a.legacyId,expectedState:item.stateToken}};
 await library.mutate(actor,f.tenant,copy);const copyNode=await f.node('material',copy.requestId);await f.mutate({action:'move',resourceId:copyNode,parentFolderId:b.id});await denied(()=>library.mutate(actor,f.tenant,copy));
 await denied(()=>workspace.preview(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_document',title:'Outside preview',profile:'focus-v3',folderId:b.legacyId,slides:[{layout:'cover',title:'Hidden'}]},slideNumbers:[1]}));
 const rename={requestId:randomUUID(),command:{action:'rename_document',id:inside.legacyId,title:'Scoped title',expectedState:item.stateToken}};await library.mutate(actor,f.tenant,rename);
 let current=(await library.list(actor,f.tenant,{kind:'documents',id:inside.legacyId})).items[0];await library.mutate(actor,f.tenant,{requestId:randomUUID(),command:{action:'trash_document',id:inside.legacyId,trashed:true,expectedState:current.stateToken}});
 current=(await library.list(actor,f.tenant,{kind:'documents',trashed:true})).items[0];assert.equal(current.id,inside.legacyId);await library.mutate(actor,f.tenant,{requestId:randomUUID(),command:{action:'trash_document',id:inside.legacyId,trashed:false,expectedState:current.stateToken}});
 await f.mutate({action:'move',resourceId:inside.id,parentFolderId:b.id});await denied(()=>library.mutate(actor,f.tenant,rename));await denied(()=>view.read(actor,f.tenant,inside.legacyId));
 await f.mutate({action:'move',resourceId:nestedNode,parentFolderId:b.id});await denied(()=>workspace.create(actor,f.tenant,create));await denied(()=>workspace.create(actor,f.tenant,nestedRequest));assert.equal((await workspace.list(actor,f.tenant)).documents.length,0);
 await keys.revoke(f.users.alice,f.tenant,null,key.id);await denied(()=>workspace.context(actor,f.tenant));
});

test('folder grant rejects wrong ownership and document scopes; removed anchor fails closed',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),a=await f.folder(),b=await f.folder('bob'),doc=await f.material();await f.grant(b.id,'alice','manager',false,'bob');
 const issue={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Folder',capability:'read',minutes:15,folderId:a.legacyId};
 await denied(()=>keys.issue(f.users.alice,f.tenant,doc.legacyId,issue));await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...issue,folderId:b.legacyId}));await denied(()=>keys.issue(f.users.alice,f.other,null,issue));
 await keys.issue(f.users.alice,f.tenant,null,issue);const actor=delegatedPrincipal(issue.secret);await workspace.context(actor,f.tenant);
 await f.orgs.withTenant(f.users.alice,f.tenant,c=>c.query('UPDATE lanka.resource_nodes SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',[f.tenant,a.id]),true);
 await denied(()=>workspace.context(actor,f.tenant));await denied(()=>keys.issue(f.users.alice,f.tenant,null,issue));
});

test('folder metadata preserves hierarchy without exposing foreign or out-of-scope parents',async t=>{
 const f=await fixture(t),a=await f.folder(),child=await f.folder(),foreign=await f.folder('bob');await f.mutate({action:'move',resourceId:child.id,parentFolderId:a.id});
 let list=await f.orgs.personalLibrary(f.users.alice,f.tenant);assert.equal(list.folders.find(x=>x.id===child.legacyId).parentId,a.legacyId);assert.ok(!list.folders.some(x=>x.id===foreign.legacyId));
 const secret=randomBytes(32).toString('hex');await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Child',capability:'read',minutes:15,folderId:child.legacyId});
 const context=await new AgentWorkspace(f.resources,f.root).context(delegatedPrincipal(secret),f.tenant);assert.equal(context.folders.length,1);assert.equal(context.folders[0].parentId,null);
 await f.grant(foreign.id,'alice','manager',false,'bob');await f.mutate({action:'move',resourceId:child.id,parentFolderId:foreign.id});list=await f.orgs.personalLibrary(f.users.alice,f.tenant);assert.equal(list.folders.find(x=>x.id===child.legacyId).parentId,null);
 await f.orgs.withTenant(f.users.bob,f.tenant,c=>c.query('UPDATE lanka.resource_nodes SET deleted_at=now() WHERE tenant_id=$1 AND id=$2',[f.tenant,foreign.id]),true);assert.ok(!(await f.orgs.personalLibrary(f.users.alice,f.tenant)).folders.some(x=>x.id===child.legacyId));
});

test('shared copy requires current copy permission, strips private data and keeps an independent editable version',async t=>{
 const f=await fixture(t),original=await f.material(),copy=new OrganizationDocumentCopy(f.resources,f.root),title='Личная копия коллеги';
 const repo=f.ws('alice').repository(original.legacyId),project=await repo.read();project.state.doc.slides[0].notes='PRIVATE_NOTES';project.state.doc.slides[0].canvas=[{id:'visible',kind:'text',text:'Общий текст',x:100,y:100,w:600,h:100,size:32,lineHeight:1.2,bold:false,color:'#111111'}];project.state.doc.slides[0].body='PRIVATE_OLD_TEMPLATE';project.state.comments.push({id:randomUUID(),slideId:project.state.doc.slides[0].id,text:'PRIVATE_DISCUSSION',author:'Alice',createdAt:new Date().toISOString(),resolved:false});
 await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,original.legacyId,JSON.stringify(project)]);
 const request={requestId:randomUUID(),sourceDocumentId:original.legacyId,expectedRevision:1,title,folderId:null};
 await denied(()=>copy.copy(f.users.bob,f.tenant,request));await f.grant(original.id,'bob','viewer');await denied(()=>copy.copy(f.users.bob,f.tenant,request));await f.grant(original.id,'bob','viewer',true);
 await denied(()=>copy.copy(f.users.bob,f.tenant,{...request,expectedRevision:2}));
 const created=await copy.copy(f.users.bob,f.tenant,request);assert.equal(created.id,request.requestId);assert.deepEqual(await copy.copy(f.users.bob,f.tenant,request),created);
 const copied=await f.ws('bob').repository(created.id).read();assert.equal(copied.state.revision,1);assert.equal(copied.state.doc.slides[0].canvas[0].text,'Общий текст');assert.equal(copied.state.comments.length,0);assert.equal(copied.state.proposals.length,0);assert.equal(copied.state.doc.slides[0].body,'');assert.ok(!JSON.stringify(copied).includes('PRIVATE_'));assert.equal(copied.state.sources.length,1);assert.match(copied.state.sources[0].excerpt,/версия 1/);
 const blobs=await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2',[f.tenant,created.id]);assert.equal(blobs.rowCount,1);assert.ok(!blobs.rows[0].bytes.toString().includes('PRIVATE_'));
 assert.equal((await repo.read()).state.doc.slides[0].notes,'PRIVATE_NOTES');await assert.rejects(f.ws('alice').repository(created.id).read(),/Документ недоступен/);
 await f.grant(original.id,'bob','viewer',false);await denied(()=>copy.copy(f.users.bob,f.tenant,request));assert.equal((await f.ws('bob').repository(created.id).read()).title,title);
});

test('workspace agent can copy shared content only with create authority and both resources in scope',async t=>{
 const f=await fixture(t),a=await f.folder(),outside=await f.folder(),source=await f.material('bob'),copy=new OrganizationDocumentCopy(f.resources,f.root),keys=new AgentDelegations(f.resources);
 await f.grant(source.id,'alice','manager',true,'bob');await f.mutate({action:'move',resourceId:source.id,parentFolderId:a.id});
 const issue=async(capability,folderId)=>{const secret=randomBytes(32).toString('hex');const key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:capability,capability,minutes:15,...(folderId?{folderId}:{})});return {actor:delegatedPrincipal(secret),key};};
 const read=await issue('read',a.legacyId),create=await issue('create',a.legacyId),request={requestId:randomUUID(),sourceDocumentId:source.legacyId,expectedRevision:1,title:'Из общей презентации',folderId:a.legacyId};
 await denied(()=>copy.copy(read.actor,f.tenant,request));await denied(()=>copy.copy(create.actor,f.tenant,{...request,folderId:null}));await denied(()=>copy.copy(create.actor,f.tenant,{...request,folderId:outside.legacyId}));
 assert.equal((await new OrganizationDocumentView(f.resources).read(create.actor,f.tenant,source.legacyId)).permission.canCopy,true);
 const created=await copy.copy(create.actor,f.tenant,request);const createdNode=await f.node('material',created.id);await f.mutate({action:'move',resourceId:createdNode,parentFolderId:outside.id});await denied(()=>copy.copy(create.actor,f.tenant,request));
 await keys.revoke(f.users.alice,f.tenant,null,create.key.id);await denied(()=>copy.copy(create.actor,f.tenant,{...request,requestId:randomUUID()}));
});

test('shared copy preserves native data objects and visible images but never copies private source files',async t=>{
 const f=await fixture(t),copy=new OrganizationDocumentCopy(f.resources,f.root),input=JSON.parse(await readFile('tests/fixtures/structured-creation.json','utf8')),id=randomUUID();
 await f.ws('alice').mutate({requestId:id,command:{...input,action:'create_document'}});const node=await f.node('material',id),repo=f.ws('alice').repository(id),project=await repo.read();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG/8AAAAASUVORK5CYII=','base64'),hash=createHash('sha256').update(png).digest('hex'),privateBytes=Buffer.from('PRIVATE_SOURCE_BYTES'),privateHash=createHash('sha256').update(privateBytes).digest('hex');
 project.state.sources.push({id:'picture',name:'PRIVATE_FILENAME',kind:'image',sha256:hash,createdAt:new Date().toISOString(),contentType:'image/png',excerpt:'PRIVATE_IMAGE_DESCRIPTION'},{id:'private-doc',name:'PRIVATE_FILE',kind:'document',sha256:privateHash,createdAt:new Date().toISOString(),contentType:'text/plain',excerpt:'PRIVATE_EXCERPT'});
 const chartSlide=structuredClone(project.state.doc.slides[0]);chartSlide.id=randomUUID();chartSlide.layout='chart';chartSlide.title='Учебные данные';chartSlide.body='Условный пример';chartSlide.chart=[{label:'А',value:10},{label:'Б',value:20}];chartSlide.chartUnit='ед.';project.state.doc.slides.push(chartSlide);
 const slide=structuredClone(project.state.doc.slides[0]);slide.id=randomUUID();slide.canvas=[{id:'img',kind:'image',x:100,y:100,w:200,h:200,assetId:'picture'}];project.state.doc.slides.push(slide);
 await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,id,JSON.stringify(project)]);for(const [h,b] of [[hash,png],[privateHash,privateBytes]])await f.db.pool.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4)',[f.tenant,id,`materials/${h}.bin`,b]);
 await f.grant(node,'bob','viewer',true);const created=await copy.copy(f.users.bob,f.tenant,{requestId:randomUUID(),sourceDocumentId:id,expectedRevision:1,title:'Копия данных',folderId:null}),target=await f.ws('bob').repository(created.id).read();
 const objects=target.state.doc.slides.flatMap(s=>s.canvas);assert.ok(objects.some(e=>e.kind==='table'));assert.ok(objects.some(e=>e.kind==='chart'));assert.equal(target.state.sources.filter(s=>s.kind==='image').length,1);assert.ok(!JSON.stringify(target).includes('PRIVATE_'));
 const before=documentView(project,{role:'viewer',canCopy:true,isOwner:false}),after=documentView(target,{role:'viewer',canCopy:true,isOwner:true});assert.deepEqual(after.slides.flatMap(s=>s.items.filter(p=>p.kind==='text').map(p=>p.text)),before.slides.flatMap(s=>s.items.filter(p=>p.kind==='text').map(p=>p.text)));
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.tenant,created.id,`materials/${privateHash}.bin`])).rowCount,0);
 await f.db.pool.query('UPDATE lanka.blobs SET bytes=$4 WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.tenant,id,`materials/${hash}.bin`,Buffer.from('corrupt')]);const failedId=randomUUID();await denied(()=>copy.copy(f.users.bob,f.tenant,{requestId:failedId,sourceDocumentId:id,expectedRevision:1,title:'Bad image',folderId:null}));assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,failedId])).rowCount,0);
});

test('shared-folder delegation follows current group rights and excludes restricted or out-of-scope documents',async t=>{
 const f=await fixture(t),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),hidden=await f.material('alice',folder.legacyId),outside=await f.material(),group=randomUUID(),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),view=new OrganizationDocumentView(f.resources),comments=new OrganizationDocumentComments(f.resources);
 await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});await f.grant(outside.id,'bob','editor');
 await f.mutate({action:'group_set',id:group,name:'Project',status:'active'});await f.mutate({action:'group_member',groupId:group,principalId:f.principals.bob,present:true});await f.mutate({action:'grant',resourceId:folder.id,subject:{kind:'group',id:group},role:'editor',canCopy:false});
 const available=await keys.list(f.users.bob,f.tenant,null);assert.ok(available.sharedFolders.some(x=>x.id===folder.id&&x.role==='editor'));assert.ok(!available.folders.some(x=>x.id===folder.legacyId));
 const secret=randomBytes(32).toString('hex'),request={requestId:randomUUID(),secret,name:'Shared project',capability:'propose',minutes:15,folderResourceId:folder.id};const key=await keys.issue(f.users.bob,f.tenant,null,request),actor=delegatedPrincipal(secret);assert.equal(key.folderResourceId,folder.id);assert.deepEqual(key.capabilities,['read','comment','propose']);
 assert.deepEqual((await workspace.list(actor,f.tenant)).documents.map(x=>x.id),[doc.legacyId]);assert.equal((await workspace.context(actor,f.tenant)).canCreate,false);assert.ok((await workspace.context(actor,f.tenant)).sharedFolders.some(x=>x.id===folder.id));
 for(const d of [hidden,outside])await denied(()=>view.read(actor,f.tenant,d.legacyId));
 const p=await f.ws('alice').repository(doc.legacyId).read(),comment={requestId:randomUUID(),slideId:p.state.doc.slides[0].id,expectedRevision:1,text:'Уточнить вывод'};await comments.add(actor,f.tenant,doc.legacyId,comment);await new OrganizationDocumentProposals(f.resources).context(actor,f.tenant,doc.legacyId);
 for(const capability of ['create','organize'])await denied(()=>keys.issue(f.users.bob,f.tenant,null,{...request,requestId:randomUUID(),secret:randomBytes(32).toString('hex'),capability}));
 await f.mutate({action:'group_member',groupId:group,principalId:f.principals.bob,present:false});await denied(()=>workspace.context(actor,f.tenant));await denied(()=>comments.add(actor,f.tenant,doc.legacyId,comment));await denied(()=>keys.issue(f.users.bob,f.tenant,null,request));assert.equal((await keys.list(f.users.bob,f.tenant,null)).sharedFolders.length,0);
 // A direct document grant does not rescue a folder key whose anchor is no longer accessible.
 await f.grant(doc.id,'bob','editor');await denied(()=>view.read(actor,f.tenant,doc.legacyId));
});

test('shared-folder IDs are explicit and commenter keys do not acquire proposal or creation authority',async t=>{
 const f=await fixture(t),same=randomUUID(),own=await f.folder('bob',same),shared=await f.folder('alice',same),doc=await f.material('alice',shared.legacyId),keys=new AgentDelegations(f.resources);await f.grant(shared.id,'bob','commenter');await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});
 const secret=randomBytes(32).toString('hex'),input={requestId:randomUUID(),secret,name:'Comments',capability:'comment',minutes:15,folderResourceId:shared.id};const key=await keys.issue(f.users.bob,f.tenant,null,input);assert.equal(key.folderResourceId,shared.id);assert.notEqual(key.folderResourceId,own.id);
 await denied(()=>keys.issue(f.users.bob,f.tenant,null,{...input,requestId:randomUUID(),capability:'propose'}));await denied(()=>keys.issue(f.users.bob,f.other,null,input));await denied(()=>keys.issue(f.users.bob,f.tenant,doc.legacyId,input));assert.throws(()=>keys.issue(f.users.bob,f.tenant,null,{...input,folderId:same}),/Choose one folder identifier/);
 const actor=delegatedPrincipal(secret);await new OrganizationDocumentView(f.resources).read(actor,f.tenant,doc.legacyId);await denied(()=>new OrganizationDocumentProposals(f.resources).context(actor,f.tenant,doc.legacyId));await denied(()=>new AgentWorkspace(f.resources,f.root).create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_folder',name:'Denied'}}));
 await f.grant(shared.id,'bob',null);await denied(()=>new AgentWorkspace(f.resources,f.root).context(actor,f.tenant));
});

test('folder sharing uses reviewed ACL epochs and protects inherited and restricted documents',async t=>{
 const f=await fixture(t),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),hidden=await f.material('alice',folder.legacyId),sharing=new OrganizationDocumentSharing(f.resources,'folder'),views=new OrganizationDocumentView(f.resources);
 await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});
 await denied(()=>sharing.read(f.users.bob,f.tenant,folder.id));await denied(()=>sharing.search(f.users.bob,f.tenant,folder.id,'ali'));await denied(()=>sharing.read(f.users.alice,f.other,folder.id));await denied(()=>sharing.read(f.users.alice,f.tenant,doc.id));
 const snapshot=await sharing.read(f.users.alice,f.tenant,folder.id);const request={requestId:randomUUID(),expectedEpoch:snapshot.authzEpoch,subject:{kind:'principal',id:f.principals.bob},role:'editor',canCopy:false};
 await sharing.change(f.users.alice,f.tenant,folder.id,request);await views.read(f.users.bob,f.tenant,doc.legacyId);await denied(()=>views.read(f.users.bob,f.tenant,hidden.legacyId));await denied(()=>sharing.read(f.users.bob,f.tenant,folder.id));
 const stale={...request,requestId:randomUUID(),role:'viewer'};await assert.rejects(sharing.change(f.users.alice,f.tenant,folder.id,stale),e=>e.status===409);
 const current=await sharing.read(f.users.alice,f.tenant,folder.id);assert.ok(current.audience.some(p=>p.id===f.principals.bob&&p.role==='editor'));await sharing.change(f.users.alice,f.tenant,folder.id,{...request,requestId:randomUUID(),expectedEpoch:current.authzEpoch,role:null});await denied(()=>views.read(f.users.bob,f.tenant,doc.legacyId));
});

test('folder sharing API binds the selected folder and denies directory and writes to nonmanagers',async t=>{
 const f=await fixture(t),folder=await f.folder(),api=organizationApi(f.orgs,f.root),url=`https://qa.invalid/api/organizations/${f.tenant}/folder-sharing?resourceId=${folder.id}`;
 assert.equal((await api(new Request(url),f.users.bob)).status,404);const snap=await(await api(new Request(url),f.users.alice)).json();assert.equal(snap.audienceCount,1);
 const body={requestId:randomUUID(),expectedEpoch:snap.authzEpoch,subject:{kind:'principal',id:f.principals.bob},role:'viewer',canCopy:false};assert.equal((await api(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),f.users.alice)).status,200);
 assert.equal((await api(new Request(url),f.users.bob)).status,403);assert.equal((await api(new Request(url.replace('folder-sharing?','folder-sharing-subjects?')+'&search=ali'),f.users.bob)).status,403);
});

test('inheritance preview shows the resulting audience without applying access and preserves direct grants',async t=>{
 const f=await fixture(t),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),sharing=new OrganizationDocumentSharing(f.resources),views=new OrganizationDocumentView(f.resources);await f.grant(folder.id,'carol','editor');await f.grant(doc.id,'bob','viewer');
 const before=await sharing.read(f.users.alice,f.tenant,doc.legacyId);assert.deepEqual(before.inheritance,{mode:'restricted',hasParent:true,canInherit:true});
 const preview=await sharing.read(f.users.alice,f.tenant,doc.legacyId,'inherit');assert.equal(preview.audienceCount,3);assert.ok(preview.audience.some(p=>p.id===f.principals.carol&&p.role==='editor'));await denied(()=>views.read(f.users.carol,f.tenant,doc.legacyId));
 const request={action:'inheritance',requestId:randomUUID(),expectedEpoch:preview.authzEpoch,inheritance:'inherit'};const result=await sharing.change(f.users.alice,f.tenant,doc.legacyId,request);assert.deepEqual(await sharing.change(f.users.alice,f.tenant,doc.legacyId,request),result);await views.read(f.users.carol,f.tenant,doc.legacyId);
 const restricted=await sharing.read(f.users.alice,f.tenant,doc.legacyId,'restricted');assert.equal(restricted.audienceCount,2);assert.ok(restricted.audience.some(p=>p.id===f.principals.bob));
 await sharing.change(f.users.alice,f.tenant,doc.legacyId,{action:'inheritance',requestId:randomUUID(),expectedEpoch:restricted.authzEpoch,inheritance:'restricted'});await denied(()=>views.read(f.users.carol,f.tenant,doc.legacyId));await views.read(f.users.bob,f.tenant,doc.legacyId);
 await assert.rejects(sharing.change(f.users.alice,f.tenant,doc.legacyId,{...request,requestId:randomUUID()}),e=>e.status===409);
});

test('inheritance requires current parent management before preview and receipt replay',async t=>{
 const f=await fixture(t),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),rootDoc=await f.material(),sharing=new OrganizationDocumentSharing(f.resources);await f.grant(doc.id,'bob','manager');
 assert.equal((await sharing.read(f.users.bob,f.tenant,doc.legacyId)).inheritance.canInherit,false);await denied(()=>sharing.read(f.users.bob,f.tenant,doc.legacyId,'inherit'));await denied(()=>sharing.read(f.users.alice,f.tenant,rootDoc.legacyId,'inherit'));
 await f.grant(folder.id,'bob','manager');const preview=await sharing.read(f.users.bob,f.tenant,doc.legacyId,'inherit'),request={action:'inheritance',requestId:randomUUID(),expectedEpoch:preview.authzEpoch,inheritance:'inherit'};await sharing.change(f.users.bob,f.tenant,doc.legacyId,request);
 await f.grant(folder.id,'bob',null);await denied(()=>sharing.change(f.users.bob,f.tenant,doc.legacyId,request));
 const api=organizationApi(f.orgs,f.root),url=`https://qa.invalid/api/organizations/${f.tenant}/documents/${doc.legacyId}/sharing?inheritance=restricted`;const r=await api(new Request(url),f.users.alice);assert.equal(r.status,200);assert.equal((await r.json()).inheritance.mode,'restricted');
});

test('shared folder navigation lists immediate permitted contents and hides restricted descendants',async t=>{
 const f=await fixture(t),root=await f.folder(),child=await f.folder(),hidden=await f.folder(),views=new OrganizationDocumentView(f.resources);
 for(const folder of [child,hidden])await f.mutate({action:'move',resourceId:folder.id,parentFolderId:root.id});await f.mutate({action:'inheritance',resourceId:child.id,inheritance:'inherit'});
 const first=await f.material('alice',root.legacyId),nested=await f.material('alice',child.legacyId),privateDoc=await f.material('alice',root.legacyId),outside=await f.material();for(const doc of [first,nested])await f.mutate({action:'inheritance',resourceId:doc.id,inheritance:'inherit'});await f.grant(root.id,'bob','manager');await f.grant(outside.id,'bob','viewer');
 const all=await views.list(f.users.bob,f.tenant);assert.ok(all.folders.some(x=>x.id===root.id));assert.ok(all.folders.some(x=>x.id===child.id&&x.parentId===root.id));assert.ok(!all.folders.some(x=>x.id===hidden.id));
 const page=await views.list(f.users.bob,f.tenant,{folderResourceId:root.id});assert.equal(page.folder.role,'manager');assert.deepEqual(page.documents.map(d=>d.id),[first.legacyId]);assert.deepEqual((await views.list(f.users.bob,f.tenant,{folderResourceId:child.id})).documents.map(d=>d.id),[nested.legacyId]);await denied(()=>views.list(f.users.bob,f.tenant,{folderResourceId:hidden.id}));await denied(()=>views.list(f.users.bob,f.tenant,{folderResourceId:first.id}));
 const ownView=await views.list(f.users.alice,f.tenant,{folderResourceId:root.id});assert.ok(ownView.folders.some(x=>x.id===child.id));assert.ok(ownView.documents.some(x=>x.id===privateDoc.legacyId));
 await f.grant(root.id,'bob',null);await denied(()=>views.list(f.users.bob,f.tenant,{folderResourceId:root.id}));assert.equal((await views.list(f.users.bob,f.tenant)).folders.length,0);
});

test('folder listing filters cannot escape a delegated root or survive its revocation',async t=>{
 const f=await fixture(t),root=await f.folder(),outside=await f.folder(),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root);await f.grant(root.id,'bob','viewer');await f.grant(outside.id,'bob','viewer');
 const secret=randomBytes(32).toString('hex');await keys.issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Folder navigation',capability:'read',minutes:15,folderResourceId:root.id});const actor=delegatedPrincipal(secret);
 assert.equal((await workspace.list(actor,f.tenant,{folderResourceId:root.id})).folder.id,root.id);await denied(()=>workspace.list(actor,f.tenant,{folderResourceId:outside.id}));assert.deepEqual((await workspace.list(actor,f.tenant)).folders.map(f=>f.id),[root.id]);
 await f.grant(root.id,'bob',null);await denied(()=>workspace.list(actor,f.tenant,{folderResourceId:root.id}));
});

test('explicit shared creation owns new content, inherits access, and rejects legacy or out-of-scope keys',async t=>{
 const f=await fixture(t),folder=await f.folder(),outside=await f.folder(),keys=new AgentDelegations(f.resources),workspace=new AgentWorkspace(f.resources,f.root),views=new OrganizationDocumentView(f.resources);await f.grant(folder.id,'bob','manager');await f.grant(folder.id,'carol','viewer');await f.grant(outside.id,'bob','manager');
 const oldSecret=randomBytes(32).toString('hex');await keys.issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret:oldSecret,name:'Personal creator',capability:'create',minutes:15});
 const request={requestId:randomUUID(),command:{action:'create_document',title:'Team draft',folderId:null,folderResourceId:folder.id,profile:'focus-v3',empty:true}};
 await denied(()=>workspace.create(delegatedPrincipal(oldSecret),f.tenant,request));assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,request.requestId])).rowCount,0);
 const secret=randomBytes(32).toString('hex');await keys.issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Team creator',capability:'create_shared',minutes:15,folderResourceId:folder.id});const actor=delegatedPrincipal(secret);assert.equal((await workspace.context(actor,f.tenant)).canCreateShared,true);
 const created=await workspace.create(actor,f.tenant,request);assert.equal(created.inheritance,'inherit');assert.deepEqual(await workspace.create(actor,f.tenant,request),created);await views.read(f.users.carol,f.tenant,created.id);await f.orgs.personalProject(f.users.bob,f.tenant,created.id);await denied(()=>f.orgs.personalProject(f.users.carol,f.tenant,created.id));
 assert.ok((await f.orgs.personalLibrary(f.users.bob,f.tenant)).documents.find(d=>d.id===created.id).inSharedFolder);
 await denied(()=>workspace.create(actor,f.tenant,{...request,requestId:randomUUID(),command:{...request.command,folderResourceId:outside.id}}));await denied(()=>workspace.create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_document',title:'Private',folderId:null,empty:true}}));
 const child=await workspace.create(actor,f.tenant,{requestId:randomUUID(),command:{action:'create_folder',name:'Nested team',parentFolderResourceId:folder.id}});const childNode=(await f.db.pool.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND owner_id=$2 AND folder_id=$3',[f.tenant,f.principals.bob,child.id])).rows[0].id;
 const nested=await workspace.create(actor,f.tenant,{...request,requestId:randomUUID(),command:{...request.command,folderResourceId:childNode}});await views.read(f.users.carol,f.tenant,nested.id);assert.ok((await views.list(f.users.bob,f.tenant,{folderResourceId:folder.id})).folders.some(x=>x.id===childNode&&x.parentId===folder.id));
 await f.grant(folder.id,'bob',null);await denied(()=>workspace.create(actor,f.tenant,request));await denied(()=>workspace.create(f.users.bob,f.tenant,request));await f.orgs.personalProject(f.users.bob,f.tenant,created.id);
});

test('shared creation issuance and browser endpoint require explicit destination management',async t=>{
 const f=await fixture(t),folder=await f.folder(),keys=new AgentDelegations(f.resources),api=organizationApi(f.orgs,f.root);await f.grant(folder.id,'bob','editor');
 const issue={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Denied creator',capability:'create_shared',minutes:15,folderResourceId:folder.id};await denied(()=>keys.issue(f.users.bob,f.tenant,null,issue));await denied(async()=>keys.issue(f.users.alice,f.tenant,null,{...issue,folderResourceId:undefined}));
 const url=`https://qa.invalid/api/organizations/${f.tenant}/shared-create`,request={requestId:randomUUID(),command:{action:'create_document',title:'UI team',folderId:null,folderResourceId:folder.id,empty:true,profile:'focus-v3'}},send=user=>api(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}),user);
 assert.equal((await send(f.users.bob)).status,403);await f.grant(folder.id,'bob','manager');assert.equal((await send(f.users.bob)).status,200);await new OrganizationDocumentView(f.resources).read(f.users.alice,f.tenant,request.requestId);
 // Legacy folder_id is null for a foreign parent; moving to personal root must still detach the canonical parent.
 await new OrganizationWorkspace(f.orgs,f.users.bob,f.tenant,f.root).mutate({requestId:randomUUID(),command:{action:'move_document',id:request.requestId,folderId:null}});
 assert.equal((await f.db.pool.query('SELECT parent_folder_id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[f.tenant,request.requestId])).rows[0].parent_folder_id,null);await denied(()=>new OrganizationDocumentView(f.resources).read(f.users.alice,f.tenant,request.requestId));
});

test('document reactions are actor-scoped, retry-safe and never grant access',async t=>{
 const f=await fixture(t),doc=await f.material(),api=organizationApi(f.orgs,f.root),view=new OrganizationDocumentView(f.resources),url='http://local/api/organizations/'+f.tenant+'/documents/'+doc.legacyId+'/reactions';
 const get=name=>api(new Request(url),f.users[name]);const set=(name,command)=>api(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command)}),f.users[name]);
 assert.equal((await get('bob')).status,404);await f.grant(doc.id,'bob','viewer');await f.grant(doc.id,'carol','viewer');
 const initial=await f.orgs.withTenant(f.users.alice,f.tenant,async(c,ctx)=>ctx.authzEpoch);
 const like={requestId:randomUUID(),kind:'like',active:true};const responses=await Promise.all([set('bob',like),set('bob',like)]);for(const r of responses)assert.equal(r.status,200);
 assert.deepEqual(await (await get('bob')).json(),{likes:1,liked:true,bookmarked:false});assert.deepEqual(await (await get('carol')).json(),{likes:1,liked:false,bookmarked:false});
 assert.equal((await set('bob',{requestId:randomUUID(),kind:'bookmark',active:true})).status,200);
 assert.equal((await view.list(f.users.bob,f.tenant,{bookmarked:true})).documents[0].id,doc.legacyId);assert.equal((await view.list(f.users.carol,f.tenant,{bookmarked:true})).documents.length,0);
 assert.equal((await set('bob',{...like,active:false})).status,409);
 await set('bob',{requestId:randomUUID(),kind:'like',active:false});await set('bob',like);assert.equal((await (await get('bob')).json()).likes,0,'old receipt must not reapply after unlike');
 assert.equal(await f.orgs.withTenant(f.users.alice,f.tenant,async(c,ctx)=>ctx.authzEpoch),initial,'reactions do not change authorization epoch');
 const secret=randomBytes(32).toString('hex');await new AgentDelegations(f.resources).issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Reaction privacy test',capability:'read',minutes:10});const agent=delegatedPrincipal(secret);
 assert.ok((await view.list(agent,f.tenant)).documents.every(d=>!('reactions' in d)));await denied(()=>view.list(agent,f.tenant,{bookmarked:true}));assert.equal((await api(new Request(url),agent)).status,403);
 const personal=await f.orgs.personalLibrary(f.users.alice,f.tenant);assert.equal(personal.documents.find(d=>d.id===doc.legacyId).reactions.bookmarked,false);
 await f.grant(doc.id,'bob',null);assert.equal((await get('bob')).status,404);assert.equal((await set('bob',like)).status,404);assert.equal((await view.list(f.users.bob,f.tenant,{bookmarked:true})).documents.length,0);
 const row=await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId]);assert.equal(row.rows[0].project.state.revision,1);
});

test('cover exposes only the first visible scene, binds revision and rechecks current access',async t=>{
 const f=await sharedFixture(t),api=organizationApi(f.orgs,f.root),base='http://local/api/organizations/'+f.tenant+'/documents/'+f.doc.legacyId;
 const second=structuredClone(f.project.state.doc.slides[0]);second.id=randomUUID();second.canvas=[{...structuredClone(f.project.state.doc.slides[0].canvas[0]),id:randomUUID(),text:'SECOND_SLIDE_ONLY'}];f.project.state.doc.slides.push(second);
 await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,f.doc.legacyId,f.project]);
 assert.equal((await api(new Request(base+'/cover?revision=1'),f.users.bob)).status,404);await f.grant(f.doc.id,'bob','viewer');
 const response=await api(new Request(base+'/cover?revision=1'),f.users.bob);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const cover=await response.json();
 assert.deepEqual(Object.keys(cover).sort(),['format','height','id','revision','slide','title','width']);assert.deepEqual(Object.keys(cover.slide).sort(),['id','items','label']);
 assert.doesNotMatch(JSON.stringify(cover),/PRIVATE_|SECOND_SLIDE_ONLY|targets|sourceField|receipts/);assert.match(JSON.stringify(cover),/Visible current text/);assert.deepEqual(cover.slide.items,(await f.view.read(f.users.bob,f.tenant,f.doc.legacyId)).slides[0].items);
 assert.equal((await api(new Request(base+'/cover'),f.users.bob)).status,400);assert.equal((await api(new Request(base+'/cover?revision=2'),f.users.bob)).status,409);
 await f.grant(f.doc.id,'bob',null);assert.equal((await api(new Request(base+'/cover?revision=1'),f.users.bob)).status,404);await denied(()=>f.view.asset(f.users.bob,f.tenant,f.doc.legacyId,'visible',1));
 const template=await f.material();const project=await f.ws('alice').repository(template.legacyId).read();project.state.doc.slides.push({...structuredClone(project.state.doc.slides[0]),id:randomUUID()});
 assert.deepEqual(documentView(project,{role:'manager',canCopy:true,isOwner:true},{firstOnly:true}).slides[0],documentView(project,{role:'manager',canCopy:true,isOwner:true}).slides[0],'cover keeps full deck numbering and composition');
});


test('workspace sessions precede documents, preserve request identity and hide revoked references',async t=>{
 const f=await fixture(t),svc=new WorkspaceSessions(f.resources),id=randomUUID(),request={requestId:id,title:'Стратегия'};
 assert.deepEqual(await svc.create(f.users.bob,f.tenant,request),{id});
 assert.deepEqual(await svc.create(f.users.bob,f.tenant,request),{id});
 assert.equal((await svc.read(f.users.bob,f.tenant,id)).documents.length,0);
 await denied(()=>svc.create(f.users.bob,f.tenant,{...request,title:'Другой запрос'}));
 await denied(()=>svc.read(f.users.alice,f.tenant,id));
 await denied(()=>svc.create(f.users.alice,f.tenant,request));
 const own=await f.material('bob'),shared=await f.material(),hidden=await f.material();
 await f.grant(shared.id,'bob','viewer');
 await svc.link(f.users.bob,f.tenant,id,own.legacyId);await svc.link(f.users.bob,f.tenant,id,shared.legacyId);await svc.link(f.users.bob,f.tenant,id,own.legacyId);
 await denied(()=>svc.link(f.users.bob,f.tenant,id,hidden.legacyId));
 let view=await svc.read(f.users.bob,f.tenant,id);assert.equal(view.documents.length,2);assert.equal(view.connectionStatus,'not_bound');assert.equal(view.scope,'workspace');
 assert.deepEqual(Object.keys(view.documents[0]).sort(),['id','revision','title']);
 await f.grant(shared.id,'bob',null);view=await svc.read(f.users.bob,f.tenant,id);assert.deepEqual(view.documents.map(d=>d.id),[own.legacyId]);assert.equal(view.unavailableDocumentCount,1);
 const conn=await f.db.pool.query("SELECT enabled FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2 AND id='external-mcp'",[f.tenant,f.principals.bob]);assert.equal(conn.rows[0].enabled,false);
});

test('folder sessions enforce current ancestry and folder authority',async t=>{
 const f=await fixture(t),svc=new WorkspaceSessions(f.resources),folder=await f.folder(),inside=await f.material('alice',folder.legacyId),outside=await f.material(),id=randomUUID();
 await f.grant(folder.id,'bob','viewer');await f.grant(inside.id,'bob','viewer');await f.grant(outside.id,'bob','viewer');
 await svc.create(f.users.bob,f.tenant,{requestId:id,title:'Проект',folderResourceId:folder.id});
 await svc.link(f.users.bob,f.tenant,id,inside.legacyId);await denied(()=>svc.link(f.users.bob,f.tenant,id,outside.legacyId));
 await f.mutate({action:'move',resourceId:inside.id,parentFolderId:null});
 const v=await svc.read(f.users.bob,f.tenant,id);assert.equal(v.documents.length,0);assert.equal(v.unavailableDocumentCount,1);
 await f.grant(folder.id,'bob',null);await denied(()=>svc.read(f.users.bob,f.tenant,id));
 await denied(()=>svc.create(f.users.bob,f.tenant,{requestId:id,title:'Проект',folderResourceId:folder.id}));
});

test('MCP mailbox requires explicit binding, serializes retries and preserves role and cancellation',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),keys=new AgentDelegations(f.resources),sid=randomUUID();
 await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Дека из чата'});
 const secret=randomBytes(32).toString('hex'),key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Мой агент',capability:'read',minutes:15}),actor=delegatedPrincipal(secret);
 const msg={requestId:randomUUID(),text:'Предложи сценарий'};
 const [one,two]=await Promise.all([b.send(f.users.alice,f.tenant,sid,msg),b.send(f.users.alice,f.tenant,sid,msg)]);assert.deepEqual(one,two);
 assert.equal((await b.list(actor,f.tenant)).sessions.length,0);await denied(()=>b.read(actor,f.tenant,sid));
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null});
 assert.equal((await b.list(actor,f.tenant)).sessions.length,1);
 await denied(()=>b.read(f.users.bob,f.tenant,sid));
 await denied(async()=>b.send(actor,f.tenant,sid,{requestId:randomUUID(),text:'Impersonate'}));
 const [r1,r2]=await Promise.all([b.receive(actor,f.tenant,sid),b.receive(actor,f.tenant,sid)]);assert.deepEqual(r1,r2);assert.equal(r1.message.id,msg.requestId);assert.equal(r1.message.delivery,'received_by_mcp_client');
 const answer={requestId:randomUUID(),replyTo:msg.requestId,text:'Вот сценарий'};
 const [a1,a2]=await Promise.all([b.reply(actor,f.tenant,sid,answer),b.reply(actor,f.tenant,sid,answer)]);assert.deepEqual(a1,a2);
 await denied(()=>b.reply(actor,f.tenant,sid,{...answer,text:'Подмена'}));
 const view=await b.read(f.users.alice,f.tenant,sid);assert.equal(view.messages.length,2);assert.equal(view.messages[1].role,'assistant');assert.equal(view.messages[1].origin,'mcp');assert.equal(view.messages[1].actorId,key.id);
 assert.equal((await b.read(actor,f.tenant,sid,{after:view.nextCursor})).messages.length,0);
 const next={requestId:randomUUID(),text:'Продолжи'};await b.send(f.users.alice,f.tenant,sid,next);await b.receive(actor,f.tenant,sid);
 await b.cancel(f.users.alice,f.tenant,sid,next.requestId);await denied(()=>b.reply(actor,f.tenant,sid,{requestId:randomUUID(),replyTo:next.requestId,text:'Поздно'}));
 await keys.revoke(f.users.alice,f.tenant,null,key.id);await denied(()=>b.read(actor,f.tenant,sid));await denied(()=>b.reply(actor,f.tenant,sid,answer));
 assert.equal((await b.read(f.users.alice,f.tenant,sid)).binding.active,false);
});

test('binding matches issuer and exact folder scope and cannot be replaced by a stale command',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),keys=new AgentDelegations(f.resources),sid=randomUUID(),folder=await f.folder();
 await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Обсуждение',folderResourceId:folder.id});
 const issue=async(name,folderResourceId)=>keys.issue(f.users[name],f.tenant,null,{requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Key',capability:'read',minutes:15,...(folderResourceId?{folderResourceId}:{})});
 const wide=await issue('alice'),foreign=await issue('bob'),first=await issue('alice',folder.id),second=await issue('alice',folder.id);
 await denied(()=>b.bind(f.users.alice,f.tenant,sid,{delegationId:wide.id,expectedDelegationId:null}));await denied(()=>b.bind(f.users.alice,f.tenant,sid,{delegationId:foreign.id,expectedDelegationId:null}));
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:first.id,expectedDelegationId:null});
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:second.id,expectedDelegationId:first.id});
 await denied(()=>b.bind(f.users.alice,f.tenant,sid,{delegationId:first.id,expectedDelegationId:null}));
 assert.equal((await b.read(f.users.alice,f.tenant,sid)).binding.id,second.id);
});

test('browser API to independent HTTP MCP mailbox round trip persists reply and rejects revoked key',async t=>{
 const f=await fixture(t),api=organizationApi(f.orgs,f.root),sid=randomUUID(),path=`https://lanka.test/api/organizations/${f.tenant}/conversations`;
 const post=(url,value)=>api(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),f.users.alice);
 assert.equal((await post(path,{requestId:sid,title:'История цивилизаций'})).status,200);
 const secret=randomBytes(32).toString('hex'),keys=new AgentDelegations(f.resources),key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Wire mailbox',capability:'read',minutes:15});
 assert.equal((await post(path+'/'+sid,{action:'bind',delegationId:key.id,expectedDelegationId:null})).status,200);
 const mid=randomUUID();assert.equal((await post(path+'/'+sid,{action:'send',requestId:mid,text:'Предложи структуру из 6 слайдов'})).status,200);
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
 const wire=(method,params={})=>fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const call=async(name,args={})=>{const r=await(await wire('tools/call',{name,arguments:args})).json();assert.notEqual(r.result?.isError,true);return JSON.parse(r.result.content[0].text);};
 assert.equal((await call('lanka_list_conversations')).sessions[0].id,sid);
 assert.equal((await call('lanka_receive_message',{sessionId:sid})).message.id,mid);
 await call('lanka_reply_message',{sessionId:sid,requestId:randomUUID(),replyTo:mid,text:'Города, письмо, торговля, государства, знания, связи.'});
 const view=await(await api(new Request(path+'/'+sid),f.users.alice)).json();assert.equal(view.messages.length,2);assert.match(view.messages[1].text,/Города/);
 await keys.revoke(f.users.alice,f.tenant,null,key.id);assert.equal((await wire('tools/list')).status,401);
});

test('mailbox results validate documents and proposals atomically, expose live status and hide revoked metadata',async t=>{
 const f=await fixture(t),sessions=new WorkspaceSessions(f.resources),bridge=new AgentBridge(f.resources),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources),sid=randomUUID();
 await sessions.create(f.users.bob,f.tenant,{requestId:sid,title:'Результаты беседы'});
 const secret=randomBytes(32).toString('hex'),key=await keys.issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Автор правок',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);
 await bridge.bind(f.users.bob,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null});
 const doc=await f.material(),hidden=await f.material();await f.grant(doc.id,'bob','editor');
 const context=await proposals.context(actor,f.tenant,doc.legacyId);
 const proposal=await proposals.create(actor,f.tenant,doc.legacyId,{requestId:randomUUID(),expectedRevision:context.revision,title:'Уточнить название',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Цивилизации и города'}]});
 const message=await bridge.send(f.users.bob,f.tenant,sid,{requestId:randomUUID(),text:'Предложи правку'});await bridge.receive(actor,f.tenant,sid);
 const request={requestId:randomUUID(),replyTo:message.id,text:'Предлагаю правку',results:[{documentId:doc.legacyId,revision:context.revision,proposalId:proposal.proposalId}]};
 await denied(()=>bridge.reply(actor,f.tenant,sid,{...request,results:[...request.results,{documentId:hidden.legacyId,revision:1}]}));
 assert.equal((await bridge.read(f.users.bob,f.tenant,sid)).messages.length,1);
 assert.equal((await sessions.read(f.users.bob,f.tenant,sid)).documents.length,0);
 await denied(()=>bridge.reply(actor,f.tenant,sid,{...request,results:[{...request.results[0],revision:999}]}));
 await bridge.reply(actor,f.tenant,sid,request);await bridge.reply(actor,f.tenant,sid,request);
 let view=await bridge.read(actor,f.tenant,sid),result=view.messages[1].results[0];
 assert.equal(result.documentId,doc.legacyId);assert.equal(result.proposalStatus,'pending');assert.match(result.url,new RegExp('review='+proposal.proposalId));
 assert.equal((await sessions.read(f.users.bob,f.tenant,sid)).documents.length,1);
 const api=organizationApi(f.orgs,f.root),accepted=await api(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:context.revision,command:{action:'accept',proposalId:proposal.proposalId,changeIds:proposal.changes.map(c=>c.id)}})}),f.users.alice);assert.equal(accepted.status,200);
 result=(await bridge.read(actor,f.tenant,sid)).messages[1].results[0];assert.equal(result.proposalStatus,'closed');assert.equal(result.revision,context.revision);assert.equal(result.currentRevision,context.revision+1);
 await f.grant(doc.id,'bob',null);view=await bridge.read(f.users.bob,f.tenant,sid);assert.deepEqual(view.messages[1].results,[{available:false}]);
 assert.equal(JSON.stringify(view.messages[1].results).includes(doc.legacyId),false);
});

test('mailbox cannot claim another key proposal or return a folder-external result',async t=>{
 const f=await fixture(t),bridge=new AgentBridge(f.resources),sessions=new WorkspaceSessions(f.resources),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources),folder=await f.folder(),doc=await f.material('alice',folder.legacyId),outside=await f.material(),sid=randomUUID();
 await sessions.create(f.users.alice,f.tenant,{requestId:sid,title:'Папочная беседа',folderResourceId:folder.id});
 const secrets=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],ks=[];
 for(const secret of secrets)ks.push(await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Agent',capability:'propose',minutes:15,folderResourceId:folder.id}));
 const actors=secrets.map(delegatedPrincipal);await bridge.bind(f.users.alice,f.tenant,sid,{delegationId:ks[0].id,expectedDelegationId:null});
 const context=await proposals.context(actors[1],f.tenant,doc.legacyId),proposal=await proposals.create(actors[1],f.tenant,doc.legacyId,{requestId:randomUUID(),expectedRevision:context.revision,title:'Другой автор',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Первые города'}]});
 const msg=await bridge.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Создай результат'});await bridge.receive(actors[0],f.tenant,sid);
 const reply={requestId:randomUUID(),replyTo:msg.id,text:'Результат'};
 await denied(()=>bridge.reply(actors[0],f.tenant,sid,{...reply,results:[{documentId:doc.legacyId,revision:context.revision,proposalId:proposal.proposalId}]}));
 await denied(()=>bridge.reply(actors[0],f.tenant,sid,{...reply,results:[{documentId:outside.legacyId,revision:1}]}));
 await bridge.reply(actors[0],f.tenant,sid,{...reply,results:[{documentId:doc.legacyId,revision:context.revision}]});
 await f.mutate({action:'move',resourceId:doc.id,parentFolderId:null});
 assert.deepEqual((await bridge.read(f.users.alice,f.tenant,sid)).messages[1].results,[{available:false}]);
});

test('editor conversation discovery is document-filtered and private; MCP receipt carries only permitted document context',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),keys=new AgentDelegations(f.resources),one=await f.material(),two=await f.material(),a=randomUUID(),other=randomUUID();
 for(const id of [a,other])await s.create(f.users.alice,f.tenant,{requestId:id,title:'Private conversation'});
 await s.link(f.users.alice,f.tenant,a,one.legacyId);await s.link(f.users.alice,f.tenant,other,two.legacyId);
 const api=organizationApi(f.orgs,f.root),url=`https://lanka.test/api/organizations/${f.tenant}/conversations?documentId=${one.legacyId}`;
 assert.deepEqual((await(await api(new Request(url),f.users.alice)).json()).sessions.map(x=>x.id),[a]);
 await f.grant(one.id,'bob','editor');assert.equal((await b.list(f.users.bob,f.tenant,{documentId:one.legacyId})).sessions.length,0);
 const secret=randomBytes(32).toString('hex'),key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Editor client',capability:'read',minutes:15}),actor=delegatedPrincipal(secret);
 await b.bind(f.users.alice,f.tenant,a,{delegationId:key.id,expectedDelegationId:null});
 await b.send(f.users.alice,f.tenant,a,{requestId:randomUUID(),text:'Посмотри эту презентацию'});
 const received=await b.receive(actor,f.tenant,a);assert.deepEqual(received.documents,[{id:one.legacyId,title:'Document',revision:1}]);
 assert.equal((await b.read(actor,f.tenant,a)).session.id,a);assert.equal((await b.list(actor,f.tenant,{documentId:two.legacyId})).sessions.length,0);
 await f.grant(two.id,'bob',null);await denied(()=>b.list(f.users.bob,f.tenant,{documentId:two.legacyId}));
});

test('message selection freezes its revision, survives identical retry and hides addresses after access revocation',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID();
 await f.grant(doc.id,'bob','editor');await s.create(f.users.bob,f.tenant,{requestId:sid,title:'Точный контекст'});await s.link(f.users.bob,f.tenant,sid,doc.legacyId);
 const p=(await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId])).rows[0].project;
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Selection',capability:'read',minutes:15}),actor=delegatedPrincipal(secret);
 await b.bind(f.users.bob,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null});
 const input={requestId:randomUUID(),text:'Уточни этот заголовок',selection:{documentId:doc.legacyId,revision:p.state.revision,slideId:p.state.doc.slides[0].id,field:'title'}};
 await b.send(f.users.bob,f.tenant,sid,input);await b.send(f.users.bob,f.tenant,sid,input);
 await denied(()=>b.send(f.users.bob,f.tenant,sid,{...input,selection:{...input.selection,field:'body'}}));
 const received=await b.receive(actor,f.tenant,sid);assert.deepEqual(received.message.selection,{available:true,...input.selection,currentRevision:p.state.revision,stale:false,targetExists:true});
 p.state.revision++;await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,p]);
 const stale=(await b.receive(actor,f.tenant,sid)).message.selection;assert.equal(stale.stale,true);assert.equal(stale.revision,input.selection.revision);assert.equal(stale.currentRevision,p.state.revision);
 await f.grant(doc.id,'bob',null);
 assert.deepEqual((await b.receive(actor,f.tenant,sid)).message.selection,{available:false});assert.deepEqual((await b.read(f.users.bob,f.tenant,sid)).messages[0].selection,{available:false});
});

test('selection rejects missing, stale or unlinked targets atomically and supports exact canvas objects',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID();await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Объекты'});
 const p=(await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId])).rows[0].project,slide=p.state.doc.slides[0];
 const selection={documentId:doc.legacyId,revision:p.state.revision,slideId:slide.id},send=selection=>b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Измени это',selection});
 await denied(()=>send(selection));await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 await denied(()=>send({...selection,revision:999}));await denied(()=>send({...selection,slideId:'missing'}));await denied(()=>send({...selection,elementId:'missing'}));
 assert.equal((await b.read(f.users.alice,f.tenant,sid)).messages.length,0);
 slide.canvas=[{id:'shape-one',kind:'rect',x:0,y:0,w:100,h:100,fill:'#ffffff'}];await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,p]);
 await denied(()=>send({...selection,field:'title'}));
 await send({...selection,elementId:'shape-one'});
 slide.canvas=[];p.state.revision++;await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,p]);
 const view=await b.read(f.users.alice,f.tenant,sid);assert.equal(view.messages[0].selection.targetExists,false);assert.equal(view.messages[0].selection.stale,true);
});

test('task-bound delegation requires a received instruction and fences writes after cancellation or reply',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID(),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources);
 await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Поручения'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Task agent',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 const context=await proposals.context(actor,f.tenant,doc.legacyId),command={requestId:randomUUID(),expectedRevision:context.revision,title:'Уточнение',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Письмо и города'}]};
 await denied(()=>proposals.create(actor,f.tenant,doc.legacyId,command));
 const msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Предложи заголовок',task:{mode:'propose',documentId:doc.legacyId}}),scoped={...actor,task:{sessionId:sid,messageId:msg.id}};
 await denied(()=>proposals.create(scoped,f.tenant,doc.legacyId,command));await b.receive(actor,f.tenant,sid);
 const result=await proposals.create(scoped,f.tenant,doc.legacyId,command);assert.ok(result.proposalId);
 await b.cancel(f.users.alice,f.tenant,sid,msg.id);await denied(()=>proposals.create(scoped,f.tenant,doc.legacyId,command));
 assert.ok((await proposals.preview(actor,f.tenant,doc.legacyId,result.proposalId)).after);
 const msg2=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Ещё вариант',task:{mode:'propose',documentId:doc.legacyId}}),scoped2={...actor,task:{sessionId:sid,messageId:msg2.id}};await b.receive(actor,f.tenant,sid);
 await b.reply(actor,f.tenant,sid,{requestId:randomUUID(),replyTo:msg2.id,text:'Обсудили'});await denied(()=>proposals.create(scoped2,f.tenant,doc.legacyId,{...command,requestId:randomUUID()}));
 assert.equal((await b.read(f.users.alice,f.tenant,sid)).binding.taskBound,true);
});

test('discussion cannot write; task cannot escape its document or borrow another binding; restriction survives rebinding',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),other=await f.material(),sid=randomUUID(),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources);
 await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Область'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);await s.link(f.users.alice,f.tenant,sid,other.legacyId);
 const secrets=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')],actors=secrets.map(delegatedPrincipal),ks=[];for(const secret of secrets)ks.push(await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Agent',capability:'propose',minutes:15}));
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:ks[0].id,expectedDelegationId:null,taskBound:true});
 const c=await proposals.context(actors[0],f.tenant,doc.legacyId),request={requestId:randomUUID(),expectedRevision:c.revision,title:'Изменение',commands:[{op:'set_title',slideId:c.slides[0].id,value:'Письмо'}]};
 let msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Обсудим',task:{mode:'discuss',documentId:doc.legacyId}});await b.receive(actors[0],f.tenant,sid);
 await denied(()=>proposals.create({...actors[0],task:{sessionId:sid,messageId:msg.id}},f.tenant,doc.legacyId,request));await b.cancel(f.users.alice,f.tenant,sid,msg.id);
 msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Измени другой документ',task:{mode:'propose',documentId:other.legacyId}});await b.receive(actors[0],f.tenant,sid);
 for(const actor of actors)await denied(()=>proposals.create({...actor,task:{sessionId:sid,messageId:msg.id}},f.tenant,doc.legacyId,request));
 await b.cancel(f.users.alice,f.tenant,sid,msg.id);await b.bind(f.users.alice,f.tenant,sid,{delegationId:ks[1].id,expectedDelegationId:ks[0].id});
 await denied(()=>proposals.create(actors[0],f.tenant,doc.legacyId,request));
});

test('HTTP MCP task metadata authorizes the received document proposal and rejects a late write',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID(),keys=new AgentDelegations(f.resources);
 await s.create(f.users.alice,f.tenant,{requestId:sid,title:'HTTP task'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await keys.issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'HTTP agent',capability:'propose',minutes:15});await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 const msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Уточни заголовок',task:{mode:'propose',documentId:doc.legacyId}});
 const origin='http://127.0.0.1:49999',app=createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'});
 const call=async(name,args,task)=>{const r=await app(new Request(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,...(task?{_meta:{lankaTask:task}}:{})}})}));return (await r.json()).result;};
 const context=JSON.parse((await call('lanka_get_edit_context',{documentId:doc.legacyId})).content[0].text),args={documentId:doc.legacyId,requestId:randomUUID(),expectedRevision:context.revision,title:'Заголовок',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Письмо и обмен'}]};
 assert.equal((await call('lanka_propose_commands',args)).isError,true);
 await call('lanka_receive_message',{sessionId:sid});const task={sessionId:sid,messageId:msg.id};
 assert.notEqual((await call('lanka_propose_commands',args,task)).isError,true);
 await b.cancel(f.users.alice,f.tenant,sid,msg.id);assert.equal((await call('lanka_propose_commands',args,task)).isError,true);
});

test('cancel waits for the authorized write transaction and fences the next write',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),sid=randomUUID(),doc=await f.material();await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Race'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Race',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 const m=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Правка',task:{mode:'propose',documentId:doc.legacyId}});await b.receive(actor,f.tenant,sid);
 const scoped={...actor,task:{sessionId:sid,messageId:m.id}};let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const write=f.orgs.withTenant(scoped,f.tenant,async()=>{entered();await gate;return 'committed';},false,{documentId:doc.legacyId,capability:'propose',write:true});await started;
 const cancel=b.cancel(f.users.alice,f.tenant,sid,m.id);let waiting=false;
 try{for(let i=0;i<100;i++){const r=await f.db.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE lanka.agent_bridge_messages SET delivery=%' AND pid<>pg_backend_pid()");if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);}finally{release();await write;await cancel;}
 await denied(()=>f.orgs.withTenant(scoped,f.tenant,async()=>{},false,{documentId:doc.legacyId,capability:'propose',write:true}));
});

test('task journal and receipt hide a revoked document address without losing the instruction mode',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID();await f.grant(doc.id,'bob','editor');await s.create(f.users.bob,f.tenant,{requestId:sid,title:'Приватный адрес'});await s.link(f.users.bob,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Reader',capability:'read',minutes:15}),actor=delegatedPrincipal(secret);await b.bind(f.users.bob,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 await b.send(f.users.bob,f.tenant,sid,{requestId:randomUUID(),text:'Посмотри',task:{mode:'discuss',documentId:doc.legacyId}});await f.grant(doc.id,'bob',null);
 assert.deepEqual((await b.read(f.users.bob,f.tenant,sid)).messages[0].task,{mode:'discuss',available:false});assert.deepEqual((await b.receive(actor,f.tenant,sid)).message.task,{mode:'discuss',available:false});
});

test('selected-field task rejects neighboring fields and stale revisions, including receipt reuse',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),p=new OrganizationDocumentProposals(f.resources),doc=await f.material(),sid=randomUUID();await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Поле'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Scoped editor',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);
 const ctx=await p.context(actor,f.tenant,doc.legacyId),slide=ctx.slides[0],base={documentId:doc.legacyId,revision:ctx.revision,slideId:slide.id,field:'title'};
 const broad={requestId:randomUUID(),expectedRevision:ctx.revision,title:'Основной текст',commands:[{op:'set_body',slideId:slide.id,value:'Другой текст'}]};await p.create(actor,f.tenant,doc.legacyId,broad);
 await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 await denied(()=>b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Ошибка',task:{mode:'propose',documentId:doc.legacyId,limitToSelection:true}}));
 const msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Уточни заголовок',selection:base,task:{mode:'propose',documentId:doc.legacyId,limitToSelection:true}});await b.receive(actor,f.tenant,sid);const scoped={...actor,task:{sessionId:sid,messageId:msg.id}};
 await denied(()=>p.create(scoped,f.tenant,doc.legacyId,broad));
 await denied(()=>p.create(scoped,f.tenant,doc.legacyId,{...broad,requestId:randomUUID(),commands:[{op:'set_title',slideId:slide.id,value:'Первые города'},{op:'set_body',slideId:slide.id,value:'Подмена'}]}));
 const good={...broad,requestId:randomUUID(),commands:[{op:'set_title',slideId:slide.id,value:'Письмо и обмен'}]};await p.create(scoped,f.tenant,doc.legacyId,good);
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,revision}',to_jsonb($3::integer)) WHERE tenant_id=$1 AND id=$2",[f.tenant,doc.legacyId,ctx.revision+1]);
 await denied(()=>p.create(scoped,f.tenant,doc.legacyId,{...good,requestId:randomUUID(),expectedRevision:ctx.revision+1}));
});

test('canvas task allows its object but rejects neighbor edits, additions and another slide atomically',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),p=new OrganizationDocumentProposals(f.resources),doc=await f.material(),sid=randomUUID();await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Объект'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const project=(await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId])).rows[0].project,slide=project.state.doc.slides[0];
 slide.canvas=[{id:'a',kind:'text',x:100,y:150,w:1100,h:180,text:'Письмо и обмен',size:64,bold:true,color:'#20243B',lineHeight:1.2},{id:'b',kind:'text',x:100,y:450,w:1100,h:180,text:'Записи сохраняют знания',size:40,bold:false,color:'#20243B',lineHeight:1.3}];
 const second={...structuredClone(slide),id:randomUUID()};project.state.doc.slides.push(second);await f.db.pool.query('UPDATE lanka.materials SET project=$3 WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId,project]);
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Object editor',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 const msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Уточни объект',selection:{documentId:doc.legacyId,revision:project.state.revision,slideId:slide.id,elementId:'a'},task:{mode:'propose',documentId:doc.legacyId,limitToSelection:true}});await b.receive(actor,f.tenant,sid);const scoped={...actor,task:{sessionId:sid,messageId:msg.id}},change={op:'set_element',slideId:slide.id,value:{...slide.canvas[0],text:'Как письмо сохраняет знания'}};
 const send=commands=>p.create(scoped,f.tenant,doc.legacyId,{requestId:randomUUID(),expectedRevision:project.state.revision,title:'Правка объекта',commands});
 for(const commands of [[change,{op:'set_element',slideId:slide.id,value:{...slide.canvas[1],text:'Подмена'}}],[change,{op:'add_element',slideId:slide.id,value:{...slide.canvas[1],id:'extra'}}],[{...change,slideId:second.id}]])await denied(()=>send(commands));
 assert.equal((await p.context(actor,f.tenant,doc.legacyId)).proposals.length,0);
 const result=await send([change]);assert.ok(result.proposalId);const after=(await f.db.pool.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND id=$2',[f.tenant,doc.legacyId])).rows[0].project;
 assert.deepEqual(after.state.doc,project.state.doc);assert.deepEqual(after.state.proposals[0].changes[0].after.canvas[1],slide.canvas[1]);
});

test('standard MCP tool arguments advertise and enforce task authority without custom metadata support',async t=>{
 const f=await fixture(t),s=new WorkspaceSessions(f.resources),b=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID();await s.create(f.users.alice,f.tenant,{requestId:sid,title:'Обычный MCP-клиент'});await s.link(f.users.alice,f.tenant,sid,doc.legacyId);
 const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Standard client',capability:'organize',minutes:15});await b.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});
 const msg=await b.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Уточни заголовок',task:{mode:'propose',documentId:doc.legacyId}});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const wire=async(method,params={})=>(await(await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());
 const call=(name,args={},meta)=>wire('tools/call',{name,arguments:args,...(meta?{_meta:meta}:{})}),value=r=>{assert.ok(r.result&&!r.result.isError,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
 const listed=(await wire('tools/list')).result.tools;
 for(const name of ['lanka_propose_commands','lanka_comment','lanka_set_comment_status','lanka_create_document','lanka_upload_source','lanka_copy_shared_document','lanka_manage_library']){const tool=listed.find(t=>t.name===name);assert.deepEqual(tool.inputSchema.properties.task.required,['sessionId','messageId']);assert.equal(tool.inputSchema.required.includes('task'),false);}
 assert.equal(listed.find(t=>t.name==='lanka_get_document_view').inputSchema.properties.task,undefined);
 value(await call('lanka_receive_message',{sessionId:sid}));const task={sessionId:sid,messageId:msg.id},ctx=value(await call('lanka_get_edit_context',{documentId:doc.legacyId})),args={documentId:doc.legacyId,requestId:randomUUID(),expectedRevision:ctx.revision,title:'Уточнение',commands:[{op:'set_title',slideId:ctx.slides[0].id,value:'Письмо и обмен'}],task};
 const conflict=await call('lanka_propose_commands',args,{lankaTask:{...task,messageId:randomUUID()}});assert.equal(conflict.result.isError,true);
 const accepted=value(await call('lanka_propose_commands',args));assert.ok(accepted.proposalId);
 assert.equal(value(await call('lanka_propose_commands',args,{lankaTask:task})).proposalId,accepted.proposalId);
 const read=await call('lanka_get_document_view',{documentId:doc.legacyId,task});assert.ok(read.error||read.result?.isError);
 await b.cancel(f.users.alice,f.tenant,sid,msg.id);assert.equal((await call('lanka_propose_commands',args)).result.isError,true);
});

async function executionFixture(t){const f=await fixture(t),sessions=new WorkspaceSessions(f.resources),bridge=new AgentBridge(f.resources),doc=await f.material(),sid=randomUUID();await sessions.create(f.users.alice,f.tenant,{requestId:sid,title:'Runtime task'});await sessions.link(f.users.alice,f.tenant,sid,doc.legacyId);const secret=randomBytes(32).toString('hex'),key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,null,{requestId:randomUUID(),secret,name:'Runtime client',capability:'propose',minutes:15}),actor=delegatedPrincipal(secret);await bridge.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});const message=await bridge.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Предложи правку',task:{mode:'propose',documentId:doc.legacyId}});await bridge.receive(actor,f.tenant,sid);return {...f,bridge,doc,sid,actor,message,secret};}

test('one runtime execution claims a message; running claim fences unscoped writers and ends after stop',async t=>{
 const f=await executionFixture(t),id=randomUUID(),claim={messageId:f.message.id,executionId:id};
 const raced=await Promise.allSettled([f.bridge.claim(f.actor,f.tenant,f.sid,claim),f.bridge.claim(f.actor,f.tenant,f.sid,{...claim,executionId:randomUUID()})]);assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);
 const winner=raced.find(r=>r.status==='fulfilled').value.execution.id,task={sessionId:f.sid,messageId:f.message.id,executionId:winner},p=new OrganizationDocumentProposals(f.resources),ctx=await p.context(f.actor,f.tenant,f.doc.legacyId),command={requestId:randomUUID(),expectedRevision:ctx.revision,title:'Runtime edit',commands:[{op:'set_title',slideId:ctx.slides[0].id,value:'Письмо и обмен'}]};
 await denied(()=>p.create({...f.actor,task},f.tenant,f.doc.legacyId,command));
 const report={messageId:f.message.id,executionId:winner,requestId:randomUUID(),status:'running',nativeThreadId:'native-thread',nativeTurnId:'native-turn'};const running=await f.bridge.report(f.actor,f.tenant,f.sid,report);assert.equal(running.execution.state,'running');
 const retry=await f.bridge.report(f.actor,f.tenant,f.sid,report);assert.equal(retry.replayed,true);assert.deepEqual(retry.execution.leaseExpiresAt,running.execution.leaseExpiresAt);
 await denied(()=>p.create({...f.actor,task:{sessionId:f.sid,messageId:f.message.id}},f.tenant,f.doc.legacyId,command));
 await p.create({...f.actor,task},f.tenant,f.doc.legacyId,command);
 await denied(()=>f.bridge.reply(f.actor,f.tenant,f.sid,{requestId:randomUUID(),replyTo:f.message.id,text:'Done'}));
 await f.bridge.reply(f.actor,f.tenant,f.sid,{requestId:randomUUID(),replyTo:f.message.id,text:'Done',executionId:winner});
 const stopped=await f.bridge.report(f.actor,f.tenant,f.sid,{...report,requestId:randomUUID(),status:'stopped'});assert.equal(stopped.execution.state,'stopped');assert.equal(stopped.stopRequested,true);
 assert.equal((await f.bridge.read(f.users.alice,f.tenant,f.sid)).messages[0].execution.reportedBy,'external_mcp_client');
});

test('expired runtime is unknown, cannot revive or take over, and late stopped report is distinct from cancellation',async t=>{
 const f=await executionFixture(t),executionId=randomUUID(),claim={messageId:f.message.id,executionId};await f.bridge.claim(f.actor,f.tenant,f.sid,claim);
 const report={...claim,requestId:randomUUID(),status:'running',nativeThreadId:'t',nativeTurnId:'u'};await f.bridge.report(f.actor,f.tenant,f.sid,report);
 await f.db.pool.query("UPDATE lanka.agent_bridge_executions SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,executionId]);
 const view=await f.bridge.read(f.users.alice,f.tenant,f.sid);assert.equal(view.messages[0].execution.state,'unknown');assert.equal((await f.bridge.claim(f.actor,f.tenant,f.sid,claim)).replayed,true);
 await denied(()=>f.bridge.claim(f.actor,f.tenant,f.sid,{...claim,executionId:randomUUID()}));await denied(()=>f.bridge.report(f.actor,f.tenant,f.sid,{...report,requestId:randomUUID()}));
 const replay=await f.bridge.report(f.actor,f.tenant,f.sid,report);assert.equal(replay.stopRequested,true);assert.equal(replay.execution.state,'unknown');
 await f.bridge.cancel(f.users.alice,f.tenant,f.sid,f.message.id);assert.equal((await f.bridge.read(f.users.alice,f.tenant,f.sid)).messages[0].execution.state,'unknown');
 const stopped=await f.bridge.report(f.actor,f.tenant,f.sid,{...claim,requestId:randomUUID(),status:'stopped'});assert.equal(stopped.execution.state,'stopped');
 await denied(()=>f.bridge.report(f.actor,f.tenant,f.sid,{...report,requestId:randomUUID()}));
});

test('runtime report preserves native identity, never extends cancellation, and rejects foreign session ownership',async t=>{
 const f=await executionFixture(t),claim={messageId:f.message.id,executionId:randomUUID()};await f.bridge.claim(f.actor,f.tenant,f.sid,claim);const report={...claim,requestId:randomUUID(),status:'running',nativeThreadId:'t',nativeTurnId:'u'},r=await f.bridge.report(f.actor,f.tenant,f.sid,report);
 await denied(()=>f.bridge.report(f.actor,f.tenant,f.sid,{...report,requestId:randomUUID(),nativeTurnId:'replacement'}));await denied(()=>f.bridge.report(f.actor,f.tenant,f.sid,{...report,status:'failed'}));
 await f.bridge.cancel(f.users.alice,f.tenant,f.sid,f.message.id);const cancelled=await f.bridge.report(f.actor,f.tenant,f.sid,{...report,requestId:randomUUID()});assert.equal(cancelled.stopRequested,true);assert.deepEqual(cancelled.execution.leaseExpiresAt,r.execution.leaseExpiresAt);
 const secret=randomBytes(32).toString('hex');await new AgentDelegations(f.resources).issue(f.users.bob,f.tenant,null,{requestId:randomUUID(),secret,name:'Other',capability:'read',minutes:15});await denied(()=>f.bridge.report(delegatedPrincipal(secret),f.tenant,f.sid,{...claim,requestId:randomUUID(),status:'stopped'}));
});

test('runtime lifecycle tools require explicit protocol discovery and the expired execution fences writes over HTTP',async t=>{
 const f=await executionFixture(t),origin='http://127.0.0.1:49999',app=createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'});
 const rpc=async(method,params={},runtime=false)=>(await(await app(new Request(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers:{Authorization:'Bearer '+f.secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18',...(runtime?{'Lanka-Runtime-Protocol':'1'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}))).json());
 assert.equal((await rpc('tools/list')).result.tools.some(t=>t.name==='lanka_claim_execution'),false);assert.equal((await rpc('tools/list',{},true)).result.tools.some(t=>t.name==='lanka_claim_execution'),true);
 const call=(name,args,runtime=true)=>rpc('tools/call',{name,arguments:args},runtime),claim={sessionId:f.sid,messageId:f.message.id,executionId:randomUUID()};assert.ok((await call('lanka_claim_execution',claim,false)).error);
 const claimed=await call('lanka_claim_execution',claim);assert.equal(JSON.parse(claimed.result.content[0].text).execution.state,'claimed');
 const reported=await call('lanka_report_execution',{...claim,requestId:randomUUID(),status:'running',nativeThreadId:'native-1',nativeTurnId:'turn-1'});assert.equal(JSON.parse(reported.result.content[0].text).execution.state,'running');
 await f.db.pool.query("UPDATE lanka.agent_bridge_executions SET lease_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[f.tenant,claim.executionId]);
 const p=new OrganizationDocumentProposals(f.resources),ctx=await p.context(f.actor,f.tenant,f.doc.legacyId),args={documentId:f.doc.legacyId,requestId:randomUUID(),expectedRevision:ctx.revision,title:'Late',commands:[{op:'set_title',slideId:ctx.slides[0].id,value:'Письмо и обмен'}],task:claim};
 assert.equal((await call('lanka_propose_commands',args,false)).result.isError,true);
});

test('companion HTTP client and model facade execute a real task and preserve the server cancellation fence',async t=>{
 const {CorporateMcpClient}=await import('../../runtime/corporate-mcp-client.mjs'),{ScopedBridgeTools}=await import('../../runtime/scoped-bridge-tools.mjs'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const url=origin+`/mcp/organizations/${f.tenant}`,control=new CorporateMcpClient({url,token:f.secret,runtime:true}),client=new CorporateMcpClient({url,token:f.secret}),task={sessionId:f.sid,messageId:f.message.id,executionId:randomUUID()},json=r=>{assert.notEqual(r.isError,true);return JSON.parse(r.content[0].text);};
 await control.initialize();assert.equal(json(await control.call('lanka_claim_execution',task)).execution.state,'claimed');
 let ready=false;const facade=new ScopedBridgeTools({client,task,documentId:f.doc.legacyId,mode:'propose',awaitRunning:async()=>{if(ready)return;const r=json(await control.call('lanka_report_execution',{...task,requestId:randomUUID(),status:'running',nativeThreadId:'test-native-thread',nativeTurnId:'test-native-turn'}));assert.equal(r.execution.state,'running');assert.equal(r.stopRequested,false);ready=true;}});
 await client.initialize();const catalog=await facade.tools();assert.equal(catalog.some(t=>t.name==='lanka_claim_execution'||t.name==='lanka_reply_message'),false);
 const context=json(await facade.call('lanka_get_edit_context')),args={requestId:randomUUID(),expectedRevision:context.revision,title:'Уточнение',commands:[{op:'set_title',slideId:context.slides[0].id,value:'Письмо и обмен'}]};
 const proposal=json(await facade.call('lanka_propose_commands',args));assert.ok(proposal.proposalId);
 await f.bridge.cancel(f.users.alice,f.tenant,f.sid,f.message.id);assert.equal((await facade.call('lanka_propose_commands',args)).isError,true);
 const stopped=json(await control.call('lanka_report_execution',{...task,requestId:randomUUID(),status:'stopped'}));assert.equal(stopped.execution.state,'stopped');
});

test('companion controller commits its final reply through real HTTP and terminates the claimed execution',async t=>{
 const {CorporateMcpClient}=await import('../../runtime/corporate-mcp-client.mjs'),{executeBridgeTask}=await import('../../runtime/companion-worker.mjs'),{openCompanionJournal}=await import('../../runtime/companion-journal.mjs'),fs=await import('node:fs/promises'),os=await import('node:os'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const client=new CorporateMcpClient({url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,runtime:true});await client.initialize();const received=JSON.parse((await client.call('lanka_receive_message',{sessionId:f.sid})).content[0].text);
 const dir=await fs.mkdtemp(os.tmpdir()+'/lanka-http-worker-');await fs.chmod(dir,0o700);const journal=await openCompanionJournal(dir+'/task.json',{sessionId:f.sid,messageId:received.message.id});t.after(async()=>{await journal.close();await fs.rm(dir,{recursive:true,force:true});});
 await executeBridgeTask({client,journal,message:received.message,setReady:async()=>{},adapter:{prepare:async()=>({threadId:'synthetic-thread',turn:async o=>{await o.onStarted('synthetic-turn');o.onTerminal({threadId:'synthetic-thread',turnId:'synthetic-turn',status:'completed'});return 'Тестовый ответ контроллера, без вызова модели.';},close:async()=>{}})}});
 assert.equal(journal.snapshot().phase,'terminal');const saved=await f.db.pool.query('SELECT text FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND id=$2',[f.tenant,journal.snapshot().replyRequestId]);assert.equal(saved.rows[0].text,journal.snapshot().reply);
 const execution=await f.db.pool.query('SELECT status FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND id=$2',[f.tenant,journal.snapshot().executionId]);assert.equal(execution.rows[0].status,'stopped');
});

test('local starts and companion claims share the last daily slot atomically and retries are free',async t=>{
 const f=await executionFixture(t),sessions=new WorkspaceSessions(f.resources),second=randomUUID();await sessions.create(f.users.alice,f.tenant,{requestId:second,title:'Second runtime'});
 const key=(await f.db.pool.query('SELECT delegation_id FROM lanka.agent_bindings WHERE tenant_id=$1 AND session_id=$2',[f.tenant,f.sid])).rows[0].delegation_id;
 await f.bridge.bind(f.users.alice,f.tenant,second,{delegationId:key,expectedDelegationId:null,taskBound:true});const next=await f.bridge.send(f.users.alice,f.tenant,second,{requestId:randomUUID(),text:'Discuss',task:{mode:'discuss'}});await f.bridge.receive(f.actor,f.tenant,second);
 // Synthetic local-start history exercises the same durable rows counted by ChatService.
 await f.db.pool.query("INSERT INTO lanka.agent_events(tenant_id,session_id,sequence,kind,payload) SELECT $1,$2,n,'run.started','{}' FROM generate_series(1,19) n",[f.tenant,f.sid]);
 try{
  const requests=[{sid:f.sid,messageId:f.message.id,executionId:randomUUID()},{sid:second,messageId:next.id,executionId:randomUUID()}];
  const results=await Promise.allSettled(requests.map(({sid,...a})=>f.bridge.claim(f.actor,f.tenant,sid,a)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const i=results.findIndex(r=>r.status==='fulfilled'),winner=requests[i],loser=requests[1-i];assert.match(results[1-i].reason.message,/20/);
  assert.equal((await f.bridge.claim(f.actor,f.tenant,winner.sid,{messageId:winner.messageId,executionId:winner.executionId})).replayed,true);
  await f.bridge.cancel(f.users.alice,f.tenant,winner.sid,winner.messageId);await denied(()=>f.bridge.claim(f.actor,f.tenant,loser.sid,{messageId:loser.messageId,executionId:loser.executionId}));
  const usage=await f.orgs.withTenant(f.users.alice,f.tenant,(c,ctx)=>agentUsage(c,f.tenant,ctx.principalId));assert.equal(usage.used,20);assert.equal(usage.remaining,0);const bob=await f.orgs.withTenant(f.users.bob,f.tenant,(c,ctx)=>agentUsage(c,f.tenant,ctx.principalId));assert.equal(bob.used,0);
  await f.db.pool.query("UPDATE lanka.agent_events SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",[f.tenant,f.sid]);
  const fresh=await f.orgs.withTenant(f.users.alice,f.tenant,(c,ctx)=>agentUsage(c,f.tenant,ctx.principalId));assert.equal(fresh.used,1);assert.equal(fresh.remaining,19);
 }finally{await f.db.pool.query('DELETE FROM lanka.agent_events WHERE tenant_id=$1 AND session_id=$2',[f.tenant,f.sid]);}
});

test('foreground companion polls two queued messages through HTTP and includes the first late reply in context',async t=>{
 const {runCompanion}=await import('../../runtime/companion-daemon.mjs'),fs=await import('node:fs/promises'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 await f.bridge.send(f.users.alice,f.tenant,f.sid,{requestId:randomUUID(),text:'Объясни ещё раз',task:{mode:'discuss'}});
 const stateDir=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'lanka-http-daemon-')));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));const abort=new AbortController(),histories=[];let answers=0;
 await runCompanion({url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,sessionId:f.sid,stateDir,command:'/test/codex',codexHome:stateDir,cwd:stateDir,model:'synthetic'},
 {signal:abort.signal,checkAccount:async()=>{},onStatus:s=>{if(s.state==='answered'&&++answers===2)abort.abort();},makeAdapter:options=>{histories.push(options.history);return {prepare:async()=>({threadId:'synthetic',turn:async o=>{await o.onStarted('turn');o.onTerminal({threadId:'synthetic',turnId:'turn',status:'completed'});return 'Синтетический ответ для проверки HTTP-цикла.';},close:async()=>{}})};}});
 assert.equal(answers,2);assert.equal(histories[0].length,0);assert.equal(histories[1].filter(m=>m.role==='assistant').length,1);
 const saved=await f.db.pool.query("SELECT count(*)::int AS n FROM lanka.agent_bridge_messages WHERE tenant_id=$1 AND session_id=$2 AND role='assistant'",[f.tenant,f.sid]);assert.equal(saved.rows[0].n,2);assert.equal((await fs.readdir(stateDir)).some(name=>name.endsWith('.mcp.json')||name.endsWith('.lock')),false);
});

test('lost HTTP reply acknowledgement is recovered from durable server evidence without a second native turn',async t=>{
 const {CorporateMcpClient}=await import('../../runtime/corporate-mcp-client.mjs'),{executeBridgeTask}=await import('../../runtime/companion-worker.mjs'),{reconcileFinishedExecution}=await import('../../runtime/companion-recovery.mjs'),{openCompanionJournal}=await import('../../runtime/companion-journal.mjs'),fs=await import('node:fs/promises'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const http=new CorporateMcpClient({url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,runtime:true});await http.initialize();const message=JSON.parse((await http.call('lanka_receive_message',{sessionId:f.sid})).content[0].text).message;
 const dir=await fs.mkdtemp(join(tmpdir(),'lanka-reply-recovery-')),journal=await openCompanionJournal(join(dir,'checkpoint.json'),{sessionId:f.sid,messageId:message.id});t.after(async()=>{await journal.close();await fs.rm(dir,{recursive:true,force:true});});let starts=0,replies=0;
 const client={call:async(name,args,signal)=>{const r=await http.call(name,args,signal);if(name==='lanka_reply_message'){replies++;assert.notEqual(r.isError,true);throw Error('Simulated lost acknowledgement after server commit');}return r;}};
 await assert.rejects(executeBridgeTask({client,journal,message,setReady:async()=>{},adapter:{prepare:async()=>({threadId:'synthetic',turn:async o=>{starts++;await o.onStarted('turn');o.onTerminal({threadId:'synthetic',turnId:'turn',status:'completed'});return 'Сохранённый ответ';},close:async()=>{}})}}),/lost acknowledgement/);
 assert.equal(journal.snapshot().phase,'unknown');await reconcileFinishedExecution(http,journal);assert.equal(journal.snapshot().phase,'terminal');assert.equal(starts,1);assert.equal(replies,1);
});

test('companion attaches a real captured proposal to its final chat reply',async t=>{
 const {CorporateMcpClient}=await import('../../runtime/corporate-mcp-client.mjs'),{ScopedBridgeTools}=await import('../../runtime/scoped-bridge-tools.mjs'),{executeBridgeTask}=await import('../../runtime/companion-worker.mjs'),{openCompanionJournal}=await import('../../runtime/companion-journal.mjs'),{recordCapturedResult,readCapturedResults}=await import('../../runtime/companion-results.mjs'),fs=await import('node:fs/promises'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const client=new CorporateMcpClient({url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,runtime:true});await client.initialize();const message=JSON.parse((await client.call('lanka_receive_message',{sessionId:f.sid})).content[0].text).message,dir=await fs.mkdtemp(join(tmpdir(),'lanka-result-cards-')),ledger=join(dir,'results');await fs.writeFile(ledger,'',{mode:0o600});const journal=await openCompanionJournal(join(dir,'checkpoint'),{sessionId:f.sid,messageId:message.id});t.after(async()=>{await journal.close();await fs.rm(dir,{recursive:true,force:true});});const state=journal.snapshot(),task={sessionId:f.sid,messageId:message.id,executionId:state.executionId};
 const facade=new ScopedBridgeTools({client,task,mode:'propose',documentId:f.doc.legacyId,awaitRunning:async()=>assert.equal(journal.snapshot().phase,'running'),onResult:(name,args,r)=>recordCapturedResult(ledger,state.executionId,name,args,r)});await facade.tools();let proposalId;
 await executeBridgeTask({client,journal,message,setReady:async()=>{},adapter:{prepare:async()=>({threadId:'synthetic',results:()=>readCapturedResults(ledger,state.executionId),turn:async o=>{await o.onStarted('turn');const ctx=JSON.parse((await facade.call('lanka_get_edit_context')).content[0].text),r=await facade.call('lanka_propose_commands',{requestId:randomUUID(),expectedRevision:ctx.revision,title:'Письмо и обмен',commands:[{op:'set_title',slideId:ctx.slides[0].id,value:'Письмо и обмен'}]});assert.notEqual(r.isError,true);const proposed=JSON.parse(r.content[0].text);proposalId=proposed.proposalId;
 const accepted=await organizationApi(f.orgs,f.root)(new Request(`https://lanka.test/api/organizations/${f.tenant}/documents/${f.doc.legacyId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:f.doc.legacyId,expectedRevision:ctx.revision,command:{action:'accept',proposalId,changeIds:proposed.changes.map(c=>c.id)}})}),f.users.alice);assert.equal(accepted.status,200);
 o.onTerminal({threadId:'synthetic',turnId:'turn',status:'completed'});return 'Предложение создано.';},close:async()=>{}})}});
 const view=JSON.parse((await client.call('lanka_read_conversation',{sessionId:f.sid})).content[0].text),reply=view.messages.find(m=>m.id===journal.snapshot().replyRequestId);assert.equal(reply.results.length,1);assert.equal(reply.results[0].proposalId,proposalId);assert.equal(reply.results[0].available,true);assert.ok(reply.results[0].url.endsWith('?review='+proposalId));assert.equal(journal.snapshot().results[0].proposalId,proposalId);assert.equal(journal.snapshot().capturedResults[0].revision,1);assert.equal(reply.results[0].revision,2);assert.equal(reply.results[0].proposalStatus,'closed');
});

test('daemon retries an unregistered quota denial after a simulated new day without duplicate native startup',async t=>{
 const {runCompanion}=await import('../../runtime/companion-daemon.mjs'),fs=await import('node:fs/promises'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const stateDir=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'lanka-quota-restart-')));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));const config={url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,sessionId:f.sid,stateDir,command:'/test/codex',codexHome:stateDir,cwd:stateDir,model:'synthetic'};let starts=0;
 const makeAdapter=()=>({prepare:async()=>({threadId:'synthetic',turn:async o=>{starts++;await o.onStarted('turn');o.onTerminal({threadId:'synthetic',turnId:'turn',status:'completed'});return 'Ответ после нового периода';},close:async()=>{}})});
 await f.db.pool.query("INSERT INTO lanka.agent_events(tenant_id,session_id,sequence,kind,payload) SELECT $1,$2,n,'run.started','{}' FROM generate_series(1,20) n",[f.tenant,f.sid]);
 try{
  await assert.rejects(runCompanion(config,{checkAccount:async()=>{},makeAdapter}),/rejected/);assert.equal(starts,0);const path=join(stateDir,f.message.id+'.checkpoint.json'),before=JSON.parse(await fs.readFile(path,'utf8'));assert.equal(before.unknownFrom,'claim_pending');
  // Only synthetic fixture history is shifted; the real owner's limit is never changed.
  await f.db.pool.query("UPDATE lanka.agent_events SET created_at=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 second' WHERE tenant_id=$1 AND session_id=$2",[f.tenant,f.sid]);
  const abort=new AbortController();await runCompanion(config,{signal:abort.signal,checkAccount:async()=>{},makeAdapter,onStatus:s=>{if(s.state==='answered')abort.abort();}});const after=JSON.parse(await fs.readFile(path,'utf8'));assert.equal(after.executionId,before.executionId);assert.equal(after.phase,'terminal');assert.equal(starts,1);
 }finally{await f.db.pool.query('DELETE FROM lanka.agent_events WHERE tenant_id=$1 AND session_id=$2',[f.tenant,f.sid]);}
});

test('panel connection context is read from authorized corporate conversation without claiming a task',async t=>{
 const {checkCompanionConnection}=await import('../../runtime/companion-daemon.mjs'),f=await executionFixture(t);let handler;
 const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const contexts=[];await assert.rejects(checkCompanionConnection({url:origin+`/mcp/organizations/${f.tenant}`,token:f.secret,sessionId:f.sid},{onContext:value=>contexts.push(value),checkAccount:async()=>{throw Error('Test missing login');}}),/Test missing login/);
 assert.deepEqual(contexts,[{sessionId:f.sid,title:'Runtime task'}]);const rows=await f.db.pool.query('SELECT count(*)::int AS n FROM lanka.agent_bridge_executions WHERE tenant_id=$1 AND session_id=$2',[f.tenant,f.sid]);assert.equal(rows.rows[0].n,0);
});

test('delegated canvas text context teaches edit_text and preserves private notes in a shared proposal',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId);
 await repo.mutate(randomUUID(),{test:'canvas text'},old=>{
  const s=old.state.doc.slides[0];s.notes='PRIVATE_TEXT_EDIT_NOTES';s.canvas=[{id:'title',kind:'text',sourceField:'title',x:100,y:100,w:900,h:52,text:'Town',size:40,bold:false,color:'#20243B',lineHeight:1.3}];old.state.revision++;return {project:old,result:{}};
 });
 const before=await repo.read(),keys=new AgentDelegations(f.resources),secret=randomBytes(32).toString('hex');
 await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Text QA',capability:'propose',minutes:15});
 const actor=delegatedPrincipal(secret),proposals=new OrganizationDocumentProposals(f.resources),context=await proposals.context(actor,f.tenant,doc.legacyId);
 assert.match(context.editingGuide.canvasText,/edit_text/);assert.match(context.editingGuide.canvasText,/height grows/);
 assert.ok(!JSON.stringify(context).includes('PRIVATE_TEXT_EDIT_NOTES'));
 const result=await proposals.create(actor,f.tenant,doc.legacyId,{requestId:randomUUID(),expectedRevision:context.revision,title:'Larger text',commands:[{op:'edit_text',slideId:context.slides[0].id,elementId:'title',value:{text:'Cities',size:80}}]});
 const stored=await repo.read(),proposed=stored.state.proposals.find(p=>p.id===result.proposalId);
 assert.deepEqual(stored.state.doc,before.state.doc);assert.equal(proposed.visibility,'shared');
 assert.equal(proposed.changes[0].after.canvas[0].h,104);assert.equal(proposed.changes[0].after.notes,'PRIVATE_TEXT_EDIT_NOTES');
 const preview=await proposals.preview(actor,f.tenant,doc.legacyId,result.proposalId);
 assert.ok(!JSON.stringify(preview).includes('PRIVATE_TEXT_EDIT_NOTES'));assert.ok(preview.after.slides[0].items.some(p=>p.kind==='text'&&p.text==='Cities'));
});

test('self-hosted readiness requires every shipped migration checksum and never repairs schema',async()=>{
 const name='lanka_readiness_'+randomUUID().replaceAll('-',''),admin=new Pool(base.connection);let database,created=false;
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;database=new Pool({...base.connection,database:name});
  await assert.rejects(()=>assertSelfHostedSchema(database));
  assert.equal((await database.query("SELECT to_regnamespace('lanka') AS schema")).rows[0].schema,null);
  await applySelfHostedMigrations(database);
  const client=await database.connect();try{await client.query('BEGIN READ ONLY');assert.equal((await assertSelfHostedSchema(client)).latest,'0036_revision_design_packages');await client.query('ROLLBACK');}finally{client.release();}
  const before=(await database.query('SELECT version,checksum FROM lanka.schema_migrations ORDER BY version')).rows;
  await database.query("DELETE FROM lanka.schema_migrations WHERE version='0029_publications'");
  await assert.rejects(()=>assertSelfHostedSchema(database),/0029_publications/);
  assert.equal((await database.query("SELECT 1 FROM lanka.schema_migrations WHERE version='0029_publications'")).rowCount,0);
  const last=before.find(m=>m.version==='0029_publications');await database.query('INSERT INTO lanka.schema_migrations(version,checksum) VALUES($1,$2)',[last.version,last.checksum]);
  await database.query("UPDATE lanka.schema_migrations SET checksum='changed' WHERE version='0001_chat'");
  await assert.rejects(()=>assertSelfHostedSchema(database),/0001_chat/);
  assert.equal((await database.query("SELECT checksum FROM lanka.schema_migrations WHERE version='0001_chat'")).rows[0].checksum,'changed');
 }finally{await database?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});

test('corporate HTTP MCP layers preserve private notes and require proposal authority and human review',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId);
 await repo.mutate(randomUUID(),{test:'shared layers'},old=>{const slide=old.state.doc.slides[0];slide.notes='PRIVATE_LAYER_NOTES';slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',sourceField:'title',x:100,y:120,w:900,h:100,text:slide.title,size:40,bold:false,color:'#20243B',lineHeight:1.3},{id:'shape',kind:'rect',x:90,y:110,w:950,h:130,color:'#99CCEE'}];old.state.revision++;return {project:old,result:{}};});
 const before=await repo.read(),keys=new AgentDelegations(f.resources),secret=randomBytes(32).toString('hex');
 await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Layer QA',capability:'propose',minutes:15});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const call=async(name,args,token=secret)=>(await(await fetch(origin+`/mcp/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:Object.fromEntries(Object.entries(args).filter(([key])=>key!=='documentId'))}})})).json());
 const value=r=>{assert.ok(r.result&&!r.result.isError,JSON.stringify(r));assert.ok(!JSON.stringify(r).includes('PRIVATE_LAYER_NOTES'));return JSON.parse(r.result.content[0].text);};
 const context=value(await call('lanka_get_edit_context',{documentId:doc.legacyId}));assert.match(context.editingGuide.canvasLayers,/reorder_element/);
 const args={documentId:doc.legacyId,requestId:randomUUID(),expectedRevision:context.revision,title:'Move shape behind text',commands:[{op:'reorder_element',slideId:context.slides[0].id,elementId:'shape',direction:'back'}]};
 const readSecret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret:readSecret,name:'Read only layer QA',capability:'read',minutes:15});
 const readOnly=await call('lanka_propose_commands',args,readSecret);assert.ok(readOnly.error||readOnly.result?.isError);assert.equal((await repo.read()).state.proposals.length,before.state.proposals.length);
 const locked=await call('lanka_propose_commands',{...args,requestId:randomUUID(),commands:[{...args.commands[0],elementId:'background',direction:'front'}]});assert.equal(locked.result.isError,true);assert.equal((await repo.read()).state.proposals.length,before.state.proposals.length);
 const proposal=value(await call('lanka_propose_commands',args));assert.equal(value(await call('lanka_propose_commands',args)).proposalId,proposal.proposalId);
 const proposed=await repo.read(),change=proposed.state.proposals.find(p=>p.id===proposal.proposalId).changes[0];assert.deepEqual(proposed.state.doc,before.state.doc);assert.equal(change.after.notes,'PRIVATE_LAYER_NOTES');assert.deepEqual(change.after.canvas.map(e=>e.id),['background','shape','title']);
 const preview=await new OrganizationDocumentProposals(f.resources).preview(delegatedPrincipal(secret),f.tenant,doc.legacyId,proposal.proposalId);assert.ok(!JSON.stringify(preview).includes('PRIVATE_LAYER_NOTES'));
 const accepted=await organizationApi(f.orgs,f.root)(new Request(origin+`/api/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:context.revision,command:{action:'accept',proposalId:proposal.proposalId,changeIds:[change.id]}})}),f.users.alice);assert.equal(accepted.status,200);
 const after=await repo.read();assert.deepEqual(after.state.doc.slides[0],change.after);assert.equal(after.state.revision,context.revision+1);
});

test('corporate Focus 3 font download requires browser identity and serves exact packaged bytes',async()=>{
 const origin='http://127.0.0.1:49999';let principal=null;
 const app=createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>principal},{},{runtimeRoot:'/unused',assetRoot:'.project-runtime'});
 const request=()=>new Request(origin+'/fonts/focus3-fonts.zip');
 assert.equal((await app(request())).status,401);
 principal={userId:randomUUID()};const response=await app(request());
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile('.project-runtime/focus3-fonts.zip'));
});

test('corporate MCP export plan is revision-bound, read-only, private and revocable',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId);
 await repo.mutate(randomUUID(),{test:'export plan'},p=>{p.state.doc.slides[0].notes='PRIVATE_EXPORT_PLAN_NOTES';p.state.revision++;return {project:p,result:{}};});
 const before=await repo.read(),secret=randomBytes(32).toString('hex'),keys=new AgentDelegations(f.resources),key=await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Plan reader',capability:'read',minutes:15});
 const origin='http://127.0.0.1:49999',app=createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>null},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'});
 const call=async(format,expectedRevision=before.state.revision)=>{
  const response=await app(new Request(origin+`/mcp/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'lanka_get_export_plan',arguments:{expectedRevision,format}}})}));return {status:response.status,body:await response.json()};
 };
 for(const format of ['pdf','pptx']){const r=await call(format);assert.equal(r.status,200);assert.equal(r.body.result.isError,undefined);const encoded=r.body.result.content[0].text;assert.ok(!encoded.includes('PRIVATE_EXPORT_PLAN_NOTES'));const result=JSON.parse(encoded);assert.equal(result.artifactCreated,false);assert.equal(result.revision,before.state.revision);assert.ok(result.capabilities.slides.length>0);assert.ok(result.capabilities.slides.flatMap(s=>s.objects).every(o=>format==='pdf'?o.representation==='pdf-content':o.representation.startsWith('native-')));assert.equal(result.sources,undefined);}
 assert.equal((await call('pptx',before.state.revision+1)).body.result.isError,true);assert.equal((await call('html')).body.result.isError,true);
 assert.deepEqual(await repo.read(),before);assert.deepEqual(await repo.listExportArtifacts(),{items:[],nextCursor:null});
 await keys.revoke(f.users.alice,f.tenant,doc.legacyId,key.id);const revoked=await call('pptx');assert.ok(revoked.status===401||revoked.status===403||revoked.body.result?.isError||revoked.body.error);
});

test('corporate HTTP MCP image insertion enforces source scope, human review and revocation',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG/8AAAAASUVORK5CYII=','base64'),hash=createHash('sha256').update(png).digest('hex');
 await f.db.pool.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4)',[f.tenant,doc.legacyId,`materials/${hash}.bin`,png]);
 await repo.mutate(randomUUID(),{test:'image insertion'},p=>{
  const slide=p.state.doc.slides[0];slide.notes='PRIVATE_INSERT_NOTES';
  slide.canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'title',kind:'text',x:100,y:100,w:900,h:100,text:'Image reuse',size:40,bold:false,color:'#20243B',lineHeight:1.3},{id:'existing-image',kind:'image',x:100,y:250,w:200,h:200,assetId:'visible-image'}];
  for(const id of ['visible-image','unreferenced-image'])p.state.sources.push({id,name:'PRIVATE_IMAGE_FILENAME',kind:'image',contentType:'image/png',sha256:hash,excerpt:'PRIVATE_IMAGE_EXCERPT',createdAt:new Date().toISOString()});
  p.state.revision++;return {project:p,result:{}};
 });
 const before=await repo.read(),keys=new AgentDelegations(f.resources),secret=randomBytes(32).toString('hex');
 const key=await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Image QA',capability:'propose',minutes:15});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const call=async(name,args,token=secret)=>{
  const response=await fetch(origin+`/mcp/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  return {status:response.status,body:await response.json()};
 };
 const value=r=>{assert.equal(r.status,200);assert.ok(r.body.result&&!r.body.result.isError,JSON.stringify(r.body));assert.ok(!JSON.stringify(r.body).includes('PRIVATE_'));return JSON.parse(r.body.result.content[0].text);};
 const context=value(await call('lanka_get_edit_context',{}));assert.match(context.editingGuide.canvasImageInsertion,/insert_image/);assert.match(context.editingGuide.canvasImageInsertion,/already referenced/);
 const args={requestId:randomUUID(),expectedRevision:context.revision,title:'Reuse image',commands:[{op:'insert_image',slideId:context.slides[0].id,elementId:'inserted-image',assetId:'visible-image'}]};
 const invalid=await call('lanka_propose_commands',{...args,requestId:randomUUID(),commands:[{...args.commands[0],assetId:'unreferenced-image'}]});assert.ok(invalid.body.error||invalid.body.result?.isError);assert.deepEqual(await repo.read(),before);
 const readSecret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret:readSecret,name:'Read only image QA',capability:'read',minutes:15});
 const readOnly=await call('lanka_propose_commands',args,readSecret);assert.ok(readOnly.body.error||readOnly.body.result?.isError);assert.deepEqual(await repo.read(),before);
 const proposal=value(await call('lanka_propose_commands',args));assert.equal(value(await call('lanka_propose_commands',args)).proposalId,proposal.proposalId);
 const proposed=await repo.read(),change=proposed.state.proposals.find(p=>p.id===proposal.proposalId).changes[0];assert.deepEqual(proposed.state.doc,before.state.doc);assert.deepEqual(change.after.canvas.slice(0,-1),before.state.doc.slides[0].canvas);assert.equal(change.after.notes,'PRIVATE_INSERT_NOTES');
 const inserted=change.after.canvas.at(-1);assert.equal(inserted.assetId,'visible-image');assert.equal(inserted.id,'inserted-image');
 for(const neighbour of change.after.canvas.slice(1,-1))assert.ok(inserted.x+inserted.w<=neighbour.x||neighbour.x+neighbour.w<=inserted.x||inserted.y+inserted.h<=neighbour.y||neighbour.y+neighbour.h<=inserted.y);
 const preview=value(await call('lanka_preview_proposal',{proposalId:proposal.proposalId}));assert.ok(!JSON.stringify(preview).includes('PRIVATE_'));assert.equal(preview.after.slides[0].items.filter(p=>p.kind==='image').length,2);
 const accepted=await organizationApi(f.orgs,f.root)(new Request(origin+`/api/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:doc.legacyId,expectedRevision:context.revision,command:{action:'accept',proposalId:proposal.proposalId,changeIds:[change.id]}})}),f.users.alice);assert.equal(accepted.status,200);
 const after=await repo.read();assert.deepEqual(after.state.doc.slides[0],change.after);assert.equal(after.state.revision,context.revision+1);
 value(await call('lanka_get_edit_context',{}));await keys.revoke(f.users.alice,f.tenant,doc.legacyId,key.id);
 for(const [name,input] of [['lanka_get_edit_context',{}],['lanka_propose_commands',args]]){const revoked=await call(name,input);assert.ok([401,403].includes(revoked.status)||revoked.body.error||revoked.body.result?.isError);}
 assert.deepEqual(await repo.read(),after);
});

test('corporate basic insertion shares brand defaults and does not expose private notes',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId);
 await repo.mutate(randomUUID(),{test:'basic insertion'},p=>{p.state.doc.slides[0].notes='PRIVATE_BASIC_NOTES';p.state.doc.slides[0].canvas=[{id:'background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true}];p.state.revision++;return {project:p,result:{}};});
 const before=await repo.read(),secret=randomBytes(32).toString('hex'),keys=new AgentDelegations(f.resources),key=await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Basic insertion QA',capability:'propose',minutes:15});
 const origin='http://127.0.0.1:49999',app=createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>null},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'});
 const call=async(name,args)=>{const r=await app(new Request(origin+`/mcp/organizations/${f.tenant}/documents/${doc.legacyId}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));return {status:r.status,body:await r.json()};};
 const value=r=>{assert.equal(r.status,200);assert.ok(r.body.result&&!r.body.result.isError,JSON.stringify(r.body));assert.ok(!JSON.stringify(r.body).includes('PRIVATE_BASIC_NOTES'));return JSON.parse(r.body.result.content[0].text);};
 const context=value(await call('lanka_get_edit_context',{}));assert.match(context.editingGuide.canvasBasicInsertion,/insert_text/);assert.match(context.editingGuide.canvasBasicInsertion,/insert_shape/);
 const args={requestId:randomUUID(),expectedRevision:context.revision,title:'Add text and shape',commands:[{op:'insert_text',slideId:context.slides[0].id,elementId:'new-text',value:'Связи между городами'},{op:'insert_shape',slideId:context.slides[0].id,elementId:'new-shape'}]};
 const result=value(await call('lanka_propose_commands',args)),stored=await repo.read();assert.deepEqual(stored.state.doc,before.state.doc);
 const change=stored.state.proposals.find(p=>p.id===result.proposalId).changes[0];assert.equal(change.after.notes,'PRIVATE_BASIC_NOTES');assert.equal(change.after.canvas[1].color,before.state.doc.brand.ink);assert.equal(change.after.canvas[2].color,before.state.doc.brand.accent);
 const preview=value(await call('lanka_preview_proposal',{proposalId:result.proposalId}));assert.ok(preview.after.slides[0].items.some(p=>p.kind==='text'&&p.text.includes('Связи')));
 await keys.revoke(f.users.alice,f.tenant,doc.legacyId,key.id);const revoked=await call('lanka_propose_commands',args);assert.ok([401,403].includes(revoked.status)||revoked.body.error||revoked.body.result?.isError);assert.deepEqual(await repo.read(),stored);
});

test('shared empty draft preserves selected source snapshots without granting original access',async t=>{
 const f=await fixture(t),folder=await f.folder(),intakes=new AgentSourceIntakes(f.orgs,f.root),api=organizationApi(f.orgs,f.root);await f.grant(folder.id,'bob','manager');
 const bytes=Buffer.from('# Материал команды\n\nПлан: три этапа и два варианта.');
 const source=await intakes.upload(f.users.bob,f.tenant,{requestId:randomUUID(),name:'team.md',base64:bytes.toString('base64')});
 const input={requestId:randomUUID(),command:{action:'create_document',title:'Из материалов',folderId:null,folderResourceId:folder.id,empty:true,profile:'focus-v3',sources:[{id:source.id,sha256:source.sha256,acceptPartial:false}]}};
 const endpoint=`http://local/api/organizations/${f.tenant}/shared-create`,send=(value,user=f.users.bob)=>api(new Request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),user);
 assert.equal((await send({...input,requestId:randomUUID(),command:{...input.command,sources:[{id:source.id,sha256:'0'.repeat(64)}]}})).status,409);
 const response=await send(input);assert.equal(response.status,200);assert.deepEqual(await(await send(input)).json(),await response.json());
 assert.deepEqual((await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.tenant,input.requestId,'materials/'+source.sha256+'.bin'])).rows[0].bytes,bytes);
 const project=await f.orgs.personalProject(f.users.bob,f.tenant,input.requestId);assert.equal(project.state.sources[0].sha256,source.sha256);assert.equal(project.state.sources[0].name,'team.md');
 const visible=await new OrganizationDocumentView(f.resources).read(f.users.alice,f.tenant,input.requestId);assert.ok(!JSON.stringify(visible).includes('План: три этапа'));
 assert.equal((await send({...input,requestId:randomUUID()},f.users.alice)).status,409);
 if(process.env.LANKA_SHARED_MATERIAL_BROWSER==='1'){
  const {chromium}=await import('playwright');let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
  handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.bob},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+`/organizations/${f.tenant}#shared/${folder.id}`);await page.getByRole('button',{name:'Новая презентация в папке',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Название в общей папке').fill('Материалы через интерфейс');await dialog.locator('summary').filter({hasText:'Исходные материалы'}).click();await dialog.getByRole('checkbox',{name:'team.md',exact:true}).check();
  const uploadedBytes=Buffer.from('# Новый файл\n\nПоказатель: 25 заявок.'),requests=[];let dropped=false;
  await page.route('**/source-intakes',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   requests.push(route.request().postDataJSON());
   if(!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('connectionfailed');}
   return route.continue();
  });
  const chooser=page.waitForEvent('filechooser');await dialog.getByLabel('Добавить материал в презентацию',{exact:true}).click();await(await chooser).setFiles({name:'uploaded.md',mimeType:'text/markdown',buffer:uploadedBytes});
  await dialog.getByRole('button',{name:'Повторить загрузку',exact:true}).click();const uploadedChoice=dialog.getByRole('checkbox',{name:'uploaded.md',exact:true});await uploadedChoice.check();assert.deepEqual(requests[1],requests[0]);assert.equal(requests.length,2);
  const uploadedList=await intakes.list(f.users.bob,f.tenant);assert.equal(uploadedList.filter(item=>item.name==='uploaded.md').length,1);const uploaded=uploadedList.find(item=>item.name==='uploaded.md');
  await mkdir('out/shared-material-browser',{recursive:true});await dialog.screenshot({path:'out/shared-material-browser/selected.png'});await page.setViewportSize({width:390,height:844});await dialog.screenshot({path:'out/shared-material-browser/mobile.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await dialog.getByRole('button',{name:'Создать и открыть',exact:true}).click();await page.waitForURL(/\/documents\//);const id=new URL(page.url()).pathname.split('/').at(-1);const saved=await f.orgs.personalProject(f.users.bob,f.tenant,id);assert.equal(saved.state.sources[0].sha256,source.sha256);assert.equal(saved.state.sources[1].sha256,uploaded.sha256);assert.deepEqual((await f.db.pool.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[f.tenant,id,'materials/'+uploaded.sha256+'.bin'])).rows[0].bytes,uploadedBytes);await page.reload();assert.deepEqual(errors,[]);
  await writeFile('out/shared-material-browser/result.json',JSON.stringify({checkedAt:new Date().toISOString(),realBackend:true,syntheticIdentity:true,browserSelection:true,browserFileChooser:true,uploadResponseLost:true,exactUploadRetry:true,noDuplicateIntake:true,uploadedBytesExact:true,sourcePersisted:true,reload:true,pageErrors:errors},null,2));
 }
});


test('document source consent pins text and bytes, rejects other keys and survives intake removal',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),intakes=new AgentSourceIntakes(f.orgs,f.root),reader=new DocumentAgentSources(f.resources);
 const uploaded=await intakes.upload(f.users.alice,f.tenant,{requestId:randomUUID(),name:'consent.md',base64:Buffer.from('# Исходник\n\nРазрешённый текст').toString('base64')});
 const id=randomUUID();await new OrganizationWorkspace(f.orgs,f.users.alice,f.tenant,f.root).mutate({requestId:id,command:{action:'create_document',title:'Source consent',folderId:null,empty:true,profile:'focus-v3',sources:[{id:uploaded.id,sha256:uploaded.sha256}]}});
 const preview=await reader.list(f.users.alice,f.tenant,id),source=preview.items[0];assert.equal(source.id,uploaded.id);
 const selected={id:source.id,sha256:source.sha256,contentHash:source.contentHash,acceptPartial:false};
 const issue={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Source QA',capability:'propose',minutes:15,documentSources:[selected],expectedRevision:1};
 await assert.rejects(()=>keys.issue(f.users.alice,f.tenant,id,{...issue,documentSources:[{...selected,contentHash:'0'.repeat(64)}]}),e=>e.status===409);
 const grant=await keys.issue(f.users.alice,f.tenant,id,issue);assert.equal(grant.documentSources.length,1);assert.deepEqual(await keys.issue(f.users.alice,f.tenant,id,issue),grant);
 const actor=delegatedPrincipal(issue.secret);assert.equal((await reader.read(actor,f.tenant,id,source.id)).contentHash,source.contentHash);
 const plain={requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'No materials',capability:'read',minutes:15};await keys.issue(f.users.alice,f.tenant,id,plain);assert.deepEqual((await reader.list(delegatedPrincipal(plain.secret),f.tenant,id)).items,[]);
 const resource=await f.node('material',id);await f.grant(resource,'bob','editor');await denied(()=>reader.list(f.users.bob,f.tenant,id));await denied(()=>keys.issue(f.users.bob,f.tenant,id,{...issue,requestId:randomUUID(),secret:randomBytes(32).toString('hex')}));await denied(()=>reader.list(actor,f.other,id));

 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 const rpc=async(name,args={},secret=issue.secret)=>{const response=await fetch(origin+`/mcp/organizations/${f.tenant}/documents/${id}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});assert.equal(response.status,200);return response.json();};
 const value=reply=>{assert.ok(reply.result&&!reply.result.isError,JSON.stringify(reply));return JSON.parse(reply.result.content[0].text);};
 assert.equal(value(await rpc('lanka_get_document_source',{id:source.id})).contentHash,source.contentHash);assert.deepEqual(value(await rpc('lanka_list_document_sources',{},plain.secret)).items,[]);
 const context=value(await rpc('lanka_get_edit_context'));const proposalRequest={requestId:randomUUID(),expectedRevision:context.revision,title:'Показатель из разрешённого источника',commands:[{op:'set_layout',slideId:context.slides[0].id,value:'chart'},{op:'set_chart',slideId:context.slides[0].id,value:[{label:'Январь',value:15},{label:'Февраль',value:20},{label:'Март',value:25}],unit:'шт.',sourceIds:[source.id]}]};
 const proposed=value(await rpc('lanka_propose_commands',proposalRequest));assert.equal(value(await rpc('lanka_propose_commands',proposalRequest)).proposalId,proposed.proposalId);
 assert.equal((await f.orgs.personalProject(f.users.alice,f.tenant,id)).state.revision,1);
 if(process.env.LANKA_DOCUMENT_SOURCE_BROWSER==='1'){
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+`/organizations/${f.tenant}/documents/${id}`);
  await page.getByRole('button',{name:'Подключить агента',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.locator('summary').filter({hasText:'Источники презентации'}).click();await dialog.getByRole('region',{name:'Источники этой презентации',exact:true}).getByRole('checkbox',{name:'consent.md',exact:true}).check();await dialog.getByText('Что увидит агент: consent.md',{exact:true}).click();await dialog.getByLabel('Название подключения агента').fill('UI source consent');
  const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/agent-delegations'));await dialog.getByRole('button',{name:'Выдать доступ к этой презентации',exact:true}).click();const uiRequest=(await sent).postDataJSON().request;
  await dialog.getByRole('region',{name:'Подключение готово'}).waitFor();assert.equal(value(await rpc('lanka_get_document_source',{id:source.id},uiRequest.secret)).contentHash,source.contentHash);
  await mkdir('out/document-source-browser',{recursive:true});await dialog.evaluate(el=>{el.scrollTop=0;});await dialog.screenshot({path:'out/document-source-browser/consent.png'});await page.setViewportSize({width:390,height:844});await dialog.evaluate(el=>{el.scrollTop=0;});await dialog.screenshot({path:'out/document-source-browser/mobile.png'});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'Dialog content overflows horizontally');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await dialog.getByRole('button',{name:'Отозвать UI source consent',exact:true}).click();const deniedResponse=await fetch(origin+`/mcp/organizations/${f.tenant}/documents/${id}`,{method:'POST',headers:{Authorization:'Bearer '+uiRequest.secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(deniedResponse.status,401);assert.deepEqual(errors,[]);
  await writeFile('out/document-source-browser/result.json',JSON.stringify({checkedAt:new Date().toISOString(),realBackend:true,syntheticIdentity:true,uiConsent:true,mcpReadSelected:true,uiRevocation:true,revokedMcpStatus:401,mobileNoOverflow:true,pageErrors:errors},null,2));
 }


 const sid=randomUUID(),sessions=new WorkspaceSessions(f.resources),bridge=new AgentBridge(f.resources);await sessions.create(f.users.alice,f.tenant,{requestId:sid,title:'Source chat'});await sessions.link(f.users.alice,f.tenant,sid,id);
 const chatRequest={...issue,requestId:randomUUID(),secret:randomBytes(32).toString('hex'),name:'Chat source consent',sourceDocumentId:id};
 const outside=await f.folder();await denied(()=>keys.issue(f.users.alice,f.tenant,null,{...chatRequest,folderId:outside.legacyId}));
 const chatKey=await keys.issue(f.users.alice,f.tenant,null,chatRequest);await bridge.bind(f.users.alice,f.tenant,sid,{delegationId:chatKey.id,expectedDelegationId:null,taskBound:true});
 const message=await bridge.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Предложи диаграмму по разрешённому источнику',task:{mode:'propose',documentId:id}});
 const chatRpc=async(name,args={},secret=chatRequest.secret)=>{const r=await fetch(origin+`/mcp/organizations/${f.tenant}`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);return r.json();};
 assert.equal(value(await chatRpc('lanka_get_document_source',{documentId:id,id:source.id})).contentHash,source.contentHash);
 const chatProposal={...proposalRequest,requestId:randomUUID(),documentId:id,task:{sessionId:sid,messageId:message.id}};
 assert.ok((await chatRpc('lanka_propose_commands',chatProposal)).result.isError);value(await chatRpc('lanka_receive_message',{sessionId:sid}));const chatProposed=value(await chatRpc('lanka_propose_commands',chatProposal));assert.ok(chatProposed.proposalId);
 await bridge.cancel(f.users.alice,f.tenant,sid,message.id);assert.ok((await chatRpc('lanka_propose_commands',chatProposal)).result.isError);

 if(process.env.LANKA_DOCUMENT_SOURCE_BROWSER==='1'){
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+`/organizations/${f.tenant}/documents/${id}?chat`);await page.getByRole('combobox',{name:'Беседа',exact:true}).selectOption(sid);const binding=page.locator('.workspace-chat-binding');await binding.locator(':scope > summary').click();await binding.getByRole('button',{name:'Подключить агента',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.locator('summary').filter({hasText:'Источники презентации'}).click();await dialog.getByRole('region',{name:'Источники этой презентации',exact:true}).getByRole('checkbox',{name:'consent.md',exact:true}).check();await dialog.getByLabel('Название подключения агента').fill('UI chat materials');
  const sent=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/agent-delegations'));await dialog.getByRole('button',{name:'Выдать ключ и связать беседу',exact:true}).click();const ui=(await sent).postDataJSON().request;await dialog.getByRole('region',{name:'Подключение готово'}).waitFor();assert.equal(ui.sourceDocumentId,id);assert.equal(value(await chatRpc('lanka_get_document_source',{documentId:id,id:source.id},ui.secret)).contentHash,source.contentHash);
  const state=await bridge.read(f.users.alice,f.tenant,sid);assert.equal(state.binding.id,ui.requestId);assert.equal(state.binding.taskBound,true);
  await mkdir('out/chat-source-browser',{recursive:true});await dialog.evaluate(el=>{el.scrollTop=0;});await dialog.screenshot({path:'out/chat-source-browser/connection.png'});await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));assert.deepEqual(errors,[]);
  await page.keyboard.press('Escape');await page.getByLabel('Сообщение',{exact:true}).fill('Проверь разрешённый материал этой презентации');const sentMessage=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/conversations/'+sid)&&r.request().postDataJSON()?.action==='send');await page.getByRole('button',{name:'Отправить',exact:true}).click();assert.equal((await sentMessage).status(),200);
  const received=value(await chatRpc('lanka_receive_message',{sessionId:sid},ui.secret));assert.equal(received.message.text,'Проверь разрешённый материал этой презентации');assert.equal(received.message.task.documentId,id);assert.equal(value(await chatRpc('lanka_get_document_source',{documentId:id,id:source.id},ui.secret)).contentHash,source.contentHash);
  const {CorporateMcpClient}=await import('../../runtime/corporate-mcp-client.mjs'),{ScopedBridgeTools}=await import('../../runtime/scoped-bridge-tools.mjs');const client=new CorporateMcpClient({url:origin+`/mcp/organizations/${f.tenant}`,token:ui.secret});await client.initialize();const facade=new ScopedBridgeTools({client,mode:'discuss',documentId:id,task:{sessionId:sid,messageId:received.message.id,executionId:randomUUID()},awaitRunning:async()=>{throw Error('No model write expected');}});assert.ok((await facade.tools()).some(t=>t.name==='lanka_get_document_source'));assert.equal(JSON.parse((await facade.call('lanka_get_document_source',{id:source.id})).content[0].text).contentHash,source.contentHash);
  value(await chatRpc('lanka_reply_message',{sessionId:sid,requestId:randomUUID(),replyTo:received.message.id,text:'Тестовый MCP-клиент прочитал выбранный источник.'},ui.secret));await page.getByText('Тестовый MCP-клиент прочитал выбранный источник.',{exact:true}).waitFor();await page.reload();await page.getByText('Тестовый MCP-клиент прочитал выбранный источник.',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  await writeFile('out/chat-source-browser/result.json',JSON.stringify({checkedAt:new Date().toISOString(),realBackend:true,syntheticIdentity:true,sourceSelectedInChat:true,uiMessageDelivered:true,mcpReplyVisible:true,workerFacadeRead:true,replySurvivesReload:true,realModel:false,workspaceKeyBound:true,taskBound:true,mcpReadSource:true,mobileDialogNoOverflow:true,pageErrors:errors},null,2));
 }
 const beforeReview=await f.orgs.personalProject(f.users.alice,f.tenant,id);
 assert.equal(beforeReview.state.proposals.find(p=>p.id===proposed.proposalId).changes[0].sourceDependencies[0].contentHash,source.contentHash);
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,sources,0,excerpt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,'Changed during review']);
 if(process.env.LANKA_DOCUMENT_SOURCE_BROWSER==='1'){
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+`/organizations/${f.tenant}/documents/${id}?review=${proposed.proposalId}`);
  const board=page.locator('.proposal-board');await board.getByText('Источник предложения изменился или удалён. Попросите агента проверить актуальные данные и предложить правку заново.',{exact:true}).waitFor();
  assert.equal(await board.getByRole('button',{name:/Принять оставшиеся правки/}).isDisabled(),true);assert.equal(await board.getByRole('checkbox',{name:'Выбрать правки слайда 1'}).isDisabled(),true);assert.equal(await board.getByRole('button',{name:'Отклонить оставшиеся',exact:true}).isEnabled(),true);
  await mkdir('out/source-review-browser',{recursive:true});await page.screenshot({path:'out/source-review-browser/desktop.png'});await page.setViewportSize({width:390,height:844});await board.getByText('Источник предложения изменился или удалён. Попросите агента проверить актуальные данные и предложить правку заново.',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'out/source-review-browser/mobile.png'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,sources}', $3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,JSON.stringify(beforeReview.state.sources)]);
  await page.reload();await board.getByRole('button',{name:/Принять оставшиеся правки/}).waitFor();await page.waitForFunction(()=>{const b=[...document.querySelectorAll('.proposal-board button')].find(b=>b.textContent.includes('Принять оставшиеся правки'));return b&&!b.disabled;});
  assert.equal(await board.getByRole('checkbox',{name:'Выбрать правки слайда 1'}).isEnabled(),true);
  await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,sources,0,excerpt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,'Changed during review']);
  await writeFile('out/source-review-browser/result.json',JSON.stringify({checkedAt:new Date().toISOString(),realBackend:true,syntheticIdentity:true,warningVisible:true,acceptDisabled:true,selectionDisabled:true,rejectionEnabled:true,unchangedSourceReenablesAcceptance:true,mobileNoOverflow:true,pageErrors:errors},null,2));
 }
 const staleReview=await fetch(origin+`/api/organizations/${f.tenant}/documents/${id}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'accept',proposalId:proposed.proposalId,changeIds:proposed.changes.map(c=>c.id)}})});
 assert.equal(staleReview.status,409);assert.match(await staleReview.text(),/Источник предложения изменился/);
 const unchanged=await f.orgs.personalProject(f.users.alice,f.tenant,id);assert.equal(unchanged.state.revision,1);assert.deepEqual(unchanged.state.doc,beforeReview.state.doc);assert.deepEqual(unchanged.state.proposals,beforeReview.state.proposals);
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,sources}', $3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,JSON.stringify(beforeReview.state.sources)]);
 const accepted=await fetch(origin+`/api/organizations/${f.tenant}/documents/${id}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'accept',proposalId:proposed.proposalId,changeIds:proposed.changes.map(c=>c.id)}})});assert.equal(accepted.status,200);const afterAcceptance=await f.orgs.personalProject(f.users.alice,f.tenant,id);assert.equal(afterAcceptance.state.revision,2);assert.ok(afterAcceptance.state.doc.slides[0].sourceIds.includes(source.id));
 await intakes.remove(f.users.alice,f.tenant,{id:uploaded.id,sha256:uploaded.sha256});assert.equal((await reader.read(actor,f.tenant,id,source.id)).contentHash,source.contentHash);
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,sources,0,name}','\"Изменённое имя\"'::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,id]);
 const replay=await rpc('lanka_propose_commands',proposalRequest);assert.ok(replay.result?.isError||replay.error);
 assert.deepEqual((await reader.list(actor,f.tenant,id)).items,[]);await assert.rejects(()=>reader.read(actor,f.tenant,id,source.id),e=>e.status===404);
 await keys.revoke(f.users.alice,f.tenant,id,issue.requestId);await denied(()=>reader.list(actor,f.tenant,id));
});

for(const taskBound of [false,true])test('corporate MCP proposes full draft in the same document and human accepts all slides'+(taskBound?' through task-bound chat':''),async t=>{
 const f=await fixture(t),id=randomUUID(),intakes=new AgentSourceIntakes(f.orgs,f.root);
 const upload=await intakes.upload(f.users.alice,f.tenant,{requestId:randomUUID(),name:'cities.md',base64:Buffer.from('Города объединяли ремесло, обмен и управление. Письмо помогало сохранять записи.').toString('base64')});
 await new OrganizationWorkspace(f.orgs,f.users.alice,f.tenant,f.root).mutate({requestId:id,command:{action:'create_document',title:'История городов',profile:'focus-v3',empty:true,folderId:null,sources:[{id:upload.id,sha256:upload.sha256}]}});
 const original=await f.orgs.personalProject(f.users.alice,f.tenant,id),source=(await new DocumentAgentSources(f.resources).list(f.users.alice,f.tenant,id)).items[0];
 const secret=randomBytes(32).toString('hex');const key=await new AgentDelegations(f.resources).issue(f.users.alice,f.tenant,taskBound?null:id,{...(taskBound?{sourceDocumentId:id}:{}),requestId:randomUUID(),secret,name:'Draft QA',capability:'propose',minutes:15,expectedRevision:1,documentSources:[{id:source.id,sha256:source.sha256,contentHash:source.contentHash,acceptPartial:false}]});
 let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const origin='http://127.0.0.1:'+server.address().port;
 handler=corporateNodeHandler(createCorporateApplication({config:{origin},handle:async()=>null,authenticate:async()=>f.users.alice},f.orgs,{runtimeRoot:f.root,assetRoot:'.project-runtime'}),origin);
 let task;const sid=randomUUID(),bridge=new AgentBridge(f.resources);let chatPage,chatErrors=[];
 if(taskBound){const sessions=new WorkspaceSessions(f.resources);await sessions.create(f.users.alice,f.tenant,{requestId:sid,title:'Первое заполнение'});await sessions.link(f.users.alice,f.tenant,sid,id);await bridge.bind(f.users.alice,f.tenant,sid,{delegationId:key.id,expectedDelegationId:null,taskBound:true});}
 const rpc=async(name,args={})=>{const response=await fetch(origin+`/mcp/organizations/${f.tenant}`+(taskBound?'':`/documents/${id}`),{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:taskBound&&!['lanka_receive_message','lanka_reply_message'].includes(name)?{documentId:id,...args,...(name==='lanka_propose_draft'&&task?{task}: {})}:args}})});return response.json();};
 const value=r=>{assert.ok(r.result&&!r.result.isError,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
 assert.equal(value(await rpc('lanka_get_edit_context')).canProposeDraft,true);assert.equal(value(await rpc('lanka_get_document_source',{id:source.id})).contentHash,source.contentHash);
 const request={requestId:randomUUID(),expectedRevision:1,title:'Города и письмо',slides:[{layout:'cover',title:'Как возникали города\nи сохранялись знания',body:'Ремесло, обмен и управление: обсуждаем, как совместная жизнь меняла общество и почему ему понадобились письменные записи.'},{layout:'split',title:'Города соединяли занятия\nи накапливали знания',body:'Совместная жизнь\nРемесло, обмен и управление объединялись в одном месте. Люди могли обмениваться результатами своего труда и решать общие задачи.\n\nСохранение сведений\nПисьмо помогало сохранять записи. Знания становились доступны за пределами устного разговора и личной памяти.',sourceIds:[source.id]},{layout:'closing',title:'Обсудим роль знаний\nв совместной жизни',body:'Как хранение сведений меняло жизнь города? Сопоставим ремесло, обмен и управление, затем сформулируем вопросы для следующего занятия.'}]};
 if(taskBound){
  assert.ok((await rpc('lanka_propose_draft',request)).result.isError);
  if(process.env.LANKA_DOCUMENT_SOURCE_BROWSER==='1'){
   const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());chatPage=await browser.newPage({viewport:{width:1440,height:1000}});chatPage.on('pageerror',e=>chatErrors.push(e.message));await chatPage.goto(origin+`/organizations/${f.tenant}/documents/${id}?chat`);await chatPage.getByRole('combobox',{name:'Беседа',exact:true}).selectOption(sid);
   await chatPage.getByText('Заполнить эту презентацию',{exact:false}).first().waitFor();assert.equal(await chatPage.getByLabel('Действие агента').inputValue(),'propose');assert.equal(await chatPage.locator('.workspace-chat-target input').isChecked(),false);
   const send=async text=>{await chatPage.getByLabel('Сообщение',{exact:true}).fill(text);const response=chatPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/conversations/'+sid)&&r.request().postDataJSON()?.action==='send');await chatPage.getByRole('button',{name:'Отправить',exact:true}).click();assert.equal((await response).status(),200);};
   await send('Пробное поручение для отмены');const cancelled=value(await rpc('lanka_receive_message',{sessionId:sid}));task={sessionId:sid,messageId:cancelled.message.id};
   const cancel=chatPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/conversations/'+sid)&&r.request().postDataJSON()?.action==='cancel');await chatPage.getByRole('button',{name:'Отменить поручение',exact:true}).click();assert.equal((await cancel).status(),200);assert.ok((await rpc('lanka_propose_draft',request)).result.isError);
   await send('Заполни эту презентацию по материалам о городах');
  }else{const cancelled=await bridge.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Отмена',task:{mode:'propose',documentId:id}});await rpc('lanka_receive_message',{sessionId:sid});task={sessionId:sid,messageId:cancelled.id};await bridge.cancel(f.users.alice,f.tenant,sid,cancelled.id);assert.ok((await rpc('lanka_propose_draft',request)).result.isError);await bridge.send(f.users.alice,f.tenant,sid,{requestId:randomUUID(),text:'Заполни',task:{mode:'propose',documentId:id}});}
  const received=value(await rpc('lanka_receive_message',{sessionId:sid}));assert.equal(received.message.task.mode,'propose');assert.equal(received.message.task.documentId,id);assert.ok(!received.message.task.limitToSelection);task={sessionId:sid,messageId:received.message.id};
 }
 const result=value(await rpc('lanka_propose_draft',request));assert.equal(value(await rpc('lanka_propose_draft',request)).proposalId,result.proposalId);assert.equal(result.kind,'draft');assert.equal(result.slideCount,3);assert.equal(result.decision,'pending');const summary=value(await rpc('lanka_get_edit_context')).proposals.find(p=>p.id===result.proposalId);assert.equal(summary.kind,'draft');assert.equal(summary.slideCount,3);
 if(taskBound){value(await rpc('lanka_reply_message',{sessionId:sid,requestId:randomUUID(),replyTo:task.messageId,text:'Тестовый MCP-клиент подготовил три слайда для проверки.',results:[{documentId:id,revision:1,proposalId:result.proposalId}]}));assert.ok((await rpc('lanka_propose_draft',request)).result.isError);}
 const pending=await f.orgs.personalProject(f.users.alice,f.tenant,id);assert.deepEqual(pending.state.doc,original.state.doc);assert.equal(pending.state.revision,1);const candidate=pending.state.proposals.find(p=>p.id===result.proposalId);assert.equal(candidate.draftCandidate.after.slides.length,3);assert.equal(candidate.draftCandidate.after.slides[0].id,original.state.doc.slides[0].id);assert.deepEqual(candidate.draftCandidate.after.brand,original.state.doc.brand);assert.equal(candidate.changes[0].sourceDependencies[0].id,source.id);
 const candidatePreview=value(await rpc('lanka_preview_proposal',{proposalId:result.proposalId}));assert.equal(candidatePreview.after.slides.length,3);assert.equal(candidatePreview.slideCount,3);assert.equal(candidatePreview.kind,'draft');
 const accept=()=>fetch(origin+`/api/organizations/${f.tenant}/documents/${id}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deckId:id,expectedRevision:1,command:{action:'accept',proposalId:result.proposalId,changeIds:result.changes.map(c=>c.id)}})});
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,doc,title}',to_jsonb($3::text)) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,'Ручная правка']);assert.equal((await accept()).status,409);
 await f.db.pool.query("UPDATE lanka.materials SET project=jsonb_set(project,'{state,doc}', $3::jsonb) WHERE tenant_id=$1 AND id=$2",[f.tenant,id,JSON.stringify(original.state.doc)]);
 if(process.env.LANKA_DOCUMENT_SOURCE_BROWSER==='1'){
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=chatPage??await browser.newPage({viewport:{width:1440,height:1000}}),errors=chatPage?chatErrors:[];if(!chatPage)page.on('pageerror',e=>errors.push(e.message));if(chatPage){await page.locator('.workspace-chat-result').filter({hasText:'Города и письмо'}).waitFor();await page.getByText('Первое заполнение · слайдов: 3',{exact:true}).waitFor();await page.reload();await page.locator('.workspace-chat-result').filter({hasText:'Города и письмо'}).waitFor();await mkdir('out/draft-candidate-browser',{recursive:true});await page.screenshot({path:'out/draft-candidate-browser/chat-card.png'});await page.locator('.workspace-chat-result').filter({hasText:'Города и письмо'}).click();}else await page.goto(origin+`/organizations/${f.tenant}/documents/${id}?review=${result.proposalId}`);
  const board=page.locator('.proposal-board');await board.getByRole('button',{name:'Принять презентацию (3)'}).waitFor();assert.equal(await board.locator('.review-change').count(),1);
  const next=board.getByRole('button',{name:'Следующий предложенный слайд'}),previous=board.getByRole('button',{name:'Предыдущий предложенный слайд'});assert.equal(await previous.isDisabled(),true);await next.click();await board.getByRole('heading',{name:/Слайд 2 ·/}).waitFor();await next.click();await board.getByRole('heading',{name:/Слайд 3 ·/}).waitFor();assert.equal(await next.isDisabled(),true);await previous.click();await board.getByRole('heading',{name:/Слайд 2 ·/}).waitFor();
  await mkdir('out/draft-candidate-browser',{recursive:true});await page.screenshot({path:'out/draft-candidate-browser/paged-review.png'});
  await board.getByLabel('Предложенный слайд',{exact:true}).selectOption('');assert.equal(await board.locator('.review-change').count(),3);
  await mkdir('out/draft-candidate-browser',{recursive:true});await page.screenshot({path:'out/draft-candidate-browser/review.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await board.getByLabel('Предложенный слайд',{exact:true}).selectOption(candidate.draftCandidate.after.slides[0].id);await board.getByRole('navigation',{name:'Слайды предложенной презентации'}).evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:'out/draft-candidate-browser/paged-mobile.png'});await board.getByRole('button',{name:'Принять презентацию (3)'}).scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'out/draft-candidate-browser/mobile.png'});
  const accepted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/documents/'+id));await board.getByRole('button',{name:'Принять презентацию (3)'}).click();assert.equal((await accepted).status(),200);await page.reload();if(chatPage){await page.locator('.workspace-chat-result').filter({hasText:'Рассмотрено · принято'}).click();}await page.getByText('Предложенная презентация · слайдов: 3',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  await writeFile(taskBound?'out/draft-candidate-browser/chat-result.json':'out/draft-candidate-browser/result.json',JSON.stringify({checkedAt:new Date().toISOString(),realBackend:true,syntheticIdentity:true,realModel:false,taskBound,chatMessageSent:taskBound,cancelledTaskCannotWrite:taskBound,replyClosesWrite:taskBound,resultCardOpensReview:taskBound,mcpCandidate:true,pagedPreview:true,pageBoundaries:true,allSlidesMode:true,previewSlides:3,humanBrowserAcceptance:true,sameDocument:true,reloadHistory:true,pageErrors:errors},null,2));
 }else assert.equal((await accept()).status,200);
 const final=await f.orgs.personalProject(f.users.alice,f.tenant,id);assert.equal(final.state.doc.id,id);assert.equal(final.state.doc.title,original.state.doc.title);assert.equal(final.state.doc.slides.length,3);assert.equal(final.state.revision,2);assert.deepEqual(final.state.sources,original.state.sources);assert.equal(value(await rpc('lanka_get_edit_context')).canProposeDraft,false);assert.ok((await rpc('lanka_propose_draft',{...request,requestId:randomUUID(),expectedRevision:2})).result.isError);
});


test('pending library metadata remains inside the delegated folder and paginates before the limit',async t=>{
 const f=await fixture(t),keys=new AgentDelegations(f.resources),library=new AgentLibrary(f.resources,f.root),folder=await f.folder();
 const outside=await f.material(),inside=[];
 for(let i=0;i<52;i++)inside.push(await f.material('alice',folder.legacyId));
 const secret=randomBytes(32).toString('hex'),requestId=randomUUID();await keys.issue(f.users.alice,f.tenant,null,{requestId,secret,name:'Pending scope',capability:'organize',minutes:15,folderId:folder.legacyId});const actor=delegatedPrincipal(secret);
 // This query-only fixture needs only the status field consumed by the metadata projection.
 await f.db.pool.query(`UPDATE lanka.materials SET project=jsonb_set(project,'{state,proposals}','[{"status":"pending"}]'::jsonb) WHERE tenant_id=$1`,[f.tenant]);
 const first=await library.list(actor,f.tenant,{kind:'documents',pendingOnly:true}),next=await library.list(actor,f.tenant,{kind:'documents',pendingOnly:true,cursor:first.nextCursor});
 assert.equal(first.items.length,50);assert.equal(next.items.length,2);assert.equal(next.nextCursor,null);
 assert.deepEqual([...first.items,...next.items].map(d=>d.id).sort(),inside.map(d=>d.legacyId).sort());
 assert.deepEqual((await library.list(actor,f.tenant,{kind:'documents',pendingOnly:true,id:outside.legacyId})).items,[]);
 await keys.revoke(f.users.alice,f.tenant,null,requestId);await denied(()=>library.list(actor,f.tenant,{kind:'documents',pendingOnly:true}));
});


test('brief proposals stay out of shared agent context and preview even if marked shared',async t=>{
 const f=await fixture(t),doc=await f.material(),repo=f.ws('alice').repository(doc.legacyId),keys=new AgentDelegations(f.resources),proposals=new OrganizationDocumentProposals(f.resources);
 let proposalId;
 await repo.mutate(randomUUID(),{test:'brief-private'},p=>{const proposal=proposeBrief(p.state,{audience:'PRIVATE_BRIEF_REVIEW'},'PRIVATE_BRIEF_TITLE','Owner');proposal.visibility='shared';proposalId=proposal.id;p.state.proposals.push(proposal);return {project:p,result:{}};});
 const secret=randomBytes(32).toString('hex');await keys.issue(f.users.alice,f.tenant,doc.legacyId,{requestId:randomUUID(),secret,name:'Scoped agent',capability:'propose',minutes:15});
 const actor=delegatedPrincipal(secret),context=await proposals.context(actor,f.tenant,doc.legacyId);
 assert.ok(!JSON.stringify(context).includes('PRIVATE_BRIEF'));assert.ok(!context.proposals.some(p=>p.id===proposalId));await denied(()=>proposals.preview(actor,f.tenant,doc.legacyId,proposalId));
});
