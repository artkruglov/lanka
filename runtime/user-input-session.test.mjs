import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {UserInputSession} from './user-input-session.mjs';
function setup(){const server=new EventEmitter();server.attachUserInputGate=g=>server.gate=g;return {server,session:new UserInputSession(server,{threadId:'private-thread',turnId:'private-turn'})};}
const prompt=secret=>({id:99,method:'item/tool/requestUserInput',params:{threadId:'private-thread',turnId:'private-turn',itemId:'private-item',questions:[{id:'q',question:'Proceed?',header:'Approval',isOther:false,isSecret:secret,options:[{label:'Decline',description:'Stop'}]}]}});
test('chat projection replaces native ids and an answer resolves only its opaque request',()=>{
 const {server,session}=setup(),sent=[];try{
  server.gate.register(prompt(false),r=>sent.push(r));server.emit('userInputPending',{id:99});
  const view=session.view();assert.equal(view.length,1);assert.match(view[0].id,/^[a-f0-9-]{36}$/);assert.equal(JSON.stringify(view).includes('private-'),false);
  assert.equal(session.answer('99',{q:{answers:['Decline']}}),false);
  assert.equal(session.answer(view[0].id,{q:{answers:['Decline']}}),true);assert.equal(sent[0].id,99);assert.deepEqual(session.view(),[]);
  assert.equal(session.answer(view[0].id,{q:{answers:['Decline']}}),false);
 }finally{session.close();}
});
test('secret prompts are not projected; closing removes listeners and invalidates answers',()=>{
 const {server,session}=setup();let unsupported=false;server.on('userInputUnsupported',()=>unsupported=true);
 server.gate.register(prompt(true),()=>assert.fail('No secret reply'));server.emit('userInputPending',{id:99});
 assert.equal(unsupported,true);assert.deepEqual(session.view(),[]);assert.equal(server.listenerCount('userInputPending'),0);assert.equal(server.gate.closed,true);
});
