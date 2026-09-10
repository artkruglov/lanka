import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
await mkdir('.test-build',{recursive:true});await build({stdin:{contents:"export * from './lib/project/document-source-grant'; export * from './lib/domain/source-review';",resolveDir:process.cwd()},outfile:'.test-build/document-source-grant.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {documentSourceText,selectedDocumentSource,assertProposalSources,sourceReviewWarnings}=await import('../../.test-build/document-source-grant.mjs');
const source={id:'source',name:'Material',kind:'document',sha256:'a'.repeat(64),contentType:'text/plain',createdAt:'2026-09-09T00:00:00Z',excerpt:'Known content',extraction:{parser:{name:'lanka-source',version:1,sha256:'b'.repeat(64)},status:'extracted',note:'Extracted',fragments:[{locator:'page 1',text:'Known content'}]}};
test('text consent pins all returned content and does not reveal incidental fields',()=>{const read=documentSourceText({...source,private:'secret',image:{}}),selection={id:read.id,sha256:read.sha256,contentHash:read.contentHash,acceptPartial:false};assert.equal(read.private,undefined);assert.equal(read.image,undefined);assert.deepEqual(selectedDocumentSource(source,selection),read);for(const patch of [{name:'New'},{excerpt:'New'},{sha256:'c'.repeat(64)},{extraction:{...source.extraction,note:'New'}}])assert.throws(()=>selectedDocumentSource({...source,...patch},selection),/изменился/);});
test('partial is explicit, unsupported and image sources never become readable text',()=>{const partial={...source,extraction:{...source.extraction,status:'partial'}},read=documentSourceText(partial),selection={id:read.id,sha256:read.sha256,contentHash:read.contentHash,acceptPartial:false};assert.throws(()=>selectedDocumentSource(partial,selection),/частично/);assert.ok(selectedDocumentSource(partial,{...selection,acceptPartial:true}));for(const status of ['failed','unsupported'])assert.throws(()=>documentSourceText({...source,extraction:{...source.extraction,status}}),/не прочитан/);assert.throws(()=>documentSourceText({...source,kind:'image'}),/изображения/);});
test('large or empty source text is rejected rather than silently truncated',()=>{assert.throws(()=>documentSourceText({...source,extraction:undefined,excerpt:'я'.repeat(17000)}),/32 КБ/);assert.throws(()=>documentSourceText({...source,extraction:undefined,excerpt:''}),/нет доступного текста/);});

test('source review pins selected changes, rejects changed or missing text and preserves legacy proposals',()=>{
 const dependency={id:source.id,contentHash:documentSourceText(source).contentHash};
 const state={sources:[structuredClone(source)],proposals:[{id:'p',changes:[{id:'c',sourceDependencies:[dependency]},{id:'independent'}]}]};
 assert.doesNotThrow(()=>assertProposalSources(state,'p',['c']));
 state.sources[0].excerpt='Changed';
 const before=structuredClone(state);
 assert.throws(()=>assertProposalSources(state,'p',['c']),/Источник предложения изменился/);assert.deepEqual(state,before);
 assert.doesNotThrow(()=>assertProposalSources(state,'p',['independent']));
 state.sources=[];assert.throws(()=>assertProposalSources(state,'p',['c']),/Источник предложения изменился/);
});

await build({stdin:{contents:"export {humanCommand} from './scripts/project-mcp/human'; export {initialState,demoDoc,propose} from './lib/domain/model';",resolveDir:process.cwd()},outfile:'.test-build/source-review-human.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {humanCommand,initialState,demoDoc,propose}=await import('../../.test-build/source-review-human.mjs');
test('human object acceptance refuses stale sources atomically while rejection remains possible',async()=>{
 const state=initialState(demoDoc());state.sources=[structuredClone(source)];
 const slide=state.doc.slides[0];slide.canvas=[{id:'text',kind:'text',x:100,y:100,w:800,h:100,text:'Before',size:32,bold:false,color:'#20243B',lineHeight:1.3}];
 const after=structuredClone(slide);after.canvas[0].text='After';
 const proposal=propose(state,[{slideId:slide.id,after}],'Update','Agent');proposal.changes[0].sourceDependencies=[{id:source.id,contentHash:documentSourceText(source).contentHash}];state.proposals.push(proposal);
 const project={format:'lanka-project/v1',title:state.doc.title,state,receipts:[]};
 const store={mutate:async(_id,_intent,fn)=>fn(project)};
 const command={action:'review_objects',proposalId:proposal.id,changeId:proposal.changes[0].id,elementIds:['text'],decision:'accepted'};
 const input=()=>({requestId:crypto.randomUUID(),deckId:state.doc.id,expectedRevision:1,command});
 state.sources[0].excerpt='Changed';const before=structuredClone(project);
 await assert.rejects(()=>humanCommand(store,input()),/Источник предложения изменился/);assert.deepEqual(project,before);
 command.decision='rejected';assert.equal((await humanCommand(store,input())).project.state.proposals[0].status,'closed');
 state.sources[0]=structuredClone(source);command.decision='accepted';const result=await humanCommand(store,input());assert.equal(result.project.state.doc.slides[0].canvas[0].text,'After');
});

test('browser source digest matches server consent and warns only on dependent changes',async()=>{
 const state={sources:[source],proposals:[{status:'pending',changes:[{id:'pinned',status:'pending',sourceDependencies:[{id:source.id,contentHash:documentSourceText(source).contentHash}]},{id:'free',status:'pending'}]}]};
 assert.deepEqual(await sourceReviewWarnings(state),{});
 state.sources=[{...source,excerpt:'Changed'}];assert.deepEqual(Object.keys(await sourceReviewWarnings(state)),['pinned']);
 state.sources=[];assert.deepEqual(Object.keys(await sourceReviewWarnings(state)),['pinned']);
});

test('whole draft acceptance preserves comments and refuses object decisions and changed base',async()=>{
 const state=initialState(demoDoc());state.doc.slides=state.doc.slides.slice(0,1);
 const after=structuredClone(state.doc);after.slides[0].title='New title';after.slides.push({...structuredClone(after.slides[0]),id:crypto.randomUUID()});
 const proposal=propose(state,[{slideId:state.doc.slides[0].id,after:after.slides[0]}],'Draft','Agent');proposal.draftCandidate={before:structuredClone(state.doc),after};state.proposals.push(proposal);
 state.comments=[{id:'comment',text:'Keep discussion'}];
 const project={format:'lanka-project/v1',title:state.doc.title,state,receipts:[]};const store={mutate:async(_id,_intent,fn)=>fn(project)};
 const command={action:'accept',proposalId:proposal.id,changeIds:[proposal.changes[0].id]},input=()=>({requestId:crypto.randomUUID(),deckId:state.doc.id,expectedRevision:state.revision,command});
 await assert.rejects(()=>humanCommand(store,{...input(),command:{action:'review_objects',proposalId:proposal.id,changeId:proposal.changes[0].id,elementIds:['x'],decision:'accepted'}}),/целиком/);
 state.doc.title='Human';await assert.rejects(()=>humanCommand(store,input()),/Конфликт версии/);state.doc.title=proposal.draftCandidate.before.title;
 const result=await humanCommand(store,input());assert.equal(result.project.state.doc.slides.length,2);assert.deepEqual(result.project.state.comments,state.comments);assert.equal(state.doc.slides.length,1);
});
