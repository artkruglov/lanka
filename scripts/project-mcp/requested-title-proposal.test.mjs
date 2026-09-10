import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {isRequestedTitleProposal} from './fixtures/requested-title-proposal.mjs';
test('fixture permission is limited to exact title text, object, revision and one command',()=>{
 const scope={slideId:'slide',revision:1,text:'Approved test title'};
 const item={server:'lanka_document',tool:'lanka_propose_commands',arguments:{requestId:randomUUID(),expectedRevision:1,title:'Test',commands:[{op:'edit_text',slideId:'slide',elementId:'title',value:{text:scope.text}}]}};
 assert.equal(isRequestedTitleProposal(item,scope),true);
 for(const change of [x=>x.tool='other',x=>x.arguments.expectedRevision=2,x=>x.arguments.commands[0].value.text='other',x=>x.arguments.commands[0].elementId='body',x=>x.arguments.commands.push(x.arguments.commands[0]),x=>x.arguments.commands[0].value.size=200,x=>x.arguments.feedbackIds=['unrelated']]){const bad=structuredClone(item);change(bad);assert.equal(isRequestedTitleProposal(bad,scope),false);}
});
