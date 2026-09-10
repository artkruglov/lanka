import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
await build({stdin:{contents:"export {captureInstalledDesign} from './lib/design-packages/capture';export {creationPreviewExamples} from './lib/domain/creation-design';export {scene} from './lib/domain/scene';",resolveDir:process.cwd()},outfile:'.project-runtime/design-capture-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {captureInstalledDesign,creationPreviewExamples,scene}=await import('../../.project-runtime/design-capture-test.mjs');
test('captured Focus renderers execute outside the installation with identical scenes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lanka-package-capture-'));
 try{for(const profile of ['focus-v2','focus-v3']){
  const a=await captureInstalledDesign(profile),b=await captureInstalledDesign(profile);assert.equal(a.manifest.digest,b.manifest.digest);
  const target=join(root,profile+'.mjs');await writeFile(target,a.blobs.get('renderer/scene.mjs'));
  const archived=await import(pathToFileURL(target).href);
  for(const [i,example] of creationPreviewExamples.entries())assert.deepEqual(archived.scene(example.slide,a.manifest.rules.brand,i,creationPreviewExamples.length,profile),scene(example.slide,a.manifest.rules.brand,i,creationPreviewExamples.length,profile));
  assert.equal(a.manifest.assets.filter(a=>a.role==='font').length,profile==='focus-v3'?3:2);
  assert.equal(a.manifest.assets.filter(a=>a.role==='reference').length,profile==='focus-v3'?3:0);
 }}finally{await rm(root,{recursive:true,force:true});}
});
