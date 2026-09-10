import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,realpath,rm,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {PDFDocument} from 'pdf-lib';
import JSZip from 'jszip';
await build({stdin:{contents:`export {exportManifestSchema} from './lib/project/export-artifact'; export {ChatDatabase} from './lib/adapters/postgres/chat-database'; export {ProjectStore} from './scripts/project-mcp/store'; export {renderProjectExport} from './scripts/project-mcp/export'; export {fromMarkdown} from './lib/domain/intake'; export {initialState} from './lib/domain/model'; export {canonicalJson} from './lib/domain/canonical-json';`,resolveDir:process.cwd()},outfile:'.project-runtime/export-artifacts-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {exportManifestSchema,ChatDatabase,ProjectStore,renderProjectExport,fromMarkdown,initialState,canonicalJson}=await import('../../.project-runtime/export-artifacts-test.mjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const installed=JSON.parse(await readFile('work/agent-chat/config.json','utf8'));
async function fixture(t,kind){
 const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-export-'))),doc=fromMarkdown('# History\n\n## Shared knowledge\nPeople preserve and exchange ideas.');doc.id=randomUUID();
 const sourceBytes=Buffer.from('Evidence retained with its original snapshot'),source={id:randomUUID(),name:'evidence.txt',kind:'text',sha256:hash(sourceBytes),createdAt:new Date().toISOString(),contentType:'text/plain',excerpt:sourceBytes.toString()};
 let db,store;
 if(kind==='pg'){
  db=new ChatDatabase({...installed,tenantId:randomUUID(),ownerId:randomUUID(),runtimeRoot:root});await db.init();
  await db.create(randomUUID(),doc,null,[source],[{hash:source.sha256,bytes:sourceBytes}]);store=db.repository(doc.id);
 }else{store=new ProjectStore(root);await store.writeMaterial(sourceBytes);const state=initialState(doc);state.sources=[source];await store.mutate(randomUUID(),{action:'create'},async()=>({project:{format:'lanka-project/v1',title:doc.title,state,receipts:[]},result:{ok:true}}));}
 t.after(async()=>{if(db){for(const table of ['command_receipts','blobs','material_revisions','materials','agent_connections'])await db.pool.query(`DELETE FROM lanka.${table} WHERE tenant_id=$1`,[db.tenant]);await db.close();}await rm(root,{recursive:true,force:true});});
 return {root,db,store,doc,source,sourceBytes};
}
for(const kind of ['file','pg']){
 test(`${kind}: exact immutable export survives later edits and re-download verifies bytes`,async t=>{
  const f=await fixture(t,kind),before=await f.store.read(),pdf=await renderProjectExport(f.store,before,'pdf');
  assert.deepEqual(await f.store.read(),before);assert.equal(pdf.revision,1);assert.equal(pdf.manifest.documentHash,hash(canonicalJson(before.state.doc)));
  assert.equal(pdf.manifest.sources[0].sha256,hash(f.sourceBytes));assert.equal(pdf.manifest.sources[0].excerpt,f.source.excerpt);assert.ok(pdf.manifest.fonts.every(f=>f.embedded&&f.sha256.length===64));assert.equal(pdf.manifest.approval,'not-a-release');assert.ok(pdf.manifest.capabilities.slides.flatMap(s=>s.objects).every(o=>o.representation==='pdf-content'));const {capabilities,...legacy}=pdf.manifest;assert.ok(exportManifestSchema.safeParse(legacy).success);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(),pdf.manifest.snapshot.slides.length);
  const artifact=await f.store.readExportArtifact(pdf.artifactId);assert.deepEqual(artifact,Buffer.from(pdf.bytes));assert.equal(hash(artifact),pdf.sha256);
  await f.store.mutate(randomUUID(),{command:{action:'save'}},async p=>{p.state.doc.title='A later document';p.state.revision++;return {project:p,result:{ok:true}};});
  const pptx=await renderProjectExport(f.store,await f.store.read(),'pptx');assert.equal(pptx.revision,2);assert.ok(pptx.manifest.fonts.every(f=>!f.embedded));
  const zip=await JSZip.loadAsync(pptx.bytes);assert.equal(Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide[0-9]+\.xml$/.test(n)).length,pptx.manifest.snapshot.slides.length);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<a:t>/);
  assert.notEqual(pptx.path,pdf.path);assert.equal((await f.store.readExportManifest(pdf.artifactId)).snapshot.title,'History');assert.deepEqual(await f.store.readExportArtifact(pdf.artifactId),artifact);
  const page=await f.store.listExportArtifacts();assert.equal(page.items.length,2);assert.equal(page.items[0].id,pptx.artifactId);assert.equal(page.nextCursor,null);assert.deepEqual(page.items[0].capabilities,pptx.manifest.capabilities);assert.ok(page.items[0].capabilities.slides.flatMap(s=>s.objects).some(o=>o.representation==='native-text'));assert.equal('snapshot' in page.items[0],false);
  await assert.rejects(f.store.saveExportArtifact(pdf.manifest,pdf.bytes));assert.equal((await f.store.listExportArtifacts()).items.length,2);
  await assert.rejects(f.store.saveExportArtifact({...pdf.manifest,id:randomUUID(),revision:999},pdf.bytes),/версия/);
  await assert.rejects(f.store.readExportArtifact('../project.json'));
  const broken=Buffer.from(pdf.bytes);broken[30]^=1;
  if(f.db)await f.db.pool.query('UPDATE lanka.export_artifacts SET bytes=$4 WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[f.db.tenant,f.doc.id,pdf.artifactId,broken]);else await writeFile(pdf.path,broken);
  await assert.rejects(f.store.readExportArtifact(pdf.artifactId),/повреждён/);
 });
 test(`${kind}: rendering from an earlier saved snapshot records that revision while edits continue`,async t=>{
  const f=await fixture(t,kind),before=await f.store.read();let changed=false;
  const wrapped=Object.create(f.store);wrapped.readFile=async(...args)=>{if(!changed){changed=true;await f.store.mutate(randomUUID(),{command:{action:'save'}},async p=>{p.state.doc.slides[0].notes='Concurrent edit';p.state.revision++;return {project:p,result:{ok:true}};});}return f.store.readFile(...args);};
  const exported=await renderProjectExport(wrapped,before,'pdf');assert.equal((await f.store.read()).state.revision,2);assert.equal(exported.revision,1);assert.deepEqual(exported.manifest.snapshot,before.state.doc);assert.equal(exported.manifest.snapshot.slides[0].notes,'');
 });
 test(`${kind}: a corrupted source prevents export and leaves history unchanged`,async t=>{
  const f=await fixture(t,kind),before=await f.store.read();
  if(f.db)await f.db.pool.query('UPDATE lanka.blobs SET bytes=$3 WHERE tenant_id=$1 AND material_id=$2',[f.db.tenant,f.doc.id,Buffer.from('corrupt')]);else await writeFile(join(f.root,'materials',f.source.sha256+'.bin'),'corrupt');
  await assert.rejects(renderProjectExport(f.store,before,'pdf'),/Source hash/);assert.deepEqual(await f.store.listExportArtifacts(),{items:[],nextCursor:null});assert.deepEqual(await f.store.read(),before);
 });
 test(`${kind}: pagination retains older artifacts, failures never expose half an artifact`,async t=>{
  const f=await fixture(t,kind),base=await renderProjectExport(f.store,await f.store.read(),'pdf');
  for(let i=0;i<26;i++)await f.store.saveExportArtifact({...base.manifest,id:randomUUID(),createdAt:new Date(Date.parse(base.manifest.createdAt)+1000*(i+1)).toISOString()},base.bytes);
  const first=await f.store.listExportArtifacts();assert.equal(first.items.length,25);assert.ok(first.nextCursor);
  const second=await f.store.listExportArtifacts(first.nextCursor);assert.equal(second.items.length,2);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(v=>v.id)).size,27);
  const bad={...base.manifest,id:randomUUID(),output:{...base.manifest.output,sha256:'0'.repeat(64)}};
  await assert.rejects(f.store.saveExportArtifact(bad,base.bytes),/повреждён/);assert.equal((await f.store.listExportArtifacts()).items.length,25);await assert.rejects(f.store.readExportManifest(bad.id));
 });
}
test('PG export metadata and bytes deny another owner, tenant and a trashed document',async t=>{
 const f=await fixture(t,'pg'),a=await renderProjectExport(f.store,await f.store.read(),'pdf');
 for(const scope of [{ownerId:randomUUID()},{tenantId:randomUUID()}]){const other=new ChatDatabase({...f.db.options,...scope});try{await assert.rejects(other.repository(f.doc.id).listExportArtifacts(),/недоступен/);await assert.rejects(other.repository(f.doc.id).readExportManifest(a.artifactId),/недоступен/);await assert.rejects(other.repository(f.doc.id).readExportArtifact(a.artifactId),/недоступен/);}finally{await other.close();}}
 await f.db.catalogCommand(randomUUID(),f.doc.id,{action:'trash_document',trashed:true});await assert.rejects(f.store.readExportArtifact(a.artifactId),/недоступен/);await assert.rejects(f.store.saveExportArtifact({...a.manifest,id:randomUUID()},a.bytes),/недоступен/);
});
test('file export refuses linked artifact members and does not leak pending directories',async t=>{
 const f=await fixture(t,'file'),a=await renderProjectExport(f.store,await f.store.read(),'pdf'),outside=join(f.root,'outside.txt');await writeFile(outside,'private');
 await rm(a.path);await symlink(outside,a.path);await assert.rejects(f.store.readExportArtifact(a.artifactId));assert.equal(await readFile(outside,'utf8'),'private');
 assert.equal((await readdir(join(f.root,'exports'))).some(name=>name.startsWith('pending-')),false);
});
test('compiled renderer keeps its own build identity instead of reading a newer installed marker',async t=>{
 const f=await fixture(t,'file'),fixed={buildHash:'a'.repeat(64),packageVersion:'test-frozen-build'};
 await build({entryPoints:['scripts/project-mcp/export.ts'],outfile:'.project-runtime/export-frozen-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external',define:{__LANKA_EXPORT_BUILD__:JSON.stringify(fixed)}});
 const frozen=await import('../../.project-runtime/export-frozen-test.mjs');
 const current=JSON.parse(await readFile('.project-runtime/export-build.json','utf8'));assert.notEqual(current.buildHash,fixed.buildHash);
 const a=await frozen.renderProjectExport(f.store,await f.store.read(),'pdf');assert.equal(a.manifest.renderer.buildHash,fixed.buildHash);assert.equal(a.manifest.renderer.packageVersion,fixed.packageVersion);
});
