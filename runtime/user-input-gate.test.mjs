import test from 'node:test';import assert from 'node:assert/strict';
import {UserInputGate} from './user-input-gate.mjs';
const request=()=>({id:7,method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'run',itemId:'item',isBlocking:true,autoResolutionMs:1,questions:[{id:'decision',header:'Confirm',question:'Create proposal?',isOther:false,isSecret:false,options:[{label:'Accept',description:'Create the proposal'},{label:'Decline',description:'Leave unchanged'}]}]}});
const response={decision:{answers:['Accept']}};
test('only explicit complete answers resolve one scoped request once',()=>{
 const gate=new UserInputGate({threadId:'t',turnId:'run'}),sent=[],m=request();
 assert.equal(gate.register(m,r=>sent.push(r)),true);assert.equal(sent.length,0);
 m.params.questions[0].options[0].label='tampered';
 assert.equal(gate.answer(7,{}),false);assert.equal(gate.answer(7,{decision:{answers:['Always allow']}}),false);
 assert.equal(gate.answer(7,response),true);assert.deepEqual(sent,[{id:7,result:{answers:response}}]);assert.equal(gate.answer(7,response),false);
});
test('reject cross-turn, unexpected approval type, duplicate and malformed requests',()=>{
 const gate=new UserInputGate({threadId:'t',turnId:'run'}),noop=()=>{};
 for(const mutate of [m=>m.params.turnId='other',m=>m.params.threadId='other',m=>m.method='item/permissions/requestApproval',m=>m.params.questions.push(m.params.questions[0]),m=>m.params.questions[0].options=[{}]]){
  const m=request();mutate(m);assert.equal(gate.register(m,noop),false);
 }
 assert.equal(gate.register(request(),noop),true);assert.equal(gate.register(request(),noop),false);
});
test('resolved prompts and stopped turns cannot be answered later',()=>{
 const gate=new UserInputGate({threadId:'t',turnId:'run'});const fail=()=>assert.fail('Late reply');
 gate.register(request(),fail);gate.resolved(7);assert.equal(gate.answer(7,response),false);
 gate.register(request(),fail);gate.close();assert.equal(gate.answer(7,response),false);assert.equal(gate.register(request(),fail),false);
});

const elicitation=()=>({id:9,method:'mcpServer/elicitation/request',params:{threadId:'t',turnId:'run',serverName:'lanka_document',mode:'form',message:'Create a proposal?',requestedSchema:{type:'object',properties:{}}}});
test('native confirmation maps explicit decisions to MCP action and content',()=>{
 for(const [label,action] of [['Accept','accept'],['Decline','decline'],['Cancel','cancel']]){
  const gate=new UserInputGate({threadId:'t',turnId:'run'}),sent=[];
  assert.equal(gate.register(elicitation(),r=>sent.push(r)),true);assert.equal(sent.length,0);
  assert.equal(gate.answer(9,{mcp_action:{answers:[label]}}),true);
  assert.deepEqual(sent,[{id:9,result:{action,content:action==='accept'?{}:null,_meta:null}}]);
 }
});
test('MCP approval rejects other servers, missing turn, URL and nonempty or constrained forms',()=>{
 for(const mutate of [p=>p.serverName='other',p=>p.turnId=null,p=>p.mode='url',p=>p.requestedSchema.properties={token:{type:'string'}},p=>p.requestedSchema.required=['token'],p=>p.requestedSchema.allOf=[{}]]){
  const gate=new UserInputGate({threadId:'t',turnId:'run'}),m=elicitation();mutate(m.params);
  assert.equal(gate.register(m,()=>assert.fail('Unexpected answer')),false);
 }
});
