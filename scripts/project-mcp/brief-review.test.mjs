import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
await build({stdin:{contents:"export * from './lib/domain/brief-review';",resolveDir:process.cwd()},outfile:'.project-runtime/brief-review-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {prepareBriefReview,acceptBriefReview}=await import('../../.project-runtime/brief-review-test.mjs');
const brief={audience:'Команда',decision:'Обсудить',keyMessage:'Результаты',origins:{audience:'assumption',decision:'user',keyMessage:'assumption'}};
test('prepare does not modify or confirm answers; acceptance is field-level',()=>{
 const original=structuredClone(brief),changes=prepareBriefReview(brief,{audience:'Руководители',decision:'Согласовать'});
 assert.deepEqual(brief,original);assert.equal(changes.length,2);
 const accepted=acceptBriefReview(brief,changes,['audience']);
 assert.deepEqual(accepted,{...brief,audience:'Руководители',origins:{...brief.origins,audience:'user'}});assert.deepEqual(brief,original);
});
test('unrelated concurrent edits survive, selected conflicts are atomic including origin changes',()=>{
 const changes=prepareBriefReview(brief,{audience:'Руководители',decision:'Согласовать'});
 const concurrent={...brief,keyMessage:'Новая мысль'};
 assert.equal(acceptBriefReview(concurrent,changes,['audience']).keyMessage,'Новая мысль');
 for(const current of [{...brief,decision:'Другое решение'},{...brief,origins:{...brief.origins,audience:'user'}}]){
  const before=structuredClone(current);assert.throws(()=>acceptBriefReview(current,changes,['audience','decision']),/Конфликт/);assert.deepEqual(current,before);
 }
});
test('missing briefing, invalid keys, duplicates and size constraints',()=>{
 const changes=prepareBriefReview(undefined,{audience:'Команда'});
 assert.deepEqual(acceptBriefReview(undefined,changes,['audience']),{audience:'Команда',decision:'',keyMessage:'',origins:{audience:'user'}});
 for(const input of [{},{audience:'x'.repeat(401)},{decision:'x'.repeat(801)},{origins:{audience:'user'}},{slides:[]}])assert.throws(()=>prepareBriefReview(brief,input));
 assert.throws(()=>prepareBriefReview(brief,{audience:brief.audience}));
 for(const keys of [[],['audience','audience'],['keyMessage']])assert.throws(()=>acceptBriefReview(undefined,changes,keys));
 assert.throws(()=>acceptBriefReview(undefined,[...changes,...changes],['audience']));
});

await build({stdin:{contents:"export {proposeBrief,acceptProposal,rejectProposal,demoDoc,initialState} from './lib/domain/model';export {proposalSummary} from './lib/domain/proposal-summary';",resolveDir:process.cwd()},outfile:'.project-runtime/brief-proposal-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const model=await import('../../.project-runtime/brief-proposal-test.mjs');
test('document proposal supports partial acceptance and rejection without slide changes',()=>{
 const state=model.initialState(model.demoDoc());state.doc.brief=structuredClone(brief);const before=structuredClone(state.doc);
 const proposal=model.proposeBrief(state,{audience:'Руководители',decision:'Согласовать'},'Уточнить замысел','Агент');state.proposals.push(proposal);
 assert.equal(proposal.visibility,undefined);assert.deepEqual(proposal.changes,[]);assert.deepEqual(state.doc,before);
 model.acceptProposal(state,proposal.id,[proposal.briefChanges[0].id]);assert.equal(proposal.status,'pending');assert.deepEqual(state.doc.slides,before.slides);assert.equal(state.doc.brief.audience,'Руководители');
 model.rejectProposal(state,proposal.id);assert.equal(proposal.status,'closed');assert.equal(state.doc.brief.decision,'Обсудить');assert.equal(model.proposalSummary(proposal).decision,'mixed');assert.equal(model.proposalSummary(proposal).kind,'brief');assert.equal(model.proposalSummary(proposal).slideCount,0);
 assert.throws(()=>model.acceptProposal(state,proposal.id,[proposal.briefChanges[1].id]));
});

test('accepting one answer into an absent brief does not conflict with its remaining unset fields',()=>{
 const changes=prepareBriefReview(undefined,{audience:'Команда',decision:'Согласовать',keyMessage:'Общий план'});
 const first=acceptBriefReview(undefined,changes,['audience']);
 const rest=acceptBriefReview(first,changes,['decision','keyMessage']);
 assert.deepEqual(rest,{audience:'Команда',decision:'Согласовать',keyMessage:'Общий план',origins:{audience:'user',decision:'user',keyMessage:'user'}});
 assert.throws(()=>acceptBriefReview({...first,decision:'Ручная правка'},changes,['decision']),/Конфликт/);
 assert.throws(()=>acceptBriefReview({...first,origins:{...first.origins,decision:'user'}},changes,['decision']),/Конфликт/);
});
