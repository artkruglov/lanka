import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
await mkdir('.test-build',{recursive:true});await build({entryPoints:['lib/domain/proposal-summary.ts'],outfile:'.test-build/proposal-summary.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});const {proposalSummary}=await import('../../.test-build/proposal-summary.mjs');
test('whole draft summary counts candidate pages rather than replacement entries',()=>{
 const p={status:'pending',draftCandidate:{after:{slides:[{},{},{}]}},changes:[{status:'pending'}]};assert.deepEqual(proposalSummary(p),{kind:'draft',slideCount:3,decision:'pending'});
 p.status='closed';p.changes[0].status='accepted';assert.equal(proposalSummary(p).decision,'accepted');p.changes[0].status='rejected';assert.equal(proposalSummary(p).decision,'rejected');
});
test('partial object review and legacy proposals retain distinct decisions without content',()=>{
 const p={status:'closed',changes:[{status:'accepted',objectDecisions:[{status:'accepted'},{status:'rejected'}],after:{notes:'PRIVATE'}}]};assert.deepEqual(proposalSummary(p),{kind:'edits',slideCount:1,decision:'mixed'});p.status='pending';assert.equal(proposalSummary(p).decision,'pending');
 assert.deepEqual(proposalSummary({status:'closed',changes:[{status:'rejected'},{status:'rejected'}]}),{kind:'edits',slideCount:2,decision:'rejected'});
});
