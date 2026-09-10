import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectClient } from "./client.mjs";
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanka-project-")));
  const c = new ProjectClient(root);
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, c };
}
const create = () => ({
  briefing: {audience:{value:"Test audience",origin:"user"},decision:{value:"Review",origin:"user"},keyMessage:{value:"Test fixture",origin:"user"}},
  requestId: randomUUID(),
  title: "Project A",
  markdown:
    "# Project A\n\n## Private workspace\nOne client, one project.\n\n## Human review\nChanges stay separate until accepted.",
});
test("Real stdio MCP creates one folder document, replays receipt and rejects cross-project IDs", async (t) => {
  const { root, c } = await setup(t);
  const init = await c.call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.result.serverInfo.name, "lanka-project-folder");
  const tools = await c.call("tools/list");
  assert.equal(tools.result.tools.length, 20);
  assert.equal(tools.result.tools.find(t=>t.name==='suggest_data_size').annotations.readOnlyHint,true);
  assert.ok(tools.result.tools.some(t=>t.name==='get_design_profile'));
  const a = create(),
    first = await c.tool("create_deck", a);
  assert.deepEqual(await c.tool("create_deck", a), first);
  await assert.rejects(
    c.tool("create_deck", { ...a, title: "Different" }),
    /reused/,
  );
  const p = JSON.parse(await readFile(join(root, "project.json"), "utf8"));
  assert.equal(p.state.doc.id, first.deckId);
  assert.equal(p.receipts.length, 1);
  await assert.rejects(
    c.tool("lint_deck", { deckId: "another-client" }),
    /outside/,
  );
  await assert.rejects(c.tool("get_project", { path: "../other" }), /no paths/);
});

test("Explicit briefing assumptions remain visible; sources stay frozen and edits reviewable", async t => {
  const {root,c}=await setup(t);
  const a=create();a.briefing.audience.origin="assumption";
  const d=await c.tool("create_deck",a);
  let p=await c.tool("get_project");
  assert.match(p.state.comments[0].text,/допущения/);
  const src={requestId:randomUUID(),deckId:d.deckId,expectedRevision:1,name:"Evidence.csv",contentType:"text/csv",base64:Buffer.from("category,value\nA,12\nB,8").toString("base64")};
  const registered=await c.tool("register_source",src);
  assert.deepEqual(await c.tool("register_source",src),registered);
  assert.equal((await readFile(join(root,"materials",`${registered.sha256}.bin`))).toString(),"category,value\nA,12\nB,8");
  await assert.rejects(c.tool("propose_commands",{requestId:randomUUID(),deckId:d.deckId,expectedRevision:1,title:"Bad",commands:[{op:"set_title",slideId:"outside",value:"X"}]}),/outside/);
  await assert.rejects(c.tool("propose_commands",{requestId:randomUUID(),deckId:d.deckId,expectedRevision:1,title:"Bad",commands:[{op:"set_table",slideId:p.state.doc.slides[0].id,value:{columns:["A","B"],rows:[["one"]]}}]}));
  const proposal=await c.tool("propose_commands",{requestId:randomUUID(),deckId:d.deckId,expectedRevision:1,title:"Evidence table",commands:[{op:"set_table",slideId:p.state.doc.slides[0].id,value:{columns:["Category","Value"],rows:[["A","12"],["B","8"]],sourceId:registered.sourceId}}]});
  p=await c.tool("get_project");
  assert.equal(p.state.doc.slides[0].table,undefined);
  assert.equal(p.state.proposals.find(v=>v.id===proposal.proposalId).changes[0].after.table.sourceId,registered.sourceId);
  await assert.rejects(c.tool("register_source",{...src,requestId:randomUUID(),deckId:"other"}),/outside/);
  await assert.rejects(c.tool("register_source",{...src,requestId:randomUUID(),contentType:"image/png"}),/PNG/);
});
test("Real MCP creates a draft without an interview and preserves partial answer provenance",async t=>{
  const {c}=await setup(t),a=create();delete a.briefing;
  const tools=(await c.call("tools/list")).result.tools;
  assert.ok(!tools.find(v=>v.name==="create_deck").inputSchema.required.includes("briefing"));
  const created=await c.tool("create_deck",a);
  assert.deepEqual(await c.tool("create_deck",a),created);
  const p=await c.tool("get_project");
  assert.deepEqual(p.state.doc.brief.origins,{audience:"assumption",decision:"assumption",keyMessage:"assumption"});
  assert.match(p.state.comments[0].text,/не ответы заказчика/);
  const second=await setup(t),b=create();b.briefing={audience:{value:"Руководители департаментов",origin:"user"}};
  await second.c.tool("create_deck",b);
  const q=await second.c.tool("get_project");
  assert.equal(q.briefing.audience.origin,"user");
  assert.equal(q.state.doc.brief.audience,"Руководители департаментов");
  assert.equal(q.briefing.decision.origin,"assumption");
  assert.equal(q.state.doc.brief.origins.keyMessage,"assumption");
});
test("Agent proposal never applies to main and has no approve/share tools", async (t) => {
  const { c } = await setup(t);
  const d = await c.tool("create_deck", create()),
    p = await c.tool("get_project");
  const after = { ...p.state.doc.slides[0], title: "Proposed new title" };
  const args = {
    requestId: randomUUID(),
    deckId: d.deckId,
    expectedRevision: 1,
    title: "Suggestion",
    changes: [{ slideId: after.id, after }],
  };
  await c.tool("propose_changes", args);
  const fresh = await c.tool("get_project");
  assert.notEqual(fresh.state.doc.slides[0].title, after.title);
  assert.equal(fresh.state.proposals.length, 1);
  await c.tool("propose_changes", args);
  assert.equal((await c.tool("get_project")).state.proposals.length, 1);
  await assert.rejects(
    c.tool("propose_changes", {
      ...args,
      requestId: randomUUID(),
      expectedRevision: 2,
    }),
    /conflict/,
  );
  for (const name of ["approve", "publish", "share", "read_file"])
    await assert.rejects(c.tool(name, {}), /Unknown tool/);
});
test("A second MCP process cannot corrupt a concurrent create or write through a lock", async (t) => {
  const { root, c } = await setup(t),
    other = new ProjectClient(root);
  t.after(() => other.close());
  const a = create();
  const results = await Promise.allSettled([
    c.tool("create_deck", a),
    other.tool("create_deck", a),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const p = JSON.parse(await readFile(join(root, "project.json"), "utf8"));
  assert.equal(p.receipts.length, 1);
  await writeFile(join(root, "write.lock"), "held");
  await assert.rejects(
    c.tool("add_comment", {
      requestId: randomUUID(),
      deckId: p.state.doc.id,
      expectedRevision: 1,
      slideId: p.state.doc.slides[0].id,
      text: "hello",
    }),
    /locked/,
  );
  assert.equal(await readFile(join(root, "write.lock"), "utf8"), "held");
});
test("Folder MCP rejects linked state and export directories", async (t) => {
  const { root, c } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "lanka-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "private");
  await symlink(join(outside, "secret.txt"), join(root, "project.json"));
  await assert.rejects(c.tool("get_project"));
  await rm(join(root, "project.json"));
  const d = await c.tool("create_deck", create());
  await symlink(outside, join(root, "exports"));
  await assert.rejects(
    c.tool("export_deck", {
      deckId: d.deckId,
      expectedRevision: 1,
      format: "pptx",
    }),
    /Linked exports/,
  );
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "private");
});

test('Handoff contains verified material bytes, excludes grants and refuses stale export',async t=>{
  const {root,c}=await setup(t),d=await c.tool('create_deck',create());
  const source=await c.tool('register_source',{requestId:randomUUID(),deckId:d.deckId,expectedRevision:1,name:'Source.txt',contentType:'text/plain',base64:Buffer.from('Project-only evidence').toString('base64')});
  const result=await c.tool('export_handoff',{deckId:d.deckId,expectedRevision:1});
  assert.equal(result.editorUrl,null);assert.equal(result.status,'upload_required');
  const handoff=JSON.parse(await readFile(result.path,'utf8'));
  assert.equal(handoff.format,'lanka-handoff/v1');
  assert.equal(Buffer.from(handoff.materials[0].base64,'base64').toString(),'Project-only evidence');
  assert.equal(handoff.grants,undefined);assert.equal(handoff.receipts,undefined);assert.equal(handoff.approvedRevision,undefined);
  await assert.rejects(c.tool('export_handoff',{deckId:d.deckId,expectedRevision:2}),/conflict/);
  await writeFile(join(root,'materials',source.sha256+'.bin'),'Tampered bytes');
  await assert.rejects(c.tool('export_handoff',{deckId:d.deckId,expectedRevision:1}),/hash mismatch/);
});
