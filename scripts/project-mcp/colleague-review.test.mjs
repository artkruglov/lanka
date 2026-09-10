import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:"export * from './lib/domain/colleague-review';",resolveDir:process.cwd()},outfile:'.project-runtime/colleague-review-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {createColleagueReview,transitionColleagueReview,colleagueReviewCommandSchema,colleagueReviewSchema,ColleagueReviewConflict,ColleagueReviewForbidden}=await import('../../.project-runtime/colleague-review-test.mjs');
const context={id:randomUUID(),tenantId:randomUUID(),documentId:randomUUID(),senderId:randomUUID(),now:'2026-09-10T14:00:00.000Z'},recipientId=randomUUID();
const create={action:'create',requestId:randomUUID(),recipientId,target:{revision:7,documentHash:'a'.repeat(64)},note:'Проверьте выводы'};
const fresh=()=>createColleagueReview(create,context),later='2026-09-10T14:02:00.000Z';
const response=(state,extra={})=>({action:'respond',requestId:randomUUID(),id:state.id,expectedStatusVersion:state.statusVersion,target:structuredClone(state.target),outcome:'reviewed',note:'Проверено',...extra});
const cancel=(state)=>({action:'cancel',requestId:randomUUID(),id:state.id,expectedStatusVersion:state.statusVersion});
test('version and authorship remain pinned; no hidden payload or mutation',()=>{
 const command=structuredClone(create),state=fresh(),before=structuredClone(state);
 create.target.revision=8;assert.equal(state.target.revision,7);create.target.revision=7;
 const answered=transitionColleagueReview(state,response(state),recipientId,later);
 assert.deepEqual(state,before);assert.deepEqual(create,command);assert.deepEqual(answered.target,state.target);
 assert.equal(answered.status,'responded');assert.equal(answered.statusVersion,2);assert.equal(answered.response.actorId,recipientId);
 assert.equal('requestId' in state,false);assert.equal('now' in state,false);
});
test('only recipient responds; only sender cancels',()=>{
 const state=fresh();
 for(const actor of [context.senderId,randomUUID()])assert.throws(()=>transitionColleagueReview(state,response(state),actor,later),ColleagueReviewForbidden);
 for(const actor of [recipientId,randomUUID()])assert.throws(()=>transitionColleagueReview(state,cancel(state),actor,later),ColleagueReviewForbidden);
 const stopped=transitionColleagueReview(state,cancel(state),context.senderId,later);assert.equal(stopped.status,'cancelled');assert.equal(stopped.cancellation.actorId,context.senderId);
});
test('concurrent responses and cancellation cannot replace an existing decision',()=>{
 const state=fresh(),answer=response(state),answered=transitionColleagueReview(state,answer,recipientId,later),stopped=transitionColleagueReview(state,cancel(state),context.senderId,later);
 for(const terminal of [answered,stopped]){
  const before=structuredClone(terminal);
  assert.throws(()=>transitionColleagueReview(terminal,response(terminal),recipientId,later),ColleagueReviewConflict);
  assert.throws(()=>transitionColleagueReview(terminal,cancel(terminal),context.senderId,later),ColleagueReviewConflict);
  assert.deepEqual(terminal,before);
 }
 assert.throws(()=>transitionColleagueReview(state,response(state,{expectedStatusVersion:2}),recipientId,later),ColleagueReviewConflict);
});
test('wrong document version, hash, request identity and stale clock are rejected',()=>{
 const state=fresh();
 for(const extra of [{target:{...state.target,revision:8}},{target:{...state.target,documentHash:'b'.repeat(64)}},{id:randomUUID()}])
  assert.throws(()=>transitionColleagueReview(state,response(state,extra),recipientId,later),ColleagueReviewConflict);
 assert.throws(()=>transitionColleagueReview(state,response(state),recipientId,'2026-09-09T14:00:00.000Z'),ColleagueReviewConflict);
});
test('changes requested require a meaningful note; unknown private fields never enter state',()=>{
 const state=fresh();
 assert.throws(()=>transitionColleagueReview(state,response(state,{outcome:'changes_requested',note:'   '}),recipientId,later));
 assert.equal(transitionColleagueReview(state,response(state,{outcome:'changes_requested',note:' Уточните данные '}),recipientId,later).response.note,'Уточните данные');
 for(const extra of [{chat:[]},{senderId:recipientId},{status:'responded'},{note:'a'.repeat(2001)}])assert.throws(()=>colleagueReviewCommandSchema.parse({...create,...extra}));
 assert.throws(()=>createColleagueReview({...create,recipientId:context.senderId},context));
 assert.throws(()=>colleagueReviewSchema.parse({...state,conversation:[]}));
});

test('stored state rejects contradictory authorship, sequence and timestamps',()=>{
 const state=fresh(),answered=transitionColleagueReview(state,response(state),recipientId,later);
 for(const corrupt of [{...state,statusVersion:2},{...answered,statusVersion:1},{...answered,response:{...answered.response,actorId:context.senderId}},{...answered,response:{...answered.response,at:'2026-09-09T14:00:00.000Z'}}])
  assert.throws(()=>colleagueReviewSchema.parse(corrupt));
});
