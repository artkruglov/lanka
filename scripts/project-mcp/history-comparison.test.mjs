import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
await build({stdin:{contents:`export {historySlideComparisons,historySourceComparisons} from './lib/project/history-comparison'; export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/history-comparison-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {historySlideComparisons,historySourceComparisons, demoDoc}=await import('../../.project-runtime/history-comparison-test.mjs');
test('restoration comparison includes additions, deletions, and reordered surviving slides without mutating revisions',()=>{
 const before=demoDoc();before.slides=before.slides.slice(0,3);
 const current=structuredClone(before);current.slides=[current.slides[2],{...current.slides[0],id:'new-slide'},current.slides[0]];
 const snapshot=structuredClone({before,current});
 const rows=historySlideComparisons(before,current);
 assert.deepEqual(rows.map(r=>[r.id,r.status,r.beforeIndex,r.currentIndex]),[
  [before.slides[0].id,'changed',0,2],[before.slides[1].id,'removed',1,-1],
  [before.slides[2].id,'changed',2,0],['new-slide','added',-1,1]]);
 assert.equal(rows.at(-1).before,undefined);assert.equal(rows[1].current,undefined);
 assert.deepEqual({before,current},snapshot);
});
test('identical content is unchanged, but changed branding and design are visible',()=>{
 const before=demoDoc(),current=structuredClone(before);
 assert.ok(historySlideComparisons(before,current).every(r=>r.status==='unchanged'));
 current.design=before.design==='focus-v3'?'focus-v2':'focus-v3';
 assert.ok(historySlideComparisons(before,current).every(r=>r.status==='changed'));
 current.design=before.design;current.brand={...current.brand,name:'Другое оформление'};
 assert.ok(historySlideComparisons(before,current).every(r=>r.status==='changed'));
});
test('changed pagination totals and text are not labelled unchanged',()=>{
 const before=demoDoc(),current=structuredClone(before);
 current.slides[0].title='Новый текст';
 assert.equal(historySlideComparisons(before,current)[0].status,'changed');
 current.slides.push({...current.slides[0],id:'added'});
 assert.ok(historySlideComparisons(before,current).every(r=>r.status!=='unchanged'));
});

const source=(id,sha256='a'.repeat(64))=>({id,sha256,name:'Source '+id,contentType:'text/plain',kind:'text',excerpt:'Evidence',createdAt:'2026-09-09T00:00:00Z'});
test('source identity changes mark only dependent slides and distinguish bytes from metadata',()=>{
 const before=demoDoc(),current=structuredClone(before);before.slides[0].sourceIds=['data'];current.slides[0].sourceIds=['data'];
 const sources=[source('data'),source('removed')],now=[{...source('data','b'.repeat(64)),name:'Renamed'},source('added')];
 const changed=historySourceComparisons(sources,now);assert.deepEqual(changed.map(r=>r.status),['changed','removed','added']);assert.equal(changed[0].contentChanged,true);assert.equal(changed[0].nameChanged,true);
 const rows=historySlideComparisons(before,current,{before:sources,current:now});assert.equal(rows[0].status,'changed');assert.deepEqual(rows[0].changedSourceIds,['data']);assert.equal(rows[1].status,'unchanged');
 const metadata=historySourceComparisons([source('data')],[{...source('data'),excerpt:'Clarified evidence'}]);assert.equal(metadata[0].status,'changed');assert.equal(metadata[0].contentChanged,false);
});
test('image and native data sources are compared, missing snapshots stay unknown and key order is immaterial',()=>{
 const before=demoDoc(),current=structuredClone(before);before.slides[0].canvas=[{kind:'image',assetId:'image'},{kind:'chart',data:{sourceId:'chart'}}];current.slides[0].canvas=structuredClone(before.slides[0].canvas);
 const sources=[source('image'),source('chart')],now=[source('image','b'.repeat(64)),source('chart','c'.repeat(64))];
 assert.deepEqual(historySlideComparisons(before,current,{before:sources,current:now})[0].changedSourceIds,['image','chart']);
 const unknown=historySlideComparisons(before,current,{before:null,current:now});assert.equal(unknown[0].sourcesUnknown,true);assert.deepEqual(unknown[0].changedSourceIds,[]);
 const reordered=Object.fromEntries(Object.entries(sources[0]).reverse());assert.equal(historySourceComparisons([sources[0]],[reordered])[0].status,'unchanged');
});
