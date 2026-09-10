import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ProjectClient } from "./client.mjs";
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanka-library-"))),
    child = spawn(
      process.execPath,
      [resolve(".project-runtime/web.mjs"), "--workspace", root, "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  t.after(async () => {
    child.kill();
    await rm(root, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout")), 10000);
    child.stdout.on("data", (b) => {
      const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("server stopped"));
    });
  });
  const landing = await fetch(origin),
    cookie = landing.headers.get("set-cookie").split(";")[0],
    headers = {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    };
  const get = async (path) => {
    const r = await fetch(origin + path, { headers });
    const data = await r.json();
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  };
  const post = async (path, body, status = 200) => {
    const r = await fetch(origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      data = await r.json();
    assert.equal(r.status, status, JSON.stringify(data));
    return data;
  };
  const action = (command, requestId = randomUUID()) =>
    post("/api/library", { requestId, command });
  return { root, origin, headers, get, post, action };
}
test("library folders, document routing, trash and idempotency preserve independent MCP roots", async (t) => {
  const f = await fixture(t),
    folder = await f.action({ action: "create_folder", name: "History" }),
    rid = randomUUID(),
    command = {
      action: "create_document",
      title: "One",
      folderId: folder.id,
      markdown: "# One",
    };
  const first = await f.action(command, rid);
  assert.deepEqual(await f.action(command, rid), first);
  const second = await f.action({
    action: "create_document",
    title: "Two",
    folderId: null,
    markdown: "# Two",
  });
  assert.equal((await f.get("/api/library")).documents.length, 2);
  const p1 = await f.get(`/api/project?documentId=${first.id}`),
    p2 = await f.get(`/api/project?documentId=${second.id}`);
  assert.notEqual(p1.state.doc.id, p2.state.doc.id);
  await f.action({
    action: "move_document",
    id: second.id,
    folderId: folder.id,
  });
  const client = new ProjectClient(join(f.root, "documents", first.id));
  t.after(() => client.close());
  await assert.rejects(
    client.tool("get_story", { deckId: p2.state.doc.id }),
    /outside|вне|друг|project/i,
  );
  await f.action({ action: "trash_document", id: first.id, trashed: true });
  assert.equal(
    (
      await fetch(f.origin + `/api/project?documentId=${first.id}`, {
        headers: f.headers,
      })
    ).status,
    400,
  );
  await f.action({ action: "trash_document", id: first.id, trashed: false });
  assert.equal(
    (await f.get(`/api/project?documentId=${first.id}`)).state.doc.id,
    p1.state.doc.id,
  );
  assert.equal(
    (
      await fetch(f.origin + `/api/project?documentId=../../project.json`, {
        headers: f.headers,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(f.origin + "/api/library", {
        headers: { ...f.headers, Origin: "https://example.com" },
      })
    ).status,
    403,
  );
});
test("history retains original bytes, restores as new revision and rejects stale writes and altered snapshots", async (t) => {
  const f = await fixture(t),
    d = await f.action({
      action: "create_document",
      title: "Before",
      folderId: null,
      markdown: "# Before",
    }),
    path = `/api/project?documentId=${d.id}`;
  let p = await f.get(path);
  const original = p.state.doc;
  const saved = {
    requestId: randomUUID(),
    deckId: original.id,
    expectedRevision: 1,
    command: {
      action: "save",
      editorContract: 'lanka-editor/3',
      doc: {
        ...original,
        title: "After",
        slides: original.slides.map((s) => ({ ...s, title: "After" })),
      },
    },
  };
  const {editorContract, ...obsoleteCommand} = saved.command;
  const denied = await f.post(path, {...saved, requestId:randomUUID(), command:obsoleteCommand}, 426);
  assert.equal(denied.code, 'EDITOR_UPGRADE_REQUIRED');
  assert.deepEqual((await f.get(path)).state.doc, original);
  assert.equal((await f.get(`/api/history?documentId=${d.id}`)).length, 1);
  await f.post(path, saved);
  await f.post(path, saved);
  let history = await f.get(`/api/history?documentId=${d.id}`);
  assert.equal(history.length, 2);
  assert.equal(
    (await f.get(`/api/history?documentId=${d.id}&revision=1`)).title,
    "Before",
  );
  await f.post(path, { ...saved, requestId: randomUUID() }, 400);
  await f.post(path, {
    requestId: randomUUID(),
    deckId: original.id,
    expectedRevision: 2,
    command: { action: "restore", revision: 1 },
  });
  p = await f.get(path);
  assert.equal(p.state.revision, 3);
  assert.deepEqual(p.state.doc, original);
  history = await f.get(`/api/history?documentId=${d.id}`);
  assert.equal(history.length, 3);
  assert.equal(history[0].hash, history[2].hash);
  const snapshot = join(
    f.root,
    "documents",
    d.id,
    "revisions",
    `${history[0].hash}.json`,
  );
  await writeFile(snapshot, "{}");
  assert.equal(
    (
      await fetch(f.origin + `/api/history?documentId=${d.id}&revision=1`, {
        headers: f.headers,
      })
    ).status,
    400,
  );
  const prior = await readFile(
    join(f.root, "documents", d.id, "project.json"),
    "utf8",
  );
  await f.post(
    path,
    {
      requestId: randomUUID(),
      deckId: original.id,
      expectedRevision: 3,
      command: { action: "restore", revision: 1 },
    },
    400,
  );
  assert.equal(
    await readFile(join(f.root, "documents", d.id, "project.json"), "utf8"),
    prior,
  );
});
test("library refuses symlinked document roots", async (t) => {
  const f = await fixture(t),
    a = await f.action({
      action: "create_document",
      title: "A",
      folderId: null,
      markdown: "# A",
    }),
    b = await f.action({
      action: "create_document",
      title: "B",
      folderId: null,
      markdown: "# B",
    });
  await rm(join(f.root, "documents", a.id), { recursive: true });
  await symlink(
    join(f.root, "documents", b.id),
    join(f.root, "documents", a.id),
  );
  assert.equal(
    (
      await fetch(f.origin + `/api/project?documentId=${a.id}`, {
        headers: f.headers,
      })
    ).status,
    400,
  );
});

test("file library blank preserves selected design and cannot be populated again after restore", async (t) => {
  const f = await fixture(t), requestId = randomUUID();
  const command = {action:"create_document",title:"Название автора",folderId:null,empty:true,profile:"focus-v3"};
  const created = await f.action(command, requestId);
  assert.deepEqual(await f.action(command, requestId), created);
  const client = new ProjectClient(join(f.root,"documents",created.id));
  t.after(()=>client.close());
  const before = await client.tool("get_project");
  assert.equal(before.canPopulate,true);
  assert.equal(before.state.doc.design,"focus-v3");
  const seed = JSON.parse(await readFile("lib/examples/lanka-sales-focus-v3.json","utf8"));
  for(const {name,contentType,base64} of seed.materials) await client.tool("register_source",{requestId:randomUUID(),deckId:created.id,expectedRevision:1,name,contentType,base64});
  const input = {requestId:randomUUID(),deckId:created.id,expectedRevision:1,slides:[seed.doc.slides[0]]};
  const result = await client.tool("populate_draft",input);
  assert.deepEqual(await client.tool("populate_draft",input),result);
  const p = await f.get(`/api/project?documentId=${created.id}`);
  assert.equal(p.state.doc.title,command.title);
  assert.deepEqual(p.state.doc.brand,before.state.doc.brand);
  await f.post(`/api/project?documentId=${created.id}`,{requestId:randomUUID(),deckId:created.id,expectedRevision:2,command:{action:"restore",revision:1}});
  const restored = await client.tool("get_project");
  assert.deepEqual(restored.state.doc,before.state.doc);
  assert.equal(restored.canPopulate,false);
  await assert.rejects(client.tool("populate_draft",{...input,requestId:randomUUID(),expectedRevision:3}),/Заготовка уже/);
});

test('file workspace duplicates a saved document with durable retry and independent state',async t=>{
 const f=await fixture(t),original=await f.action({action:'create_document',title:'Original',folderId:null,markdown:'# Original\n\n## One\nSaved content.'});
 const before=await f.get('/api/project?documentId='+original.id),c=new ProjectClient({workspaceRoot:f.root,editorOrigin:f.origin});t.after(()=>c.close());await c.call('initialize');
 const args={requestId:randomUUID(),materialId:original.id,title:'Copy',expectedRevision:before.state.revision};
 const copy=await c.tool('lanka_duplicate_material',args);assert.deepEqual(await c.tool('lanka_duplicate_material',args),copy);
 const after=await f.get('/api/project?documentId='+copy.materialId);assert.equal(after.state.doc.id,copy.materialId);assert.equal(after.state.doc.title,'Copy');assert.equal(after.state.revision,1);assert.deepEqual(after.state.doc.slides,before.state.doc.slides);assert.deepEqual((await f.get('/api/project?documentId='+original.id)).state,before.state);
 assert.equal((await f.get('/api/library')).documents.length,2);
 await assert.rejects(c.tool('lanka_duplicate_material',{...args,requestId:randomUUID(),expectedRevision:999}),/Конфликт версии/);assert.equal((await f.get('/api/library')).documents.length,2);
});

for(const profile of ['focus-v2','focus-v3'])test(`Markdown library creation preserves explicit ${profile} and exact retry`,async t=>{
 const f=await fixture(t),requestId=randomUUID();
 const command={action:'create_document',title:'Города',folderId:null,profile,markdown:'# Города\n\nПисьмо и обмен'};
 const created=await f.action(command,requestId),project=await f.get(`/api/project?documentId=${created.id}`);
 assert.equal(project.state.doc.design,profile);
 const blank=await f.action({action:'create_document',title:'Эталон бренда',folderId:null,profile,empty:true});
 const reference=await f.get(`/api/project?documentId=${blank.id}`);
 assert.deepEqual(project.state.doc.brand,reference.state.doc.brand);
 assert.deepEqual(await f.action(command,requestId),created);
 assert.deepEqual((await f.get(`/api/project?documentId=${created.id}`)).state.doc,project.state.doc);
 assert.equal((await f.get(`/api/history?documentId=${created.id}`)).length,1);
 assert.equal((await f.get('/api/library')).documents.length,2);
});

test('Markdown library creation without a profile retains legacy defaults',async t=>{
 const f=await fixture(t),created=await f.action({action:'create_document',title:'Прежний путь',folderId:null,markdown:'# Прежний путь'});
 const project=await f.get(`/api/project?documentId=${created.id}`);
 assert.equal(project.state.doc.design,'focus-v2');
 assert.equal(project.state.revision,1);
});

test('file library creation without Markdown creates an immediately readable profiled document',async t=>{
 const f=await fixture(t),requestId=randomUUID(),command={action:'create_document',title:'Новый документ',folderId:null,profile:'focus-v3'};
 const created=await f.action(command,requestId),p=await f.get(`/api/project?documentId=${created.id}`);
 assert.equal(p.state.doc.title,command.title);assert.equal(p.state.doc.design,'focus-v3');assert.equal(p.state.revision,1);assert.ok(p.state.doc.slides.length>0);assert.equal(p.state.doc.slides[0].title,'Главная мысль');
 assert.deepEqual(await f.action(command,requestId),created);
 assert.equal((await f.get('/api/library')).documents[0].revision,1);
});
