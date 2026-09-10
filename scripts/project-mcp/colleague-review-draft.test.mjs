import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {build} from 'esbuild';
await build({stdin:{contents:"export {ColleagueReviewDraft} from './lib/project/colleague-review-draft';export {scopedStorage} from './lib/project/browser-context';",resolveDir:process.cwd()},outfile:'.project-runtime/colleague-review-draft-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {ColleagueReviewDraft,scopedStorage}=await import('../../.project-runtime/colleague-review-draft-test.mjs');
const store=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};};
const command=()=>({action:'create',requestId:randomUUID(),recipientId:randomUUID(),target:{revision:3,documentHash:'a'.repeat(64)},note:'Проверить'});
test('reload keeps the exact pending command, drafts and distinct document scopes',()=>{
 const storage=store(),doc=randomUUID(),draft=new ColleagueReviewDraft(storage,doc),op=command(),review=randomUUID();draft.edit({note:op.note,search:'Коллега',selected:review});draft.answer(review,'Замечание','changes_requested');draft.stage(op);
 const resumed=new ColleagueReviewDraft(storage,doc);assert.deepEqual(resumed.snapshot,draft.snapshot);assert.deepEqual(resumed.stage(command()),op);assert.equal(new ColleagueReviewDraft(storage,randomUUID()).snapshot.pending,null);
 resumed.settle(randomUUID(),true);assert.deepEqual(resumed.snapshot.pending,op);resumed.settle(op.requestId,true);assert.equal(resumed.snapshot.pending,null);assert.equal(resumed.snapshot.note,'');assert.equal(resumed.snapshot.answers[review].text,'Замечание');
});
test('user and organization namespaces do not expose each others pending command',()=>{
 const storage=store(),doc=randomUUID(),ctx={userId:randomUUID(),tenantId:randomUUID(),documentId:doc};const a=new ColleagueReviewDraft(scopedStorage(storage,ctx),doc);a.stage(command());
 for(const other of [{...ctx,userId:randomUUID()},{...ctx,tenantId:randomUUID()}])assert.equal(new ColleagueReviewDraft(scopedStorage(storage,other),doc).snapshot.pending,null);
});
test('storage failures cannot create a sendable pending command or erase an uncertain one',()=>{
 const doc=randomUUID(),memory=store();let fails=false;const storage={getItem:k=>memory.getItem(k),setItem:(k,v)=>{if(fails)throw Error('Quota');memory.setItem(k,v);}};
 const draft=new ColleagueReviewDraft(storage,doc),op=command();fails=true;assert.throws(()=>draft.stage(op));assert.equal(draft.snapshot.pending,null);fails=false;draft.stage(op);fails=true;assert.throws(()=>draft.settle(op.requestId,true));assert.deepEqual(new ColleagueReviewDraft(storage,doc).snapshot.pending,op);
 assert.throws(()=>new ColleagueReviewDraft(null,doc).stage(op));assert.throws(()=>new ColleagueReviewDraft({getItem:()=>'{broken',setItem:()=>assert.fail()},doc).stage(op));
});
