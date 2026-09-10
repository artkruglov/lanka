import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdir,readFile} from 'node:fs/promises';
await mkdir('.test-build',{recursive:true});await build({stdin:{contents:"export * from './lib/project/quality-corpus';export {initialState,demoDoc} from './lib/domain/model';",resolveDir:process.cwd()},outfile:'.test-build/quality-corpus-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {assessCorpusCase,initialState,demoDoc}=await import('../../.test-build/quality-corpus-test.mjs');
const spec={id:'case',slideCount:{min:1,max:40},requiresSources:false,requiresBaseline:false,humanReview:['Read the brief']};
test('missing, corrupt and technically valid outputs never count as human acceptance',()=>{
 assert.equal(assessCorpusCase(spec).status,'missing');assert.equal(assessCorpusCase(spec,{state:{doc:{}}}).status,'invalid-output');
 const result=assessCorpusCase(spec,{state:initialState(demoDoc())});assert.equal(result.humanAcceptance,'not-assessed');assert.ok(result.humanReview.includes('Read the brief'));assert.notEqual(result.status,'accepted');
 const missing=assessCorpusCase({...spec,requiresSources:true,slideCount:{min:30,max:40}},{state:initialState(demoDoc())});assert.equal(missing.status,'technical-issues');assert.ok(missing.issues.some(i=>i.includes('исходные материалы')));assert.ok(missing.issues.some(i=>i.includes('Число слайдов')));
});
test('refresh requires baseline and preserves protected title, document and object geometry',()=>{
 const state=initialState(demoDoc());state.doc.slides[0].canvas=[{kind:'rect',id:'box',x:20,y:20,w:100,h:100,color:'#123456'}];
 const baseline={state:structuredClone(state)},input={state},refresh={...spec,requiresBaseline:true};
 assert.ok(assessCorpusCase(refresh,input).issues.some(i=>i.includes('исходной деки')));
 state.doc.slides[0].title='Changed';state.doc.slides[0].canvas[0].x=50;state.doc.id='different';
 const result=assessCorpusCase(refresh,input,baseline);for(const part of ['другой документ','заголовок','геометрия'])assert.ok(result.issues.some(i=>i.includes(part)),part);
 assert.equal(baseline.state.doc.slides[0].canvas[0].x,20);
});
test('corporate corpus has ten distinct briefs with materials and explicit human criteria',async()=>{
 const corpus=JSON.parse(await readFile('quality/corporate-v1/cases.json','utf8'));assert.equal(corpus.cases.length,10);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,10);
 for(const c of corpus.cases){assert.ok(c.brief.length>40);assert.ok(c.materials[0].text.length>50);assert.ok(c.humanReview.length>=2);assert.ok(c.slideCount.max>=c.slideCount.min);}
 assert.ok(corpus.cases.some(c=>c.id==='english'));assert.ok(corpus.cases.some(c=>c.requiresBaseline));
});
