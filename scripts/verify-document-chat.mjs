// Explicit live acceptance: uses the locally connected account and creates a new test document.
// Run `node scripts/verify-document-chat.mjs start`, restart Lanka, then run `... resume`.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Pool } from "pg";

const phase=process.argv[2];
if(!["start","resume"].includes(phase))throw new Error("Pass start or resume; this test invokes the real agent.");
const origin="http://127.0.0.1:4317",output=new URL("../out/chat-acceptance/",import.meta.url);
await mkdir(output,{recursive:true});
const landing=await fetch(origin),cookie=landing.headers.get("set-cookie").split(";")[0];
const headers={Cookie:cookie,Origin:origin,"Content-Type":"application/json"};
const config=JSON.parse(await readFile(new URL("../work/agent-chat/config.json",import.meta.url),"utf8"));
const pool=new Pool(config.connection);
async function api(path,body) {
  const r=await fetch(origin+path,{headers,method:body===undefined?"GET":"POST",...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await r.json();if(!r.ok)throw new Error(`${path}: ${r.status}: ${JSON.stringify(data)}`);return data;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=220000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await fn();if(value)return value;await pause(350);}
  throw new Error("Acceptance timed out");
}
const getProject=id=>api(`/api/project?documentId=${id}`);
let report;
const save=()=>writeFile(new URL("live-chat.json",output),JSON.stringify(report,null,2));
async function send(text,mode="discuss") {
  const p=await getProject(report.documentId);
  const input={requestId:randomUUID(),text,mode,expectedRevision:p.state.revision,selection:{slideId:p.state.doc.slides[0].id,field:"title"}};
  const sent=await api(`/api/v1/agent-sessions/${report.sessionId}/messages`,input);
  assert.deepEqual(await api(`/api/v1/agent-sessions/${report.sessionId}/messages`,input),sent);
  return sent;
}
async function complete(sent) {
  const view=await until(async()=>{const v=await api(`/api/v1/agent-sessions/${report.sessionId}`);return !v.active?v:null;});
  const message=view.messages.at(-1);assert.equal(message.status,"complete",message.text);
  const run=(await pool.query("SELECT s.native_thread_id,r.native_turn_id,j.status FROM lanka.agent_sessions s JOIN lanka.agent_runs r ON r.tenant_id=s.tenant_id AND r.session_id=s.id JOIN lanka.jobs j ON j.tenant_id=r.tenant_id AND j.id=r.id WHERE r.tenant_id=$1 AND r.id=$2",[config.tenantId,sent.runId])).rows[0];
  assert.equal(run.status,"completed");assert.ok(run.native_thread_id);assert.ok(run.native_turn_id);
  report.turns.push({runId:sent.runId,...run,messageId:message.id,text:message.text,proposalId:message.proposalId,cursor:view.cursor});await save();return message;
}
try {
  if(phase==="start") {
    const state=await api("/api/v1/agent-connections/local-codex/connect",{});assert.equal(state.status,"ready");
    const id=randomUUID();
    await api("/api/library",{requestId:id,command:{action:"create_document",title:"Цивилизации: обсудить и улучшить",folderId:null,markdown:"# Цивилизации: обсудить и улучшить\n\n## Как города изменили общество\nПостоянные поселения позволили людям специализироваться, обмениваться товарами и передавать знания.\n\n## Письмо сохраняет знания\nЗаписи помогали учитывать запасы, закреплять договорённости и передавать сведения между поколениями.\n\n## Торговля соединяет регионы\nВместе с товарами люди переносили технологии, идеи и привычки.\n\n## Связи важнее изоляции\nРазвитие цивилизаций можно рассматривать через обмен знаниями, организацию труда и взаимодействие обществ."}});
    let p=await getProject(id);const doc=structuredClone(p.state.doc);doc.design="focus-v3";
    await api(`/api/project?documentId=${id}`,{requestId:randomUUID(),deckId:id,expectedRevision:p.state.revision,command:{action:"save",doc}});
    const {sessionId}=await api(`/api/v1/materials/${id}/agent-sessions`,{});
    report={date:new Date().toISOString(),surface:"live HTTP + Codex App Server, browser QA pending",documentId:id,sessionId,model:state.model,cli:state.version,turns:[]};await save();
    await complete(await send("Для этой беседы аудитория — руководители, а главный акцент — обмен идеями. Запомни это для следующего сообщения. Предложи одним коротким абзацем, как сделать выбранный слайд интереснее для этой аудитории. Пока ничего не меняй."));
    p=await getProject(id);assert.equal(p.state.revision,2);assert.equal(p.state.proposals.length,0);
    report.firstPhase="passed";await save();console.log(JSON.stringify({phase,documentId:id,sessionId,status:"passed; restart server before resume"}));
  } else {
    report=JSON.parse(await readFile(new URL("live-chat.json",output),"utf8"));
    let p;
    if(!report.review) {
    const memory=await complete(await send("Напомни, какую аудиторию и главный акцент я указал в предыдущем сообщении. Ответь одним предложением, ничего не меняй."));
    assert.match(memory.text,/руководител/i);assert.match(memory.text,/обмен/i);
    const edit=await complete(await send("Предложи заменить только заголовок выбранного слайда на «Города объединяют знания». Не меняй основной текст и остальные слайды.","edit"));
    assert.ok(edit.proposalId);
    p=await getProject(report.documentId);const before=structuredClone(p.state.doc);
    const proposal=p.state.proposals.find(v=>v.id===edit.proposalId);assert.ok(proposal);
    assert.equal(p.state.revision,2);assert.notEqual(p.state.doc.slides[0].title,"Города объединяют знания");
    await api(`/api/project?documentId=${report.documentId}`,{requestId:randomUUID(),deckId:report.documentId,expectedRevision:p.state.revision,command:{action:"accept",proposalId:proposal.id,changeIds:proposal.changes.map(c=>c.id)}});
    p=await getProject(report.documentId);assert.equal(p.state.doc.slides[0].title,"Города объединяют знания");assert.equal(p.state.revision,3);
    assert.equal(p.state.doc.slides[0].body,before.slides[0].body);assert.deepEqual(p.state.doc.slides.slice(1),before.slides.slice(1));
    assert.equal(new Set(report.turns.map(t=>t.native_thread_id)).size,1,"all turns resume the exact native thread across server restart");
    report.review={proposalId:proposal.id,acceptedRevision:p.state.revision,unchangedOtherSlides:true};await save();
    }
    report.exports=[];
    for(const format of ["pdf","pptx"]) {
      const r=await fetch(origin+`/api/export?documentId=${report.documentId}`,{headers,method:"POST",body:JSON.stringify({deckId:report.documentId,expectedRevision:3,format})});
      assert.equal(r.status,200,await (r.status===200?Promise.resolve(""):r.text()));
      const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.length>1000);
      assert.equal(bytes.subarray(0,format==="pdf"?5:2).toString(),format==="pdf"?"%PDF-":"PK");
      await writeFile(new URL(`civilizations.${format}`,output),bytes);report.exports.push({format,revision:r.headers.get("x-lanka-revision"),bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
    }
    const cancelled=await send("Составь подробный план обсуждения истории цивилизаций: двадцать пунктов с пояснениями. Пока не меняй презентацию.");
    await until(async()=>{
      const r=await pool.query("SELECT native_turn_id FROM lanka.agent_runs WHERE tenant_id=$1 AND id=$2",[config.tenantId,cancelled.runId]);return r.rows[0]?.native_turn_id;
    },30000);
    await api(`/api/v1/agent-runs/${cancelled.runId}/cancel`,{sessionId:report.sessionId,requestId:randomUUID()});
    const acknowledgement=await until(async()=>{
      const r=await pool.query("SELECT r.interrupt_acknowledged,j.status FROM lanka.agent_runs r JOIN lanka.jobs j ON j.tenant_id=r.tenant_id AND j.id=r.id WHERE r.tenant_id=$1 AND r.id=$2",[config.tenantId,cancelled.runId]);return r.rows[0]?.interrupt_acknowledged?r.rows[0]:null;
    },10000);
    await pause(1500);p=await getProject(report.documentId);
    assert.equal(p.state.revision,3);assert.equal(p.state.proposals.length,1);assert.equal(acknowledgement.status,"cancelled");
    report.cancellation={runId:cancelled.runId,...acknowledgement,lateMutation:false};
    const events=await pool.query("SELECT kind,count(*)::int AS count FROM lanka.agent_events WHERE tenant_id=$1 AND session_id=$2 GROUP BY kind",[config.tenantId,report.sessionId]);
    report.events=events.rows;assert.ok(events.rows.some(e=>e.kind==="message.delta"&&e.count>0));
    report.final="passed";await save();console.log(JSON.stringify({phase,status:"passed",documentId:report.documentId,turns:report.turns.length,cancellation:report.cancellation,exports:report.exports.map(e=>e.format)}));
  }
} finally {await pool.end();}
