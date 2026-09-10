import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';import JSZip from 'jszip';import {packageCompanion} from './package-companion.mjs';
const exec=promisify(execFile);
test('relocated package starts panel without repository or dependencies and carries verified source hashes',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'lanka-kit-'));t.after(()=>rm(temp,{recursive:true,force:true}));const output=await packageCompanion(join(temp,'kit'));
 const manifest=JSON.parse(await readFile(join(output.directory,'MANIFEST.json'),'utf8'));const zip=await JSZip.loadAsync(await readFile(output.archive));assert.ok(Object.keys(manifest.files).length>10);
 const runtime=join(output.directory,'runtime'),pkg=JSON.parse(await readFile(join(runtime,'package.json'),'utf8'));
 assert.deepEqual(Object.keys(pkg.scripts),['install:runtime','check','setup','panel','start','inspect','recover']);
 for(const command of Object.values(pkg.scripts)){
  assert.match(command,/^node companion-[a-z-]+\.mjs$/);
  const entry=command.slice(5);assert.ok(manifest.files['runtime/'+entry]);
  await exec(process.execPath,['--check',join(runtime,entry)],{cwd:temp,timeout:10000});
 }
 // Actual npm dispatch from outside the checkout: missing dependencies must produce
 // the companion diagnostic, not a nonexistent application entry point.
 await assert.rejects(exec('npm',['run','check','--prefix',runtime],{cwd:temp,timeout:15000}),e=>
  e.code===1&&e.stderr.includes('Codex в комплекте не готов')&&!e.stderr.includes('Cannot find module'));
 for(const [path,hash] of Object.entries(manifest.files)){assert.equal(createHash('sha256').update(await readFile(join(output.directory,path))).digest('hex'),hash);assert.equal(createHash('sha256').update(await zip.file('lanka-companion/'+path).async('nodebuffer')).digest('hex'),hash);assert.ok(!/(?:^|\/)(?:work|out|node_modules|\.git)\//.test(path));}
 const program=`import {startCompanionPanel} from './lanka-companion/runtime/companion-panel.mjs';import {companionSetupCommands} from './lanka-companion/runtime/companion-setup.mjs';const panel=await startCompanionPanel({});const response=await fetch(panel.origin);if(response.status!==200)throw Error('Panel failed');if(!companionSetupCommands('/private/config.json').panel.includes(import.meta.dirname))throw Error('Stale source path');await panel.close();console.log('RELOCATED_OK');`;
 await writeFile(join(temp,'kit','smoke.mjs'),program);const result=await exec(process.execPath,[join(temp,'kit','smoke.mjs')],{cwd:temp,timeout:15000});assert.equal(result.stdout.trim(),'RELOCATED_OK');
 await assert.rejects(packageCompanion(join(temp,'kit')),e=>e.code==='EEXIST');assert.ok(await readFile(output.archive));
});
