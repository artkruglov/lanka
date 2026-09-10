import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import JSZip from 'jszip';import {buildFocusFonts} from '../build-focus-fonts.mjs';
test('font package is reproducible and contains only exact bundled fonts, licenses and guidance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lanka-font-package-'));
 try{const first=join(root,'a.zip'),second=join(root,'b.zip');const manifest=await buildFocusFonts(first);await buildFocusFonts(second);const bytes=await readFile(first);assert.deepEqual(bytes,await readFile(second));
 const zip=await JSZip.loadAsync(bytes);assert.deepEqual(Object.keys(zip.files).sort(),['IBMPlexMono-Medium.ttf','IBMPlexSans-Regular.ttf','IBMPlexSans-SemiBold.ttf','OFL-IBMPlexMono.txt','OFL-IBMPlexSans.txt','README.txt','manifest.json'].sort());
 for(const file of manifest.files){const packed=await zip.file(file.name).async('nodebuffer');assert.deepEqual(packed,await readFile('public/fonts/'+file.name));assert.equal(createHash('sha256').update(packed).digest('hex'),file.sha256);}
 assert.match(await zip.file('README.txt').async('string'),/не встраиваются в PPTX/);assert.deepEqual(JSON.parse(await zip.file('manifest.json').async('string')),manifest);
 }finally{await rm(root,{recursive:true,force:true});}
});
