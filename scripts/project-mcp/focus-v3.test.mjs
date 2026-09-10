import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawn, spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import JSZip from "jszip";
import {PNG} from "pngjs";
import {ProjectClient} from "./client.mjs";

test("Focus 3 survives the real MCP export boundary and local editor font routes", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lanka-focus3-")));
  const client = new ProjectClient(root);
  t.after(async () => {client.close(); await rm(root, {recursive: true, force: true});});
  const seed = JSON.parse(await readFile("lib/examples/lanka-sales-focus-v3.json", "utf8"));
  const sources = seed.materials.map(({name, contentType, base64}) => ({name, contentType, base64}));
  const created = await client.tool("create_deck", {requestId: randomUUID(), doc: seed.doc, sources, briefing: seed.briefing});
  const project = await client.tool("get_project");
  const check = await client.tool("lint_deck", {deckId: created.deckId});
  assert.deepEqual(check.overflowSlides, []);
  assert.ok(!check.issues.some(i => i.severity === "error"));
  const previewArgs={deckId:created.deckId,expectedRevision:project.state.revision,slideIds:[seed.doc.slides[0].id,seed.doc.slides[3].id]};
  await assert.rejects(client.tool("render_slides",{...previewArgs,expectedRevision:99}),/Revision conflict/);
  await assert.rejects(client.tool("render_slides",{...previewArgs,slideIds:["outside"]}),/outside/);
  await assert.rejects(client.tool("render_slides",{...previewArgs,slideIds:[previewArgs.slideIds[0],previewArgs.slideIds[0]]}),/Duplicate/);
  const rendered=await client.call("tools/call",{name:"render_slides",arguments:previewArgs});
  assert.equal(rendered.result.isError,false);
  const metadata=JSON.parse(rendered.result.content[0].text);
  assert.deepEqual(metadata.images.map(i=>i.number),[1,4]);
  assert.equal(metadata.revision,project.state.revision);
  const pngs=rendered.result.content.filter(i=>i.type==="image");
  assert.equal(pngs.length,2);
  for(const item of pngs){const png=PNG.sync.read(Buffer.from(item.data,"base64"));assert.deepEqual([png.width,png.height],[1200,675]);}
  assert.notEqual(pngs[0].data,pngs[1].data);
  assert.deepEqual((await client.tool("get_project")).state,project.state);
  for (const format of ["pdf", "pptx"]) {
    const exported = await client.tool("export_deck", {deckId: created.deckId, expectedRevision: project.state.revision, format});
    assert.ok(exported.path.startsWith(root + "/exports/"));
    const bytes = await readFile(exported.path);
    if (format === "pdf") {
      const fonts = spawnSync("pdffonts", [exported.path], {timeout:10000});
      if (fonts.status === 0) {
        assert.match(fonts.stdout.toString(), /IBMPlexSans-SemiBold/);
        assert.match(fonts.stdout.toString(), /IBMPlexMono-Medium/);
        assert.doesNotMatch(fonts.stdout.toString(), /DejaVu/);
      }
    } else {
      const zip = await JSZip.loadAsync(bytes);
      assert.match(await zip.file("ppt/theme/theme1.xml").async("string"), /<a:accent1><a:srgbClr val="444BE8"\/>/);
    }
  }
  const worker = spawn(process.execPath, [resolve(".project-runtime/web.mjs"), "--root", root, "--port", "0"], {stdio: ["ignore", "pipe", "pipe"]});
  t.after(() => worker.kill());
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Editor startup timed out")), 10000);
    worker.once("exit", code => {clearTimeout(timer); reject(new Error(`Editor exited: ${code}`));});
    worker.stdout.on("data", b => {const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) {clearTimeout(timer); resolve(m[0]);}});
  });
  const landing = await fetch(origin), cookie = landing.headers.get("set-cookie").split(";")[0];
  for (const name of ["IBMPlexSans-Regular.ttf", "IBMPlexSans-SemiBold.ttf", "IBMPlexMono-Medium.ttf"]) {
    const response = await fetch(origin + "/fonts/" + name, {headers: {Cookie: cookie}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "font/ttf");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile("public/fonts/" + name));
  }
});
