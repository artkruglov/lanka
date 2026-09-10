import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('.test-build',{recursive:true});
await build({stdin:{contents:"export {folderTree} from './lib/project/library-folders';export {readLibraryWindow} from './lib/project/library-refresh';",resolveDir:process.cwd()},outfile:'.test-build/library-refresh.mjs',bundle:true,platform:'node',format:'esm'});
const {folderTree,readLibraryWindow}=await import('../../.test-build/library-refresh.mjs');
test('folder paths disambiguate equal names and preserve flat legacy folders',()=>{
 const f=folderTree([{id:'b',name:'Бета'},{id:'a',name:'Альфа'},{id:'c',name:'Данные',parentId:'a'},{id:'d',name:'Данные',parentId:'b'}]);
 assert.deepEqual(f.map(x=>[x.id,x.depth,x.path]),[['a',0,'Альфа'],['c',1,'Альфа / Данные'],['b',0,'Бета'],['d',1,'Бета / Данные']]);assert.deepEqual(f[1].ancestors,['a']);
});
test('malformed parent references cannot hang navigation or erase own folders',()=>{
 const f=folderTree([{id:'a',name:'A',parentId:'b'},{id:'b',name:'B',parentId:'a'},{id:'c',name:'C',parentId:'missing'}]);assert.equal(f.length,3);assert.deepEqual(f.map(x=>x.depth),[0,0,0]);
});
test('refresh re-reads loaded pages and replaces removed or changed documents',async()=>{
 const calls=[];const pages={first:{documents:[{id:'new',title:'New'},{id:'a',title:'Updated'}],nextCursor:'next',folders:[]},next:{documents:[{id:'b',title:'Second page'}],nextCursor:null,folders:[{id:'folder'}]}};
 const result=await readLibraryWindow(async cursor=>{calls.push(cursor);return pages[cursor??'first'];},2);
 assert.deepEqual(calls,[undefined,'next']);assert.deepEqual(result.documents.map(d=>d.id),['new','a','b']);assert.equal(result.documents[1].title,'Updated');assert.equal(result.nextCursor,null);
});
test('refresh deduplicates shifting pages, stops at end and rejects partial failures',async()=>{
 let n=0;const result=await readLibraryWindow(async()=>++n===1?{documents:[{id:'a'}],nextCursor:'next'}:{documents:[{id:'a'},{id:'b'}],nextCursor:null},4);assert.equal(n,2);assert.deepEqual(result.documents.map(d=>d.id),['a','b']);
 await assert.rejects(readLibraryWindow(async cursor=>{if(cursor)throw Error('offline');return {documents:[{id:'a'}],nextCursor:'next'};},2),/offline/);
 await assert.rejects(readLibraryWindow(async()=>({documents:[],nextCursor:'same'}),4),/повтор страницы/);
});
