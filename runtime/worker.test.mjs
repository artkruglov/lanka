import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTask } from "./worker.mjs";

async function harness(t, phase, outputs, checks = []) {
  const root = await mkdtemp(join(tmpdir(), "lanka-worker-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [],
    prompts = [],
    lifecycle = [];
  const task = {
    id: "task",
    version: 2,
    state: {
      status: "running",
      phase,
      input: { targetSlides: 3 },
      questions: [],
      extractions: [],
      snapshot: {
        doc: { id: "deck", title: "Brief", brief: {}, brand: {} },
        sources: [],
      },
      plan: { slides: [] },
    },
  };
  class Server {
    async initialize() {
      lifecycle.push("initialize");
    }
    async authenticate() {
      lifecycle.push("authenticate");
    }
    async start() {
      const id = `thread-${lifecycle.length}`;
      lifecycle.push(id);
      return { thread: { id } };
    }
    async turn(thread, prompt) {
      prompts.push({ thread, prompt });
      assert.ok(outputs.length, "unexpected extra model turn");
      return JSON.stringify(outputs.shift());
    }
    close() {
      lifecycle.push("closed");
    }
  }
  const client = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "claim_task") return { task, leaseToken: "lease" };
      if (name === "get_task") return { task };
      if (name === "check_task_candidate")
        return checks.shift() || { valid: true };
      return { task: { ...task, version: ++task.version } };
    },
  };
  return {
    root,
    calls,
    prompts,
    lifecycle,
    run: () =>
      processTask(
        client,
        { id: "task", version: 1 },
        { model: "test-model", workRoot: root, Server },
      ),
  };
}

test("Story phase authenticates Codex, submits questions and removes attempt files", async (t) => {
  const h = await harness(t, "story", [
    {
      kind: "questions",
      questions: [
        {
          id: "untrusted-model-id",
          text: "Which period?",
          reason: "Period changes the conclusion",
        },
      ],
    },
  ]);
  await h.run();
  assert.deepEqual(h.lifecycle.slice(0, 2), ["initialize", "authenticate"]);
  const asked = h.calls.find((c) => c.name === "ask_task_questions");
  assert.match(asked.args.questions[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(asked.args.leaseToken, "lease");
  assert.ok(!h.calls.some((c) => c.name.includes("accept")));
  assert.deepEqual(await readdir(h.root), []);
});

test("Composition repairs failed layout, uses a distinct critic thread and submits only candidate", async (t) => {
  const h = await harness(
    t,
    "compose",
    [
      { id: "bad" },
      { id: "repaired" },
      { summary: "Limitations recorded", blockingIssues: [] },
    ],
    [
      { valid: false, issues: ["overflow"], overflow: ["slide"] },
      { valid: true },
    ],
  );
  await h.run();
  const result = h.calls.find((c) => c.name === "submit_task_candidate");
  assert.equal(result.args.doc.id, "repaired");
  assert.equal(result.args.critique, "Limitations recorded");
  assert.match(h.prompts[1].prompt, /overflow/);
  assert.notEqual(h.prompts[1].thread, h.prompts[2].thread);
  assert.ok(!h.calls.some((c) => c.name.includes("accept")));
  assert.deepEqual(await readdir(h.root), []);
});

test("Blocking narrative critique exhausts the bounded repair budget without saving a candidate", async (t) => {
  const outputs = Array.from({ length: 3 }, () => [
    { id: "candidate" },
    { summary: "Unsupported conclusion", blockingIssues: ["Missing evidence"] },
  ]).flat();
  const h = await harness(t, "compose", outputs);
  await assert.rejects(h.run(), /repair budget/);
  assert.ok(h.calls.some((c) => c.name === "fail_task"));
  assert.ok(!h.calls.some((c) => c.name === "submit_task_candidate"));
  assert.deepEqual(await readdir(h.root), []);
});
