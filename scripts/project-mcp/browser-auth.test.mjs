import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {SignJWT,generateKeyPair,exportJWK} from 'jose';

await mkdir('.test-build',{recursive:true});
await build({stdin:{contents:`export {ChatDatabase} from './lib/adapters/postgres/chat-database';
 export {PostgresBrowserIdentityStore} from './lib/adapters/postgres/browser-identity';
 export {OidcBrowserAuth,oidcBrowserConfigSchema} from './lib/server/oidc-browser-auth';
 export {withBrowserIdentity} from './lib/server/browser-auth-gate';
 export {PostgresOrganizationAccess,provisionOrganization} from './lib/adapters/postgres/organization-access';
 export {organizationApi} from './lib/server/organization-api';
 export {createCorporateApplication,corporateNodeHandler} from './lib/server/corporate-http';export {PostgresResourceAccess} from './lib/adapters/postgres/resource-access';`,resolveDir:process.cwd()},
 outfile:'.test-build/browser-auth.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {ChatDatabase,PostgresBrowserIdentityStore,OidcBrowserAuth,oidcBrowserConfigSchema,withBrowserIdentity,PostgresOrganizationAccess,provisionOrganization,organizationApi,createCorporateApplication,corporateNodeHandler,PostgresResourceAccess}=await import('../../.test-build/browser-auth.mjs');
const base=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
const digest=value=>createHash('sha256').update(value).digest('base64url');
const cookieValue=(response,name)=>response.headers.getSetCookie().find(v=>v.startsWith(name+'='))?.split(';')[0];

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'lanka-auth-')),id=randomUUID(),issuer=`https://idp.test/${id}`;
 const db=new ChatDatabase({...base,tenantId:randomUUID(),ownerId:randomUUID(),runtimeRoot:root});
 let server;const codes=new Map(),requests=[],tenants=[];
 t.after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  for(const tenant of tenants){for(const table of ['command_receipts','blobs','export_artifacts','material_revisions','materials','catalog_receipts','catalog_folders','workspace_catalogs','organization_receipts','organization_audit','organization_memberships','principals'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[tenant]);await db.pool.query('DELETE FROM lanka.tenants WHERE id=$1',[tenant]);}
  await db.pool.query('DELETE FROM lanka.browser_logins WHERE deployment IN (SELECT DISTINCT deployment FROM lanka.browser_sessions s JOIN lanka.auth_identities i ON i.id=s.identity_id WHERE i.issuer=$1)',[issuer]);
  await db.pool.query('DELETE FROM lanka.browser_logins WHERE deployment=ANY($1::text[])',[deployments]);
  await db.pool.query('DELETE FROM lanka.auth_identities WHERE issuer=$1',[issuer]);
  await db.pool.query('DELETE FROM lanka.agent_connections WHERE tenant_id=$1',[db.tenant]);
  await db.close();await rm(root,{recursive:true,force:true});
 });
 const deployments=[];await db.init();
 const keys=await generateKeyPair('RS256'),badKeys=await generateKeyPair('RS256');
 const jwk={...await exportJWK(keys.publicKey),alg:'RS256',use:'sig',kid:'test-key'};
 let metadataOverrides={};
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://provider');requests.push(url.pathname);
  const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(url.pathname.endsWith('/.well-known/openid-configuration'))return json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256'],...metadataOverrides});
  if(url.pathname.endsWith('/jwks'))return json({keys:[jwk]});
  if(url.pathname.endsWith('/token')) {
   let body='';for await(const chunk of req)body+=chunk;
   const p=new URLSearchParams(body),code=p.get('code'),record=codes.get(code);codes.delete(code);
   if(req.headers.authorization!==`Basic ${Buffer.from('lanka:secret').toString('base64')}`||!record||digest(p.get('code_verifier')??'')!==record.challenge||p.get('redirect_uri')!==record.redirect)return json({error:'invalid_grant'},400);
   const {overrides}=record,now=Math.floor(Date.now()/1000);
   const claims={iss:issuer,sub:'alice',aud:'lanka',iat:now,exp:now+3600,nonce:record.nonce,email:'shared@example.test',email_verified:true,...overrides};
   delete claims.badSignature;delete claims.omitIdToken;
   const idToken=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(overrides.badSignature?badKeys.privateKey:keys.privateKey);
   return json({access_token:'not-for-browser',token_type:'Bearer',expires_in:3600,...(overrides.omitIdToken?{}:{id_token:idToken})});
  }
  json({error:'unknown'},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const local=`http://127.0.0.1:${server.address().port}`;
 const transport=(url,options)=>{const target=new URL(url);return fetch(local+target.pathname+target.search,options);};
 const config={origin:'https://lanka.test',issuer,clientId:'lanka',clientSecret:'secret'},store=new PostgresBrowserIdentityStore(db.pool);
 const open=async(extra={})=>{const a=await OidcBrowserAuth.open({...config,...extra},store,transport);deployments.push(a.deployment);return a;};
 const auth=await open();
 const request=(path,headers={},method='GET')=>new Request(config.origin+path,{method,headers});
 const begin=async(extra='',a=auth)=>{
  const r=await a.handle(new Request(a.config.origin+'/auth/login'+extra));assert.equal(r.status,302);
  const target=new URL(r.headers.get('location'));assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  assert.ok(target.searchParams.get('nonce'));assert.ok(target.searchParams.get('state'));
  return {target,cookie:cookieValue(r,'__Host-lanka_login')};
 };
 const finish=async(login,overrides={},headers={},a=auth,handle=req=>a.handle(req))=>{
  const p=login.target.searchParams,code=randomUUID();codes.set(code,{nonce:p.get('nonce'),challenge:p.get('code_challenge'),redirect:p.get('redirect_uri'),overrides});
  const url=new URL(p.get('redirect_uri'));url.searchParams.set('code',code);url.searchParams.set('state',p.get('state'));
  const req=new Request(url,{headers:{cookie:login.cookie,...headers}}),response=await handle(req);
  return {response,request:req,session:cookieValue(response,'__Host-lanka_session')};
 };
 return {db,auth,store,open,request,begin,finish,requests,config,tenants,root,setMetadata:value=>{metadataOverrides=value;}};
}

test('OIDC code flow persists issuer/sub identity, rotates session and discards provider credentials',async t=>{
 const f=await fixture(t),login=await f.begin('?returnTo=%2Fdocuments%2F11111111-1111-4111-8111-111111111111%3Fchat'),done=await f.finish(login);
 assert.equal(done.response.status,302);assert.equal(done.response.headers.get('location'),'/documents/11111111-1111-4111-8111-111111111111?chat');
 const sessionHeader=done.response.headers.getSetCookie().find(v=>v.startsWith('__Host-lanka_session='));
 for(const flag of ['Secure','HttpOnly','SameSite=Lax','Path=/'])assert.ok(sessionHeader.includes(flag));
 const who=await f.auth.authenticate(f.request('/api/library',{cookie:done.session}));assert.equal(who.subject,'alice');assert.equal(who.issuer,f.config.issuer);assert.equal(who.tenantId,undefined);
 const rows=await f.db.pool.query('SELECT * FROM lanka.browser_sessions WHERE identity_id=$1',[who.userId]);assert.equal(rows.rowCount,1);
 assert.ok(!JSON.stringify(rows.rows).includes(done.session.split('=')[1]));assert.ok(!JSON.stringify(rows.rows).includes('not-for-browser'));
 const restarted=await f.open();assert.deepEqual(await restarted.authenticate(f.request('/api/library',{cookie:done.session})),who);
 const again=await f.begin(),rotated=await f.finish(again,{}, {cookie:`${again.cookie}; ${done.session}`});assert.equal(rotated.response.status,302);
 assert.equal(await f.auth.authenticate(f.request('/',{cookie:done.session})),null);
 assert.equal((await f.auth.authenticate(f.request('/',{cookie:rotated.session}))).userId,who.userId);
 assert.ok(f.requests.some(p=>p.endsWith('/jwks')),'ID token signature must be checked');
});

test('state is browser-bound, single-use and atomic under concurrent callbacks',async t=>{
 const f=await fixture(t),a=await f.begin(),b=await f.begin();
 assert.equal((await f.finish(a,{}, {cookie:b.cookie})).response.status,400);
 const done=await f.finish(a);assert.equal(done.response.status,302);
 assert.equal((await f.auth.handle(done.request)).status,400);
 const login=await f.begin(),result=await Promise.all([f.finish(login),f.finish(login)]);
 assert.deepEqual(result.map(r=>r.response.status).sort(),[302,400]);
});

test('invalid signed claims, signature, missing ID token and expired login never establish a session',async t=>{
 const f=await fixture(t);
 for(const claims of [{nonce:'other'},{iss:'https://other.test'},{aud:'other-client'},{exp:1},{badSignature:true},{omitIdToken:true},{sub:''}]) {
  const done=await f.finish(await f.begin(),claims);assert.equal(done.response.status,400,JSON.stringify(claims));
  assert.equal(done.session,undefined);assert.ok(!(await done.response.text()).includes('not-for-browser'));
 }
 const expired=await f.begin();await f.db.pool.query("UPDATE lanka.browser_logins SET expires_at=now()-interval '1 second' WHERE deployment=$1",[f.auth.deployment]);
 assert.equal((await f.finish(expired)).response.status,400);
 assert.equal((await f.db.pool.query('SELECT 1 FROM lanka.auth_identities WHERE issuer=$1',[f.config.issuer])).rowCount,0);
});

test('identities with the same email remain separate; disabled identity cannot sign in',async t=>{
 const f=await fixture(t),a=await f.finish(await f.begin()),b=await f.finish(await f.begin(),{sub:'bob'});
 const aa=await f.auth.authenticate(f.request('/',{cookie:a.session})),bb=await f.auth.authenticate(f.request('/',{cookie:b.session}));
 assert.notEqual(aa.userId,bb.userId);
 await f.db.pool.query('UPDATE lanka.auth_identities SET disabled=true WHERE id=$1',[aa.userId]);
 assert.equal(await f.auth.authenticate(f.request('/',{cookie:a.session})),null);
 assert.equal((await f.finish(await f.begin())).response.status,400);
 assert.ok(await f.auth.authenticate(f.request('/',{cookie:b.session})));
});

test('issuer is part of identity and claims never create organization membership',async t=>{
 const a=await fixture(t),b=await fixture(t);
 const sa=await a.finish(await a.begin(),{tenant_id:a.db.tenant,roles:['admin']}),sb=await b.finish(await b.begin());
 const pa=await a.auth.authenticate(a.request('/',{cookie:sa.session})),pb=await b.auth.authenticate(b.request('/',{cookie:sb.session}));
 assert.equal(pa.subject,pb.subject);assert.notEqual(pa.issuer,pb.issuer);assert.notEqual(pa.userId,pb.userId);
 assert.equal(pa.tenant_id,undefined);assert.equal(pa.roles,undefined);
 const unverified=await a.finish(await a.begin(),{email_verified:false});assert.equal(unverified.response.status,302);
 const row=await a.db.pool.query('SELECT verified_email FROM lanka.auth_identities WHERE id=$1',[pa.userId]);assert.equal(row.rows[0].verified_email,null);
});

test('logout requires same origin, revokes only the session, and expiry and epoch invalidate access',async t=>{
 const f=await fixture(t),a=await f.finish(await f.begin()),b=await f.finish(await f.begin());
 const who=await f.auth.authenticate(f.request('/',{cookie:a.session}));
 assert.equal((await f.auth.handle(f.request('/auth/logout',{cookie:a.session,origin:'https://attacker.test'},'POST'))).status,403);
 assert.ok(await f.auth.authenticate(f.request('/',{cookie:a.session})));
 assert.equal((await f.auth.handle(f.request('/auth/logout',{cookie:a.session,origin:f.config.origin},'POST'))).status,204);
 assert.equal(await f.auth.authenticate(f.request('/',{cookie:a.session})),null);assert.ok(await f.auth.authenticate(f.request('/',{cookie:b.session})));
 await f.db.pool.query('UPDATE lanka.auth_identities SET auth_epoch=auth_epoch+1 WHERE id=$1',[who.userId]);
 assert.equal(await f.auth.authenticate(f.request('/',{cookie:b.session})),null);
 for(const column of ['expires_at','idle_expires_at']) {
  const c=await f.finish(await f.begin());await f.db.pool.query(`UPDATE lanka.browser_sessions SET ${column}=now()-interval '1 second' WHERE deployment=$1`,[f.auth.deployment]);
  assert.equal(await f.auth.authenticate(f.request('/',{cookie:c.session})),null);
 }
});

test('product gate rejects forged headers, cross-origin writes, duplicate cookies and another deployment',async t=>{
 const f=await fixture(t),gate=withBrowserIdentity(f.auth,async(req,p)=>Response.json({userId:p.userId}));
 assert.equal((await gate(f.request('/api/library',{'oai-authenticated-user-id':randomUUID(),'x-tenant-id':randomUUID()}))).status,401);
 const done=await f.finish(await f.begin());
 assert.equal((await gate(f.request('/api/library',{cookie:done.session}))).status,200);
 assert.equal((await gate(f.request('/api/library',{cookie:done.session},'POST'))).status,403);
 assert.equal((await gate(f.request('/api/library',{cookie:done.session,origin:f.config.origin},'POST'))).status,200);
 assert.equal((await gate(f.request('/api/library',{cookie:`${done.session}; ${done.session}`}))).status,401);
 const other=await f.open({origin:'https://another-lanka.test'});
 assert.equal(await other.authenticate(new Request('https://another-lanka.test/api/library',{headers:{cookie:done.session}})),null);
 assert.equal(await f.auth.authenticate(new Request('https://attacker.test/',{headers:{cookie:done.session}})),null);
});

test('configuration and discovery reject insecure endpoints; redirects cannot escape the editor',async t=>{
 const f=await fixture(t);
 assert.equal(oidcBrowserConfigSchema.safeParse({...f.config,origin:'http://127.0.0.1:4317'}).success,false);
 assert.equal(oidcBrowserConfigSchema.safeParse({...f.config,issuer:'https://user:pass@idp.test'}).success,false);
 for(const returnTo of ['https://attacker.test','//attacker.test','/\\attacker.test','/auth/callback','/%2f%2fattacker.test']) {
  const r=await f.finish(await f.begin('?returnTo='+encodeURIComponent(returnTo)));assert.equal(r.response.headers.get('location'),'/');
 }
 f.setMetadata({token_endpoint:'https://unapproved.test/token'});await assert.rejects(f.open(),/Unapproved/);
 f.setMetadata({issuer:'https://other-issuer.test'});await assert.rejects(f.open());
});

test('storage outages fail closed and maintenance removes expired secrets without deleting valid sessions',async t=>{
 const f=await fixture(t),done=await f.finish(await f.begin());
 const invalid=await f.begin();await f.db.pool.query("UPDATE lanka.browser_logins SET expires_at=now()-interval '1 second' WHERE deployment=$1",[f.auth.deployment]);
 await f.store.cleanup();assert.equal((await f.finish(invalid)).response.status,400);
 assert.ok(await f.auth.authenticate(f.request('/',{cookie:done.session})));
 const original=f.store.authenticate;f.store.authenticate=async()=>{throw Error('postgres://private-secret');};
 const r=await withBrowserIdentity(f.auth,async()=>{throw Error('Handler must not run');})(f.request('/api/library',{cookie:done.session}));
 assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private-secret'));f.store.authenticate=original;
});

test('OIDC session → organization HTTP gate → membership grant and revoke for two users and tenants',async t=>{
 const f=await fixture(t),alice=await f.finish(await f.begin()),bob=await f.finish(await f.begin(),{sub:'bob'});
 const pa=await f.auth.authenticate(f.request('/',{cookie:alice.session})),pb=await f.auth.authenticate(f.request('/',{cookie:bob.session}));
 for(const p of [pa,pb]){const id=randomUUID();f.tenants.push(id);await provisionOrganization(f.db.pool,{requestId:id,slug:'test-'+id,name:p.subject,ownerUserId:p.userId});}
 const [a,b]=f.tenants,gate=withBrowserIdentity(f.auth,organizationApi(new PostgresOrganizationAccess(f.db.pool),f.root));
 const get=(path,session)=>gate(f.request(path,{cookie:session}));
 assert.deepEqual((await (await get('/api/organizations',alice.session)).json()).organizations.map(x=>x.id),[a]);
 assert.equal((await get(`/api/organizations/${a}/library`,bob.session)).status,404);
 const edit=status=>gate(new Request(f.config.origin+`/api/organizations/${a}/members`,{method:'POST',headers:{cookie:alice.session,origin:f.config.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),userId:pb.userId,role:'member',status})}));
 assert.equal((await edit('active')).status,200);assert.equal((await get(`/api/organizations/${a}/library`,bob.session)).status,200);
 const docId=randomUUID(),created=await gate(new Request(f.config.origin+`/api/organizations/${a}/library`,{method:'POST',headers:{cookie:alice.session,origin:f.config.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:docId,command:{action:'create_document',title:'Личный план',markdown:'# План\n\n## Решение\nУчебный пример.',folderId:null}})}));
 assert.equal(created.status,200);assert.equal((await get(`/api/organizations/${a}/documents/${docId}`,alice.session)).status,200);
 assert.equal((await get(`/api/organizations/${a}/documents/${docId}`,bob.session)).status,404);
 assert.equal((await edit('suspended')).status,200);assert.equal((await get(`/api/organizations/${a}/library`,bob.session)).status,404);
 assert.equal((await get(`/api/organizations/${b}/library`,bob.session)).status,200);
 assert.equal((await gate(f.request('/api/organizations',{'oai-authenticated-user-id':pa.userId}))).status,401);
});

async function mounted(t,f) {
 const app=createCorporateApplication(f.auth,new PostgresOrganizationAccess(f.db.pool),{runtimeRoot:f.root,assetRoot:join(process.cwd(),'.project-runtime')});
 const server=createServer(corporateNodeHandler(app,f.config.origin));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 return (path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=httpRequest({host:'127.0.0.1',port:server.address().port,path,method,headers:{host:'lanka.test',...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const out=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)out.append(res.rawHeaders[i],res.rawHeaders[i+1]);resolve(new Response([204,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:out}));});
  });req.on('error',reject);req.end(body);
 });
}
async function wireLogin(f,wire,sub='alice',returnTo='/') {
 const response=await wire('/auth/login?returnTo='+encodeURIComponent(returnTo));assert.equal(response.status,302);
 const login={target:new URL(response.headers.get('location')),cookie:cookieValue(response,'__Host-lanka_login')};
 return f.finish(login,{sub},{},f.auth,req=>{const url=new URL(req.url);return wire(url.pathname+url.search,{headers:{cookie:login.cookie}});});
}
test('mounted HTTP server: signed login, organization library, editor save, export and account recovery',async t=>{
 const f=await fixture(t),wire=await mounted(t,f);
 const landing=await wire('/');assert.equal(landing.status,200);assert.match(await landing.text(),/Войти через компанию/);
 assert.equal((await wire('/api/organizations',{headers:{'oai-authenticated-user-id':randomUUID()}})).status,401);
 assert.equal((await wire('/',{headers:{host:'evil.test','x-forwarded-host':'lanka.test'}})).status,403);
 assert.equal((await wire('/\\evil.test/')).status,403);
 const alice=await wireLogin(f,wire),pa=await f.auth.authenticate(f.request('/',{cookie:alice.session}));
 assert.equal(alice.response.headers.getSetCookie().length,2,'callback both sets session and removes login cookie');
 const tenant=randomUUID();f.tenants.push(tenant);await provisionOrganization(f.db.pool,{requestId:tenant,slug:'test-'+tenant,name:'Компания',ownerUserId:pa.userId});
 const headers={cookie:alice.session,'x-lanka-page-user':pa.userId,origin:f.config.origin,'content-type':'application/json'};
 const get=path=>wire(path,{headers});
 const post=(path,value,override={})=>wire(path,{method:'POST',headers:{...headers,...override},body:JSON.stringify(value)});
 const library=`/api/organizations/${tenant}/library`;
 assert.equal((await post(library,{}, {origin:'https://other.test'})).status,403);
 assert.equal((await post(`/api/organizations/${tenant}/members`,{padding:'x'.repeat(5000)})).status,413);
 assert.equal((await get('/organizations/'+tenant)).status,200);
 const shell=await (await get('/')).text();assert.match(shell,new RegExp(`data-user-id="${pa.userId}"`));assert.match(shell,/data-auth="oidc"/);
 assert.equal((await get('/project.js')).headers.get('content-type'),'text/javascript; charset=utf-8');
 assert.equal((await get('/fonts/IBMPlexSans-Regular.ttf')).status,200);
 assert.equal((await get('/config.json')).status,404);
 const folder=randomUUID();assert.equal((await post(library,{requestId:folder,command:{action:'create_folder',name:'Команда'}})).status,200);
 const doc=randomUUID();assert.equal((await post(library,{requestId:doc,command:{action:'create_document',title:'План команды',folderId:folder,markdown:'# План команды\n\n## Решение\nУчебный пример.',profile:'focus-v3'}})).status,200);
 const path=`/api/organizations/${tenant}/documents/${doc}`;
 const page=await get(`/organizations/${tenant}/documents/${doc}?chat`);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const listing=await (await get(library+'?search='+encodeURIComponent('команды')+'&folderId='+folder)).json();assert.equal(listing.documents.length,1);assert.equal(listing.documents[0].id,doc);assert.equal(listing.documents[0].design,'focus-v3');assert.equal(listing.documents[0].preview.slide.title,'Решение');
 assert.equal((await (await get(library+'?search=absent')).json()).documents.length,0);
 const project=await (await get(path)).json(),updated=structuredClone(project.state.doc);updated.slides[0].title='Проверено';
 const save={requestId:randomUUID(),deckId:doc,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:updated}};
 const legacy=structuredClone(save);delete legacy.command.editorContract;
 const refused=await post(path,legacy);assert.equal(refused.status,426);assert.equal((await refused.json()).code,'EDITOR_UPGRADE_REQUIRED');assert.deepEqual(await (await get(path)).json(),project);
 const saved=await post(path,save);assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).revision,2);
 const bob=await wireLogin(f,wire,'bob'),pb=await f.auth.authenticate(f.request('/',{cookie:bob.session}));
 const access=new PostgresOrganizationAccess(f.db.pool);await access.setMembership(pa,tenant,{requestId:randomUUID(),userId:pb.userId,role:'member',status:'active'});
 const changed=await post(path,{...save,requestId:randomUUID(),expectedRevision:2},{cookie:bob.session});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'ACCOUNT_CHANGED');
 assert.equal((await wire(path,{headers:{cookie:bob.session}})).status,404);
 assert.equal((await wire(`/organizations/${tenant}/documents/${doc}`,{headers:{cookie:bob.session}})).status,404);
 const resource=(await f.db.pool.query('SELECT id FROM lanka.resource_nodes WHERE tenant_id=$1 AND material_id=$2',[tenant,doc])).rows[0].id;
 const bobPrincipal=await access.withTenant(pb,tenant,async(c,ctx)=>ctx.principalId),acl=new PostgresResourceAccess(access);
 const grant=role=>acl.mutate(pa,tenant,{requestId:randomUUID(),command:{action:'grant',resourceId:resource,subject:{kind:'principal',id:bobPrincipal},role,canCopy:false}});
 await grant('viewer');
 const sharedLibrary=`/api/organizations/${tenant}/shared-library`;
 const bobList=()=>wire(sharedLibrary+'?search='+encodeURIComponent('команды'),{headers:{cookie:bob.session,'x-lanka-page-user':pb.userId}});
 const sharedListing=await bobList();assert.equal(sharedListing.status,200);assert.equal(sharedListing.headers.get('cache-control'),'no-store');
 assert.deepEqual((await sharedListing.json()).documents.map(d=>d.id),[doc]);
 assert.equal((await wire(sharedLibrary,{headers:{cookie:bob.session,'x-lanka-page-user':pa.userId}})).status,409);
 assert.equal((await wire(sharedLibrary)).status,401);
 const shared=await wire(`/organizations/${tenant}/documents/${doc}`,{headers:{cookie:bob.session}});assert.equal(shared.status,200);assert.match(await shared.text(),/data-document-mode="view"/);
 assert.match(await (await get(`/organizations/${tenant}/documents/${doc}`)).text(),/data-document-mode="editor"/);
 const sharedData=await wire(path+'/view',{headers:{cookie:bob.session,'x-lanka-page-user':pb.userId}});assert.equal(sharedData.status,200);assert.equal((await sharedData.json()).permission.isOwner,false);
 assert.equal((await wire(path,{headers:{cookie:bob.session}})).status,404,'grant never opens owner editor package');
 assert.equal((await wire(path+'/view',{headers:{cookie:bob.session,'x-lanka-page-user':pa.userId}})).status,409);
 await grant(null);assert.equal((await wire(path+'/view',{headers:{cookie:bob.session}})).status,404);
 assert.deepEqual((await (await bobList()).json()).documents,[]);
 assert.equal((await wire(`/organizations/${tenant}/documents/${doc}`,{headers:{cookie:bob.session}})).status,404);

 const sharing=await (await get(path+'/sharing')).json();
 const shareInput={requestId:randomUUID(),expectedEpoch:sharing.authzEpoch,subject:{kind:'principal',id:bobPrincipal},role:'viewer',canCopy:false};
 assert.equal((await post(path+'/sharing',shareInput,{origin:'https://other.test'})).status,403);
 assert.equal((await post(path+'/sharing',shareInput,{cookie:bob.session})).status,409);
 const sharedByHttp=await post(path+'/sharing',shareInput);assert.equal(sharedByHttp.status,200,await sharedByHttp.clone().text());
 assert.deepEqual((await (await bobList()).json()).documents.map(d=>d.id),[doc]);
 assert.equal((await wire(path+'/sharing',{headers:{cookie:bob.session,'x-lanka-page-user':pb.userId}})).status,403);
 const currentSharing=await (await get(path+'/sharing')).json();
 assert.equal((await post(path+'/sharing',{...shareInput,requestId:randomUUID(),expectedEpoch:currentSharing.authzEpoch,role:null})).status,200);
 assert.deepEqual((await (await bobList()).json()).documents,[]);

 const exported=await post(path+'/export',{deckId:doc,expectedRevision:2,format:'pdf'});assert.equal(exported.status,200,await exported.clone().text());assert.ok(exported.headers.get('x-lanka-artifact'));assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0,4).toString(),'%PDF');
 assert.equal((await post(library,{requestId:randomUUID(),command:{action:'trash_document',id:doc,trashed:true}})).status,200);
 assert.equal((await (await get(library)).json()).documents.length,0);assert.equal((await (await get(library+'?trash=1')).json()).documents[0].id,doc);
 assert.equal((await get(path)).status,404);
 assert.equal((await post(library,{requestId:randomUUID(),command:{action:'trash_document',id:doc,trashed:false}})).status,200);
 assert.equal((await get(path)).status,200);
 assert.equal((await wire('/auth/logout',{method:'POST',headers})).status,204);assert.equal((await get(path)).status,401);
 const returned=await wireLogin(f,wire,'alice','/auth/complete');assert.equal(returned.response.headers.get('location'),'/auth/complete');
 const session=await (await wire('/auth/session',{headers:{cookie:returned.session}})).json();assert.equal(session.principal.userId,pa.userId);
 assert.equal((await wire(path,{headers:{cookie:returned.session,'x-lanka-page-user':pa.userId}})).status,200);
 assert.equal((await wire('/auth/complete',{headers:{cookie:returned.session}})).status,200);
});
