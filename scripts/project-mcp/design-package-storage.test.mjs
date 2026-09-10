import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {Pool} from 'pg';import {build} from 'esbuild';
await build({stdin:{contents:"export * from './lib/adapters/postgres/design-package-storage';export * from './lib/design-packages/manifest';export * from './lib/adapters/postgres/schema';export * from './lib/adapters/postgres/design-package-resolver';export * from './lib/adapters/postgres/revision-design-package';export {scene} from './lib/domain/scene';export {creationPreviewExamples} from './lib/domain/creation-design';",resolveDir:process.cwd()},outfile:'.project-runtime/design-package-storage-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {saveDesignPackageIn:save,loadDesignPackageIn:load,createManifest,bytesDigest,applySelfHostedMigrations,saveInstalledDesignIn,resolveDesignPackageIn,scene,creationPreviewExamples,bindRevisionDesignIn,readRevisionDesignIn}=await import('../../.project-runtime/design-package-storage-test.mjs');
test('PostgreSQL packages retain A after B, isolate tenants, reject updates and roll back incomplete saves',async()=>{
 const base=JSON.parse(await readFile('work/agent-chat/config.json','utf8')),name='lanka_pack_'+randomUUID().replaceAll('-',''),admin=new Pool(base.connection);let db;
 try{
 await admin.query(`CREATE DATABASE "${name}"`);db=new Pool({...base.connection,database:name});await applySelfHostedMigrations(db);
 const tenant=randomUUID(),other=randomUUID();
 const bundle=version=>{const blobs=new Map([['render.mjs',Buffer.from('render '+version)],['sans.ttf',Buffer.from('font '+version)],['license.txt',Buffer.from('license')]]);const roles=['renderer','font','license'];return {blobs,manifest:createManifest({format:'lanka-design-package/v1',profile:'focus-v3',componentSchema:'fixture/v1',renderer:{entry:'render.mjs',buildSha256:bytesDigest(blobs.get('render.mjs'))},rules:{version},assets:[...blobs].map(([path,bytes],i)=>({path,role:roles[i],sha256:bytesDigest(bytes),byteLength:bytes.length}))})};};
 const tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const a=bundle('A'),b=bundle('B');
 const repeats=await Promise.all([tx(c=>save(c,tenant,a.manifest,a.blobs)),tx(c=>save(c,tenant,a.manifest,a.blobs))]);assert.deepEqual(repeats[0],repeats[1]);
 await tx(c=>save(c,tenant,b.manifest,b.blobs));
 assert.deepEqual((await tx(c=>load(c,tenant,a.manifest.digest))).manifest,a.manifest);
 assert.deepEqual((await tx(c=>load(c,tenant,a.manifest.digest))).blobs,a.blobs);
 assert.equal(await tx(c=>load(c,other,a.manifest.digest)),null);
 await assert.rejects(db.query('UPDATE lanka.design_packages SET manifest=manifest WHERE tenant_id=$1',[tenant]),/immutable/);
 await assert.rejects(db.query('UPDATE lanka.design_package_assets SET bytes=bytes WHERE tenant_id=$1',[tenant]),/immutable/);
 const third=bundle('C');await assert.rejects(tx(async c=>{await save(c,tenant,third.manifest,third.blobs);throw Error('abort');}),/abort/);
 assert.equal(await tx(c=>load(c,tenant,third.manifest.digest)),null);
 const corrupt=new Map(a.blobs);corrupt.set('sans.ttf',Buffer.from('broken'));await assert.rejects(tx(c=>save(c,tenant,a.manifest,corrupt)),/asset mismatch/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM lanka.design_packages')).rows[0].n,2);
 // Real Focus bytes travel through PostgreSQL; resolving never falls back to installation.
 for(const profile of ['focus-v2','focus-v3']){
  const manifest=await tx(c=>saveInstalledDesignIn(c,tenant,profile));
  const restored=await tx(c=>resolveDesignPackageIn(c,tenant,manifest.digest,profile));
  assert.deepEqual(restored.manifest,manifest);
  assert.ok(restored.blobs.get('renderer/scene.mjs').length>1000);
  const archived=await import('data:text/javascript;base64,'+Buffer.from(restored.blobs.get('renderer/scene.mjs')).toString('base64'));
  for(const [i,example] of creationPreviewExamples.entries())assert.deepEqual(archived.scene(example.slide,manifest.rules.brand,i,creationPreviewExamples.length,profile),scene(example.slide,manifest.rules.brand,i,creationPreviewExamples.length,profile));
  for(const asset of manifest.assets)assert.equal(bytesDigest(restored.blobs.get(asset.path)),asset.sha256);
  await assert.rejects(tx(c=>resolveDesignPackageIn(c,other,manifest.digest,profile)),/недоступна/);
  await assert.rejects(tx(c=>resolveDesignPackageIn(c,tenant,manifest.digest,profile==='focus-v2'?'focus-v3':'focus-v2')),/другому шаблону/);
 }
 await assert.rejects(tx(c=>resolveDesignPackageIn(c,tenant,'0'.repeat(64),'focus-v3')),/недоступна/);
 const installed=await tx(c=>saveInstalledDesignIn(c,tenant,'focus-v3'));
 const documentId=randomUUID(),doc={design:'focus-v3'},documentHash=bytesDigest(JSON.stringify(doc));
 await db.query('INSERT INTO lanka.materials(tenant_id,id,owner_id,project) VALUES($1,$2,$3,$4)',[tenant,documentId,randomUUID(),JSON.stringify({state:{doc}})]);
 await db.query("INSERT INTO lanka.material_revisions(tenant_id,material_id,revision,hash,doc,action) VALUES($1,$2,1,$3,$4,'test')",[tenant,documentId,documentHash,JSON.stringify(doc)]);
 const target={documentId,revision:1,documentHash};
 assert.equal(await tx(c=>readRevisionDesignIn(c,tenant,target)),undefined);
 assert.equal(await tx(c=>bindRevisionDesignIn(c,tenant,target,installed.digest)),installed.digest);
 assert.equal(await tx(c=>bindRevisionDesignIn(c,tenant,target,installed.digest)),installed.digest);
 const {digest:oldDigest,...body}=installed;
 const changed=createManifest({...body,rules:{...body.rules,fixture:'changed'}}),source=await tx(c=>load(c,tenant,oldDigest));
 await tx(c=>save(c,tenant,changed,source.blobs));
 await assert.rejects(tx(c=>bindRevisionDesignIn(c,tenant,target,changed.digest)),/нельзя заменить/);
 await assert.rejects(tx(c=>bindRevisionDesignIn(c,other,target,installed.digest)),/недоступна/);
 await assert.rejects(tx(c=>bindRevisionDesignIn(c,tenant,{...target,revision:2},installed.digest)),/недоступна/);
 assert.equal(await tx(c=>readRevisionDesignIn(c,tenant,target)),installed.digest);
 await assert.rejects(db.query('DELETE FROM lanka.design_packages WHERE tenant_id=$1 AND digest=$2',[tenant,installed.digest]),e=>e.code==='23503');



 const role='pack_runtime_'+randomUUID().replaceAll('-','');
 await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
 try{
  await db.query(`GRANT USAGE ON SCHEMA lanka TO "${role}"; GRANT SELECT,INSERT ON lanka.design_packages,lanka.design_package_assets TO "${role}"`);
  await tx(async c=>{await c.query(`SET LOCAL ROLE "${role}"`);await save(c,tenant,third.manifest,third.blobs);assert.deepEqual((await load(c,tenant,third.manifest.digest)).manifest,third.manifest);});
  for(const table of ['design_packages','design_package_assets'])for(const op of ['DELETE FROM','UPDATE'])await assert.rejects(tx(async c=>{await c.query(`SET LOCAL ROLE "${role}"`);await c.query(op==='UPDATE'?`UPDATE lanka.${table} SET tenant_id=tenant_id`:`DELETE FROM lanka.${table}`);}),e=>e.code==='42501');
 }finally{await db.query(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}

 }finally{if(db)await db.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
});
