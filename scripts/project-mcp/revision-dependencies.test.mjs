import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:"export * from './lib/project/revision-dependencies';",resolveDir:process.cwd()},outfile:'.test-build/revision-dependencies.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {captureRevisionDependencies,capturedRevisionSource}=await import('../../.test-build/revision-dependencies.mjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=(id,bytes)=>({id,name:'Historical '+id,sha256:hash(bytes),kind:'text',contentType:'text/plain',excerpt:'Original evidence',createdAt:'2026-09-09T00:00:00.000Z'});
const project=sources=>({state:{revision:4,doc:{id:'deck',title:'Original'},sources}});
test('revision capture preserves historical source identity, owns bytes and deduplicates content',async()=>{
 const bytes=Buffer.from('original'),p=project([source('a',bytes),source('b',bytes)]),original=structuredClone(p);let calls=0;
 const result=await captureRevisionDependencies(p,async()=>{calls++;p.state.revision++;p.state.doc.title='Later';p.state.sources[0].name='Later';return bytes;});
 assert.equal(calls,1);assert.equal(result.blobs.length,1);assert.equal(result.snapshot.revision,4);assert.deepEqual(result.snapshot.sources,original.state.sources);
 bytes.fill(0);assert.equal(result.blobs[0].bytes.toString(),'original');
 const selected=capturedRevisionSource(result.snapshot,'a');selected.name='Modified reader copy';assert.equal(result.snapshot.sources[0].name,'Historical a');
 assert.equal(hash(result.bytes),result.hash);assert.deepEqual(JSON.parse(result.bytes),result.snapshot);
 const same=await captureRevisionDependencies(original,async()=>Buffer.from('original'));assert.equal(same.hash,result.hash);
});
test('missing and corrupt historical files cannot silently resolve to current data',async()=>{
 const old=Buffer.from('old'),missing=Buffer.from('missing'),p=project([source('changed',old),source('missing',missing)]);
 const result=await captureRevisionDependencies(p,async key=>key===hash(old)?Buffer.from('new'):undefined);
 assert.deepEqual(result.snapshot.unavailable.map(x=>x.reason).sort(),['hash-mismatch','missing']);assert.equal(result.blobs.length,0);
 assert.throws(()=>capturedRevisionSource(result.snapshot,'changed'),/not captured/);assert.throws(()=>capturedRevisionSource(result.snapshot,'missing'),/not captured/);
 assert.throws(()=>capturedRevisionSource(result.snapshot,'unknown'),/unavailable/);
 await assert.rejects(()=>captureRevisionDependencies(p,async()=>{throw Error('Storage unavailable');}),/Storage unavailable/);
});
test('capture bounds retained bytes and rejects ambiguous source IDs',async()=>{
 const tooBig=Buffer.alloc(5_000_001,1),p=project([source('big',tooBig)]),result=await captureRevisionDependencies(p,async()=>tooBig);
 assert.equal(result.snapshot.unavailable[0].reason,'size-limit');assert.equal(result.blobs.length,0);
 const bytes=Buffer.from('a'),duplicate=await captureRevisionDependencies(project([source('same',bytes),source('same',bytes)]),async()=>bytes);
 assert.throws(()=>capturedRevisionSource(duplicate.snapshot,'same'),/ambiguous/);
 await assert.rejects(()=>captureRevisionDependencies(project([{...source('bad',bytes),sha256:'bad'}]),async()=>bytes),/Invalid dependency hash/);
});

test('capture bounds file reads without inventing completeness for omitted sources',async()=>{
 const files=new Map(Array.from({length:257},(_,i)=>{const bytes=Buffer.from('source-'+i);return [hash(bytes),bytes];}));let reads=0;
 const p=project([...files.values()].map((bytes,i)=>source('s'+i,bytes)));
 const result=await captureRevisionDependencies(p,async key=>{reads++;return files.get(key);});
 assert.equal(reads,256);assert.equal(result.blobs.length,256);assert.equal(result.snapshot.sources.length,257);assert.equal(result.snapshot.unavailable[0].reason,'file-count-limit');
 const omitted=result.snapshot.sources.find(s=>s.sha256===result.snapshot.unavailable[0].sha256);assert.throws(()=>capturedRevisionSource(result.snapshot,omitted.id),/not captured/);
});
