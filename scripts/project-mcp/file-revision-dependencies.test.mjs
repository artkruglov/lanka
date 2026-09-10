import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,rm,readFile,writeFile,unlink,symlink,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:"export {ProjectStore} from './scripts/project-mcp/store';export {humanCommand} from './scripts/project-mcp/human';export {initialState} from './lib/domain/model';export {fromMarkdown} from './lib/domain/intake';",resolveDir:process.cwd()},outfile:'.test-build/file-revision-dependencies.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {ProjectStore,humanCommand,initialState,fromMarkdown}=await import('../../.test-build/file-revision-dependencies.mjs');
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-file-history-'))),store=new ProjectStore(root);t.after(()=>rm(root,{recursive:true,force:true}));
 const sha256=await store.writeMaterial(image),doc=fromMarkdown('# Архив\n\n## Город\nПисьмо сохраняет знания.');doc.slides[0].assetId='image';
 const state=initialState(doc);state.sources=[{id:'image',name:'Первоначальное изображение',kind:'image',contentType:'image/png',sha256,createdAt:new Date().toISOString(),excerpt:''}];
 await store.mutate(randomUUID(),{},async()=>({project:{format:'lanka-project/v1',title:doc.title,state,receipts:[]},result:{}}));
 const restore=async(revision,requestId=randomUUID())=>{const p=await store.read();return humanCommand(store,{requestId,deckId:p.state.doc.id,expectedRevision:p.state.revision,command:{action:'restore',revision}});};
 return {root,store,sha256,restore};
}
test('file revision restores its own metadata and deleted current image, retains history and replays once',async t=>{
 const f=await fixture(t),original=await f.store.read(),archive=await f.store.readRevisionDependencies(1);assert.deepEqual((await f.store.readRevisionSources(1)).sources,original.state.sources);
 await f.store.mutate(randomUUID(),{edit:1},async p=>{p.state.doc.title='Новый заголовок';p.state.sources[0].name='Современное имя';p.state.revision++;return {project:p,result:{}};});
 await unlink(join(f.root,'materials',f.sha256+'.bin'));assert.deepEqual((await f.store.readRevisionAsset(1,'image')).bytes,image);assert.equal(archive.snapshot.sources[0].name,'Первоначальное изображение');
 await assert.rejects(()=>f.store.restoreRevision(1),/внутри операции/);
 const requestId=randomUUID(),before=await f.store.read(),input={requestId,deckId:before.state.doc.id,expectedRevision:2,command:{action:'restore',revision:1}};
 assert.deepEqual(await humanCommand(f.store,input),{revision:3});assert.deepEqual(await humanCommand(f.store,input),{revision:3});
 const after=await f.store.read();assert.deepEqual(after.state.sources,original.state.sources);assert.deepEqual(after.state.doc,original.state.doc);assert.equal(after.state.revision,3);assert.deepEqual(after.history[0],original.history[0]);
 assert.deepEqual(await f.store.readFile('materials/'+f.sha256+'.bin'),image);assert.deepEqual((await f.store.readRevisionDependencies(3)).snapshot.sources,original.state.sources);
 assert.deepEqual((await readdir(join(f.root,'revision-files'))),[f.sha256+'.bin']);
});
test('failed archive save leaves project bytes unchanged; absent, corrupt and linked archives fail closed',async t=>{
 const f=await fixture(t),before=await readFile(join(f.root,'project.json')),p=await f.store.read();
 const original=f.store.readFile.bind(f.store);f.store.readFile=async(path,...rest)=>{if(path.startsWith('materials/'))throw Error('injected read failure');return original(path,...rest);};
 await assert.rejects(()=>f.store.mutate(randomUUID(),{},async p=>{p.state.revision++;return {project:p,result:{}};}),/injected read/);f.store.readFile=original;assert.deepEqual(await readFile(join(f.root,'project.json')),before);
 const archivePath=join(f.root,'revision-sources',p.history[0].dependenciesHash+'.json'),archiveBytes=await readFile(archivePath);await writeFile(archivePath,'{}');await assert.rejects(()=>f.restore(1),/hash mismatch/);assert.deepEqual(await readFile(join(f.root,'project.json')),before);
 await unlink(archivePath);await symlink(join(f.root,'project.json'),archivePath);await assert.rejects(()=>f.store.readRevisionDependencies(1));await unlink(archivePath);await writeFile(archivePath,archiveBytes);
 await unlink(join(f.root,'revision-files',f.sha256+'.bin'));await assert.rejects(()=>f.restore(1));assert.deepEqual(await readFile(join(f.root,'project.json')),before);
});
test('legacy snapshots are not backfilled and an aborted restore does not expose staged files',async t=>{
 const f=await fixture(t);await unlink(join(f.root,'materials',f.sha256+'.bin'));
 const before=await readFile(join(f.root,'project.json'));
 await assert.rejects(()=>f.store.mutate(randomUUID(),{},async()=>{await f.store.restoreRevision(1);throw Error('cancelled before commit');}),/cancelled before commit/);
 await assert.rejects(()=>f.store.readFile('materials/'+f.sha256+'.bin'),e=>e.code==='ENOENT');assert.deepEqual(await readFile(join(f.root,'project.json')),before);
 const p=JSON.parse(before);delete p.history[0].dependenciesHash;await writeFile(join(f.root,'project.json'),JSON.stringify(p));
 await f.store.mutate(randomUUID(),{},async p=>{p.state.revision++;return {project:p,result:{}};});
 assert.equal((await f.store.read()).history[0].dependenciesHash,undefined);assert.equal(await f.store.readRevisionSources(1),null);await assert.rejects(()=>f.restore(1),/нет проверяемого архива/);await assert.rejects(()=>f.restore(2),/нет проверяемого архива/);
});
