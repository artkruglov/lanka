import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {indexedDB} from 'fake-indexeddb';
globalThis.indexedDB=indexedDB;
await build({stdin:{contents:`export {SceneCanvas} from './components/slide-canvas';export * from './lib/project/browser-context';export {createCorporateTransport} from './lib/project/local-client';export {imageUploadJournal} from './lib/project/image-upload';export {DataWindowDraft,browserDataWindowStore} from './lib/project/data-window-draft';export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.test-build/corporate-client.mjs',bundle:true,format:'esm',platform:'node'});
const {SceneCanvas,corporateContext,scopedApiPath,scopedStorage,browserDatabaseName,createCorporateTransport,imageUploadJournal,DataWindowDraft,browserDataWindowStore,demoDoc}=await import('../../.test-build/corporate-client.mjs');
const ctx={userId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222',documentId:'33333333-3333-4333-8333-333333333333'};
const docBase=`/api/organizations/${ctx.tenantId}/documents/${ctx.documentId}`;
function memory(){const data=new Map();return {get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),clear:()=>data.clear()};}
test('corporate API paths retain filters and asset parameters without leaking loopback document routing',()=>{
 assert.equal(scopedApiPath('/api/organizations',ctx),'/api/organizations');
 assert.equal(scopedApiPath('/api/publications',ctx),docBase+'/publications');
 assert.equal(scopedApiPath('/api/publications/'+ctx.documentId+'/artifacts?kind=preview&page=1&prepared=true',ctx),docBase+'/publications/'+ctx.documentId+'/artifacts?kind=preview&page=1&prepared=true');
 assert.throws(()=>scopedApiPath('/api/publications/bad',ctx));
 assert.throws(()=>scopedApiPath('/api/publications',{...ctx,documentId:null}));
 assert.equal(scopedApiPath('/api/conversations/'+ctx.documentId+'?after=5',ctx),`/api/organizations/${ctx.tenantId}/conversations/${ctx.documentId}?after=5`);
 assert.throws(()=>scopedApiPath('/api/conversations/bad',ctx));
 assert.equal(scopedApiPath('/api/members?search=100%25_&expectedEpoch=2',ctx),`/api/organizations/${ctx.tenantId}/members?search=100%25_&expectedEpoch=2`);
 assert.equal(scopedApiPath('/api/library?search=План&trash=1',ctx),`/api/organizations/${ctx.tenantId}/library?search=%D0%9F%D0%BB%D0%B0%D0%BD&trash=1`);
 for(const [path,suffix] of [['project',''],['shared-comments','/shared-comments'],['images','/images'],['assets','/assets'],['sources','/sources'],['history','/history'],['export','/export'],['export-artifacts','/exports']])assert.equal(scopedApiPath(`/api/${path}?documentId=${ctx.documentId}&id=source`,ctx),docBase+suffix+'?id=source');
 for(const path of ['/api/v1/agent-connections','/api/workspace-connection','/api/project?documentId=../../other'])assert.throws(()=>scopedApiPath(path,ctx));
 assert.throws(()=>scopedApiPath('/api/project',{...ctx,tenantId:null}));
 assert.equal(scopedApiPath('/api/project',null),'/api/project');
});
test('journals enumerate and clear only the same account and organization namespace',()=>{
 const storage=memory(),a=scopedStorage(storage,ctx),b=scopedStorage(storage,{...ctx,tenantId:ctx.documentId}),c=scopedStorage(storage,{...ctx,userId:ctx.documentId});
 storage.setItem('legacy-draft','local');a.setItem('draft','alice');b.setItem('draft','other-org');c.setItem('draft','bob');
 assert.equal(a.length,1);assert.equal(a.key(0),'draft');assert.equal(a.key(1),null);assert.equal(a.getItem('draft'),'alice');
 a.clear();assert.equal(a.length,0);assert.equal(b.getItem('draft'),'other-org');assert.equal(c.getItem('draft'),'bob');assert.equal(storage.getItem('legacy-draft'),'local');
 assert.equal(scopedStorage(storage,null),storage);
});
test('verified page context scopes IndexedDB names and does not activate from URL alone',t=>{
 const oldDoc=globalThis.document,oldLocation=globalThis.location;t.after(()=>{if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
 globalThis.document={body:{dataset:{}}};globalThis.location={pathname:`/organizations/${ctx.tenantId}/documents/${ctx.documentId}`};assert.equal(corporateContext(),null);assert.equal(browserDatabaseName('images'),'images');
 document.body.dataset={auth:'oidc',userId:ctx.userId};assert.deepEqual(corporateContext(),ctx);
 const name=browserDatabaseName('images');location.pathname=`/organizations/${ctx.documentId}`;assert.notEqual(browserDatabaseName('images'),name);
 location.pathname=`/organizations/${ctx.tenantId}`;document.body.dataset.userId=ctx.documentId;assert.notEqual(browserDatabaseName('images'),name);
 document.body.dataset.userId='';assert.throws(()=>corporateContext());
});
test('expired corporate POST is not replayed through local session refresh',async()=>{
 const calls=[];let expired=0;const send=createCorporateTransport(ctx,async(path,init)=>{calls.push({path,init});return Response.json({error:'Войдите'},{status:401});},()=>expired++);
 const body=JSON.stringify({requestId:'stable',command:{title:'Черновик'}});
 await assert.rejects(send('/api/project',{method:'POST',body,headers:{'Content-Type':'application/json'}}),e=>e.status===401);
 assert.equal(calls.length,1);assert.equal(calls[0].path,docBase);assert.equal(calls[0].init.body,body);assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.headers.get('X-Lanka-Page-User'),ctx.userId);assert.equal(expired,1);
});
test('account change blocks the old page while ordinary revision conflicts do not sign it out',async()=>{
 let expired=0;const callback=()=>expired++;
 await assert.rejects(createCorporateTransport(ctx,async()=>Response.json({code:'ACCOUNT_CHANGED',error:'Другой аккаунт'},{status:409}),callback)('/api/project'),e=>e.status===409);assert.equal(expired,1);
 await assert.rejects(createCorporateTransport(ctx,async()=>Response.json({error:'Конфликт версии'},{status:409}),callback)('/api/project'),e=>e.status===409);assert.equal(expired,1);
});
test('corporate network error preserves abort semantics and never retries a write',async()=>{
 let calls=0;const send=createCorporateTransport(ctx,async()=>{calls++;throw Error('network');},()=>assert.fail());
 await assert.rejects(send('/api/project',{method:'POST',body:'request'}),/Правки остаются/);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(send('/api/project',{signal:controller.signal}),/network/);assert.equal(calls,2);
});

test('actual IndexedDB image and unfinished data journals stay isolated across accounts and tenants',async t=>{
 const oldDoc=globalThis.document,oldLocation=globalThis.location;t.after(()=>{if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});
 globalThis.document={body:{dataset:{auth:'oidc',userId:ctx.userId}}};globalThis.location={pathname:`/organizations/${ctx.tenantId}/documents/${ctx.documentId}`};
 const upload={requestId:crypto.randomUUID(),deckId:ctx.documentId,expectedRevision:1,slideId:'slide',name:'photo.png',contentType:'image/png',base64:'aGVsbG8='};
 await imageUploadJournal(ctx.documentId,'tab','write',upload);
 const base={id:'chart',kind:'chart',x:100,y:100,w:800,h:400,style:{design:'focus-v2',brand:demoDoc().brand},data:{seriesId:'series',unit:'hours',rows:[{id:'row',label:'A',value:20}]}};
 const session=new DataWindowDraft({documentId:ctx.documentId,slideId:'slide',owner:'tab',base});const draft=structuredClone(session.record.draft);draft.data.rows[0].value='25,';await session.set(draft);
 for(const change of ['tenant','user']) {
  location.pathname=`/organizations/${change==='tenant'?ctx.documentId:ctx.tenantId}/documents/${ctx.documentId}`;document.body.dataset.userId=change==='user'?ctx.documentId:ctx.userId;
  assert.equal(await imageUploadJournal(ctx.documentId,'tab','read'),null);assert.deepEqual(await browserDataWindowStore.list(ctx.documentId),[]);
  await imageUploadJournal(ctx.documentId,'tab','delete');
 }
 location.pathname=`/organizations/${ctx.tenantId}/documents/${ctx.documentId}`;document.body.dataset.userId=ctx.userId;
 assert.deepEqual(await imageUploadJournal(ctx.documentId,'tab','read'),upload);assert.equal((await browserDataWindowStore.list(ctx.documentId))[0].draft.data.rows[0].value,'25,');
});


test('shared viewer transport stays bound to page organization, document and user',async()=>{
 const ctx={userId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222',documentId:'33333333-3333-4333-8333-333333333333'};
 const calls=[],send=createCorporateTransport(ctx,async(path,init)=>{calls.push([path,init.headers.get('X-Lanka-Page-User')]);return Response.json({});});
 await send('/api/view');await send('/api/view-assets?id=image&revision=2');
 assert.deepEqual(calls,[[`/api/organizations/${ctx.tenantId}/documents/${ctx.documentId}/view`,ctx.userId],[`/api/organizations/${ctx.tenantId}/documents/${ctx.documentId}/view-assets?id=image&revision=2`,ctx.userId]]);
 await assert.rejects(send('/api/organizations/foreign/documents/other/view'));
});

test('shared catalogue transport requires a tenant but no document and retains its value cursor',async()=>{
 const context={...ctx,documentId:null},calls=[];
 const send=createCorporateTransport(context,async(path,init)=>{calls.push([path,init.headers.get('X-Lanka-Page-User'),init.credentials]);return Response.json({});});
 const query=new URLSearchParams({search:'План 100%_',cursor:'2026-09-08T10:00:00.123456Z|'+ctx.documentId});
 await send('/api/shared-library?'+query);
 assert.deepEqual(calls,[[`/api/organizations/${ctx.tenantId}/shared-library?${query}`,ctx.userId,'same-origin']]);
 assert.throws(()=>scopedApiPath('/api/shared-library',{...context,tenantId:null}));
 await assert.rejects(send('/api/organizations/'+ctx.documentId+'/shared-library'));
});

test('sharing reads and writes bind the document and replay no corporate authorization failures',async()=>{
 const calls=[],body=JSON.stringify({requestId:'stable',expectedEpoch:'20',subject:{kind:'group',id:ctx.userId},role:'viewer',canCopy:false});
 const send=createCorporateTransport(ctx,async(path,init)=>{calls.push({path,init});return Response.json({});});
 await send('/api/sharing');await send('/api/sharing-subjects?search=Team');await send('/api/sharing',{method:'POST',body});
 assert.deepEqual(calls.map(c=>c.path),[docBase+'/sharing',docBase+'/sharing-subjects?search=Team',docBase+'/sharing']);
 assert.equal(calls[2].init.body,body);assert.equal(calls[2].init.headers.get('X-Lanka-Page-User'),ctx.userId);
 assert.throws(()=>scopedApiPath('/api/sharing',{...ctx,documentId:null}));
});

test('folder sharing requests bind to the page tenant and an explicit resource ID',()=>{
 const id=ctx.documentId,library={...ctx,documentId:null};assert.equal(scopedApiPath('/api/folder-sharing?resourceId='+id,library),`/api/organizations/${ctx.tenantId}/folder-sharing?resourceId=${id}`);assert.equal(scopedApiPath('/api/folder-sharing-subjects?resourceId='+id+'&search=team',library),`/api/organizations/${ctx.tenantId}/folder-sharing-subjects?resourceId=${id}&search=team`);assert.throws(()=>scopedApiPath('/api/folder-sharing',library));
});

test('static template previews in a corporate library do not require document asset scope',t=>{
 const oldDoc=globalThis.document,oldLocation=globalThis.location;t.after(()=>{if(oldDoc===undefined)delete globalThis.document;else globalThis.document=oldDoc;if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;});globalThis.document={body:{dataset:{auth:'oidc',userId:ctx.userId}}};globalThis.location={pathname:`/organizations/${ctx.tenantId}`};
 const markup=renderToStaticMarkup(createElement(SceneCanvas,{items:[{kind:'rect',x:0,y:0,w:100,h:100,fill:'#ffffff'}],title:'Template preview'}));assert.ok(markup.includes('Template preview'));assert.ok(markup.includes('<rect'));
});
