import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdir} from 'node:fs/promises';
await mkdir('.test-build',{recursive:true});await build({entryPoints:['lib/project/proposal-review-state.ts'],outfile:'.test-build/proposal-review-state.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});const {proposalReviewState:view}=await import('../../.test-build/proposal-review-state.mjs');
test('partial slide review remains pending until the remaining decision',()=>{
 const p={status:'pending',changes:[{status:'accepted'},{status:'pending'}]};
 assert.deepEqual(view(p),{decision:'pending',label:'Часть правок принята · осталось проверить'});
 p.changes[1].status='rejected';p.status='closed';assert.deepEqual(view(p),{decision:'mixed',label:'Принято частично'});
});
test('object-level rejection does not hide outstanding objects or imply acceptance',()=>{
 const p={status:'pending',changes:[{status:'pending',objectDecisions:[{status:'rejected'}]}]};
 assert.deepEqual(view(p),{decision:'pending',label:'Часть правок отклонена · осталось проверить'});
 p.changes[0].objectDecisions.push({status:'accepted'});
 assert.deepEqual(view(p),{decision:'pending',label:'Часть правок принята · осталось проверить'});
 p.status='closed';p.changes[0].status='accepted';assert.equal(view(p).decision,'mixed');
});
test('brief fields and unavailable metadata never masquerade as a final acceptance',()=>{
 const p={status:'pending',changes:[],briefChanges:[{status:'accepted'},{status:'pending'}]};
 assert.equal(view(p).label,'Часть правок принята · осталось проверить');
 p.briefChanges[1].status='accepted';p.status='closed';assert.equal(view(p).label,'Принято');
 assert.equal(view(undefined).decision,'unavailable');
 assert.equal(view({status:'closed',changes:[{status:'rejected'}]}).label,'Отклонено');
});
