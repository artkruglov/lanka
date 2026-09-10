import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {build} from 'esbuild';
await build({stdin:{contents:`export {prepareColleagueReviewVersion} from './lib/project/colleague-review-version';export {canonicalJson} from './lib/domain/canonical-json';export {createColleagueReview} from './lib/domain/colleague-review';export {preparePublicationCopy} from './lib/project/publication-copy';export {preparePublicationPackage} from './lib/project/publication-package';export {demoDoc,initialState} from './lib/domain/model';export {documentView} from './lib/project/document-view';`,resolveDir:process.cwd()},outfile:'.project-runtime/publication-package-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {prepareColleagueReviewVersion,canonicalJson,createColleagueReview,preparePublicationCopy,preparePublicationPackage,initialState,demoDoc,documentView}=await import('../../.project-runtime/publication-package-test.mjs');
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64'),sha256=createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const doc=demoDoc();doc.design="focus-v3";doc.slides=doc.slides.slice(0,1);doc.brand.company='PRIVATE-COMPANY';doc.slides[0].notes='PRIVATE-NOTES';
 const style={design:'focus-v3',brand:doc.brand},box={x:100,y:200,w:1000,h:400};
 doc.slides[0].canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#ffffff'},
 {id:'title',kind:'text',x:100,y:80,w:1000,h:80,text:'Видимый заголовок',size:32,font:'sans',bold:true,lineHeight:1.3,color:'#111111',sourceField:'title'},
 {id:'image-1',kind:'image',...box,assetId:'private-image-id'},
 {id:'image-2',kind:'image',...box,assetId:'private-image-alias'},
 {id:'chart',kind:'chart',...box,style,data:{seriesId:'series',sourceId:'private-data-id',unit:'hours',rows:[{id:'a',label:'A',value:20}]}},
 {id:'table',kind:'table',...box,style,data:{sourceId:'private-data-id',columns:[{id:'name',label:'Name',role:'key',valueType:'text',unit:''},{id:'value',label:'Value',role:'number',valueType:'number',unit:''}],rows:[{id:'a',cells:{name:'A',value:20}}]}}];
 const state=initialState(doc);state.revision=7;
 state.sources=['private-image-id','private-image-alias','unused-image'].map(id=>({id,name:'PRIVATE-FILENAME',kind:'image',sha256,createdAt:'2026-09-09T00:00:00.000Z',contentType:'image/png',excerpt:'PRIVATE-EXCERPT'}));
 const project={format:'lanka-project/v1',title:doc.title,state,receipts:[{secret:'PRIVATE-RECEIPT'}],briefing:{secret:'PRIVATE-BRIEF'},chat:'PRIVATE-CHAT'};
 const options={tenantId:randomUUID(),materialId:randomUUID(),publicationId:randomUUID(),expectedRevision:7,createdAt:'2026-09-09T00:00:00.000Z'};
 return {project,options};
}
test('publication is deterministic, strips private state and retains native data with deduplicated verified dependencies',async()=>{
 const {project,options}=fixture(),before=structuredClone(project),reads=[];
 const result=await preparePublicationPackage(project,options,async h=>{reads.push(h);return bytes;});
 assert.deepEqual(reads,[sha256]);assert.deepEqual(project,before);
 const text=result.bytes.toString();for(const secret of ['PRIVATE-','private-image','private-data-id','unused-image'])assert.equal(text.includes(secret),false,secret);
 for(const blob of result.blobs)assert.equal(blob.bytes.toString().includes('PRIVATE-'),false);
 assert.equal(result.payload.document.slides[0].canvas.find(e=>e.kind==='chart').data.rows[0].value,20);
 assert.equal(result.payload.document.slides[0].canvas.find(e=>e.kind==='table').data.rows[0].cells.value,20);
 const visible=p=>documentView(p,{role:'viewer',canCopy:true,isOwner:false}).slides.map(s=>s.items.map(e=>e.kind==='image'?{...e,assetId:'image'}:e));
 assert.deepEqual(visible({state:{doc:result.payload.document,revision:7}}),visible(before));
 assert.equal(result.payload.sources.filter(s=>s.kind==='image').length,2);assert.equal(result.blobs.length,2);
 assert.deepEqual(result.bytes,(await preparePublicationPackage(project,options,async()=>bytes)).bytes);
 assert.equal(result.hash,createHash('sha256').update(result.bytes).digest('hex'));
 const target=randomUUID(),copy=preparePublicationCopy(result.payload,target,'New title',options.createdAt);
 assert.deepEqual(visible(copy),visible({state:{doc:result.payload.document,revision:7}}));
 assert.notEqual(copy.state.doc.slides[0].id,result.payload.document.slides[0].id);
 assert.ok(copy.state.doc.slides[0].canvas.every(e=>e.id.startsWith(target)));
 assert.ok(copy.state.sources.every(s=>s.id.startsWith(target)));assert.equal(copy.state.revision,1);
 assert.equal(copy.state.doc.slides[0].canvas.find(e=>e.kind==='table').data.rows[0].cells.value,20);
 assert.equal(copy.state.doc.slides[0].canvas.find(e=>e.kind==='chart').data.rows[0].value,20);
 assert.equal(copy.state.proposals.length,0);assert.equal(copy.state.comments.length,0);

 project.state.doc.slides[0].canvas[1].text='Changed';assert.equal(result.payload.document.slides[0].canvas.find(e=>e.kind==='text').text,'Видимый заголовок');
});
test('preparation snapshots before asynchronous reads and owns the returned bytes',async()=>{
 const {project,options}=fixture(),loaded=Buffer.from(bytes);
 const result=await preparePublicationPackage(project,options,async()=>{project.state.doc.title='Later';project.state.sources[0].excerpt='Changed';return loaded;});
 loaded.fill(0);assert.notEqual(result.payload.document.title,'Later');assert.deepEqual(result.blobs.find(b=>b.hash===sha256).bytes,bytes);
});
test('missing, changed, oversized, ambiguous assets and stale versions fail without leaking loader errors',async()=>{
 for(const loader of [async()=>undefined,async()=>Buffer.alloc(0),async()=>Buffer.from('changed'),async()=>Buffer.alloc(5_000_001),async()=>{throw Error('PRIVATE-path');}]){
  const {project,options}=fixture();await assert.rejects(preparePublicationPackage(project,options,loader),e=>!e.message.includes('PRIVATE')&&/Изображение/.test(e.message));
 }
 const {project,options}=fixture();await assert.rejects(preparePublicationPackage(project,{...options,expectedRevision:6},async()=>{assert.fail('must not load');}),/Версия/);
 project.state.sources.push(structuredClone(project.state.sources[0]));await assert.rejects(preparePublicationPackage(project,options,async()=>bytes),/Изображение/);
});

test('colleague review pins exact content without publishing or exposing private materials',async()=>{
 const {project,options}=fixture(),before=structuredClone(project);
 const review=createColleagueReview({action:'create',requestId:randomUUID(),recipientId:randomUUID(),target:{revision:project.state.revision,documentHash:createHash('sha256').update(canonicalJson(project.state.doc)).digest('hex')},note:'Проверьте'},
  {id:randomUUID(),tenantId:options.tenantId,documentId:project.state.doc.id,senderId:randomUUID(),now:options.createdAt});
 const reads=[];const result=await prepareColleagueReviewVersion(project,review,async h=>{reads.push(h);return bytes;});
 assert.deepEqual(reads,[sha256]);assert.deepEqual(project,before);
 assert.equal(result.version.format,'lanka-colleague-review-version/v1');assert.deepEqual(result.version.target,review.target);
 const json=JSON.stringify(result.version);for(const secret of ['PRIVATE-','private-image','private-data-id','unused-image','lanka-publication/v1'])assert.equal(json.includes(secret),false,secret);
 for(const blob of result.blobs)assert.equal(blob.bytes.toString().includes('PRIVATE-'),false);
 const visible=doc=>documentView({state:{doc,revision:7}},{role:'viewer',canCopy:true,isOwner:false}).slides.map(s=>s.items.map(e=>e.kind==='image'?{...e,assetId:'image'}:e));
 assert.deepEqual(visible(result.version.document),visible(project.state.doc));
 assert.deepEqual(result.version.document.slides.map(s=>s.id),project.state.doc.slides.map(s=>s.id));
 for(const wrong of [{...review,documentId:randomUUID()},{...review,target:{...review.target,revision:8}},{...review,target:{...review.target,documentHash:'b'.repeat(64)}}])
  await assert.rejects(()=>prepareColleagueReviewVersion(project,wrong,async()=>assert.fail('Wrong revision must not load images')),/не совпадает/);
 await assert.rejects(()=>prepareColleagueReviewVersion(project,review,async()=>undefined),/Изображение/);
 project.state.doc.slides[0].notes='Changed private note';await assert.rejects(()=>prepareColleagueReviewVersion(project,review,async()=>bytes),/не совпадает/);
});
