import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
await build({entryPoints:['lib/design-packages/manifest.ts'],outfile:'.test-build/design-package-manifest.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {createManifest,readManifest,verifyPackage,bytesDigest}=await import('../../.test-build/design-package-manifest.mjs');
const fixture=()=>{
 const blobs=new Map([['render/main.mjs',Buffer.from('renderer A')],['fonts/sans.ttf',Buffer.from('fixture font')],['licenses/font.txt',Buffer.from('fixture license')]]);
 const roles=['renderer','font','license'];
 return {blobs,body:{format:'lanka-design-package/v1',profile:'focus-v3',componentSchema:'fixture/v1',renderer:{entry:'render/main.mjs',buildSha256:bytesDigest(blobs.get('render/main.mjs'))},rules:{title:{size:44,weight:600},recipes:['cover','content']},assets:[...blobs].map(([path,bytes],i)=>({path,role:roles[i],sha256:bytesDigest(bytes),byteLength:bytes.length}))}};
};
test('identity survives JSONB key order and asset enumeration order',()=>{
 const {body,blobs}=fixture(),a=createManifest(body);
 const b=createManifest({...body,assets:[...body.assets].reverse(),rules:{recipes:['cover','content'],title:{weight:600,size:44}}});
 assert.equal(a.digest,b.digest);assert.deepEqual(verifyPackage(JSON.parse(JSON.stringify(a)),blobs),a);
});
test('rules, renderer and font changes create different identities',()=>{
 const {body}=fixture(),a=createManifest(body);
 for(const mutate of [b=>b.rules.title.size=45,b=>b.rules.recipes.reverse(),b=>{b.assets[0].sha256=bytesDigest('renderer B');b.renderer.buildSha256=b.assets[0].sha256;},b=>b.assets[1].sha256=bytesDigest('font B')]){
 const b=structuredClone(body);mutate(b);assert.notEqual(createManifest(b).digest,a.digest);
 }
});
test('rejects corrupted manifest, bytes, missing and extra assets',()=>{
 const {body,blobs}=fixture(),m=createManifest(body);
 assert.throws(()=>readManifest({...m,profile:'focus-v2'}),/digest mismatch/);
 const corrupt=new Map(blobs);corrupt.set('fonts/sans.ttf',Buffer.from('changed font'));assert.throws(()=>verifyPackage(m,corrupt),/asset mismatch/);
 const missing=new Map(blobs);missing.delete('fonts/sans.ttf');assert.throws(()=>verifyPackage(m,missing),/asset set/);
 assert.throws(()=>verifyPackage(m,new Map([...blobs,['extra.txt',Buffer.from('x')]])),/asset set/);
});
test('rejects traversal, duplicates, invalid JSON and unattached renderer',()=>{
 const {body}=fixture();
 for(const mutate of [b=>b.assets[1].path='../outside.ttf',b=>b.assets.push(b.assets[1]),b=>b.rules.bad=undefined,b=>b.rules.bad=Infinity,b=>b.renderer.entry='other.mjs',b=>b.assets[0].role='reference',b=>b.assets=b.assets.filter(a=>a.role!=='license')]){
 const b=structuredClone(body);mutate(b);assert.throws(()=>createManifest(b));
 }
});
