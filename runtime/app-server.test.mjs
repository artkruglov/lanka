import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServer } from "./app-server.mjs";
import { LankaClient, parseArtifact } from "./worker.mjs";
import {dedicatedProfile} from './local-profile.mjs';
import {mkdtemp,realpath,readdir,stat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('dedicated profiles are empty, private and separated by owner; linked profiles are rejected',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'lanka-profile-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const tenant=randomUUID(),owner=randomUUID();
  const a=await dedicatedProfile(root,tenant,owner),b=await dedicatedProfile(root,tenant,randomUUID());
  assert.notEqual(a,b);assert.deepEqual(await readdir(a),[]);assert.equal((await stat(a)).mode&0o777,0o700);
  assert.equal(await dedicatedProfile(root,tenant,owner),a);
  await rm(a,{recursive:true});await symlink(b,a);
  await assert.rejects(dedicatedProfile(root,tenant,owner),/real directory/);
});

function fakeProcess(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.send = (m) => child.stdout.write(JSON.stringify(m) + "\n");
  child.kill = () => {};
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split("\n"))
        handler(JSON.parse(line), child);
      callback();
    },
  });
  return child;
}
test("RPC failures retain safe code and operation without provider payloads",async()=>{
  const child=fakeProcess((m,c)=>c.send({id:m.id,error:{code:-32603,message:"private prompt and credential",data:{token:"secret"}}}));
  const server=new CodexAppServer({spawnProcess:()=>child});
  try{
    await assert.rejects(server.request("thread/read",{threadId:"test"}),error=>{
      assert.equal(error.message,"Codex request failed");
      assert.equal(error.rpcCode,-32603);
      assert.equal(error.operation,"thread/read");
      assert.equal(JSON.stringify(error).includes("secret"),false);
      assert.equal(JSON.stringify(error).includes("private"),false);
      return true;
    });
  }finally{server.close();}
});
test("an active writer is a distinct error without leaking the native thread ID",async()=>{
  const child=fakeProcess((m,c)=>c.send({id:m.id,error:{code:-32600,message:"thread 01a07fd6-eb46-73d0-b200-456a15aea41b already has an active writer"}}));
  const server=new CodexAppServer({spawnProcess:()=>child});
  try{await assert.rejects(server.resume("test","/project","model"),error=>{
    assert.equal(error.reason,"THREAD_IN_USE");
    assert.equal(JSON.stringify(error).includes("01a07fd6"),false);
    return true;
  });}finally{server.close();}
});
test("Persistent review threads opt in; resume reapplies the read-only policy",async()=>{
  const sent=[];
  const child=fakeProcess((m,c)=>{sent.push(m);c.send({id:m.id,result:{thread:{id:m.params.threadId||"thread-a"}}});});
  const server=new CodexAppServer({spawnProcess:()=>child});
  try{
    await server.start("/project","model");
    await server.start("/project","model",{persistent:true});
    const scope={features:{plugins:false},mcp_servers:{lanka_document:{enabled:true}}};
    await server.resume("thread-a","/project","model",{config:scope});
    assert.equal(sent[0].params.ephemeral,true);
    assert.equal(sent[1].params.ephemeral,false);
    assert.equal(sent[2].method,"thread/resume");
    assert.equal(sent[2].params.threadId,"thread-a");
    assert.equal(sent[2].params.sandbox,"read-only");
    assert.equal(sent[2].params.approvalPolicy,"never");
    assert.equal(sent[2].params.cwd,"/project");
    assert.deepEqual(sent[2].params.config,scope);
  }finally{server.close();}
});
test("App Server buffers early results and ignores completion from another turn", async () => {
  let argsSeen, envSeen;
  const child = fakeProcess((m, c) => {
    if (m.method === "turn/start") {
      c.send({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "previous", status: "completed" },
        },
      });
      c.send({
        method: "item/completed",
        params: {
          threadId: "thread",
          turnId: "current",
          item: { type: "agentMessage", text: '{"kind":"plan"}' },
        },
      });
      c.send({
        method: "turn/completed",
        params: {
          threadId: "thread",
          turn: { id: "current", status: "completed" },
        },
      });
      c.send({ id: m.id, result: { turn: { id: "current" } } });
    }
  });
  const server = new CodexAppServer({
    cwd: "/tmp",
    codexHome: "/tmp/lanka-test",
    spawnProcess: (_cmd, args, opts) => {
      argsSeen = args;
      envSeen = opts.env;
      return child;
    },
  });
  try {
    assert.equal(await server.turn("thread", "request"), '{"kind":"plan"}');
    assert.ok(argsSeen.includes("features.shell_tool=false"));
    assert.equal(envSeen.LANKA_ACCESS_TOKEN, undefined);
  } finally {
    server.close();
  }
});
test("Abort interrupts the exact active turn and does not grant server approval", async () => {
  const sent = [];
  const child = fakeProcess((m, c) => {
    sent.push(m);
    if (m.method === "turn/start")
      c.send({ id: m.id, result: { turn: { id: "active" } } });
    if (m.method === "turn/interrupt") {
      c.send({ id: m.id, result: {} });
      c.send({method:"turn/completed",params:{threadId:"thread",turn:{id:"active",status:"interrupted"}}});
    }
  });
  const server = new CodexAppServer({
    cwd: "/tmp",
    codexHome: "/tmp/lanka-test",
    spawnProcess: () => child,
  });
  const controller = new AbortController();
  const promise = server.turn("thread", "request", {
    signal: controller.signal,
  });
  await new Promise((r) => setImmediate(r));
  child.send({
    id: 100,
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  controller.abort();
  await assert.rejects(promise, /interrupted/);
  assert.ok(
    sent.some(
      (m) => m.method === "turn/interrupt" && m.params.turnId === "active",
    ),
  );
  assert.ok(sent.some((m) => m.id === 100 && m.error));
  server.close();
});
test("Gateway retries lost responses with the same command bytes", async () => {
  const bodies = [];
  let attempts = 0;
  const client = new LankaClient(
    "https://gateway.invalid/api/mcp",
    "test-token",
    async (_url, options) => {
      bodies.push(options.body);
      if (attempts++ === 0) throw new Error("Lost response");
      return Response.json({
        result: { content: [{ type: "text", text: '{"ok":true}' }] },
      });
    },
  );
  assert.deepEqual(await client.call("claim_task", { requestId: "stable" }), {
    ok: true,
  });
  assert.equal(bodies[0], bodies[1]);
});
test("timeout waits for delayed interrupt receipt and exact terminal event before close",async()=>{
  let acknowledged=false,completed=false,closed=false;
  const child=fakeProcess((m,c)=>{
    if(m.method==='turn/start')c.send({id:m.id,result:{turn:{id:'current'}}});
    if(m.method==='turn/interrupt')setTimeout(()=>{
      assert.equal(closed,false);
      c.send({id:m.id,result:{}});
      c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'other',status:'interrupted'}}});
      c.send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'current',delta:'late answer'}});
      setTimeout(()=>{
        assert.equal(closed,false);completed=true;
        c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'current',status:'completed'}}});
      },20);
    },20);
  });
  child.kill=()=>{closed=true;};
  const server=new CodexAppServer({spawnProcess:()=>child});
  try {
    await assert.rejects(server.turn('thread','request',{timeout:10,onInterrupt:async()=>{acknowledged=true;},onText:()=>assert.fail('Late text escaped cancellation')}),/turn timed out/);
    assert.equal(acknowledged,true);assert.equal(completed,true);
  }finally{server.close();}
});
test("unacknowledged interrupt is bounded and does not report a receipt",async()=>{
  const child=fakeProcess((m,c)=>{if(m.method==='turn/start')c.send({id:m.id,result:{turn:{id:'current'}}});});
  const server=new CodexAppServer({spawnProcess:()=>child});
  try {
    await assert.rejects(server.turn('thread','request',{timeout:10,onInterrupt:()=>assert.fail('No acknowledgement arrived'),onTerminal:()=>assert.fail('No terminal event arrived')}),/turn timed out/);
    assert.equal(server.pending.size,0);
  }finally{server.close();}
});
test("early deltas wait for durable turn identity; other-turn text is ignored",async()=>{
  let persisted=false;
  const streamed=[];
  const child=fakeProcess((m,c)=>{
    if(m.method!=="turn/start")return;
    for(const [turnId,delta] of [["previous","private old text"],["current","Hello "]])
      c.send({method:"item/agentMessage/delta",params:{threadId:"thread",turnId,delta}});
    c.send({id:m.id,result:{turn:{id:"current"}}});
    c.send({method:"item/agentMessage/delta",params:{threadId:"thread",turnId:"current",delta:"world"}});
    c.send({method:"item/completed",params:{threadId:"thread",turnId:"current",item:{type:"agentMessage",text:"Hello world"}}});
    c.send({method:"turn/completed",params:{threadId:"thread",turn:{id:"current",status:"completed"}}});
  });
  const server=new CodexAppServer({spawnProcess:()=>child});
  try {
    const result=await server.turn("thread","request",{
      onStarted:async id=>{assert.equal(id,"current");await new Promise(r=>setImmediate(r));persisted=true;},
      onText:text=>{assert.equal(persisted,true);streamed.push(text);},
    });
    assert.equal(result,"Hello world");assert.deepEqual(streamed,["Hello ","world"]);
  }finally{server.close();}
});
test("failure to persist native turn identity interrupts the computation",async()=>{
  const sent=[];
  const child=fakeProcess((m,c)=>{sent.push(m);c.send({id:m.id,result:m.method==="turn/start"?{turn:{id:"current"}}:{}});if(m.method==='turn/interrupt')c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'current',status:'interrupted'}}});});
  const server=new CodexAppServer({spawnProcess:()=>child});
  try {
    await assert.rejects(server.turn("thread","request",{onStarted:async()=>{throw new Error("database unavailable");}}),/database unavailable/);
    assert.ok(sent.some(m=>m.method==="turn/interrupt"&&m.params.turnId==="current"));
  }finally{server.close();}
});
test("Malformed and oversized model artifacts fail before any mutation", () => {
  assert.deepEqual(parseArtifact('```json\n{"kind":"questions"}\n```'), {
    kind: "questions",
  });
  assert.throws(() => parseArtifact("explanation instead of JSON"));
  assert.throws(() => parseArtifact("x".repeat(600001)), /limit/);
});


test("visual references are explicit localImage inputs in the same supervised turn",async()=>{
  let input,effort;
  const child=fakeProcess((m,c)=>{
    if(m.method!=="turn/start")return;input=m.params.input;effort=m.params.effort;
    c.send({id:m.id,result:{turn:{id:"visual"}}});
    queueMicrotask(()=>{c.send({method:"item/completed",params:{threadId:"thread",turnId:"visual",item:{type:"agentMessage",text:"ok"}}});c.send({method:"turn/completed",params:{threadId:"thread",turn:{id:"visual",status:"completed"}}});});
  });
  const server=new CodexAppServer({spawnProcess:()=>child});
  try {assert.equal(await server.turn("thread","Follow the reference",{imagePaths:["/package/cover.png"],effort:"medium"}),"ok");assert.equal(effort,"medium");assert.deepEqual(input,[{type:"text",text:"Follow the reference",text_elements:[]},{type:"localImage",path:"/package/cover.png"}]);await assert.rejects(server.turn("thread","bad",{imagePaths:["relative.png"]}),/Invalid image/);}
  finally {server.close();}
});

test('terminal observer requires the exact native event, not interrupt acknowledgement',async()=>{
 const events=[];const child=fakeProcess((m,c)=>{
  if(m.method==='turn/start')c.send({id:m.id,result:{turn:{id:'current'}}});
  if(m.method==='turn/interrupt'){
   c.send({id:m.id,result:{}});
   c.send({method:'turn/completed',params:{threadId:'another',turn:{id:'current',status:'interrupted'}}});
   c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'other',status:'interrupted'}}});
   setTimeout(()=>{assert.equal(events.length,0);c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'current',status:'interrupted'}}});},10);
  }
 });const server=new CodexAppServer({spawnProcess:()=>child});
 try{await assert.rejects(server.turn('thread','request',{timeout:10,onTerminal:e=>events.push(e)}),/timed out/);assert.deepEqual(events,[{threadId:'thread',turnId:'current',status:'interrupted'}]);}finally{server.close();}
});
test('terminal observer reports completion once and preserves the normal answer',async()=>{
 const events=[];const child=fakeProcess((m,c)=>{if(m.method!=='turn/start')return;c.send({id:m.id,result:{turn:{id:'current'}}});c.send({method:'item/completed',params:{threadId:'thread',turnId:'current',item:{type:'agentMessage',text:'Done'}}});for(let i=0;i<2;i++)c.send({method:'turn/completed',params:{threadId:'thread',turn:{id:'current',status:'completed'}}});});
 const server=new CodexAppServer({spawnProcess:()=>child});try{assert.equal(await server.turn('thread','request',{onTerminal:e=>events.push(e)}),'Done');assert.equal(events.length,1);}finally{server.close();}
});

test('non-envelope JSON cannot crash the reader or interfere with the next valid response',async()=>{
 const notifications=[];
 const child=fakeProcess((m,c)=>{
   c.stdout.write('not-json\n');
   for(const invalid of [null,42,true,'text',[],[{}],{}, {method:17}])c.send(invalid);
   c.send({method:'account/updated',params:{authMode:'chatgpt'}});
   c.send({id:m.id,result:{ok:true}});
 });
 const server=new CodexAppServer({spawnProcess:()=>child});server.on('notification',m=>notifications.push(m));
 try{assert.deepEqual(await server.request('account/read'),{ok:true});assert.equal(notifications.length,1);assert.equal(notifications[0].method,'account/updated');assert.equal(server.pending.size,0);}finally{server.close();}
});
test('malformed RPC errors reject safely and leave the connection usable',async()=>{
 const replies=[{error:null},{error:'private credential'},{error:[]},{error:{code:1,message:'private'},result:{ok:true}}];
 const child=fakeProcess((m,c)=>c.send({id:m.id,...(replies.shift()??{result:{ok:true}})}));
 const server=new CodexAppServer({spawnProcess:()=>child});
 try{
   for(let i=0;i<4;i++)await assert.rejects(server.request('account/read'),e=>e.message==='Invalid Codex response'&&e.operation==='account/read'&&!JSON.stringify(e).includes('private'));
   assert.deepEqual(await server.request('account/read'),{ok:true});assert.equal(server.pending.size,0);
 }finally{server.close();}
});

test('releaseAndClose unsubscribes only its acquired thread and waits for child exit',async()=>{
 const calls=[],kills=[];const child=fakeProcess((m,c)=>{calls.push(m);c.send({id:m.id,result:{status:'unsubscribed'}});});
 child.kill=signal=>{kills.push(signal);return true;};
 const server=new CodexAppServer({spawnProcess:()=>child});
 let finished=false;const closing=server.releaseAndClose('owned-thread').then(()=>{finished=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls.map(m=>[m.method,m.params]),[['thread/unsubscribe',{threadId:'owned-thread'}]]);
 assert.equal(finished,false);assert.deepEqual(kills,['SIGTERM']);
 server.close();assert.deepEqual(kills,['SIGTERM']);
 child.emit('exit',0);await closing;assert.equal(finished,true);
});
test('failed acquisition closes its child without touching a thread',async()=>{
 const calls=[];const child=fakeProcess(m=>calls.push(m));child.kill=()=>{queueMicrotask(()=>child.emit('exit',0));return true;};
 const server=new CodexAppServer({spawnProcess:()=>child});await server.releaseAndClose();assert.deepEqual(calls,[]);
});
test('unsubscribe failure still waits for its own child to exit',async()=>{
 const child=fakeProcess((m,c)=>c.send({id:m.id,error:{code:-32601,message:'unsupported'}}));child.kill=()=>{queueMicrotask(()=>child.emit('exit',0));return true;};
 const server=new CodexAppServer({spawnProcess:()=>child});await server.releaseAndClose('owned-thread');assert.equal(server.closed,true);
});

test('native user input is queued only with an explicit scoped gate; lifecycle clears it',async()=>{
  const {UserInputGate}=await import('./user-input-gate.mjs');
  const sent=[];const child=fakeProcess(m=>sent.push(m));
  const server=new CodexAppServer({spawnProcess:()=>child});
  const prompt=id=>({id,method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'run',itemId:'item',questions:[{id:'d',header:'Approval',question:'Create proposal?',isOther:false,isSecret:false,options:[{label:'Decline',description:'Do not run'}]}]}});
  try{
    child.send(prompt(1));await new Promise(r=>setImmediate(r));assert.equal(sent[0].error.code,-32601);
    const gate=new UserInputGate({threadId:'t',turnId:'run'});server.attachUserInputGate(gate);
    child.send(prompt(2));await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
    assert.equal(gate.answer(2,{d:{answers:['Decline']}}),true);assert.equal(sent[1].id,2);
    child.send(prompt(3));child.send({method:'serverRequest/resolved',params:{threadId:'t',requestId:3}});
    await new Promise(r=>setImmediate(r));assert.equal(gate.answer(3,{d:{answers:['Decline']}}),false);
    child.send(prompt(4));child.send({method:'turn/completed',params:{threadId:'t',turn:{id:'run'}}});
    await new Promise(r=>setImmediate(r));assert.equal(gate.answer(4,{d:{answers:['Decline']}}),false);
  }finally{server.close();}
});

for(const cause of ['cancel','timeout'])test(`${cause} fences a queued human answer before interrupt acknowledgement`,async()=>{
 const {UserInputGate}=await import('./user-input-gate.mjs');
 const controller=new AbortController();let acknowledge,interruptSent;const interrupted=new Promise(r=>interruptSent=r);const responses=[];
 const child=fakeProcess((m,c)=>{
  if(m.method==='turn/start')c.send({id:m.id,result:{turn:{id:'run'}}});
  else if(m.method==='turn/interrupt'){acknowledge=()=>{c.send({id:m.id,result:{}});c.send({method:'turn/completed',params:{threadId:'t',turn:{id:'run',status:'interrupted'}}});};interruptSent();}
  else responses.push(m);
 });
 const server=new CodexAppServer({spawnProcess:()=>child});
 const gate=new UserInputGate({threadId:'t',turnId:'run'});server.attachUserInputGate(gate);
 let started;const ready=new Promise(r=>started=r);
 const turn=server.turn('t','test',{signal:controller.signal,timeout:cause==='timeout'?100:5000,onStarted:async()=>{started();}});
 const rejected=assert.rejects(turn,cause==='timeout'?/timed out/:/interrupted/);
 try{
  await ready;
  child.send({id:50,method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'run',itemId:'i',questions:[{id:'q',header:'Confirm',question:'Continue?',isOther:false,isSecret:false,options:[{label:'Accept',description:'Continue'}]}]}});
  await new Promise(r=>setImmediate(r));assert.equal(gate.pending.size,1);
  if(cause==='cancel')controller.abort();
  await interrupted;
  assert.equal(gate.answer(50,{q:{answers:['Accept']}}),false);
  assert.equal(responses.length,0);assert.equal(typeof acknowledge,'function');
  acknowledge();await rejected;
 }finally{server.close();}
});

test('interactive native start and resume verify on-request with human reviewer',async()=>{
 const sent=[];const child=fakeProcess((m,c)=>{sent.push(m);c.send({id:m.id,result:{thread:{id:'t'},approvalPolicy:'on-request',approvalsReviewer:'user'}});});
 const server=new CodexAppServer({spawnProcess:()=>child,nativeMcpTools:true});
 try{await server.start('/project','model',{interactiveInput:true});await server.resume('t','/project','model',{interactiveInput:true});
  assert.ok(sent.every(m=>m.params.approvalPolicy==='on-request'&&m.params.sandbox==='read-only'));
 }finally{server.close();}
});
test('interactive native adapter fails closed on another reviewer or missing policy',async()=>{
 for(const result of [{approvalPolicy:'on-request',approvalsReviewer:'auto_review'},{}]){
  const child=fakeProcess((m,c)=>c.send({id:m.id,result}));const server=new CodexAppServer({spawnProcess:()=>child,nativeMcpTools:true});
  try{await assert.rejects(server.start('/project','model',{interactiveInput:true}),/could not be verified/);await assert.rejects(server.resume('t','/project','model',{interactiveInput:true}),/could not be verified/);}finally{server.close();}
 }
 const server=new CodexAppServer({spawnProcess:()=>fakeProcess(()=>assert.fail('Must not send'))});
 try{await assert.rejects(server.start('/project','model',{interactiveInput:true}),/isolated MCP/);}finally{server.close();}
});
