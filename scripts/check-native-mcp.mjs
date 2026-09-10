/** Explicit live acceptance run; uses the signed-in user's Codex and may consume usage.
 * node scripts/check-native-mcp.mjs --config /absolute/config.json --document-id UUID
 *   --prompt /absolute/brief.txt --output /absolute/evidence.json
 * Not part of automated tests. No global Codex settings are written.
 */
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {openNativeMcp,nativeMcpInstructions} from "../runtime/native-mcp.mjs";
import {ProjectClient} from "./project-mcp/client.mjs";
import assert from "node:assert/strict";
const option=name=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error(`Missing ${name}`);return process.argv[i+1];};
const configPath=option("--config"),id=option("--document-id"),promptPath=option("--prompt"),output=option("--output");
const resumePath=process.argv.includes("--resume-from")?option("--resume-from"):null;
const previous=resumePath?JSON.parse(await readFile(resumePath,"utf8")):null;
if(previous&&(previous.documentId!==id||previous.status!=="completed"||!previous.threadId||!previous.model))throw new Error("Resume evidence must identify a completed run for this document");
if(![configPath,promptPath,output].every(p=>p.startsWith("/"))||!/^[-a-f0-9]{36}$/.test(id))throw new Error("Use absolute paths and a document UUID");
const config=JSON.parse(await readFile(configPath,"utf8")),prompt=await readFile(promptPath,"utf8");
if(!prompt.trim()||prompt.length>16000)throw new Error("Brief must be 1–16000 characters");
await mkdir(dirname(output),{recursive:true});
// Never overwrite the evidence or start a new run after an uncertain result.
await writeFile(output,"{}",{flag:"wx",mode:0o600});
const evidence={documentId:id,startedAt:new Date().toISOString(),status:"starting",events:[]};
let pending=Promise.resolve();
const save=()=>{const bytes=JSON.stringify(evidence,null,2);pending=pending.then(()=>writeFile(output,bytes,{mode:0o600}));return pending;};
let server,initial;
try {
  const initialReader=new ProjectClient({configPath,documentId:id});
  try {
    initial=await initialReader.tool("get_project");
    if(!previous&&!initial.canPopulate)throw new Error("This creation check requires an unchanged empty UI draft");
    if(previous&&!initial.state)throw new Error("Review requires a saved presentation");
    evidence.initialRevision=initial.state.revision;
  } finally {initialReader.close();}
  const cwd=resolve(config.runtimeRoot,"native-mcp",id);
  server=await openNativeMcp({...config,cwd,mcpCommand:process.execPath,mcpArgs:[resolve(".project-runtime/server.mjs"),"--library-config",configPath,"--document-id",id]});
  const catalog=await server.request("model/list",{}),model=previous?.model||catalog.data?.find(m=>m.isDefault)?.model;
  if(!model)throw new Error("No default model");
  evidence.model=model;
  if(previous){
    const actual=await server.request("thread/read",{threadId:previous.threadId,includeTurns:true});
    if(actual.thread?.id!==previous.threadId||actual.thread.cwd!==cwd)throw new Error("Saved native thread binding changed");
    if(actual.thread.turns.some(t=>t.status==="inProgress"))throw new Error("Previous native turn is still running; do not start a replacement");
  }
  const settings={instructions:nativeMcpInstructions,config:server.nativeThreadConfig};
  const t=previous?await server.resume(previous.threadId,cwd,model,settings):await server.start(cwd,model,{persistent:true,...settings});
  if(previous&&t.thread.id!==previous.threadId)throw new Error("Native resume substituted another thread");
  evidence.mode=previous?"review":"create";
  evidence.threadId=t.thread.id;
  let cursor,tools=[];
  do {
    const inventory=await server.request("mcpServerStatus/list",{threadId:t.thread.id,detail:"toolsAndAuthOnly",...(cursor?{cursor}:{})});
    for(const s of inventory.data){const names=Object.keys(s.tools||{});if(s.name!=="lanka_document"&&names.length)throw new Error(`Unexpected callable server: ${s.name}`);if(s.name==="lanka_document")tools.push(...names);}
    cursor=inventory.nextCursor;
  }while(cursor);
  if(!tools.includes("populate_draft")||!tools.includes("render_slides"))throw new Error("Required Lanka tools are missing");
  evidence.tools=tools;evidence.status="running";await save();
  server.on("notification",m=>{
    if(m.params?.threadId!==t.thread.id||m.method!=="item/completed")return;
    const item=m.params.item;
    if(item.type!=="mcpToolCall")return;
    evidence.events.push({at:new Date().toISOString(),tool:item.tool,status:item.status,arguments:item.arguments,
      isError:item.result?.isError,error:item.error||null,
      text:item.result?.content?.filter(c=>c.type==="text").map(c=>c.text).join("\n").slice(0,4000),
      imageCount:item.result?.content?.filter(c=>c.type==="image").length||0});
    void save();console.log(`${item.tool}: ${item.status}`);
  });
  evidence.reply=await server.turn(t.thread.id,prompt,{effort:"medium",timeout:480000,onStarted:async turnId=>{evidence.turnId=turnId;await save();}});
  evidence.providerStatus="completed";
  const reader=new ProjectClient({configPath,documentId:id});
  try {
    const project=await reader.tool("get_project");
    evidence.saved={revision:project.state?.revision,slideCount:project.state?.doc.slides.length,canPopulate:project.canPopulate};
    const completed=evidence.events.filter(e=>e.status==="completed"&&!e.error&&!e.isError);
    if(previous) {
      assert.deepEqual(project.state.doc,initial.state.doc,"Native review must preserve the saved document");
      assert.equal(project.state.revision,initial.state.revision);
      const proposals=project.state.proposals.filter(p=>!initial.state.proposals.some(old=>old.id===p.id));
      if(!proposals.length)throw new Error("No new review proposal was saved");
      for(const proposal of proposals){
        if(proposal.status!=="pending"||!proposal.feedbackIds?.length)throw new Error("Review proposal must be pending and linked to feedback");
        const seen=new Set(completed.filter(e=>e.tool==="render_slides"&&e.imageCount&&e.arguments.proposalId===proposal.id).flatMap(e=>e.arguments.slideIds||[]));
        if(proposal.changes.some(c=>!seen.has(c.slideId)))throw new Error("Agent did not inspect all proposed slides");
        if(!project.state.comments.some(c=>c.proposalId===proposal.id&&proposal.feedbackIds.includes(c.replyTo)&&!initial.state.comments.some(old=>old.id===c.id)))throw new Error("No reply linked to proposal and feedback");
      }
      evidence.proposalIds=proposals.map(p=>p.id);
    } else {
      if(!project.state||project.canPopulate||project.state.revision<=evidence.initialRevision)throw new Error("Agent finished without filling the presentation");
      if(!completed.some(e=>e.tool==="populate_draft")||!completed.some(e=>e.tool==="get_design_profile"&&e.imageCount))throw new Error("Native creation and visual design context were not observed");
      const seen=new Set(completed.filter(e=>e.tool==="render_slides"&&e.imageCount).flatMap(e=>e.arguments.slideIds||[]));
      evidence.unseenSlides=project.state.doc.slides.filter(s=>!seen.has(s.id)).map(s=>s.id);
      if(evidence.unseenSlides.length)throw new Error("Agent did not inspect every saved slide");
    }
  } finally {reader.close();}
  evidence.status="completed";console.log(evidence.reply);
} catch(e){evidence.status="failed";evidence.error=e.message;process.exitCode=1;console.error(e.message);}
finally{evidence.finishedAt=new Date().toISOString();await save();server?.close();}
