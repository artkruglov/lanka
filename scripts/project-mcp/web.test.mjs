import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectClient } from "./client.mjs";
import { ProjectReviewSession } from "../../runtime/project-review.mjs";
import { ReviewCheckpoint } from "../../runtime/review-checkpoint.mjs";
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanka-web-")));
  const worker = spawn(process.execPath, [resolve(".project-runtime/web.mjs"), "--root", root, "--port", "0"], {stdio: ["ignore", "pipe", "pipe"]});
  const client = new ProjectClient(root);
  t.after(async () => {worker.kill(); client.close(); await rm(root, {recursive: true, force: true});});
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Project editor startup timed out")), 10000);
    worker.once("exit", code => {clearTimeout(timer); reject(new Error(`Editor exited: ${code}`));});
    worker.stdout.on("data", b => {const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/); if(m) {clearTimeout(timer); resolve(m[0]);}});
  });
  const landing = await fetch(origin);
  const cookie = landing.headers.get("set-cookie").split(";")[0];
  const headers = {Cookie: cookie, Origin: origin, "Content-Type": "application/json"};
  const get = async () => (await fetch(origin + "/api/project", {headers})).json();
  const post = async (command, base, requestId = randomUUID()) => fetch(origin + "/api/project", {method: "POST", headers,
    body: JSON.stringify({requestId, deckId: base?.state.doc.id, expectedRevision: base?.state.revision, command})});
  return {root, origin, headers, client, get, post};
}
test("expired cookie is recoverable while cross-origin requests remain denied before writes", async t => {
  const {origin,headers,get}=await setup(t);
  const expired=await fetch(origin+"/api/project",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({command:{action:"create",markdown:"# Must not create"}})});
  assert.equal(expired.status,403);assert.equal((await expired.json()).code,"LOCAL_SESSION_EXPIRED");
  assert.equal((await get()).empty,true);
  const denied=await fetch(origin+"/api/project",{headers:{...headers,Origin:"https://outside.example"}});
  assert.equal(denied.status,403);assert.equal(await denied.text(),"Origin denied");
  const home=await fetch(origin);assert.equal(home.status,200);assert.ok(home.headers.get("set-cookie"));
  assert.equal((await get()).empty,true);
});

test("Human editor and real MCP share one file, preserve feedback and review an agent proposal", async t => {
  const {root, client, get, post} = await setup(t);
  assert.equal((await post({action: "create", markdown: "# Shared project\n\n## Main point\nExplicit source text."})).status, 200);
  let p = await get();
  assert.equal(p.state.doc.design, "focus-v2");
  const originalStory = await client.tool("get_story", {deckId: p.state.doc.id});
  assert.equal(originalStory.realization.design, "focus-v2");
  assert.ok((await client.tool("get_authoring_guide")).recipes.statement);
  const doc = structuredClone(p.state.doc); doc.design = "classic-v1";
  const id = randomUUID();
  assert.equal((await post({action: "save",editorContract:'lanka-editor/3', doc}, p, id)).status, 200);
  assert.equal((await post({action: "save",editorContract:'lanka-editor/3', doc}, p, id)).status, 200);
  const actual = await client.tool("get_project");
  assert.equal(actual.state.doc.design, "classic-v1");
  assert.deepEqual(actual.state.doc.slides, p.state.doc.slides);
  assert.equal(actual.state.revision, 2);
  assert.equal((await post({action: "save",editorContract:'lanka-editor/3', doc}, p)).status, 400);
  p = await get();
  const slide = p.state.doc.slides[0];
  assert.equal((await post({action: "comment", slideId: slide.id, text: "Make the title more precise"}, p)).status, 200);
  assert.equal((await client.tool("get_story", {deckId: p.state.doc.id})).comments[0].text, "Make the title more precise");
  await client.tool("propose_changes", {requestId: randomUUID(), deckId: p.state.doc.id, expectedRevision: 2, title: "Precise wording",
    changes: [{slideId: slide.id, after: {...slide, title: "Revised main point"}}]});
  p = await get();
  assert.equal(p.state.doc.slides[0].title, slide.title);
  const proposal = p.state.proposals[0];
  assert.equal((await post({action: "accept", proposalId: proposal.id, changeIds: proposal.changes.map(c => c.id)}, p)).status, 200);
  const saved = JSON.parse(await readFile(join(root,"project.json"),"utf8"));
  assert.equal(saved.state.doc.slides[0].title, "Revised main point");
  assert.equal(saved.state.revision, 3);
  assert.equal(saved.state.proposals[0].status, "closed");
  assert.equal(saved.state.comments.length, 1);
  await assert.rejects(client.tool("get_story", {deckId: "other-project"}), /outside/);
});
test("Project web server rejects missing session, cross-site writes, forged hosts and paths", async t => {
  const {origin, headers, get, post} = await setup(t);
  assert.equal((await fetch(origin + "/api/project")).status, 403);
  assert.equal((await fetch(origin + "/", {headers: {Origin: "https://unrelated.example"}})).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + "/", {headers: {Host: "unrelated.example"}}, res => {res.resume(); resolve(res.statusCode);});
    req.on("error", reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(origin + "/api/project", {method:"POST", headers:{...headers, Origin:"https://unrelated.example"}, body:"{}"})).status,403);
  assert.equal((await fetch(origin + "/api/project", {method:"POST", headers:{Cookie:headers.Cookie,"Content-Type":"application/json"}, body:"{}"})).status,404);
  assert.equal((await fetch(origin + "/project.json", {headers})).status,404);
  assert.equal((await fetch(origin + "/api/assets?id=../other-project", {headers})).status,400);
  const historical=await fetch(origin+'/api/assets?revision=1&id=old-image',{headers});assert.equal(historical.status,400);assert.match(await historical.text(),/нет проверяемого архива/);
  await post({action:"create",markdown:"# Client folder\n\n## One project\nLocal content."});
  const p = await get();
  assert.equal((await post({action:"save",editorContract:'lanka-editor/3', doc:{...p.state.doc,id:"another"}},p)).status,400);
  assert.equal((await post({action:"publish"},p)).status,400);
  const exportResult = await fetch(origin+"/api/export", {method:"POST",headers,body:JSON.stringify({deckId:p.state.doc.id,expectedRevision:p.state.revision,format:"pdf"})});
  assert.equal(exportResult.status,200);
  assert.equal(exportResult.headers.get("x-lanka-revision"),"1");
  assert.equal(new TextDecoder().decode((await exportResult.arrayBuffer()).slice(0,5)),"%PDF-");
});

test("Live feedback reaches the same review thread and resolves only by an explicit human action", async t => {
  const {root,client,get,post}=await setup(t);
  await post({action:"create",markdown:"# Review loop\n\n## Main point\nEvidence matters."});
  let p=await get();
  const deckId=p.state.doc.id,slideId=p.state.doc.slides[0].id;
  const start=await client.tool("wait_for_feedback",{deckId,timeoutMs:0});
  const waiting=client.tool("wait_for_feedback",{deckId,cursor:start.cursor,timeoutMs:3000});
  await post({action:"comment",slideId,text:"Сделай вывод конкретнее"},p);
  const update=await waiting;
  assert.equal(update.changed,true);
  assert.equal(update.comments.length,1);
  assert.equal((await client.tool("wait_for_feedback",{deckId,cursor:update.cursor,timeoutMs:1})).changed,false);
  let starts=0,turns=0;
  const fakeServer={start:async()=>{starts++;return {thread:{id:"same-thread"}};},turn:async(threadId,prompt)=>{
    assert.equal(threadId,"same-thread");assert.match(prompt,/недоверенные/);turns++;
    return JSON.stringify({title:"Уточнение вывода",reply:"Уточнил формулировку, проверьте результат.",commands:[{op:"set_title",slideId,value:`Новый вывод ${turns}`}]});
  }};
  const session=new ProjectReviewSession({client,server:fakeServer,root});
  await session.reviewNext();
  p=await get();
  assert.equal(p.state.doc.slides[0].title,"Main point");
  assert.equal(p.state.comments[0].resolved,false);
  assert.equal(p.state.comments[1].replyTo,p.state.comments[0].id);
  const proposal=p.state.proposals[0];
  assert.equal((await post({action:"accept",proposalId:proposal.id,changeIds:proposal.changes.map(c=>c.id)},p)).status,200);
  p=await get();
  assert.equal(p.state.comments[0].resolved,false,"accepting a proposal does not resolve the reviewer's concern");
  assert.equal((await post({action:"resolve_comment",commentId:p.state.comments[0].id},p)).status,200);
  p=await get();
  assert.equal(p.state.comments[0].resolved,true,"resolution is an explicit separate action");
  assert.equal(p.state.doc.slides[0].title,"Новый вывод 1");
  await post({action:"comment",slideId,text:"Добавь ещё конкретики"},p);
  await session.reviewNext();
  assert.equal(starts,1);assert.equal(turns,2);
  assert.equal((await session.reviewNext()).idle,true);
});
test("Review restart resumes one thread and recovers a committed proposal after a lost response",async t=>{
  const {root,client,get,post}=await setup(t);
  const home=await realpath(await mkdtemp(join(tmpdir(),"lanka-review-home-")));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await post({action:"create",markdown:"# Resume\n\n## Main point\nOriginal text."});
  let p=await get();const deckId=p.state.doc.id,slideId=p.state.doc.slides[0].id;
  await post({action:"comment",slideId,text:"Уточни вывод"},p);
  let starts=0,resumes=0,turns=0,lose=true;
  const server={
    start:async(_root,_model,options)=>{assert.equal(options.persistent,true);starts++;return {thread:{id:"durable-thread"}};},
    resume:async id=>{assert.equal(id,"durable-thread");resumes++;return {thread:{id}};},
    turn:async()=>{turns++;return JSON.stringify({title:"Уточнение",reply:"Предлагаю правку",commands:[{op:"set_title",slideId,value:"Уточнённый вывод"}]});},
  };
  const interruptedClient={tool:async(name,args)=>{const r=await client.tool(name,args);if(name==="propose_commands"&&lose){lose=false;throw new Error("Lost response after commit");}return r;}};
  let checkpoint=await ReviewCheckpoint.open({home,root,deckId});
  await assert.rejects(new ProjectReviewSession({client:interruptedClient,server,root,checkpoint}).reviewNext(),/Lost response/);
  await checkpoint.close();
  checkpoint=await ReviewCheckpoint.open({home,root,deckId});
  const restarted=new ProjectReviewSession({client,server,root,checkpoint});
  await restarted.reviewNext();
  p=await get();
  assert.equal(p.state.proposals.length,1);assert.equal(turns,1);
  assert.equal(p.state.comments.filter(c=>c.replyTo).length,1);
  assert.equal(p.state.doc.slides[0].title,"Main point");
  const proposal=p.state.proposals[0];
  await post({action:"accept",proposalId:proposal.id,changeIds:proposal.changes.map(c=>c.id)},p);
  p=await get();await post({action:"comment",slideId,text:"Сделай ещё точнее"},p);
  await restarted.reviewNext();
  assert.equal(starts,1);assert.equal(resumes,1);assert.equal(turns,2);assert.equal(checkpoint.data.turns,2);
  await checkpoint.save({turns:20});
  p=await get();await post({action:"comment",slideId,text:"Ещё один запрос"},p);
  await assert.rejects(restarted.reviewNext(),/20-turn limit/);assert.equal(turns,2);
  await checkpoint.close();
});

test('HTTP object review persists mixed decisions with MCP, replay, conflicts and remaining acceptance',async t=>{
  const {client,get,post,root}=await setup(t);
  assert.equal((await post({action:'create',markdown:'# Review objects\n\n## Title\nBody'})).status,200);
  let p=await get();const doc=structuredClone(p.state.doc),slide=doc.slides[0];
  const text=(id,y)=>({id,kind:'text',x:100,y,w:800,h:100,text:id,size:32,bold:false,color:'#20243B',lineHeight:1.3});
  slide.canvas=[text('one',100),text('two',250),text('three',400),text('neighbor',550)];
  assert.equal((await post({action:'save',editorContract:'lanka-editor/3',doc},p)).status,200);p=await get();
  const after={...slide,canvas:slide.canvas.map(e=>e.id==='neighbor'?e:{...e,text:e.text+' proposed'})};
  await client.tool('propose_changes',{requestId:randomUUID(),deckId:doc.id,expectedRevision:p.state.revision,title:'Three separate edits',changes:[{slideId:slide.id,after}]});
  p=await get();const proposal=p.state.proposals.at(-1),change=proposal.changes[0];
  const manual=structuredClone(p.state.doc);manual.slides[0].canvas.find(e=>e.id==='neighbor').x=320;
  assert.equal((await post({action:'save',editorContract:'lanka-editor/3',doc:manual},p)).status,200);p=await get();
  const action={action:'review_objects',proposalId:proposal.id,changeId:change.id,elementIds:['one'],decision:'accepted'},receipt=randomUUID();
  assert.equal((await post(action,p,receipt)).status,200);assert.equal((await post(action,p,receipt)).status,200);
  assert.equal((await post({...action,elementIds:['two']},p)).status,400);
  p=await get();const acceptedRevision=p.state.revision;
  assert.equal((await post({...action,elementIds:['two'],decision:'rejected'},p)).status,200);p=await get();
  assert.equal(p.state.revision,acceptedRevision);
  assert.equal((await post({action:'accept',proposalId:proposal.id,changeIds:[change.id]},p)).status,200);
  const saved=await client.tool('get_project'),current=saved.state.doc.slides[0];
  assert.deepEqual(current.canvas.map(e=>e.text),['one proposed','two','three proposed','neighbor']);assert.equal(current.canvas[3].x,320);
  assert.equal(saved.state.proposals.at(-1).status,'closed');
  assert.deepEqual(saved.state.proposals.at(-1).changes[0].objectDecisions.map(d=>d.status),['accepted','rejected','accepted']);
  assert.deepEqual(JSON.parse(await readFile(join(root,'project.json'),'utf8')).state,saved.state);
  await assert.rejects(client.tool('review_objects',action));
});

test('HTTP file exports retain earlier bytes and expose the exact manifest through MCP history',async t=>{
 const f=await setup(t);await f.post({action:'create',markdown:'# Shared history\n\n## A saved idea\nOne reusable version.'});const before=await f.get();
 const res=await fetch(f.origin+'/api/export',{method:'POST',headers:f.headers,body:JSON.stringify({deckId:before.state.doc.id,expectedRevision:1,format:'pdf'})});assert.equal(res.status,200);
 const id=res.headers.get('x-lanka-artifact');assert.ok(id);const original=Buffer.from(await res.arrayBuffer());
 const list=await f.client.tool('list_exports',{deckId:before.state.doc.id});assert.equal(list.items.length,1);assert.equal(list.items[0].id,id);
 const info=await f.client.tool('get_export_artifact',{deckId:before.state.doc.id,artifactId:id});assert.equal(info.manifest.revision,1);assert.deepEqual(info.manifest.snapshot,before.state.doc);assert.deepEqual(await readFile(info.path),original);
 const doc=structuredClone(before.state.doc);doc.title='Later';assert.equal((await f.post({action:'save',editorContract:'lanka-editor/3',doc},before)).status,200);
 const file=await fetch(f.origin+`/api/export-artifacts?artifactId=${id}&part=file`,{headers:f.headers});assert.equal(file.status,200);assert.equal(file.headers.get('x-lanka-revision'),'1');assert.deepEqual(Buffer.from(await file.arrayBuffer()),original);
 const manifest=await fetch(f.origin+`/api/export-artifacts?artifactId=${id}&part=manifest`,{headers:f.headers});assert.equal((await manifest.json()).snapshot.title,'Shared history');
 assert.equal((await fetch(f.origin+'/api/export-artifacts')).status,403);
 assert.equal((await fetch(f.origin+'/api/export-artifacts?artifactId=../../project.json&part=file',{headers:f.headers})).status,400);
 const old=await fetch(f.origin+'/api/export',{method:'POST',headers:f.headers,body:JSON.stringify({deckId:before.state.doc.id,expectedRevision:1,format:'pdf'})});assert.equal(old.status,400);assert.equal((await f.client.tool('list_exports',{deckId:before.state.doc.id})).items.length,1);
});

test('obsolete editors cannot replace a document even at the current revision',async t=>{
 const {get,post}=await setup(t);
 assert.equal((await post({action:'create',markdown:'# Upgrade QA\n\n## Keep this slide\nOriginal content.'})).status,200);
 const before=await get(),doc=structuredClone(before.state.doc);doc.title='Must not be saved';
 for(const version of [undefined,'lanka-editor/1','lanka-editor/2']){
  const response=await post({action:'save',doc,...(version?{editorContract:version}:{})},before);
  assert.equal(response.status,426);assert.equal((await response.json()).code,'EDITOR_UPGRADE_REQUIRED');
  assert.deepEqual(await get(),before);
 }
 const response=await post({action:'save',doc,editorContract:'lanka-editor/3'},before);
 assert.equal(response.status,200);assert.equal((await get()).state.doc.title,doc.title);
});
