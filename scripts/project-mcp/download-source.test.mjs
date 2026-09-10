import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:"export {downloadSourceOriginal} from './lib/project/download-source';export {createCorporateTransport} from './lib/project/local-client';",resolveDir:process.cwd()},outfile:'.test-build/download-source.mjs',bundle:true,platform:'node',format:'esm'});
const {downloadSourceOriginal,createCorporateTransport}=await import('../../.test-build/download-source.mjs');
const ctx={userId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222',documentId:'33333333-3333-4333-8333-333333333333'},bytes=Buffer.from('Точный оригинал.');
const source={id:'original',name:'источник.md',sha256:createHash('sha256').update(bytes).digest('hex')};
test('source download preserves page identity, scoped path, exact bytes and filename',async()=>{
 const calls=[],saved=[],transport=createCorporateTransport(ctx,async(path,init)=>{calls.push({path,init});return new Response(bytes);});
 await downloadSourceOriginal(ctx.documentId,source,transport,(blob,name)=>saved.push({blob,name}));
 assert.equal(calls[0].path,`/api/organizations/${ctx.tenantId}/documents/${ctx.documentId}/sources?id=original`);assert.equal(calls[0].init.headers.get('X-Lanka-Page-User'),ctx.userId);assert.equal(saved[0].name,source.name);assert.deepEqual(Buffer.from(await saved[0].blob.arrayBuffer()),bytes);
});
test('failed access or corrupt content never downloads an error response as the original',async()=>{
 const save=()=>assert.fail('No file may be saved');let auth=0;
 const expired=createCorporateTransport(ctx,async()=>Response.json({error:'Войдите'},{status:401}),()=>auth++);
 await assert.rejects(()=>downloadSourceOriginal(ctx.documentId,source,expired,save),/Войдите/);assert.equal(auth,1);
 await assert.rejects(()=>downloadSourceOriginal(ctx.documentId,source,async()=>new Response('wrong bytes'),save),/Контрольная сумма/);
});
