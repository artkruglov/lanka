import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
await build({stdin:{contents:'export {SlideInspector} from "./components/slide-inspector"; export {blankSlide} from "./lib/domain/model"; export {sourceDownload} from "./lib/project/source-download";',resolveDir:process.cwd()},outfile:'.project-runtime/source-preview-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
const {SlideInspector,blankSlide,sourceDownload}=await import('../../.project-runtime/source-preview-test.mjs');
const source={id:'s',name:'Отчёт.txt',kind:'document',sha256:'a'.repeat(64),createdAt:new Date().toISOString(),contentType:'text/plain',excerpt:'legacy',extraction:{status:'partial',note:'Прочитана первая страница',parser:{name:'lanka-source',version:1,sha256:'b'.repeat(64)},fragments:[{locator:'Страница 1',text:'<script>alert(1)</script>'}]}};
test('template and manual canvas retain source provenance, escaped partial text and read-only selection',()=>{
 for(const canvas of [undefined,[]]){
  const html=renderToStaticMarkup(createElement(SlideInspector,{slide:{...blankSlide(),sourceIds:['s'],canvas},sources:[source],index:0,editable:false,onChange:()=>{}}));
  assert.match(html,/Прочитана только часть файла/);assert.match(html,/Прочитана первая страница/);assert.match(html,/Страница 1/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/disabled/);assert.doesNotMatch(html,/Скачать оригинал/);
 }
});
test('original download rejects absent or mismatched bytes and never renders source content inline',async()=>{
 const {createHash}=await import('node:crypto'),bytes=Buffer.from('<html>source</html>'),s={...source,name:'Отчёт\r\n"/bad.txt',sha256:createHash('sha256').update(bytes).digest('hex')};
 let reads=0;const repo={read:async()=>({state:{sources:[s]}}),readFile:async()=>{reads++;return bytes;}};
 await assert.rejects(sourceDownload(repo,'missing'));assert.equal(reads,0);
 await assert.rejects(sourceDownload({...repo,readFile:async()=>Buffer.from('tampered')},s.id),/hash mismatch/);
 const result=await sourceDownload(repo,s.id);assert.deepEqual(result.bytes,bytes);assert.equal(result.headers['Content-Type'],'application/octet-stream');assert.match(result.headers['Content-Disposition'],/^attachment;/);assert.doesNotMatch(result.headers['Content-Disposition'],/[\r\n]/);assert.equal(result.headers['X-Content-Type-Options'],'nosniff');
});
