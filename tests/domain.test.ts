import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { env } from "./cloudflare-stub";
import { command } from "@/lib/server/commands";
import {
  getDeck,
  getReleases,
  saveDeck,
  listDecks,
  activity,
  history,
} from "@/lib/server/store";
import { actorFrom, sameOrigin } from "@/lib/server/auth";
import {
  demoDoc,
  validateDoc,
  propose,
  acceptProposal,
  initialState,
  changedContent,
  hasContrast,
  defaultBrand,
  blankSlide,
} from "@/lib/domain/model";
import { fromMarkdown, parseCsv } from "@/lib/domain/intake";
import { scene } from "@/lib/domain/scene";
import { afterSave, sameDocument } from "@/lib/domain/editing";
import { inspectNarrative } from "@/lib/domain/narrative";
import { resolveBriefing, briefFromBriefing, editBriefField } from "@/lib/domain/briefing";
import { recipeSamples } from "@/lib/domain/recipes";
import { storyView } from "@/lib/domain/authoring";
import { buildPptx, pdfBytes } from "@/lib/export";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { GET as studioGet, POST as studioPost } from "@/app/api/studio/route";
import { GET as assetGet } from "@/app/api/assets/route";
import { openStarter } from "@/lib/server/starters";
import { deckLinks, deckPath } from "@/lib/deck-links";
import { designReview } from "@/lib/domain/design-review";
import focusFixtures from "../design-packs/focus-v1/fixtures.json";
import focus2Fixtures from "../design-packs/focus-v2/fixtures.json";
import focus2Seed from "../lib/examples/lanka-sales-focus-v2.json";
import {
  startRun,
  executeRun,
  cancelRun,
  getRun,
  listRuns,
  runBudget,
} from "@/lib/server/agent";
import { clientRequest } from "@/lib/client-request";
import {
  createTask,
  getTask,
  taskCommand,
  taskEvents,
  inspectCandidate,
  listTasks,
} from "@/lib/server/tasks";
let db: DatabaseSync;
test("Design version changes geometry while preserving story and legacy rendering", () => {
  const doc = demoDoc();
  const original = structuredClone(doc);
  for (const s of recipeSamples()) {
    assert.equal(scene(s, doc.brand, 0, 9, "atelier-v1").overflow, false, s.layout);
    assert.deepEqual(scene(s, doc.brand), scene(s, doc.brand, 0, 1, "classic-v1"));
    if (s.layout !== "table") assert.notDeepEqual(scene(s, doc.brand, 0, 1, "atelier-v1"), scene(s, doc.brand));
  }
  const classic = validateDoc({...doc, design: "classic-v1"});
  assert.deepEqual(storyView(classic).story, storyView(doc).story);
  assert.deepEqual(doc, original);
  assert.throws(() => validateDoc({...doc, design: "untrusted-code"}));
  assert.equal(scene({...doc.slides[0], body: "Long text ".repeat(300)}, doc.brand, 0, 1, "atelier-v1").overflow, true);
});
function statement(sql: string) {
  let params: any[] = [];
  const api = {
    bind(...values: any[]) {
      params = values;
      return api;
    },
    async first<T>() {
      return (db.prepare(sql).get(...params) ?? null) as T | null;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...params) as T[], success: true };
    },
    async run() {
      return api.execute();
    },
    execute() {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes) }, success: true };
    },
  };
  return api;
}
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(`drizzle/${migration}`, "utf8"));
  delete env.LLM_API_URL;
  delete env.LLM_API_KEY;
  delete env.LLM_MODEL;
  delete env.AGENT_DAILY_RUN_LIMIT;
  delete env.AGENT_SITE_DAILY_RUN_LIMIT;
  const objects=new Map<string,{bytes:Uint8Array;contentType:string}>();
  env.BUCKET={
    async put(key:string,bytes:Uint8Array,options:any){objects.set(key,{bytes:new Uint8Array(bytes),contentType:options.httpMetadata.contentType});},
    async get(key:string){const o=objects.get(key);return o?{body:o.bytes,httpMetadata:{contentType:o.contentType},arrayBuffer:async()=>o.bytes.buffer}:null;},
    async delete(key:string){objects.delete(key);},
  };
  env.DB = {
    prepare: statement,
    async batch(commands: any[]) {
      db.exec("BEGIN");
      try {
        // A D1 batch is atomic: no interleaved awaits inside this transaction.
        const out = commands.map((c) => c.execute());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
});
afterEach(() => db.close());
const owner = { id: "user-owner", email: "owner@example.org" },
  other = { id: "user-other", email: "other@example.org" };
const make = () => command(owner, { action: "create", demo: true });
const count = (table: string) =>
  Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
function configureAgent() {
  env.LLM_API_URL = "https://provider.invalid/v1/chat/completions";
  env.LLM_API_KEY = "test-only-placeholder";
  env.LLM_MODEL = "test-model";
}
function runInput(d: Awaited<ReturnType<typeof make>>) {
  return {
    requestId: crypto.randomUUID(),
    deckId: d.id,
    expectedRevision: d.state.revision,
    instruction: "Сократи заголовок",
    slideIds: [d.state.doc.slides[0].id],
  };
}
function modelResponse(d: Awaited<ReturnType<typeof make>>) {
  const slide = d.state.doc.slides[0];
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: "Короткий заголовок",
            changes: [
              {
                slideId: slide.id,
                after: { ...slide, title: "Новый заголовок" },
              },
            ],
          }),
        },
      },
    ],
    usage: { total_tokens: 143 },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function heldProvider() {
  const called = deferred<void>(),
    answer = deferred<Response>();
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    called.resolve();
    return answer.promise;
  }) as typeof fetch;
  return { called, answer, fetcher, calls: () => calls };
}
test("Concurrent keyed creates commit one deck and replay the same receipt", async () => {
  const body = { action: "create", doc: demoDoc(), requestId: crypto.randomUUID(), briefing: {audience:{value:"Тестовая аудитория",origin:"user"},decision:{value:"Проверить пилот",origin:"user"},keyMessage:{value:"Тестовый бриф",origin:"user"}} };
  const results = await Promise.all([
    command(owner, body, "agent"),
    command(owner, body, "agent"),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(count("decks"), 1);
  assert.equal(count("command_receipts"), 1);
  assert.equal(count("events"), 1);
  assert.equal(results.filter((r) => r.receipt?.replayed).length, 1);
  await assert.rejects(command(owner,{action:"create",demo:true,requestId:crypto.randomUUID(),briefing:body.briefing},"agent"),/Передайте содержание/);
  await assert.rejects(
    command(owner, { ...body, title: "Altered" }, "agent"),
    /идентификатор/,
  );
  await assert.rejects(
    command(owner, { action: "create", demo: true }, "agent"),
    /requestId/,
  );
});
test("Keyed comments replay once across concurrent requests and later document revisions", async () => {
  const d = await make(),
    body = {
      action: "comment",
      requestId: crypto.randomUUID(),
      deckId: d.id,
      expectedRevision: 1,
      slideId: d.state.doc.slides[0].id,
      text: "Уточнить источник",
    };
  await Promise.all([
    command(owner, body, "agent"),
    command(owner, body, "agent"),
  ]);
  assert.equal((await getDeck(owner, d.id)).state.comments.length, 1);
  await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc: { ...d.state.doc, title: "Updated" },
  });
  const replay = await command(owner, body, "agent");
  assert.equal(replay.receipt?.revision, 1);
  assert.equal(replay.state.revision, 2);
  assert.equal(replay.state.comments.length, 1);
  assert.equal(count("command_receipts"), 1);
});
test("Receipt replay rechecks current access and never grants back a revoked deck", async () => {
  const d = await make();
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [{ email: other.email, role: "editor" }],
  });
  const b = {
    action: "comment",
    requestId: crypto.randomUUID(),
    deckId: d.id,
    expectedRevision: 1,
    slideId: d.state.doc.slides[0].id,
    text: "Comment",
  };
  await command(other, b, "agent");
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [],
  });
  await assert.rejects(command(other, b, "agent"), /недоступна/);
});
test("Failed command transaction leaves no success receipt or extra audit event", async () => {
  const d = await make();
  await command(owner, {
    action: "approve",
    deckId: d.id,
    expectedRevision: 1,
  });
  await command(owner, {
    action: "release",
    deckId: d.id,
    expectedRevision: 1,
  });
  const before = count("events");
  await assert.rejects(
    command(owner, {
      action: "release",
      deckId: d.id,
      expectedRevision: 1,
      requestId: crypto.randomUUID(),
    }),
  );
  assert.equal(count("command_receipts"), 0);
  assert.equal(count("events"), before);
});
test("Imported proposal replay after acceptance does not reopen it or change the revision", async () => {
  const d = await make(),
    slide = d.state.doc.slides[0];
  const body = {
    action: "propose",
    requestId: crypto.randomUUID(),
    deckId: d.id,
    expectedRevision: 1,
    title: "Edit",
    changes: [{ slideId: slide.id, after: { ...slide, title: "Accepted" } }],
  };
  const proposed = await command(owner, body, "agent"),
    p = proposed.state.proposals[0];
  await command(owner, {
    action: "accept",
    deckId: d.id,
    expectedRevision: 1,
    proposalId: p.id,
    changeIds: p.changes.map((c) => c.id),
  });
  const replay = await command(owner, body, "agent");
  assert.equal(replay.state.revision, 2);
  assert.equal(replay.state.proposals.length, 1);
  assert.equal(replay.state.proposals[0].status, "closed");
  assert.equal(replay.receipt?.replayed, true);
});
test("Agent start requires configured provider and reserves no budget on validation failure", async () => {
  const d = await make();
  await assert.rejects(startRun(owner, runInput(d)), /не подключён/);
  configureAgent();
  await assert.rejects(
    startRun(owner, { ...runInput(d), expectedRevision: 99 }),
  );
  await assert.rejects(
    startRun(owner, { ...runInput(d), slideIds: ["missing"] }),
  );
  assert.equal((await runBudget(owner)).used, 0);
});
test("Concurrent duplicate starts reserve one run and a second active task is rejected", async () => {
  configureAgent();
  const d = await make(),
    input = runInput(d);
  const [a, b] = await Promise.all([
    startRun(owner, input),
    startRun(owner, input),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await runBudget(owner)).used, 1);
  assert.equal(
    (await activity(owner, d.id)).filter((e) => e.action === "agent.queued")
      .length,
    1,
  );
  await assert.rejects(startRun(owner, runInput(d)), /активная задача/);
  await assert.rejects(
    startRun(owner, { ...input, instruction: "Другая задача" }),
    /идентификатор/,
  );
  await cancelRun(owner, a.id);
  assert.equal((await startRun(owner, input)).status, "cancelled");
});
test("Daily user reservation is atomic across decks and cancellation never refunds it", async () => {
  configureAgent();
  env.AGENT_DAILY_RUN_LIMIT = "1";
  const a = await make(),
    b = await make();
  const result = await Promise.allSettled([
    startRun(owner, runInput(a)),
    startRun(owner, runInput(b)),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const success = result.find(
    (r) => r.status === "fulfilled",
  ) as PromiseFulfilledResult<Awaited<ReturnType<typeof startRun>>>;
  await cancelRun(owner, success.value.id);
  assert.equal((await runBudget(owner)).remaining, 0);
  await assert.rejects(startRun(owner, runInput(a)), /дневной лимит/);
});
test("Site daily reservation is atomic across different principals", async () => {
  configureAgent();
  env.AGENT_SITE_DAILY_RUN_LIMIT = "1";
  const a = await make(),
    b = await command(other, { action: "create", demo: true });
  const results = await Promise.allSettled([
    startRun(owner, runInput(a)),
    startRun(other, runInput(b)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(count("agent_runs"), 1);
});
test("Concurrent execute calls invoke provider once and commit one reviewable proposal", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d)),
    provider = heldProvider();
  const work = executeRun(owner, r.id, provider.fetcher);
  await provider.called.promise;
  assert.equal(
    (await executeRun(owner, r.id, provider.fetcher)).status,
    "running",
  );
  provider.answer.resolve(modelResponse(d));
  const completed = await work;
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.totalTokens, 143);
  assert.equal(provider.calls(), 1);
  const after = await getDeck(owner, d.id);
  assert.equal(after.state.proposals.length, 1);
  assert.equal(after.state.proposals[0].id, completed.proposalId);
  assert.deepEqual(after.state.doc, d.state.doc);
  assert.equal(after.state.approvedRevision, null);
  assert.equal((await cancelRun(owner, r.id)).status, "succeeded");
});
test("Cancellation during inference blocks delayed proposal and retains consumed attempt", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d)),
    provider = heldProvider();
  const work = executeRun(owner, r.id, provider.fetcher);
  await provider.called.promise;
  assert.equal((await cancelRun(owner, r.id)).status, "cancelled");
  await cancelRun(owner, r.id);
  provider.answer.resolve(modelResponse(d));
  assert.equal((await work).status, "cancelled");
  assert.equal((await getDeck(owner, d.id)).state.proposals.length, 0);
  assert.equal((await runBudget(owner)).used, 1);
  assert.equal(
    (await activity(owner, d.id)).filter((e) => e.action === "agent.cancelled")
      .length,
    1,
  );
  assert.equal((await getRun(owner, r.id)).totalTokens, 143);
  assert.equal((await startRun(owner, runInput(d))).status, "queued");
});
test("Transaction fence independently blocks writes for cancelled and overdue running tasks", async () => {
  configureAgent();
  const d = await make(),
    slide = d.state.doc.slides[0];
  for (const status of ["cancelled", "running"]) {
    const r = await startRun(owner, runInput(d));
    db.prepare("UPDATE agent_runs SET status=?, deadline_at=? WHERE id=?").run(
      status,
      status === "running" ? 0 : Date.now() + 60_000,
      r.id,
    );
    const before = count("events");
    await assert.rejects(
      command(
        owner,
        {
          action: "propose",
          deckId: d.id,
          expectedRevision: 1,
          title: "Late",
          changes: [{ slideId: slide.id, after: { ...slide, title: "Late" } }],
        },
        "agent",
        { run: { id: r.id, totalTokens: 12 } },
      ),
    );
    assert.equal(count("events"), before);
    assert.equal((await getDeck(owner, d.id)).state.proposals.length, 0);
  }
});
test("Document edit during inference is preserved and stale model completion fails", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d)),
    provider = heldProvider();
  const work = executeRun(owner, r.id, provider.fetcher);
  await provider.called.promise;
  await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc: { ...d.state.doc, title: "Human latest" },
  });
  provider.answer.resolve(modelResponse(d));
  const result = await work;
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "conflict");
  const after = await getDeck(owner, d.id);
  assert.equal(after.state.doc.title, "Human latest");
  assert.equal(after.state.proposals.length, 0);
});
test("Cancelled and expired queued runs never call provider and expire without redispatch", async () => {
  configureAgent();
  const d = await make();
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return modelResponse(d);
  }) as typeof fetch;
  const a = await startRun(owner, runInput(d));
  await cancelRun(owner, a.id);
  assert.equal((await executeRun(owner, a.id, fetcher)).status, "cancelled");
  const b = await startRun(owner, runInput(d));
  db.prepare("UPDATE agent_runs SET deadline_at=0 WHERE id=?").run(b.id);
  assert.equal((await executeRun(owner, b.id, fetcher)).status, "expired");
  assert.equal(calls, 0);
});
test("Changed provider configuration does not send saved snapshot to another endpoint", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d));
  env.LLM_API_URL = "https://changed.invalid";
  let calls = 0;
  const result = await executeRun(owner, r.id, (async () => {
    calls++;
    return modelResponse(d);
  }) as typeof fetch);
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
});
test("Invalid model JSON and HTTP errors leave no proposal and release the active lock", async () => {
  configureAgent();
  const d = await make();
  for (const response of [
    Response.json({
      choices: [{ message: { content: '{"unexpected":true}' } }],
    }),
    new Response("secret provider body", { status: 500 }),
  ]) {
    const r = await startRun(owner, runInput(d));
    const result = await executeRun(
      owner,
      r.id,
      (async () => response) as typeof fetch,
    );
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.errorMessage ?? "", /secret provider body/);
    assert.equal((await getDeck(owner, d.id)).state.proposals.length, 0);
  }
});
test("Run history and cancellation enforce current deck roles", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d));
  await assert.rejects(listRuns(other, d.id), /недоступна/);
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [{ email: other.email, role: "viewer" }],
  });
  const rows = await listRuns(other, d.id);
  assert.equal(rows[0].canCancel, false);
  assert.equal(rows[0].canExecute, false);
  assert.ok(!("input" in rows[0]));
  assert.ok(!("provider_hash" in rows[0]));
  await assert.rejects(cancelRun(other, r.id), /автор или владелец/);
  await assert.rejects(executeRun(other, r.id), /нет права/);
});
test("Access revoked during inference prevents proposal completion", async () => {
  configureAgent();
  const d = await make();
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [{ email: other.email, role: "editor" }],
  });
  const r = await startRun(other, runInput(d)),
    provider = heldProvider();
  const work = executeRun(other, r.id, provider.fetcher);
  await provider.called.promise;
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [],
  });
  provider.answer.resolve(modelResponse(d));
  await assert.rejects(work, /недоступна/);
  assert.equal((await getRun(owner, r.id)).status, "failed");
  assert.equal((await getDeck(owner, d.id)).state.proposals.length, 0);
});
test("Provider timeout fails the run without leaking exception text or retrying inference", async () => {
  configureAgent();
  const d = await make(),
    r = await startRun(owner, runInput(d));
  let calls = 0;
  const result = await executeRun(owner, r.id, (async () => {
    calls++;
    throw new DOMException("secret network detail", "TimeoutError");
  }) as typeof fetch);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "timeout");
  assert.equal(calls, 1);
  assert.doesNotMatch(result.errorMessage ?? "", /secret/);
  assert.equal((await getDeck(owner, d.id)).state.proposals.length, 0);
});
test("Browser retries a lost command response with identical bytes and never retries HTTP errors", async () => {
  const original = globalThis.fetch,
    bodies: string[] = [];
  try {
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("lost response");
      return Response.json({ ok: true });
    }) as typeof fetch;
    await clientRequest("/api/studio", { action: "create", demo: true });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.match(JSON.parse(bodies[0]).requestId, /^[a-f0-9-]{36}$/);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: "conflict" }, { status: 409 });
    }) as typeof fetch;
    await assert.rejects(
      clientRequest("/api/studio", { action: "create" }),
      /conflict/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("Markdown intake reuses explicit content and CSV handles quotes and decimals", () => {
  const d = fromMarkdown(
    "# Отчёт\n\nНаш контекст\n\n## Результаты\n- Первый\n- Второй",
  );
  assert.equal(d.slides.length, 2);
  assert.equal(d.slides[1].title, "Результаты");
  assert.match(d.slides[1].body, /Первый/);
  assert.deepEqual(
    parseCsv('Название;Значение\n"Регион, север";"12,5"\nЮг;-4'),
    [
      { label: "Регион, север", value: 12.5 },
      { label: "Юг", value: -4 },
    ],
  );
  assert.throws(() => parseCsv('A,B\n"broken,2'));
  assert.throws(() => parseCsv("Название,Значение\nA,NA"));
});
test("Schema rejects duplicate slide ids, nonfinite metrics and invalid brand colors", () => {
  const d = demoDoc();
  d.slides[1].id = d.slides[0].id;
  assert.throws(() => validateDoc(d));
  const x = demoDoc();
  x.slides[2].metrics[0].value = NaN;
  assert.throws(() => validateDoc(x));
  assert.equal(hasContrast(defaultBrand), true);
  assert.equal(hasContrast({ ...defaultBrand, primary: "#FFFFFF" }), false);
});
test("Partial review accepts independent slides and rejects overwrite of a concurrent edit", () => {
  const state = initialState(demoDoc());
  const a = state.doc.slides[0],
    b = state.doc.slides[1];
  const p = propose(
    state,
    [
      { slideId: a.id, after: { ...a, title: "Предложение 1" } },
      { slideId: b.id, after: { ...b, title: "Предложение 2" } },
    ],
    "Правки",
    "agent",
  );
  state.proposals.push(p);
  acceptProposal(state, p.id, [p.changes[0].id]);
  changedContent(state);
  assert.equal(state.doc.slides[0].title, "Предложение 1");
  assert.equal(p.status, "pending");
  state.doc.slides[1].title = "Ручная правка";
  assert.throws(
    () => acceptProposal(state, p.id, [p.changes[1].id]),
    /Конфликт/,
  );
  assert.equal(state.doc.slides[1].title, "Ручная правка");
});
test("Multi-slide acceptance validates every before-image before any mutation", () => {
  const state = initialState(demoDoc());
  const p = propose(
    state,
    state.doc.slides
      .slice(0, 2)
      .map((s) => ({ slideId: s.id, after: { ...s, title: "Agent" } })),
    "changes",
    "agent",
  );
  state.proposals.push(p);
  state.doc.slides[1].title = "Human";
  const before = JSON.stringify(state);
  assert.throws(() =>
    acceptProposal(
      state,
      p.id,
      p.changes.map((c) => c.id),
    ),
  );
  assert.equal(JSON.stringify(state), before);
});
test("Server isolates owners, enforces reader roles and revokes grants", async () => {
  let d = await make();
  await assert.rejects(getDeck(other, d.id), /недоступна/);
  assert.equal((await listDecks(other)).length, 0);
  d = await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [{ email: other.email, role: "viewer" }],
  });
  assert.equal((await getDeck(other, d.id)).role, "viewer");
  await assert.rejects(
    command(other, {
      action: "save",
      deckId: d.id,
      expectedRevision: 1,
      doc: d.state.doc,
    }),
    /нет права/,
  );
  await assert.rejects(
    command(other, { action: "approve", deckId: d.id, expectedRevision: 1 }),
    /нет права/,
  );
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: 1,
    grants: [],
  });
  await assert.rejects(getDeck(other, d.id), /недоступна/);
});
test("CAS failure leaves document, audit and revisions untouched", async () => {
  const d = await make();
  const a = structuredClone(d.state),
    b = structuredClone(d.state);
  a.doc.title = "First";
  changedContent(a);
  b.doc.title = "Second";
  changedContent(b);
  await saveDeck(owner, d, a, "save");
  await assert.rejects(saveDeck(owner, d, b, "save"), /другой вкладке/);
  assert.equal((await getDeck(owner, d.id)).state.doc.title, "First");
  assert.equal((await activity(owner, d.id)).length, 2);
  assert.equal((await history(owner, d.id)).length, 2);
});
test("Approval pins exact revision, mutation clears it, releases remain immutable and duplicates rollback", async () => {
  let d = await make();
  d = await command(owner, {
    action: "approve",
    deckId: d.id,
    expectedRevision: 1,
  });
  d = await command(owner, {
    action: "release",
    deckId: d.id,
    expectedRevision: 1,
  });
  const release = (await getReleases(owner, d.id))[0];
  const auditCount = (await activity(owner, d.id)).length;
  await assert.rejects(
    command(owner, { action: "release", deckId: d.id, expectedRevision: 1 }),
  );
  assert.equal((await activity(owner, d.id)).length, auditCount);
  const doc = structuredClone(d.state.doc);
  doc.slides[0].title = "Новая версия";
  d = await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc,
  });
  assert.equal(d.state.approvedRevision, null);
  await assert.rejects(
    command(owner, { action: "release", deckId: d.id, expectedRevision: 2 }),
  );
  assert.equal(
    (await getReleases(owner, d.id))[0].doc.slides[0].title,
    release.doc.slides[0].title,
  );
  await assert.rejects(
    command(owner, { action: "save", deckId: d.id, expectedRevision: 1, doc }),
  );
  d = await command(owner, {
    action: "restore",
    deckId: d.id,
    expectedRevision: 2,
    revision: 1,
  });
  assert.equal(d.state.revision, 3);
  assert.equal(d.state.doc.slides[0].title, release.doc.slides[0].title);
});
test("Agent surface cannot publish or approve, stale inference proposal is rejected", async () => {
  const d = await make();
  await assert.rejects(
    command(
      owner,
      { action: "approve", deckId: d.id, expectedRevision: 1 },
      "agent",
    ),
    /Агент может/,
  );
  await assert.rejects(
    command(
      owner,
      { action: "share", deckId: d.id, expectedRevision: 1, grants: [] },
      "agent",
    ),
  );
  const doc = structuredClone(d.state.doc);
  doc.title = "Human update";
  await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc,
  });
  await assert.rejects(
    command(
      owner,
      {
        action: "propose",
        requestId: crypto.randomUUID(),
        deckId: d.id,
        expectedRevision: 1,
        title: "Late model",
        changes: [{ slideId: doc.slides[0].id, after: doc.slides[0] }],
      },
      "agent",
    ),
    /Версия документа изменилась/,
  );
});
test("Server blocks empty required content, overflow and source reference fabrication", async () => {
  let d = await make();
  const doc = structuredClone(d.state.doc);
  doc.slides[0].title = "";
  d = await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc,
  });
  await assert.rejects(
    command(owner, { action: "approve", deckId: d.id, expectedRevision: 2 }),
    /заголовок/,
  );
  const next = structuredClone(d.state.doc);
  next.slides[0].title = "Header";
  next.slides[0].sourceIds = ["fake-source"];
  await assert.rejects(
    command(owner, {
      action: "save",
      deckId: d.id,
      expectedRevision: 2,
      doc: next,
    }),
    /источник/,
  );
  const dense = blankSlide("content");
  dense.body = Array(200).fill("Строка").join("\n");
  assert.equal(scene(dense, defaultBrand).overflow, true);
});
test("MCP initialization/tool discovery and unauthorized calls obey transport contract", async () => {
  const call = (payload: unknown, auth = true) =>
    mcpPost(
      new Request("https://lanka.test/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth
            ? {
                "oai-authenticated-user-id": owner.id,
                "oai-authenticated-user-email": owner.email,
              }
            : {}),
        },
        body: JSON.stringify(payload),
      }),
    );
  const init = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(
    ((await init.json()) as any).result.protocolVersion,
    "2025-03-26",
  );
  const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = ((await list.json()) as any).result.tools;
  assert.ok(tools.some((t: any) => t.name === "propose_changes"));
  const proposalSchema = tools.find(
    (t: any) => t.name === "propose_changes",
  ).inputSchema;
  assert.ok(proposalSchema.required.includes("requestId"));
  assert.deepEqual(proposalSchema.properties.changes.items.required, [
    "slideId",
    "after",
  ]);
  function checkRequired(schema: any) {
    for (const key of schema.required ?? [])
      assert.ok(
        key in (schema.properties ?? {}),
        `Required property ${key} must be declared`,
      );
    for (const value of Object.values(schema.properties ?? {}))
      checkRequired(value);
    if (schema.items) checkRequired(schema.items);
  }
  for (const tool of tools) checkRequired(tool.inputSchema);
  assert.ok(!tools.some((t: any) => /approve|publish|release/.test(t.name)));
  const unauthorized = await call(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    false,
  );
  assert.equal(unauthorized.status, 401);
  assert.throws(() =>
    sameOrigin(
      new Request("https://lanka.test/api/studio", {
        method: "POST",
        headers: {
          Origin: "https://evil.test",
          "Content-Type": "application/json",
        },
      }),
    ),
  );
  assert.throws(() => actorFrom(new Request("https://lanka.test/api/studio")));
});
test("Native PPTX retains Russian text, editable shapes and expected slide count", async () => {
  const doc = demoDoc();
  const pptx = await buildPptx(doc);
  const bytes = await pptx.write({
    outputType: "uint8array",
    compression: true,
  });
  const zip = await JSZip.loadAsync(bytes as Uint8Array);
  const paths = Object.keys(zip.files).filter((p) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(p),
  );
  assert.equal(paths.length, doc.slides.length);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  assert.match(xml, /Большие идеи/);
  assert.match(xml, /<p:sp>/);
  assert.ok(zip.file("ppt/notesSlides/notesSlide1.xml"));
});
function inspectPdf(bytes: Uint8Array, tool: "pdffonts" | "pdftotext"): string | null {
  const dir = mkdtempSync(join(tmpdir(), "lanka-pdf-test-"));
  try {
    const file = join(dir, "slides.pdf");
    writeFileSync(file, bytes);
    // Both PDF suites use a file: stdin previously stalled on this Mac.
    const result = spawnSync(tool, tool === "pdftotext" ? [file, "-"] : [file], {timeout: 15000});
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout.toString();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test("PDF embeds Cyrillic fonts and has one page per shared-scene slide", async () => {
  const doc = demoDoc();
  const bytes = await pdfBytes(
    doc,
    readFileSync("public/fonts/DejaVuSans.ttf"),
    readFileSync("public/fonts/DejaVuSans-Bold.ttf"),
  );
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 4);
  assert.equal(pdf.getTitle(), doc.title);
  const extraction = inspectPdf(bytes, "pdftotext");
  if (extraction !== null) assert.match(extraction, /Большие идеи/);
  assert.ok(bytes.length > 10_000);
});
test("JSON cloning remaps immutable sources without granting access to the original deck", async () => {
  const d = await make();
  const sourceId = "source-1",
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO assets (id,deck_id,owner,key,name,kind,sha256,content_type,excerpt,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      sourceId,
      d.id,
      owner.id,
      "blob-original",
      "data.csv",
      "text",
      "hash",
      "text/csv",
      "name,value\nA,10",
      now,
    )
    .run();
  const state = structuredClone(d.state);
  state.sources.push({
    id: sourceId,
    name: "data.csv",
    kind: "text",
    sha256: "hash",
    contentType: "text/csv",
    excerpt: "name,value\nA,10",
    createdAt: now,
  });
  state.doc.slides[0].sourceIds = [sourceId];
  changedContent(state);
  const saved = await saveDeck(owner, d, state, "source.upload");
  const clone = await command(owner, {
    action: "create",
    doc: saved.state.doc,
  });
  assert.notEqual(clone.id, d.id);
  const remapped = clone.state.doc.slides[0].sourceIds[0];
  assert.notEqual(remapped, sourceId);
  assert.equal(clone.state.sources[0].id, remapped);
  const row = await env.DB.prepare(
    "SELECT deck_id, key FROM assets WHERE id = ?",
  )
    .bind(remapped)
    .first();
  assert.equal(row.deck_id, clone.id);
  assert.equal(row.key, "blob-original");
  await command(owner, {
    action: "share",
    deckId: clone.id,
    expectedRevision: 1,
    grants: [{ email: other.email, role: "viewer" }],
  });
  assert.equal((await getDeck(other, clone.id)).role, "viewer");
  await assert.rejects(getDeck(other, d.id));
});

test("Legacy documents remain valid; narrative fields are bounded and never imply verified logic", () => {
  const doc = demoDoc();
  assert.deepEqual(validateDoc(doc), doc);
  assert.ok(inspectNarrative(doc).some((i) => i.code === "brief-incomplete"));
  doc.brief = {
    audience: "Совет директоров",
    decision: "Согласовать пилот",
    keyMessage: "Проверить результат на одной команде",
  };
  doc.slides[0].intent = {
    role: "evidence",
    takeaway: "Пилот сократит время",
    transition: "Далее план измерения",
    openQuestions: ["На чём основана оценка?"],
  };
  assert.ok(inspectNarrative(doc).some((i) => i.code === "evidence-unlinked"));
  assert.ok(inspectNarrative(doc).some((i) => i.code === "open-questions"));
  assert.throws(() =>
    validateDoc({ ...doc, brief: { ...doc.brief, verified: true } }),
  );
  assert.throws(() =>
    validateDoc({
      ...doc,
      slides: [
        {
          ...doc.slides[0],
          intent: { ...doc.slides[0].intent, role: "verified" },
        },
      ],
    }),
  );
  assert.throws(() =>
    validateDoc({
      ...doc,
      slides: [
        {
          ...doc.slides[0],
          intent: {
            ...doc.slides[0].intent,
            openQuestions: Array(9).fill("Вопрос"),
          },
        },
      ],
    }),
  );
});

test("Brief saves create durable revisions and reject stale writes", async () => {
  const d = await make();
  const brief = {
    audience: "Руководитель",
    decision: "Начать пилот",
    keyMessage: "Проверяем результат",
  };
  await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc: { ...d.state.doc, brief },
  });
  const current = await getDeck(owner, d.id);
  assert.deepEqual(current.state.doc.brief, brief);
  assert.equal(current.state.revision, 2);
  await assert.rejects(
    command(owner, {
      action: "save",
      deckId: d.id,
      expectedRevision: 1,
      doc: { ...d.state.doc, brief: { ...brief, decision: "Устаревший бриф" } },
    }),
    /Версия/,
  );
  assert.equal(
    (await getDeck(owner, d.id)).state.doc.brief?.decision,
    "Начать пилот",
  );
});

test("Narrative corrections remain proposals until accepted and preserve the before image", async () => {
  const d = await make(),
    before = d.state.doc.slides[0];
  const intent = {
    role: "recommendation",
    takeaway: "Начать с одной команды",
    transition: "Затем определить критерии",
    openQuestions: [],
  };
  const proposed = await command(owner, {
    action: "propose",
    deckId: d.id,
    expectedRevision: 1,
    title: "Объяснить роль",
    changes: [{ slideId: before.id, after: { ...before, intent } }],
  });
  assert.equal(proposed.state.doc.slides[0].intent, undefined);
  const p = proposed.state.proposals[0];
  const accepted = await command(owner, {
    action: "accept",
    deckId: d.id,
    expectedRevision: 1,
    proposalId: p.id,
    changeIds: [p.changes[0].id],
  });
  assert.deepEqual(accepted.state.doc.slides[0].intent, intent);
  assert.equal(accepted.state.revision, 2);
  assert.equal(accepted.state.proposals[0].changes[0].before.intent, undefined);
});

test("Agent receives the brief and whole outline while changing only selected slides", async () => {
  const d = await make();
  const updated = await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: 1,
    doc: {
      ...d.state.doc,
      brief: {
        audience: "Команда",
        decision: "Пилот",
        keyMessage: "Ясная аргументация",
      },
    },
  });
  configureAgent();
  const run = await startRun(owner, runInput(updated));
  await executeRun(owner, run.id, async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.brief.decision, "Пилот");
    assert.equal(input.outline.length, updated.state.doc.slides.length);
    assert.equal(input.slides.length, 1);
    assert.match(body.messages[0].content, /openQuestions/);
    return modelResponse(updated);
  });
  assert.equal((await getRun(owner, run.id)).status, "succeeded");
});

test("New composition fixtures fit the shared scene; excessive steps block rendering", async () => {
  const samples = recipeSamples();
  for (const slide of samples)
    assert.equal(scene(slide, defaultBrand).overflow, false, slide.layout);
  const step = samples.find((s) => s.layout === "steps")!;
  assert.equal(
    scene({ ...step, body: Array(5).fill("Шаг").join("\n\n") }, defaultBrand)
      .overflow,
    true,
  );
  const doc = {
    ...demoDoc(),
    slides: samples.filter(
      (s) => s.layout === "statement" || s.layout === "steps",
    ),
  };
  const pptx = await buildPptx(doc);
  const zip = await JSZip.loadAsync(
    (await pptx.write({ outputType: "uint8array" })) as Uint8Array,
  );
  assert.match(
    await zip.file("ppt/slides/slide1.xml")!.async("string"),
    /Один слайд/,
  );
  assert.match(
    await zip.file("ppt/slides/slide2.xml")!.async("string"),
    /Выбрать команду/,
  );
  const pdf = await pdfBytes(
    doc,
    readFileSync("public/fonts/DejaVuSans.ttf"),
    readFileSync("public/fonts/DejaVuSans-Bold.ttf"),
  );
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 2);
});

const taskInput = () => ({
  workflow: "formal" as const,
  title: "План пилота",
  brief: {
    audience: "Руководитель",
    decision: "Согласовать пилот",
    keyMessage: "Начать с одной команды",
  },
  instruction: "Не выдумывать результаты",
  targetSlides: 3,
  brandId: defaultBrand.id,
});
const newTask = () =>
  createTask(owner, { requestId: crypto.randomUUID(), input: taskInput() });
const taskAct = (
  task: any,
  action: string,
  extra: Record<string, unknown> = {},
  surface: "human" | "agent" = "human",
  actor = owner,
) =>
  taskCommand(
    actor,
    {
      action,
      taskId: task.id,
      expectedVersion: task.version,
      requestId: crypto.randomUUID(),
      ...extra,
    },
    surface,
  );
async function queueTask(t: any, actor = owner) {
  let q = await taskAct(t, "enqueue", {}, "human", actor);
  if (q.task.state.phase === "brief") q = await taskAct(q.task, "answer", {answers:q.task.state.questions.map((v:any)=>({id:v.id,answer:v.suggestion || "Допущение теста",assumed:!v.suggestion}))}, "human", actor);
  return q;
}
async function claimedTask() {
  const t = await newTask();
  const q = await queueTask(t);
  return taskAct(q.task, "claim", {}, "agent");
}
function testPlan() {
  return {
    summary: "План принятия решения",
    slides: Array.from({ length: 3 }, (_, i) => ({
      id: crypto.randomUUID(),
      title: `Слайд ${i + 1}`,
      intent: {
        role: i === 2 ? "decision" : "context",
        takeaway: `Вывод ${i + 1}`,
        transition: i < 2 ? "Далее — следующий довод" : "",
        openQuestions: [],
      },
      sourceIds: [],
      evidence: [],
    })),
    limitations: ["Тестовые данные"],
  };
}
async function compositionTask() {
  const claimed = await claimedTask();
  const plan = testPlan();
  const ready = await taskAct(
    claimed.task,
    "plan",
    { leaseToken: claimed.leaseToken, plan },
    "agent",
  );
  const accepted = await taskAct(ready.task, "accept_plan");
  return taskAct(accepted.task, "claim", {}, "agent");
}
function candidateFor(task: any) {
  return {
    ...task.state.snapshot.doc,
    slides: task.state.plan.slides.map((p: any) => ({
      ...blankSlide("content"),
      id: p.id,
      title: p.title,
      body: p.intent.takeaway,
      intent: p.intent,
    })),
  };
}

test("Task creation is atomic and idempotent, with no extra deck on a race", async () => {
  const input = { requestId: crypto.randomUUID(), input: taskInput() };
  const [a, b] = await Promise.all([
    createTask(owner, input),
    createTask(owner, input),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(count("decks"), 1);
  assert.equal(count("presentation_tasks"), 1);
  assert.equal(count("task_events"), 1);
  await assert.rejects(
    createTask(owner, {
      ...input,
      input: { ...input.input, title: "Иной бриф" },
    }),
    /другим брифом/,
  );
  await assert.rejects(getTask(other, a.id), /недоступна/);
  assert.equal((await listTasks(other)).length, 0);
});

test("Competing claims have one winner, hidden lease and replay-safe token", async () => {
  const q = await queueTask(await newTask());
  const input = {
    action: "claim",
    taskId: q.task.id,
    expectedVersion: q.task.version,
    requestId: crypto.randomUUID(),
  };
  const [a, b] = await Promise.all([
    taskCommand(owner, input, "agent"),
    taskCommand(owner, input, "agent"),
  ]);
  assert.equal(a.leaseToken, b.leaseToken);
  assert.equal(a.task.state.attempt, 1);
  assert.equal(
    JSON.stringify(await getTask(owner, q.task.id)).includes(a.leaseToken!),
    false,
  );
  await assert.rejects(taskAct(a.task, "claim", {}, "agent"), /уже взята/);
  assert.equal(
    (await taskEvents(owner, q.task.id)).filter((e) => e.kind === "claim")
      .length,
    1,
  );
});

test("Questions survive reload; answers queue a new attempt with the same task", async () => {
  const run = await claimedTask();
  const question = {
    id: crypto.randomUUID(),
    text: "Кто согласует?",
    reason: "Это определяет глубину деталей",
  };
  const paused = await taskAct(
    run.task,
    "questions",
    { leaseToken: run.leaseToken, questions: [question] },
    "agent",
  );
  assert.equal(paused.task.state.status, "awaiting_input");
  const reloaded = await getTask(owner, run.task.id);
  assert.equal(reloaded.state.questions.at(-1)!.text, question.text);
  await assert.rejects(
    taskAct(reloaded, "answer", {
      answers: [{ id: crypto.randomUUID(), answer: "Ответ" }],
    }),
    /список/,
  );
  const answered = await taskAct(reloaded, "answer", {
    answers: [{ id: question.id, answer: "Совет директоров" }],
  });
  assert.equal(answered.task.state.status, "queued");
  assert.equal(answered.task.state.questions.at(-1)!.answer, "Совет директоров");
  await assert.rejects(
    taskAct(
      answered.task,
      "plan",
      { leaseToken: run.leaseToken, plan: testPlan() },
      "agent",
    ),
    /не может/,
  );
});

test("Cancelled or expired workers cannot heartbeat or submit late results", async () => {
  const run = await claimedTask();
  const cancelled = await taskAct(run.task, "cancel");
  await assert.rejects(
    taskAct(
      cancelled.task,
      "plan",
      { leaseToken: run.leaseToken, plan: testPlan() },
      "agent",
    ),
    /не может/,
  );
  await assert.rejects(
    taskAct(
      cancelled.task,
      "heartbeat",
      { leaseToken: run.leaseToken },
      "agent",
    ),
    /не может/,
  );
  const second = await claimedTask();
  db.prepare(
    "UPDATE presentation_tasks SET lease_expires_at = 1 WHERE id = ?",
  ).run(second.task.id);
  const expired = await getTask(owner, second.task.id);
  assert.equal(expired.state.status, "failed");
  await assert.rejects(
    taskAct(
      expired,
      "plan",
      { leaseToken: second.leaseToken, plan: testPlan() },
      "agent",
    ),
    /не может/,
  );
});

test("Plan validates slide count and evidence anchors; agents cannot accept it", async () => {
  const run = await claimedTask();
  const plan = testPlan();
  plan.slides[0].evidence = [
    { sourceId: "fabricated", locator: "Страница 1" },
  ] as any;
  await assert.rejects(
    taskAct(run.task, "plan", { leaseToken: run.leaseToken, plan }, "agent"),
    /фрагмент/,
  );
  const ready = await taskAct(
    run.task,
    "plan",
    { leaseToken: run.leaseToken, plan: testPlan() },
    "agent",
  );
  await assert.rejects(
    taskAct(ready.task, "accept_plan", {}, "agent"),
    /недоступно/,
  );
  await assert.rejects(
    command(owner, {
      action: "approve",
      deckId: ready.task.deckId,
      expectedRevision: 1,
    }),
    /завершите/,
  );
});

test("Full candidate stays separate until atomic human acceptance, with retry receipt", async () => {
  const run = await compositionTask(),
    doc = candidateFor(run.task);
  assert.equal((await inspectCandidate(owner, run.task.id, doc)).valid, true);
  const changedIntent = structuredClone(doc);
  changedIntent.slides[0].intent.takeaway = "Неутверждённый вывод";
  await assert.rejects(
    inspectCandidate(owner, run.task.id, changedIntent),
    /принятые выводы/,
  );
  const proposal = await taskAct(
    run.task,
    "candidate",
    {
      leaseToken: run.leaseToken,
      doc,
      critique: "Тестовая проверка структуры",
    },
    "agent",
  );
  assert.equal(
    (await getDeck(owner, run.task.deckId)).state.doc.slides.length,
    1,
  );
  const input = {
    action: "accept_candidate",
    taskId: proposal.task.id,
    expectedVersion: proposal.task.version,
    requestId: crypto.randomUUID(),
  };
  const [a, b] = await Promise.all([
    taskCommand(owner, input),
    taskCommand(owner, input),
  ]);
  assert.equal(a.task.state.status, "completed");
  assert.equal(b.task.state.status, "completed");
  const deck = await getDeck(owner, run.task.deckId);
  assert.equal(deck.state.doc.slides.length, 3);
  assert.equal(deck.state.revision, 2);
  assert.equal(
    (await taskEvents(owner, run.task.id)).filter(
      (e) => e.kind === "candidate.accepted",
    ).length,
    1,
  );
});

test("Human changes invalidate queued snapshots and stale candidates", async () => {
  const run = await compositionTask(),
    doc = candidateFor(run.task);
  const proposal = await taskAct(
    run.task,
    "candidate",
    { leaseToken: run.leaseToken, doc, critique: "Проверка" },
    "agent",
  );
  const d = await getDeck(owner, run.task.deckId);
  d.state.doc.title = "Другое решение";
  await command(owner, {
    action: "save",
    deckId: d.id,
    expectedRevision: d.state.revision,
    doc: d.state.doc,
  });
  await assert.rejects(
    taskAct(proposal.task, "accept_candidate"),
    /изменилась/,
  );
  assert.equal((await getDeck(owner, d.id)).state.doc.slides.length, 1);
});

test("Task mutation checks current roles and rejects a revoked worker", async () => {
  const t = await newTask();
  let d = await getDeck(owner, t.deckId);
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: d.state.revision,
    grants: [{ email: other.email, role: "editor" }],
  });
  const q = await queueTask(await getTask(other, t.id), other);
  const run = await taskAct(q.task, "claim", {}, "agent", other);
  d = await getDeck(owner, t.deckId);
  await command(owner, {
    action: "share",
    deckId: d.id,
    expectedRevision: d.state.revision,
    grants: [],
  });
  await assert.rejects(
    taskAct(
      run.task,
      "heartbeat",
      { leaseToken: run.leaseToken },
      "agent",
      other,
    ),
    /недоступна/,
  );
  assert.equal((await getTask(owner, t.id)).state.status, "running");
});

test("Autosave acknowledgment preserves typing after the request and cannot replace another deck", async () => {
  const deck = await make();
  const sent = structuredClone(deck.state.doc);
  sent.slides[0].title = "First edit";
  const newer = structuredClone(sent);
  newer.slides[0].title = "First edit with more typing";
  const saved = await command(owner, {
    action: "save",
    deckId: deck.id,
    expectedRevision: deck.state.revision,
    doc: sent,
  });
  assert.equal(
    afterSave(newer, sent, saved.state.doc)!.slides[0].title,
    "First edit with more typing",
  );
  const another = { ...newer, id: "another-deck" };
  assert.equal(afterSave(another, sent, saved.state.doc), another);
  assert.deepEqual(afterSave(sent, sent, saved.state.doc), saved.state.doc);
  const next = await command(owner, {
    action: "save",
    deckId: deck.id,
    expectedRevision: saved.state.revision,
    doc: newer,
  });
  assert.equal(next.state.revision, 3);
  await assert.rejects(
    command(owner, {
      action: "save",
      deckId: deck.id,
      expectedRevision: deck.state.revision,
      doc: sent,
    }),
    /изменилась/,
  );
});

test("Schema-normalized key ordering is not a conflicting save or a new dirty edit", async () => {
  const deck = await make();
  const original = deck.state.doc;
  const reordered = Object.fromEntries(
    Object.entries(original).reverse(),
  ) as typeof original;
  reordered.slides = original.slides.map(
    (slide) =>
      Object.fromEntries(Object.entries(slide).reverse()) as typeof slide,
  );
  const saved = await command(owner, {
    action: "save",
    deckId: deck.id,
    expectedRevision: deck.state.revision,
    doc: reordered,
  });
  assert.equal(sameDocument(reordered, saved.state.doc), true);
  assert.deepEqual(
    afterSave(reordered, original, saved.state.doc),
    saved.state.doc,
  );
  const edited = structuredClone(reordered);
  edited.slides[0].title += " changed";
  assert.equal(sameDocument(edited, saved.state.doc), false);
});

test("Portable project includes verified materials and drops application ACL and approval", async () => {
  const { folderProject, projectZip, materialPath } = await import(
    "../lib/project/package"
  );
  const { default: JSZip } = await import("jszip");
  const d = await make();
  const bytes = new TextEncoder().encode("A source snapshot");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  d.state.sources = [
    {
      id: "source-a",
      name: "brief.txt",
      kind: "text",
      contentType: "text/plain",
      sha256: hash,
      excerpt: "A source snapshot",
      createdAt: new Date().toISOString(),
    },
  ];
  d.state.grants = [{ email: "colleague@example.test", role: "editor" }];
  d.state.approvedRevision = d.state.revision;
  d.state.approvedBy = "owner";
  const p = folderProject(d);
  const zip = await JSZip.loadAsync(await projectZip(p, async () => bytes));
  const saved = JSON.parse(await zip.file("project.json")!.async("string"));
  assert.deepEqual(saved.state.grants, []);
  assert.equal(saved.state.approvedRevision, null);
  assert.deepEqual(
    await zip.file(materialPath(hash))!.async("uint8array"),
    bytes,
  );
  await assert.rejects(
    projectZip(p, async () => new TextEncoder().encode("different")),
    /изменился/,
  );
  assert.throws(() => materialPath("../outside"), /hash/);
});


test("Formal workflow requires briefing even with prefilled values; agent cannot skip confirmation", async () => {
  const t = await createTask(owner,{requestId:crypto.randomUUID(),input:{...taskInput(),brief:{audience:"",decision:"",keyMessage:""}}});
  const q = await taskAct(t,"enqueue");
  assert.equal(q.task.state.status,"awaiting_input");
  await assert.rejects(taskAct(q.task,"claim",{},"agent"),/бриф/);
  await assert.rejects(taskAct(q.task,"answer",{answers:[]},"agent"),/недоступно/);
  const answers=q.task.state.questions.map((v:any)=>({id:v.id,answer:v.field==="audience"?"Бизнес-заказчик":"Согласовать пилот",assumed:true}));
  const confirmed=await taskAct(q.task,"answer",{answers});
  assert.ok(confirmed.task.state.briefConfirmedAt);
  assert.equal(confirmed.task.state.phase,"story");
  assert.equal(confirmed.task.state.input.brief.audience,"Бизнес-заказчик");
  assert.equal(confirmed.task.state.snapshot!.doc.brief!.audience,"Бизнес-заказчик");
  assert.ok(confirmed.task.state.questions.every((v:any)=>v.assumed));
  assert.equal(confirmed.task.state.input.brief.origins?.audience,"assumption");
});

test("Draft workflow continues from a saved plan without faking human approval",async()=>{
  const input={...taskInput(),workflow:undefined,brief:{audience:"",decision:"",keyMessage:""}};
  const created=await createTask(owner,{requestId:crypto.randomUUID(),input});
  assert.equal(created.state.workflow,"draft");
  assert.equal(created.state.phase,"story");
  assert.deepEqual(created.state.questions,[]);
  assert.equal(created.state.input.brief.origins?.audience,"assumption");
  const q=await taskAct(created,"enqueue");
  assert.equal(q.task.state.status,"queued");
  const run=await taskAct(q.task,"claim",{},"agent"),request={action:"plan",taskId:run.task.id,expectedVersion:run.task.version,requestId:crypto.randomUUID(),leaseToken:run.leaseToken,plan:testPlan()};
  const planned=await taskCommand(owner,request,"agent");
  assert.equal(planned.task.state.phase,"compose");
  assert.equal(planned.task.state.status,"queued");
  assert.ok(planned.task.state.planPreparedAt);
  assert.equal(planned.task.state.planAcceptedAt,undefined);
  assert.equal(planned.task.state.briefConfirmedAt,undefined);
  assert.deepEqual((await taskCommand(owner,request,"agent")).task.state,planned.task.state);
  const composing=await taskAct(planned.task,"claim",{},"agent");
  const candidate=candidateFor(composing.task);
  assert.equal((await inspectCandidate(owner,composing.task.id,candidate)).valid,true);
  const ready=await taskAct(composing.task,"candidate",{leaseToken:composing.leaseToken,doc:candidate,critique:"Проверка синтетического черновика"},"agent");
  assert.equal(ready.task.state.status,"awaiting_review");
  assert.equal((await getDeck(owner,created.deckId)).state.revision,1);
  await assert.rejects(taskAct(ready.task,"accept_candidate",{},"agent"),/недоступно/);
});

test("Drafts can still stop for a material question; legacy tasks keep formal gates",async()=>{
  const draft=await createTask(owner,{requestId:crypto.randomUUID(),input:{...taskInput(),workflow:"draft"}});
  const queued=await taskAct(draft,"enqueue"),run=await taskAct(queued.task,"claim",{},"agent");
  const asked=await taskAct(run.task,"questions",{leaseToken:run.leaseToken,questions:[{id:crypto.randomUUID(),text:"Какой период покрывают данные?",reason:"Период влияет на сравнение."}]},"agent");
  assert.equal(asked.task.state.status,"awaiting_input");
  await assert.rejects(taskAct(asked.task,"claim",{},"agent"),/не готова/);
  await assert.rejects(taskAct(asked.task,"answer",{answers:[]},"agent"),/недоступно/);
  const legacy=await newTask(),state=structuredClone(legacy.state);delete state.workflow;
  db.prepare("UPDATE presentation_tasks SET state=? WHERE id=?").run(JSON.stringify(state),legacy.id);
  const old=await getTask(owner,legacy.id),waiting=await taskAct(old,"enqueue");
  assert.equal(waiting.task.state.status,"awaiting_input");
  await assert.rejects(taskAct(waiting.task,"claim",{},"agent"),/бриф/);
});

test("Brief provenance survives creation and only an edited field becomes a human answer",async()=>{
  const initial=briefFromBriefing(resolveBriefing({audience:{value:"Команда",origin:"user"}}));
  const edited=editBriefField(initial,"decision","Выбрать вариант");
  assert.equal(edited.origins?.decision,"user");
  assert.equal(edited.origins?.keyMessage,"assumption");
  assert.equal(initial.origins?.decision,"assumption");
  const original=demoDoc();original.slides[0].notes="Заметки автора".repeat(180);
  const id=crypto.randomUUID(),body={action:"create",requestId:id,doc:original};
  const result=await command(owner,body,"agent");
  assert.equal(result.state.doc.slides[0].notes,original.slides[0].notes);
  assert.equal(result.state.doc.brief?.origins?.audience,"assumption");
  assert.equal((await command(owner,body,"agent")).id,result.id);
});

test("Cloud semantic edits link feedback, keep main unchanged and resolve only on acceptance",async()=>{
  const d=await make(),slide=d.state.doc.slides[0];
  const commented=await command(owner,{action:"comment",deckId:d.id,expectedRevision:d.state.revision,slideId:slide.id,text:"Уточнить вывод"});
  const feedbackId=commented.state.comments[0].id;
  const proposed=await command(owner,{action:"propose_commands",requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:d.state.revision,title:"Точный вывод",commands:[{op:"set_title",slideId:slide.id,value:"Уточнённый вывод"}],feedbackIds:[feedbackId]},"agent");
  assert.equal(proposed.state.doc.slides[0].title,slide.title);
  const p=proposed.state.proposals[0];
  const replied=await command(owner,{action:"reply",requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:d.state.revision,commentId:feedbackId,text:"Предлагаю уточнение.",proposalId:p.id},"agent");
  assert.equal(replied.state.comments[0].resolved,false);
  assert.equal(replied.state.comments[1].replyTo,feedbackId);
  const accepted=await command(owner,{action:"accept",deckId:d.id,expectedRevision:d.state.revision,proposalId:p.id,changeIds:p.changes.map(c=>c.id)});
  assert.equal(accepted.state.comments[0].resolved,true);
  assert.equal(accepted.state.doc.slides[0].title,"Уточнённый вывод");
  await assert.rejects(command(other,{action:"propose_commands",requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:accepted.state.revision,title:"Other tenant",commands:[{op:"set_title",slideId:slide.id,value:"Outside"}]},"agent"),/недоступна/);
});

test('Focus fixtures preserve content, fit the canvas and reject oversized copy',()=>{
  const doc=demoDoc();
  for(const fixture of focusFixtures){
    const s=validateDoc({...doc,slides:[{...blankSlide(),...fixture}]}).slides[0];
    const before=JSON.stringify(s),result=scene(s,defaultBrand,0,10,'focus-v1');
    assert.equal(result.overflow,false,s.layout);
    assert.equal(JSON.stringify(s),before);
    for(const item of result.items){assert.ok(item.x>=0 && item.y>=0);assert.ok(item.x+item.w<=1600.01);if(item.kind!=='text')assert.ok(item.y+item.h<=900);}
  }
  const s={...blankSlide('cover'),title:'Оченьдлинноеслово'.repeat(15)};
  assert.equal(scene(s,defaultBrand,0,1,'focus-v1').overflow,true);
  assert.ok(designReview({...doc,design:'focus-v1',slides:[{...s,body:'слово '.repeat(80)}]}).issues.length);
});
function apiRequest(path:string,actor=owner,body?:unknown){return new Request('https://lanka.example'+path,{method:body?'POST':'GET',headers:{'oai-authenticated-user-id':actor.id,'oai-authenticated-user-email':actor.email,...(body?{'origin':'https://lanka.example','content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
test('Permanent MCP links reopen the saved deck and never widen access',async()=>{
  const result=await mcpPost(apiRequest('/api/mcp',owner,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_deck',arguments:{requestId:crypto.randomUUID(),markdown:'# Saved deck\n\n## A decision\nReview this proposal.',briefing:{audience:{value:'Team',origin:'user'},decision:{value:'Review',origin:'user'},keyMessage:{value:'Saved link',origin:'user'}}}}}));
  const payload:any=await result.json(),made=JSON.parse(payload.result.content[0].text);
  assert.equal(payload.result.isError,false);
  assert.equal(made.links.editorUrl,'https://lanka.example'+deckPath(made.id));
  assert.match(made.links.presentationUrl,/\?mode=present$/);
  assert.equal((await studioGet(apiRequest('/api/studio?deckId='+made.id))).status,200);
  assert.equal((await studioGet(apiRequest('/api/studio?deckId='+made.id,other))).status,404);
  const blocked=await mcpPost(apiRequest('/api/mcp',other,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_deck_links',arguments:{deckId:made.id}}}));
  assert.equal((await blocked.json() as any).result.isError,true);
  assert.throws(()=>deckLinks('javascript:alert(1)',made.id));
});
test('Editable example preserves saved edits on reopen and isolates each owner',async()=>{
  const d=await openStarter(owner,'lanka-sales');
  assert.equal(d.state.doc.design,'focus-v1');
  assert.equal(d.state.sources.length,1);
  const doc=structuredClone(d.state.doc);doc.slides[0].title='Изменено в редакторе';
  const response=await studioPost(apiRequest('/api/studio',owner,{action:'save',deckId:d.id,expectedRevision:1,doc}));
  assert.equal(response.status,200);
  const saved:any=await response.json();assert.equal(saved.deck.state.revision,2);
  const again=await openStarter(owner,'lanka-sales');
  assert.equal(again.id,d.id);assert.equal(again.state.doc.slides[0].title,'Изменено в редакторе');
  const copy=await openStarter(other,'lanka-sales');
  assert.notEqual(copy.id,d.id);assert.notEqual(copy.state.doc.slides[0].title,'Изменено в редакторе');
  assert.equal(count('decks'),2);
  assert.equal((await assetGet(apiRequest('/api/assets?id='+d.state.sources[0].id))).status,200);
  assert.equal((await assetGet(apiRequest('/api/assets?id='+d.state.sources[0].id,other))).status,404);
  await assert.rejects(openStarter(owner,'../../other-client'));
});
test('Imported handoff remaps material IDs and cannot reference another project',async()=>{
  const doc=demoDoc();doc.slides[0].sourceIds=['local-source'];
  const materials=[{id:'local-source',name:'Evidence.txt',contentType:'text/plain',base64:btoa('Frozen evidence')}];
  const d=await command(owner,{action:'create',doc,materials});
  assert.notEqual(d.state.doc.slides[0].sourceIds[0],'local-source');
  const response=await assetGet(apiRequest('/api/assets?id='+d.state.sources[0].id));
  assert.equal(await response.text(),'Frozen evidence');
  const before=count('decks');
  await assert.rejects(command(other,{action:'create',doc,materials:[{...materials[0],id:'different'}]}),/отсутствуют/);
  assert.equal(count('decks'),before);
  assert.deepEqual(d.state.grants,[]);assert.equal(d.state.approvedRevision,null);
});


test('Focus v2 exports readable fixtures and keeps the pinned v1 contract',()=>{
  const doc=demoDoc();
  assert.equal(doc.design,'focus-v2');
  for(const fixture of focus2Fixtures){
    const s=validateDoc({...doc,slides:[{...blankSlide(),...fixture}]}).slides[0];
    const before=JSON.stringify(s),result=scene(s,defaultBrand,0,9,'focus-v2');
    assert.equal(result.overflow,false,s.layout);
    assert.equal(JSON.stringify(s),before);
    for(const item of result.items){
      assert.ok(item.x>=0 && item.y>=0 && item.x+item.w<=1600.01);
      if(item.kind==='text')assert.ok(item.y+item.size*1.18<=900.01);
      else assert.ok(item.y+item.h<=900);
    }
  }
  assert.equal(scene({...blankSlide('cover'),title:'Длинноеслово'.repeat(20)},defaultBrand,0,1,'focus-v2').overflow,true);
  const sample=validateDoc(focus2Seed.doc);
  assert.equal(sample.slides.some(s=>s.assetId||s.layout==='image'),false);
  // The old sample deliberately pins multiline titles. They still render, but
  // no longer count as passing the package's two-line authoring policy.
  assert.deepEqual(designReview(sample).issues.map(issue=>issue.slideId),
    sample.slides.filter(s=>s.title.split('\n').length>2).map(s=>s.id));
  sample.slides.forEach((s,i)=>assert.equal(scene(s,sample.brand,i,sample.slides.length,sample.design).overflow,false,s.id));
});

test('A new design example preserves the earlier document and each owners saved edits',async()=>{
  const old=await openStarter(owner,'lanka-sales');
  const current=await openStarter(owner,'lanka-sales-focus-v2');
  assert.notEqual(current.id,old.id);
  assert.equal(current.state.doc.design,'focus-v2');
  assert.equal((await getDeck(owner,old.id)).state.doc.design,'focus-v1');
  const doc=structuredClone(current.state.doc);doc.slides[0].title='Моя версия Focus 2';
  await command(owner,{action:'save',deckId:current.id,expectedRevision:current.state.revision,doc});
  const again=await openStarter(owner,'lanka-sales-focus-v2');
  assert.equal(again.id,current.id);assert.equal(again.state.doc.slides[0].title,doc.slides[0].title);
  const independent=await openStarter(other,'lanka-sales-focus-v2');
  assert.notEqual(independent.id,current.id);
  await assert.rejects(getDeck(other,current.id),/недоступна/);
  await assert.rejects(openStarter(owner,'toString'));
});


test('Focus 2 binds visible text to exact semantic editor fields without relying on matching text', () => {
  const doc = validateDoc(focus2Seed.doc);
  for (const fixture of focus2Fixtures) {
    const slide = validateDoc({...doc, slides:[{...blankSlide(),...fixture}]}).slides[0];
    const texts = scene(slide,doc.brand,0,1,'focus-v2').items.filter(p=>p.kind==='text');
    assert.ok(texts.some(p=>p.editField==='title'),slide.layout);
    for (const p of texts.filter(p=>p.editField)) {
      const field=p.editField!;
      assert.ok(['title','body','eyebrow'].includes(field) || /^(metric|table|chart):/.test(field),field);
    }
    slide.metrics.forEach(m=>assert.ok(texts.some(p=>p.editField===`metric:${m.id}:value`)));
    if(slide.layout==='table') slide.table?.rows.forEach((row,i)=>row.forEach((cell,j)=>{if(cell)assert.ok(texts.some(p=>p.editField===`table:${i}:${j}`));}));
  }
  const slide={...blankSlide('cover'),title:'Одинаково',body:'Одинаково',eyebrow:'Одинаково'};
  const fields=scene(slide,doc.brand,0,1,'focus-v2').items.filter(p=>p.kind==='text' && p.text==='Одинаково').map(p=>p.kind==='text' ? p.editField : undefined);
  assert.deepEqual(new Set(fields),new Set(['title','body','eyebrow']));
});

// Focus 3 is additive: the earlier fixture and starter tests above remain unchanged.
import focus3Seed from "../lib/examples/lanka-sales-focus-v3.json";
import { lintDoc } from "../lib/domain/model";
import { compileCommands } from "../lib/domain/commands";
import focus3Fixtures from "../design-packs/focus-v3/fixtures.json";
import focus3Tokens from "../design-packs/focus-v3/tokens.json";
import { focusV3Scene, focusV3Variant } from "../lib/domain/focus-v3";
import { attachDataObject } from "../lib/domain/data-object";
import { block as plexBlock, glue as plexGlue } from "../lib/domain/scene-text-v3";
import { textStyle, pdfFontFiles } from "../lib/domain/scene-typography";
import { pptxBytes } from "../lib/export";
import { slideSvg } from "../lib/export-svg";
import { defaultDesign } from "../lib/domain/design";

test("Focus 3 fixtures and sales example fit, expose policy metrics and preserve semantic input", () => {
  const doc = validateDoc(focus3Seed.doc), P = focus3Tokens.policy;
  const fixtures = focus3Fixtures.map(f => validateDoc({...doc, slides: [{...blankSlide(), ...f}]}).slides[0]);
  for (const slides of [doc.slides, fixtures]) slides.forEach((s, i) => {
    const before = structuredClone(s), result = scene(s, doc.brand, i, slides.length, "focus-v3");
    assert.equal(result.overflow, false, s.id);
    assert.deepEqual(s, before);
    const m = result.meta!;
    assert.ok(m.titleFill <= P.maxTitleFill, s.id);
    assert.ok(m.titleLines <= P.maxTitleLines[["cover", "statement", "closing"].includes(s.layout) ? "display" : "h1"], s.id);
    assert.ok(m.occupancy >= P.occupancy[0] && m.occupancy <= P.occupancy[1], s.id);
    assert.ok(m.primaryTextClasses <= P.primaryTextClassesPerSlide, s.id);
    assert.ok(m.gap >= focus3Tokens.zones.minTitleGap, s.id);
    for (const p of result.items) {
      assert.ok(Number.isFinite(p.x + p.y + p.w) && p.x >= 0 && p.x + p.w <= 1600.01, s.id);
      assert.ok(p.y >= 0 && p.y + (p.kind === "text" ? textStyle(p).baseline : p.h) <= 900, s.id);
    }
  });
  assert.equal(focusV3Variant(doc.slides[3]), "before-after");
  assert.equal(focusV3Variant(doc.slides[6]), "facts");
  assert.equal(focusV3Variant(fixtures[8]), "hero");
  assert.equal(focusV3Variant({...fixtures[8], metrics: fixtures[8].metrics.map(m => ({...m, sourceId: undefined}))}), "facts");
  assert.deepEqual(lintDoc(doc), []);
  // The supplied geometry has two 145px column blocks versus a 150px advisory minimum.
  // Preserve and surface the handoff discrepancy instead of silently relaxing its policy.
  const review = designReview(doc);
  assert.equal(review.certification, "candidate");
  assert.deepEqual(review.issues, [doc.slides[1], doc.slides[7]].map(s => ({slideId: s.id, message: "Доказательство слишком маленькое для отдельного слайда."})));
  assert.equal(focusV3Scene({...doc.slides[1], title: "Очень длинный заголовок ".repeat(25)}, doc.brand, 1, 9).overflow, true);
});

test("Focus 3 schema validates structured comparisons and table roles; new lint stays scoped", () => {
  const doc = validateDoc(focus3Seed.doc);
  assert.throws(() => validateDoc({...doc, slides: [{...doc.slides[5], table: {...doc.slides[5].table, columnRoles: ["key", "meta"]}}]}), /Роли колонок/);
  assert.throws(() => validateDoc({...doc, slides: [{...doc.slides[3], comparison: {...doc.slides[3].comparison, variant: "options"}}]}));
  const invalid = {...doc, slides: [{...doc.slides[3], comparison: undefined, body: "Только один блок"}]};
  assert.ok(lintDoc(invalid).some(i => i.code === "split-shape" && i.severity === "error"));
  assert.ok(!lintDoc({...invalid, design: "focus-v2"}).some(i => i.code === "split-shape"));
  const early = {...doc, slides: [doc.slides[4], ...doc.slides.slice(0, 4)]};
  assert.ok(lintDoc(early).some(i => i.code === "statement-before-evidence"));
  const repeated = {...doc, slides: [doc.slides[3], doc.slides[4], {...doc.slides[4], id: "second-statement"}]};
  assert.ok(lintDoc(repeated).some(i => i.code === "too-many-statements"));
  assert.match(plexGlue("и в проекте — решение"), /и\u00a0в\u00a0проекте\u00a0— решение/);
  const balanced = plexBlock("Команде нужна одна общая версия", 1168, 80, 1.04, "sans", true, -0.025, true);
  assert.equal(balanced.lines.length, 2);
  assert.ok(Math.max(...balanced.widths) - Math.min(...balanced.widths) < 150);
  const changes = compileCommands(doc, [{op: "set_comparison", slideId: doc.slides[3].id, value: {...doc.slides[3].comparison, status: "На проверке"}}]);
  assert.equal(changes[0].after.comparison?.status, "На проверке");
  assert.notEqual(doc.slides[3].comparison?.status, "На проверке");
});

test("Focus 3 starter keeps owner edits, concurrent opens, previous decks and the default isolated", async () => {
  const v1 = await openStarter(owner, "lanka-sales"), v2 = await openStarter(owner, "lanka-sales-focus-v2");
  const snapshots = [structuredClone(v1.state), structuredClone(v2.state)];
  const [v3, same] = await Promise.all([openStarter(owner, "lanka-sales-focus-v3"), openStarter(owner, "lanka-sales-focus-v3")]);
  assert.equal(v3.id, same.id);
  assert.notEqual(v3.id, v1.id); assert.notEqual(v3.id, v2.id);
  assert.equal(v3.state.doc.design, "focus-v3");
  const doc = structuredClone(v3.state.doc);
  doc.slides[3].comparison!.after.text = "Предложение владельца";
  await command(owner, {action: "save", deckId: v3.id, expectedRevision: v3.state.revision, doc});
  const reopened = await openStarter(owner, "lanka-sales-focus-v3");
  assert.equal(reopened.state.doc.slides[3].comparison!.after.text, "Предложение владельца");
  const independent = await openStarter(other, "lanka-sales-focus-v3");
  assert.notEqual(independent.id, v3.id);
  await assert.rejects(getDeck(other, v3.id), /недоступна/);
  assert.deepEqual((await getDeck(owner, v1.id)).state, snapshots[0]);
  assert.deepEqual((await getDeck(owner, v2.id)).state, snapshots[1]);
  assert.equal(defaultDesign, "focus-v2"); assert.equal(demoDoc().design, "focus-v2");
});

test("Focus 3 exports editable Plex text, exact tracking and brand theme colors", async () => {
  const doc = validateDoc(focus3Seed.doc);
  const zip = await JSZip.loadAsync(await pptxBytes(doc));
  const theme = await zip.file("ppt/theme/theme1.xml")!.async("string");
  for (const [role, color] of Object.entries({dk1: "15182A", lt1: "F6F6F3", accent1: "444BE8", accent2: "A9AEFF"}))
    assert.match(theme, new RegExp(`<a:${role}><a:srgbClr val="${color}"/></a:${role}>`));
  assert.match(theme, /IBM Plex Sans/);
  for (const [i, s] of doc.slides.entries()) {
    const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`)!.async("string");
    assert.match(xml, /IBM Plex Sans/); assert.match(xml, /IBM Plex Mono/);
    assert.doesNotMatch(xml, /DejaVu/);
    assert.match(xml, /<p:sp>/);
    assert.match(xml, /wrap="none"/);
    for (const p of scene(s, doc.brand, i, doc.slides.length, doc.design).items) if (p.kind === "text" && p.tracking)
      assert.match(xml, new RegExp(`spc="${Math.round(p.tracking * p.size * 0.6 * 100)}"`));
    const svg = slideSvg(s, doc.brand, i, doc.slides.length, doc.design);
    assert.match(svg, /font-family="IBM Plex Mono"/);
    assert.match(svg, /letter-spacing="1.56"/);
    assert.doesNotMatch(svg, /DejaVu/);
  }
});

test("Focus 3 PDF embeds all three Plex fonts and keeps Cyrillic text extractable", async () => {
  const doc = validateDoc(focus3Seed.doc);
  const fonts = pdfFontFiles(doc.design).map(name => readFileSync(`public/fonts/${name}`));
  await assert.rejects(pdfBytes(doc, fonts[0], fonts[1]), /Mono/);
  const bytes = await pdfBytes(doc, fonts[0], fonts[1], undefined, fonts[2]);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 9);
  const list = inspectPdf(bytes, "pdffonts");
  if (list !== null) {
    for (const name of ["IBMPlexSans-Regular", "IBMPlexSans-SemiBold", "IBMPlexMono-Medium"])
      assert.match(list, new RegExp(`${name}.*yes`));
    assert.doesNotMatch(list, /DejaVu/);
  }
  const text = inspectPdf(bytes, "pdftotext");
  if (text !== null) assert.match(text, /Презентации с агентом/);
});

test("Focus 3 renders an ordinary single-paragraph content slide without inventing columns", () => {
  const slide={...blankSlide("content"),title:"Письмо сохраняет знания",body:"Записи помогали учитывать запасы, закреплять договорённости и передавать сведения между поколениями."};
  const before=JSON.stringify(slide);
  const rendered=scene(slide,defaultBrand,1,4,"focus-v3");
  assert.equal(rendered.overflow,false);
  assert.equal(rendered.meta?.variant,"lead");
  assert.ok(rendered.items.some(p=>p.kind==="text"&&p.editField==="body"));
  assert.equal(JSON.stringify(slide),before);
  assert.equal(scene({...slide,body:slide.body.repeat(80)},defaultBrand,1,4,"focus-v3").overflow,true);
});
test("Focus 3 retries a crowded comparison without rewriting content or shrinking type", () => {
  const s = {...blankSlide("split"), title: "От линии на карте к сети связей", body: "По материалам UNESCO", comparison: {
    prompt: {label: "Как читать карту", text: "Представьте путь одного товара через несколько рынков."},
    before: {label: "Упрощённая картина", text: "Один маршрут. Один купец проходит весь путь."},
    after: {label: "Более точная картина", text: "Много маршрутов. Товар передают через цепочку посредников."},
    status: "Учебное сравнение представлений",
  }};
  const before = structuredClone(s), data = scene(s, defaultBrand, 2, 4, "focus-v3");
  assert.equal(data.overflow, false);
  assert.equal(data.meta?.variant, "before-after-wide");
  assert.ok((data.meta?.gap || 0) >= 64);
  assert.deepEqual(s, before);
  assert.ok(data.items.some(p => p.kind === "text" && p.editField === "comparison:after:text"));
  assert.ok(data.items.some(p => p.kind === "text" && p.editField === "title" && p.size === 80));
});

import { canvasFromScene, canvasScene, withCanvas, fitElement } from "../lib/domain/canvas";
import { canvasSchema, validateReferences } from "../lib/domain/model";

test("direct editing preserves every Focus 3 fixture's visible typography and geometry",()=>{
  const doc=validateDoc(focus3Seed.doc);
  for(const s of [...doc.slides,...focus3Fixtures.map(s=>validateDoc({...doc,slides:[{...blankSlide(),...s}]}).slides[0])]) {
    const before=scene(s,doc.brand,0,doc.slides.length,"focus-v3");
    const elements=canvasSchema.parse(canvasFromScene(before));
    const after=scene({...s,canvas:elements},doc.brand,0,doc.slides.length,"focus-v3");
    const visible=(data:ReturnType<typeof scene>)=>data.items.map(p=>p.kind==="text"?
      {kind:p.kind,text:p.text,x:p.x,y:Math.round(p.y*1000)/1000,size:p.size,bold:p.bold,font:p.font,color:p.color,tracking:p.tracking}:
      {kind:p.kind,x:p.x,y:p.y,w:p.w,h:p.h,...(p.kind==="rect"?{color:p.color}:{assetId:p.assetId})});
    assert.deepEqual(visible(after),visible(before),s.title);
    assert.equal(after.overflow,false,s.title);
  }
});

test("canvas object commands preserve ids, review isolation and visible title, reject stale semantic edits",()=>{
  const doc=validateDoc(focus3Seed.doc),s=doc.slides[0];
  s.canvas=canvasFromScene(scene(s,doc.brand,0,doc.slides.length,doc.design));
  const target=s.canvas.find(e=>e.kind==="text"&&e.sourceField==="title")!;
  assert.equal(target.kind,"text");if(target.kind!=="text")return;
  const value={...target,text:"Прямое редактирование",x:target.x+10};
  const changes=compileCommands(doc,[{op:"set_element",slideId:s.id,value}]);
  assert.equal(s.canvas.find(e=>e.id===target.id),target);
  assert.equal(changes[0].after.canvas!.find(e=>e.id===target.id)!.x,value.x);
  assert.match(changes[0].after.title,/Прямое редактирование/);
  assert.throws(()=>compileCommands(doc,[{op:"set_body",slideId:s.id,value:"Невидимая правка"}]),/canvas objects/);
  assert.throws(()=>compileCommands(doc,[{op:"set_element",slideId:s.id,value:{...value,id:"missing"}}]),/outside/);
  assert.throws(()=>compileCommands(doc,[{op:"remove_element",slideId:s.id,elementId:s.canvas![0].id}]),/locked/);
  assert.throws(()=>canvasSchema.parse([value,value]),/уникальны/);
  assert.equal(canvasScene([{...value,h:1}]).overflow,true);
  assert.equal(canvasScene([{...value,x:1599}]).overflow,true);
  assert.equal(fitElement({...value,x:1599}).x,1600-value.w);
  const state=initialState({...doc,slides:[withCanvas(s,[{id:"img",kind:"image",x:0,y:0,w:100,h:100,assetId:"outside"}])]});
  state.doc.slides[0].sourceIds=[];state.doc.slides[0].metrics=[];state.doc.slides[0].table=undefined;
  assert.throws(()=>validateReferences(state),/Изображение объекта/);
});

test("directly edited objects reach PDF and editable PowerPoint text, shapes and images",async()=>{
  const doc=validateDoc(focus3Seed.doc);doc.slides=[doc.slides[0]];
  doc.slides[0].canvas=[
    {id:"bg",kind:"rect",x:0,y:0,w:1600,h:900,color:"#FFFFFF",locked:true},
    {id:"text",kind:"text",x:120,y:140,w:900,h:100,text:"Объект после правки",size:44,bold:false,color:"#20243B",font:"sans",lineHeight:1.3},
    {id:"shape",kind:"rect",x:120,y:350,w:350,h:120,color:"#444BE8"},
    {id:"image",kind:"image",x:1000,y:300,w:120,h:120,assetId:"test-image"},
  ];
  const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=","base64");
  const load=async()=>({bytes:Uint8Array.from(image).buffer,type:"image/png"});
  const pptx=await buildPptx(doc,[],load),zip=await JSZip.loadAsync(await pptx.write({outputType:"nodebuffer"}) as Buffer);
  const xml=await zip.file("ppt/slides/slide1.xml")!.async("string");
  assert.match(xml,/<a:t>Объект после правки<\/a:t>/);assert.match(xml,/<p:pic>/);assert.match(xml,/444BE8/);
  const fonts=["IBMPlexSans-Regular.ttf","IBMPlexSans-SemiBold.ttf","IBMPlexMono-Medium.ttf"].map(f=>Uint8Array.from(readFileSync(`public/fonts/${f}`)).buffer);
  const pdf=await pdfBytes(doc,fonts[0],fonts[1],load,fonts[2]);
  assert.equal((await PDFDocument.load(pdf)).getPageCount(),1);
});

import { assertEditDesign } from "../lib/agents/edit-design";
import {canvasContrast,contrastRatio} from '../lib/domain/canvas-contrast';

test('canvas contrast catches invisible rules and text against their actual solid backing',()=>{
  const bg={id:'bg',kind:'rect' as const,x:0,y:0,w:1600,h:900,color:'#15182A'};
  const text={id:'text',kind:'text' as const,x:100,y:100,w:500,h:100,text:'Visible words',size:40,bold:false,color:'#FFFFFF',lineHeight:1.3};
  const rule={id:'rule',kind:'rect' as const,x:100,y:250,w:600,h:1,color:bg.color};
  assert.equal(contrastRatio('#000000','#ffffff'),21);
  assert.deepEqual(canvasContrast([bg,text,rule]).map(i=>[i.elementId,i.code]),[['rule','canvas-rule-contrast']]);
  assert.ok(canvasContrast([bg,{...text,color:bg.color}]).some(i=>i.elementId==='text'));
  assert.deepEqual(canvasContrast([bg,text,{...rule,color:'#777777'}]),[]);
  const card={id:'card',kind:'rect' as const,x:90,y:90,w:600,h:130,color:'#FFFFFF'};
  assert.deepEqual(canvasContrast([bg,card,{...text,color:'#15182A'}]),[]);
  assert.ok(canvasContrast([bg,{...card,w:40},{...text,color:'#15182A'}]).some(i=>i.elementId==='text'));
  assert.deepEqual(canvasContrast([bg,{...text,color:bg.color},{...card,w:600,h:300}]),[]);
  assert.deepEqual(canvasContrast([bg,{id:'image',kind:'image',x:90,y:90,w:600,h:130,assetId:'photo'},{...text,color:bg.color}]),[]);
  // A large low-contrast panel is a surface, not a disappearing separator.
  assert.deepEqual(canvasContrast([bg,{...card,color:bg.color}]),[]);
});

test('design proposals reject contrast regressions while permitting inherited problems and improvements',()=>{
  const doc=demoDoc();const s=doc.slides[0];
  s.canvas=[{id:'bg',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF'},
    {id:'copy',kind:'text',x:100,y:150,w:800,h:120,text:'Keep the words',size:40,bold:false,color:'#DDDDDD',lineHeight:1.3}];
  const candidate=(color:string)=>({...s,canvas:s.canvas!.map(e=>e.id==='copy'?{...e,color}:e)});
  assert.doesNotThrow(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,notes:'Unrelated note'}}]));
  assert.doesNotThrow(()=>assertEditDesign(doc,[{slideId:s.id,after:candidate('#AAAAAA')} ]));
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:candidate('#FFFFFF')}]),/плохо различим/);
  if(s.canvas[1].kind==='text')s.canvas[1].color='#000000';
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,canvas:s.canvas!.map(e=>e.id==='bg'?{...e,color:'#000000'}:e)}}]),/плохо различим/);
});
test("full-slide proposals cannot discard manual objects or silently edit obsolete template fields",()=>{
  const doc=validateDoc(focus3Seed.doc),s=doc.slides[0];
  s.canvas=canvasFromScene(scene(s,doc.brand,0,doc.slides.length,doc.design));
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,canvas:undefined}}]),/сохраните ручные объекты/);
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,body:"Невидимое содержание"}}]),/поля исходного шаблона/);
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,title:"Невидимый заголовок"}}]),/видимым объектам/);
  assert.throws(()=>validateDoc({...doc,design:"focus-v2"}),/Шрифты объектов/);
});

test("cloud commands preserve server-resolved object anchors and existing ACL",async()=>{
 const d=await make(),doc=structuredClone(d.state.doc),s=doc.slides[0];
 s.canvas=[{id:'comment-object',kind:'text',x:100,y:150,w:800,h:120,text:'Original quote',size:40,bold:false,color:'#20243B',lineHeight:1.3}];
 const saved=await command(owner,{action:'save',deckId:d.id,expectedRevision:d.state.revision,doc});
 const input={action:'comment',requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:saved.state.revision,slideId:s.id,elementId:'comment-object',text:'Please clarify'};
 const commented=await command(owner,input),root=commented.state.comments.at(-1)!;
 assert.deepEqual(root.anchor,{elementId:'comment-object',quote:'Original quote',revision:saved.state.revision});
 await assert.rejects(command(other,{...input,requestId:crypto.randomUUID()}));
 await assert.rejects(command(owner,{...input,requestId:crypto.randomUUID(),elementId:'missing'}),/Объект комментария недоступен/);
 const replied=await command(owner,{action:'reply',deckId:d.id,expectedRevision:commented.state.revision,commentId:root.id,text:'Kept in context'});
 assert.deepEqual(replied.state.comments.at(-1)!.anchor,root.anchor);
 assert.equal(replied.state.comments.length,commented.state.comments.length+1);
});

import { decideProposalObjects, rejectProposal } from '../lib/domain/model';
import { objectChanges, remainingSlide } from '../lib/domain/object-review';
function objectReviewFixture() {
  const doc=demoDoc();doc.slides=[blankSlide()];
  const box=(id:string,y:number)=>({id,kind:'text' as const,x:100,y,w:800,h:100,text:id,size:32,bold:false,color:'#20243B',lineHeight:1.3});
  doc.slides[0]=withCanvas(doc.slides[0],[{...box('title',100),sourceField:'title'},box('body',250),box('neighbor',400)]);
  const state=initialState(doc),before=state.doc.slides[0];
  const after=withCanvas(before,before.canvas!.map(e=>e.kind==='text'&&e.id!=='neighbor'?{...e,text:e.text+' proposed'}:e));
  const p=propose(state,[{slideId:before.id,after}],'Two objects','agent');state.proposals.push(p);
  return {state,p,c:p.changes[0],before,after};
}
test('object review merges neighbors, retains immutable evidence and skips rejected changes in remaining preview',()=>{
  const {state,p,c}=objectReviewFixture(),evidence=structuredClone(c);
  const neighbor=state.doc.slides[0].canvas!.find(e=>e.id==='neighbor')!;neighbor.x=340;
  decideProposalObjects(state,p.id,c.id,['title'],'accepted');changedContent(state);
  assert.equal(state.doc.slides[0].title,'title proposed');assert.equal(p.status,'pending');
  assert.equal(state.doc.slides[0].canvas!.find(e=>e.id==='neighbor')!.x,340);
  // A later manual correction to the already accepted object must survive accepting the rest.
  state.doc.slides[0]=withCanvas(state.doc.slides[0],state.doc.slides[0].canvas!.map(e=>e.kind==='text'&&e.id==='title'?{...e,text:'Manual final title'}:e));
  const preview=remainingSlide(state.doc.slides[0],c);
  assert.equal(preview.title,'Manual final title');
  acceptProposal(state,p.id,[c.id]);
  assert.equal(state.doc.slides[0].title,'Manual final title');assert.equal(p.status,'closed');
  assert.deepEqual(c.before,evidence.before);assert.deepEqual(c.after,evidence.after);
  const other=objectReviewFixture();
  decideProposalObjects(other.state,other.p.id,other.c.id,['title'],'rejected');
  const rest=remainingSlide(other.state.doc.slides[0],other.c);
  assert.equal(rest.title,'title');assert.equal(rest.canvas![1].kind==='text'&&rest.canvas![1].text,'body proposed');
  acceptProposal(other.state,other.p.id,[other.c.id]);
  assert.equal(other.state.doc.slides[0].title,'title');assert.equal(other.p.status,'closed');
  assert.deepEqual(other.c.objectDecisions?.map(d=>d.status),['rejected','accepted']);
});
test('same-object conflicts and invalid batches are atomic; independent objects can still be accepted',()=>{
  const {state,p,c}=objectReviewFixture();state.doc.slides[0].canvas![1].x=500;
  const snapshot=structuredClone(state);
  assert.throws(()=>acceptProposal(state,p.id,[c.id]),/Конфликт/);assert.deepEqual(state,snapshot);
  assert.throws(()=>decideProposalObjects(state,p.id,c.id,['title','body'],'accepted'),/Конфликт/);assert.deepEqual(state,snapshot);
  decideProposalObjects(state,p.id,c.id,['title'],'accepted');
  assert.throws(()=>decideProposalObjects(state,p.id,c.id,['title'],'accepted'),/обработан/);
  rejectProposal(state,p.id);assert.equal(p.status,'closed');
  assert.equal(state.doc.slides[0].canvas![1].x,500);
});
test('object additions and removals preserve proposed layer order across separate decisions',()=>{
  const {state,before}=objectReviewFixture();state.proposals=[];
  const a={id:'add-a',kind:'rect' as const,x:100,y:600,w:100,h:100,color:'#123456'},b={...a,id:'add-b',x:240};
  const after=withCanvas(before,[before.canvas![0],a,b,before.canvas![2]]);
  const p=propose(state,[{slideId:before.id,after}],'Add/remove','agent');state.proposals.push(p);const c=p.changes[0];
  assert.deepEqual(objectChanges(c),['body','add-a','add-b']);
  decideProposalObjects(state,p.id,c.id,['add-b'],'accepted');
  decideProposalObjects(state,p.id,c.id,['add-a'],'accepted');
  decideProposalObjects(state,p.id,c.id,['body'],'accepted');
  assert.deepEqual(state.doc.slides[0].canvas,after.canvas);
  const other=objectReviewFixture();other.c.after=withCanvas(other.before,[other.before.canvas![1],other.before.canvas![0],other.before.canvas![2]]);
  assert.equal(objectChanges(other.c),null);
  assert.throws(()=>decideProposalObjects(other.state,other.p.id,other.c.id,['title'],'accepted'),/отдельного/);
  other.c.after={...other.after,notes:'changed metadata'};assert.equal(objectChanges(other.c),null);
});
test('object acceptance validates merged document and asset references before mutation',()=>{
  const {state,p,c}=objectReviewFixture();
  c.after=withCanvas(c.before,[{id:'image',kind:'image',x:0,y:0,w:200,h:200,assetId:'missing'}]);
  const original=structuredClone(state);
  assert.throws(()=>decideProposalObjects(state,p.id,c.id,['image'],'accepted'),/Изображение объекта/);assert.deepEqual(state,original);
  c.after=withCanvas(c.before,[c.before.canvas![0]]);
  // The only remaining object cannot be deleted by a later proposal if that empties the canvas.
  const current=state.doc.slides[0];current.canvas=[current.canvas![1]];
  const snapshot=structuredClone(state);
  assert.throws(()=>decideProposalObjects(state,p.id,c.id,['body'],'accepted'));
  assert.deepEqual(state,snapshot);
});
test('cloud object decisions enforce human ACL, revisions and persist mixed review history',async()=>{
  const d=await make(),fixture=objectReviewFixture();const doc={...d.state.doc,slides:fixture.state.doc.slides};
  let saved=await command(owner,{action:'save',deckId:d.id,expectedRevision:d.state.revision,doc});
  saved=await command(owner,{action:'propose',requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:saved.state.revision,title:'Objects',changes:[{slideId:doc.slides[0].id,after:fixture.after}]},'agent');
  const p=saved.state.proposals.at(-1)!,c=p.changes[0];
  const input={action:'review_objects',requestId:crypto.randomUUID(),deckId:d.id,expectedRevision:saved.state.revision,proposalId:p.id,changeId:c.id,elementIds:['title'],decision:'accepted'};
  await assert.rejects(command(owner,input,'agent'),/Агент может/);await assert.rejects(command(other,input));
  const accepted=await command(owner,input);assert.equal(accepted.state.revision,saved.state.revision+1);
  await assert.rejects(command(owner,{...input,requestId:crypto.randomUUID(),elementIds:['body']}),/верси/i);
  const rejected=await command(owner,{...input,requestId:crypto.randomUUID(),expectedRevision:accepted.state.revision,elementIds:['body'],decision:'rejected'});
  assert.equal(rejected.state.revision,accepted.state.revision);assert.equal(rejected.state.proposals.at(-1)!.status,'closed');
  assert.deepEqual(rejected.state.proposals.at(-1)!.changes[0].objectDecisions?.map(d=>d.status),['accepted','rejected']);
});

test('background layout lock permits recoloring without unlock and blocks geometry/deletion bypass',()=>{
  const doc=validateDoc(focus3Seed.doc);const s=doc.slides[0];s.canvas=canvasFromScene(scene(s,doc.brand,0,doc.slides.length,doc.design));
  const background=s.canvas[0];assert.equal(background.locked,true);assert.equal(background.kind,'rect');
  const commands=[{op:'set_element',slideId:s.id,value:{...background,color:'#F0F0F0'}}];
  const changes=compileCommands(doc,commands);assert.equal(changes[0].after.canvas![0].locked,true);
  assertEditDesign(doc,changes);
  assert.throws(()=>assertEditDesign(doc,compileCommands(doc,[{op:'set_element',slideId:s.id,value:{...background,color:'#101018'}}])),/плохо различим/);
  assert.deepEqual(changes[0].after.canvas!.slice(1),s.canvas!.slice(1));
  for(const value of [{...background,x:10},{...background,locked:false},{...background,w:1500}]){
    assert.throws(()=>compileCommands(doc,[{op:'set_element',slideId:s.id,value}]),/locked/);
    assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,canvas:[value,...s.canvas!.slice(1)]}}]),/заблокированного/);
  }
  assert.throws(()=>compileCommands(doc,[{op:'remove_element',slideId:s.id,elementId:background.id}]),/locked/);
  assert.throws(()=>assertEditDesign(doc,[{slideId:s.id,after:{...s,canvas:s.canvas!.slice(1)}}]),/заблокированного/);
  const lockedTitle={...s.canvas.find(e=>e.kind==='text')!,locked:true};s.canvas.push({...lockedTitle,id:'locked-title'});
  assert.throws(()=>compileCommands(doc,[{op:'set_element',slideId:s.id,value:{...lockedTitle,id:'locked-title',color:'#FFFFFF'}}]),/locked/);
});

import {imageFrameSchema,defaultImageFrame,imagePlacement} from '../lib/domain/image-frame';
import {createRequire} from 'node:module';
test('image frames preserve aspect ratio and clamp valid crops to the immutable source',()=>{
 const box={x:100,y:100,w:400,h:400},base=defaultImageFrame(200,100);
 assert.deepEqual(imagePlacement(box,base),{viewport:{x:100,y:200,w:400,h:200},draw:{x:100,y:200,w:400,h:200},source:{x:0,y:0,w:200,h:100}});
 const right=imagePlacement(box,{...base,fit:'cover',focusX:1});assert.deepEqual(right.source,{x:100,y:0,w:100,h:100});assert.equal(right.draw.x,-300);
 for(const zoom of [1,2,8])for(const focusX of [0,.5,1])for(const focusY of [0,.5,1]){
  const p=imagePlacement(box,{...base,fit:'cover',zoom,focusX,focusY});assert.ok(p.source.x>=0&&p.source.y>=0);assert.ok(p.source.x+p.source.w<=200+.00001);assert.ok(p.source.y+p.source.h<=100+.00001);assert.equal(p.source.w/p.source.h,box.w/box.h);
 }
 assert.throws(()=>imageFrameSchema.parse({...base,zoom:0}));assert.throws(()=>imageFrameSchema.parse({...base,sourceWidth:0}));assert.throws(()=>imageFrameSchema.parse({...base,focusX:1.1}));
});
test('image replacement and crop are reviewable object commands with stable identity',()=>{
 const doc=demoDoc(),s=doc.slides[0];s.canvas=[{id:'picture',kind:'image',x:100,y:100,w:400,h:400,assetId:'first',frame:defaultImageFrame(200,100)}];
 const value={...s.canvas[0],assetId:'second',frame:{...defaultImageFrame(100,200),fit:'cover' as const,zoom:2}};
 const changes=compileCommands(doc,[{op:'set_element',slideId:s.id,value}]);
 assert.equal(changes[0].after.canvas![0].id,'picture');assert.ok(s.canvas[0].kind==='image');assert.equal(s.canvas[0].assetId,'first');assert.deepEqual(changes[0].after.canvas![0],value);
});
test('cropped images export their original bytes and native crop in PPTX and a clipped PDF image',async()=>{
 const {PNG}=createRequire(import.meta.url)('pngjs'),png=new PNG({width:200,height:100});
 for(let y=0;y<100;y++)for(let x=0;x<200;x++){const i=(y*200+x)*4;png.data[i]=x<100?255:0;png.data[i+1]=x>=100?255:0;png.data[i+2]=y>=50?255:0;png.data[i+3]=255;}
 const bytes=PNG.sync.write(png),load=async()=>({bytes:Uint8Array.from(bytes).buffer,type:'image/png'});
 const doc=demoDoc();doc.slides=[doc.slides[0]];doc.slides[0].canvas=[{id:'picture',kind:'image',assetId:'pixels',x:100,y:100,w:400,h:400,frame:{...defaultImageFrame(200,100),fit:'cover',focusX:1}}];
 const p=await buildPptx(doc,[],load),zip=await JSZip.loadAsync(await p.write({outputType:'nodebuffer'}) as Buffer),xml=await zip.file('ppt/slides/slide1.xml')!.async('string');
 const crop=xml.match(/<a:srcRect l="(\d+)" r="(\d+)" t="(\d+)" b="(\d+)"/)!;assert.ok(crop);for(const [i,want] of [50000,0,0,0].entries())assert.ok(Math.abs(Number(crop[i+1])-want)<=2);assert.equal((xml.match(/<p:pic>/g)||[]).length,1);
 const media=Object.keys(zip.files).find(k=>k.startsWith('ppt/media/')&&k.endsWith('.png'))!;assert.deepEqual(await zip.file(media)!.async('nodebuffer'),bytes);
 const fonts=['DejaVuSans.ttf','DejaVuSans-Bold.ttf'].map(f=>Uint8Array.from(readFileSync(`public/fonts/${f}`)).buffer);
 const pdf=await pdfBytes(doc,fonts[0],fonts[1],load);assert.equal((await PDFDocument.load(pdf)).getPageCount(),1);
 const svg=slideSvg(doc.slides[0],doc.brand,0,1,doc.design,'',()=> 'data:image/png;base64,'+bytes.toString('base64'));assert.match(svg,/viewBox="100 0 100 100"/);
 assert.ok(doc.slides[0].canvas[0].kind==='image');doc.slides[0].canvas[0].frame!.sourceWidth=201;
 await assert.rejects(()=>buildPptx(doc,[],load),/Размер исходного/);await assert.rejects(()=>pdfBytes(doc,fonts[0],fonts[1],load),/Размер исходного/);
});

import {assertUprightImage} from '../lib/domain/image-orientation';
test('EXIF rotation cannot silently export a different image crop',()=>{
 const bytes=new ArrayBuffer(40),v=new DataView(bytes);v.setUint16(0,0xffd8);v.setUint16(2,0xffe1);v.setUint16(4,34);v.setUint32(6,0x45786966);v.setUint16(12,0x4949);v.setUint16(14,42,true);v.setUint32(16,8,true);v.setUint16(20,1,true);v.setUint16(22,0x112,true);v.setUint16(24,3,true);v.setUint32(26,1,true);v.setUint16(30,1,true);
 assert.doesNotThrow(()=>assertUprightImage(bytes,'image/jpeg'));
 for(const orientation of [2,3,4,5,6,7,8]){v.setUint16(30,orientation,true);assert.throws(()=>assertUprightImage(bytes,'image/jpeg'),/EXIF/);}
 assert.doesNotThrow(()=>assertUprightImage(bytes,'image/png'));
});

test('canvas handoff and owner copy remap image IDs and preserve normalized/original provenance',async()=>{
 const doc=demoDoc(),png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
 doc.slides=[blankSlide()];doc.slides[0].canvas=[{id:'picture',kind:'image',assetId:'normalized',x:100,y:100,w:400,h:400,frame:defaultImageFrame(1,1)}];
 const materials=[{id:'original',name:'Original.png',contentType:'image/png',base64:png,image:{width:1,height:1,normalizedSourceId:'normalized'}},{id:'normalized',name:'Normalized.png',contentType:'image/png',base64:png,image:{width:1,height:1,originalSourceId:'original'}}];
 const imported=await command(owner,{action:'create',doc,materials});const picture=imported.state.doc.slides[0].canvas![0];assert.ok(picture.kind==='image');assert.notEqual(picture.assetId,'normalized');
 const original=imported.state.sources.find(s=>s.name==='Original.png')!;assert.equal(original.image?.normalizedSourceId,picture.assetId);assert.equal(imported.state.sources.length,2);assert.equal(imported.state.sources.find(s=>s.id===picture.assetId)!.image?.originalSourceId,original.id);
 const copy=await command(owner,{action:'create',doc:imported.state.doc});const copied=copy.state.doc.slides[0].canvas![0];assert.ok(copied.kind==='image');assert.notEqual(copied.assetId,picture.assetId);assert.equal(copy.state.sources.length,2);assert.equal(copy.state.sources.find(s=>s.name==='Original.png')!.image?.normalizedSourceId,copied.assetId);
 await assert.rejects(command(other,{action:'create',doc:imported.state.doc}));
 await assert.rejects(command(owner,{action:'create',doc,materials:[materials[0]]}),/вариант|отсутствуют/);
});

import './data-object.test';

test('data object sources remain tenant-scoped and remap on import and owner copy',async()=>{
 const doc=demoDoc();doc.design='focus-v3';doc.slides=[blankSlide()];
 doc.slides[0].canvas=[{id:'chart',kind:'chart',x:100,y:400,w:1400,h:350,style:{design:'focus-v3',brand:doc.brand},data:{sourceId:'numbers',seriesId:'series',unit:'hours',rows:[{id:'research',label:'Research',value:25}]}}];
 const materials=[{id:'numbers',name:'Synthetic numbers.csv',contentType:'text/csv',base64:Buffer.from('department,hours\nResearch,25').toString('base64')}];
 const imported=await command(owner,{action:'create',doc,materials});const chart=imported.state.doc.slides[0].canvas![0];assert.ok(chart.kind==='chart');
 assert.notEqual(chart.data.sourceId,'numbers');assert.equal(chart.data.sourceId,imported.state.sources[0].id);
 const copy=await command(owner,{action:'create',doc:imported.state.doc});const copied=copy.state.doc.slides[0].canvas![0];assert.ok(copied.kind==='chart');
 assert.notEqual(copied.data.sourceId,chart.data.sourceId);assert.equal(copied.data.sourceId,copy.state.sources[0].id);
 assert.deepEqual(copied.data.rows,chart.data.rows);
 await assert.rejects(command(other,{action:'create',doc:imported.state.doc}));
 await assert.rejects(command(owner,{action:'create',doc,materials:[]}));
});

import './data-layout.test';

import {reviewObjects,reviewPreview} from '../lib/project/review-preview';
test('review presentation shows the actual remaining result, stable numbers and no accepted or rejected reapplication',()=>{
 const {state,p,c}=objectReviewFixture();
 state.doc.slides[0].canvas!.find(e=>e.id==='neighbor')!.x=340;
 decideProposalObjects(state,p.id,c.id,['title'],'accepted');
 state.doc.slides[0]=withCanvas(state.doc.slides[0],state.doc.slides[0].canvas!.map(e=>e.kind==='text'&&e.id==='title'?{...e,text:'Manual final title'}:e));
 const snapshot=structuredClone(state),preview=reviewPreview(c,state.doc.slides[0]);
 assert.equal(preview.conflicted,false);assert.equal(preview.before.title,'Manual final title');assert.equal(preview.after.title,'Manual final title');
 assert.equal(preview.after.canvas!.find(e=>e.id==='neighbor')!.x,340);
 assert.deepEqual(reviewObjects(c,state.doc.slides[0]).map(o=>[o.number,o.id,o.status]),[[1,'title','accepted'],[2,'body','pending']]);
 assert.deepEqual(state,snapshot);
 const other=objectReviewFixture();decideProposalObjects(other.state,other.p.id,other.c.id,['title'],'rejected');
 assert.equal(reviewPreview(other.c,other.state.doc.slides[0]).after.title,'title');
 assert.deepEqual(reviewObjects(other.c,other.state.doc.slides[0]).filter(o=>o.status==='pending').map(o=>o.number),[2]);
});
test('conflicted review explicitly uses historical pair while independent decisions remain available',()=>{
 const {state,c}=objectReviewFixture();state.doc.slides[0].canvas![1].x=500;
 const preview=reviewPreview(c,state.doc.slides[0]);
 assert.equal(preview.conflicted,true);assert.deepEqual(preview.before,c.before);assert.deepEqual(preview.after,c.after);
 assert.notDeepEqual(preview.before,state.doc.slides[0]);
 const items=reviewObjects(c,state.doc.slides[0]);assert.equal(items[0].conflict,'');assert.match(items[1].conflict,/Конфликт/);
 assert.equal(reviewPreview(c,undefined).conflicted,true);assert.ok(reviewObjects(c,undefined).every(o=>!!o.conflict));
});
test('review object list identifies removal, insertion and reorder without making grouped changes independently acceptable',()=>{
 const {state,before,c}=objectReviewFixture();
 c.after=withCanvas(before,[before.canvas![0],{id:'new',kind:'rect',x:100,y:600,w:100,h:100,color:'#123456'},before.canvas![2]]);
 const items=reviewObjects(c,state.doc.slides[0]);
 assert.deepEqual(items.map(o=>[o.id,o.reasons]),[['body',['Удаление']],['new',['Добавление']]]);
 assert.equal(items[0].after,undefined);assert.equal(items[1].before,undefined);
 assert.equal(reviewPreview(c,state.doc.slides[0]).conflicted,false);
 c.after=withCanvas(before,[before.canvas![1],before.canvas![0],before.canvas![2]]);
 const order=reviewObjects(c,state.doc.slides[0]);assert.deepEqual(order.map(o=>o.id),['title','body']);
 assert.ok(order.every(o=>!o.independent&&o.reasons.includes('Порядок слоёв')));
 c.after={...before,notes:'Changed notes'};assert.deepEqual(reviewObjects(c,state.doc.slides[0]),[]);
});
test('review labels distinguish text, geometry and native chart data; template previews do not invent object identities',()=>{
 const {state,c}=objectReviewFixture();
 assert.deepEqual(reviewObjects(c,state.doc.slides[0]).map(o=>o.reasons),[['Текст'],['Текст']]);
 const s=blankSlide();s.canvas=[{id:'chart',kind:'chart',x:100,y:400,w:1400,h:350,style:{design:'focus-v3',brand:state.doc.brand},data:{seriesId:'series',unit:'hours',rows:[{id:'row',label:'Work',value:25}]}}];
 const after=structuredClone(s);if(after.canvas![0].kind==='chart'){after.canvas![0].data.rows[0].value=42;after.canvas![0].w=1200;}
 const dataChange={...c,before:s,after};const item=reviewObjects(dataChange,s)[0];assert.equal(item.label,'Диаграмма');assert.deepEqual(item.reasons,['Размер','Данные']);
 const template=blankSlide(),next={...template,title:'New title'};const semantic={...c,before:template,after:next};
 assert.deepEqual(reviewObjects(semantic,template),[]);assert.equal(reviewPreview(semantic,template).after.title,'New title');
});

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProposalBoard} from '../components/proposal-board';
test('rendered review keeps markers opt-in, shows truthful conflict labels and keeps viewer decisions disabled',()=>{
 const {state,p,c}=objectReviewFixture();decideProposalObjects(state,p.id,c.id,['title'],'accepted');
 const deck={id:state.doc.id,owner:'owner',version:1,updatedAt:'',state,role:'owner' as const};
 const render=(role:'owner'|'viewer'='owner')=>renderToStaticMarkup(createElement(ProposalBoard,{deck:{...deck,role},disabled:false,onAction:()=>{throw Error('Rendering must not decide');}}));
 const html=render();assert.doesNotMatch(html,/aria-label="Правка [12]:/);assert.match(html,/<button[^>]*aria-pressed="false"[^>]*>Показать отметки<\/button>/);
 assert.match(html,/После принятия/);assert.match(html,/Отдельные правки/);assert.match(html,/Технические подробности/);
 const viewer=render('viewer');assert.match(viewer,/<button[^>]*disabled=""[^>]*>Принять № 2<\/button>/);
 state.doc.slides[0].canvas![1].x=500;
 const conflicted=render();assert.match(conflicted,/Исходное предложение/);assert.match(conflicted,/Посмотреть текущий слайд/);assert.doesNotMatch(conflicted,/После принятия/);
});

import "./focus-fact-rows.test";

test('Focus 3 short numeric reports keep readable data, policy and canvas conversion',()=>{
 const doc=validateDoc(focus3Seed.doc),base=blankSlide();
 const table={...base,id:'short-table',layout:'table' as const,title:'Работа по отделам',table:{columns:['Отдел','Обращения','Консультации','Внедрения'],columnRoles:['key','number','number','number'] as const,rows:[['Платформа','50','30','20'],['Данные','40','30','10'],['Сервисы','30','20','10']]}};
 const chart={...base,id:'short-chart',layout:'chart' as const,title:'Обращения по отделам',chart:[{label:'Платформа',value:50},{label:'Данные',value:40},{label:'Сервисы',value:30}],chartUnit:'обращений'};
 const slides=validateDoc({...doc,slides:[table,chart]}).slides;
 for(const s of slides){const before=structuredClone(s),rendered=scene(s,doc.brand,0,2,'focus-v3');assert.equal(rendered.overflow,false);assert.deepEqual(designReview({...doc,slides:[s]}).issues,[]);assert.deepEqual(s,before);const data=rendered.items.slice(rendered.dataRange!.start,rendered.dataRange!.end);
  const cells=data.filter(p=>p.kind==='text'&&p.editField?.match(/^(table:\d+:\d+|chart:\d+:)/));assert(cells.length>=6);assert(cells.every(p=>p.kind==='text'&&p.size>=24));
  const canvas=canvasFromScene(rendered);const after=scene({...s,canvas},doc.brand,0,2,'focus-v3');const visible=(r:typeof rendered)=>r.items.map(p=>p.kind==='text'?{kind:p.kind,text:p.text,x:p.x,y:Math.round(p.y*1000)/1000,size:p.size,bold:p.bold,font:p.font,color:p.color,tracking:p.tracking}:{kind:p.kind,x:p.x,y:p.y,w:p.w,h:p.h});assert.deepEqual(visible(after),visible(rendered));assert.equal(after.overflow,false);
 }
 // More rows and prose tables keep their existing recipe; the new mode is not a relaxed lint gate.
 const dense={...slides[0],table:{...slides[0].table!,rows:Array(6).fill(['Платформа','50','30','20'])}};assert.equal(focusV3Variant(dense),'auto');
 const prose={...slides[0],table:{...slides[0].table!,columnRoles:['key','text','number','number'] as ('key'|'text'|'number')[]}};assert.equal(focusV3Variant(prose),'auto');
 assert(designReview({...doc,slides:[{...base,title:'Пусто',layout:'content'}]}).issues.some(i=>i.message.includes('почти пуст')));
 const signed={...slides[1],chart:[{label:'Платформа',value:-50},{label:'Данные',value:0},{label:'Сервисы',value:30}]};assert.equal(scene(signed,doc.brand,0,1,'focus-v3').overflow,false);
});

test('existing unversioned Focus 3 data objects retain their original recipe',()=>{
 const doc=validateDoc(focus3Seed.doc);
 for(const s of [{...blankSlide(),layout:'chart' as const,title:'Обращения по отделам',chart:[{label:'Платформа',value:50},{label:'Данные',value:40},{label:'Сервисы',value:30}],chartUnit:'обращений'}, {...blankSlide(),layout:'table' as const,title:'Работа по отделам',table:{columns:['Отдел','Обращения'],columnRoles:['key','number'] as ('key'|'number')[],rows:[['Платформа','50'],['Данные','40'],['Сервисы','30']]}}]){
  const old=focusV3Scene(s,doc.brand,0,1,0,false),wrapped=attachDataObject(old,s,doc.brand,'focus-v3');const e=wrapped.dataObjects![0].element;delete e.style.layoutVersion;
  const after=scene({...s,canvas:canvasFromScene(wrapped)},doc.brand,0,1,'focus-v3');const visible=(r:typeof old|ReturnType<typeof scene>)=>r.items.map(p=>p.kind==='text'?{text:p.text,x:p.x,y:Math.round(p.y*1000)/1000,size:p.size,color:p.color}:{kind:p.kind,x:p.x,y:p.y,w:p.w,h:p.h});assert.deepEqual(visible(after),visible(old));
  assert.equal(scene(s,doc.brand,0,1,'focus-v3').dataObjects![0].element.style.layoutVersion,'focus-v3-data-2');
 }
});

test('neutral comparison removes correction marks without rewriting text or changing legacy slides',()=>{
 const doc=demoDoc(),s={...blankSlide('split'),title:'Сравним процессы',comparison:{before:{label:'Сейчас',text:'Поиск в разрозненных документах'},after:{label:'В пилоте',text:'Поиск в согласованном корпусе'}}};
 const legacy=scene(s,doc.brand,0,1,'focus-v3');
 const correction=scene({...s,comparison:{...s.comparison,mode:'correction'}},doc.brand,0,1,'focus-v3');
 const neutral=scene({...s,comparison:{...s.comparison,mode:'neutral'}},doc.brand,0,1,'focus-v3');
 assert.deepEqual(correction,legacy);
 assert(neutral.items.length<legacy.items.length);
 assert.deepEqual(neutral.items.filter(p=>p.kind==='text').map(p=>p.text),legacy.items.filter(p=>p.kind==='text').map(p=>p.text));
 assert.equal(neutral.overflow,false);
 assert.doesNotThrow(()=>validateDoc({...doc,design:'focus-v3',slides:[{...s,comparison:{...s.comparison,mode:'neutral'}}]}));
});

test('Focus 3 reports repeated rendered columns across content and steps as nonblocking advice',()=>{
 const doc=demoDoc();doc.design='focus-v3';doc.slides=Array.from({length:4},(_,i)=>({...blankSlide(i%2?'steps':'content'),title:'Порядок работы',body:'Подготовка\nСогласовать материалы и участников.\n\nПроверка\nПроверить результат с командой.'}));
 const before=structuredClone(doc),result=designReview(doc);assert.equal(result.composition?.advisories.length,1);assert.equal(result.composition?.assessedSlides,4);assert.equal(result.composition?.advisories[0].slideIds.length,4);assert(!result.issues.some(i=>i.message.includes('ради разнообразия')));assert.deepEqual(doc,before);
 assert.equal(designReview({...doc,slides:doc.slides.slice(0,3)}).composition?.advisories.length,0);
 const manual=structuredClone(doc);manual.slides[0].canvas=[];assert.equal(designReview(manual).composition?.assessedSlides,3);assert.equal(designReview(manual).composition?.advisories.length,0);
});
