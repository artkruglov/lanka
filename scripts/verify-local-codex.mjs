/** Explicit live acceptance command. Uses the owner's installed, already signed-in Codex.
 * Production review-worker keeps its separate runtime/auth requirements.
 * No credentials are read by this script; auth is owned by App Server.
 */
import { CodexAppServer } from "../runtime/app-server.mjs";
import { ProjectReviewSession } from "../runtime/project-review.mjs";
import { ReviewCheckpoint } from "../runtime/review-checkpoint.mjs";
import { ProjectClient } from "./project-mcp/client.mjs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = resolve(
    "work/local-library/documents/7534ae80-b420-45e3-9933-83a56762a101",
  ),
  command = "/opt/homebrew/bin/codex",
  codexHome = process.env.CODEX_HOME || resolve(process.env.HOME, ".codex");
let server, checkpoint, client;
const checks = [];
try {
  server = new CodexAppServer({ cwd: root, codexHome, command });
  await server.initialize();
  const account = await server.request("account/read", { refreshToken: false });
  assert.equal(account.account?.type, "chatgpt");
  checks.push("managed ChatGPT account verified");
  const models = await server.request("model/list", {}),
    model = models.data.find((m) => m.isDefault)?.model;
  assert.ok(model);
  // Discover names without printing configuration values, then disable every configured MCP.
  const cfg = await server.request("config/read", { includeLayers: false });
  const mcpNames = Object.keys(cfg.config?.mcp_servers || {});
  assert.ok(mcpNames.every((n) => /^[a-zA-Z0-9_-]+$/.test(n)));
  server.close();
  function start() {
    return new CodexAppServer({
      cwd: root,
      codexHome,
      command,
      spawnProcess: (cmd, args, options) =>
        spawn(
          cmd,
          [
            ...mcpNames.flatMap((n) => [
              "-c",
              `mcp_servers.${n}.enabled=false`,
            ]),
            ...args,
          ],
          options,
        ),
    });
  }
  server = start();
  await server.initialize();
  let toolUse = false;
  server.on("notification", (m) => {
    if (
      m.method === "item/started" &&
      !["reasoning", "agentMessage", "userMessage"].includes(
        m.params?.item?.type,
      )
    )
      toolUse = true;
  });
  checkpoint = await ReviewCheckpoint.open({
    home: resolve("work/local-review-runtime"),
    root,
    deckId: "7534ae80-b420-45e3-9933-83a56762a101",
    model,
  });
  client = new ProjectClient(root);
  const before = await client.tool("get_project");
  const session = new ProjectReviewSession({
    client,
    server,
    root,
    model,
    checkpoint,
  });
  console.log("Running one real comment → proposal → reply turn.");
  const result = await session.reviewNext();
  assert.equal(result.idle, false);
  assert.ok(result.proposalId);
  assert.ok(checkpoint.data.threadId);
  assert.equal(toolUse, false);
  const after = await client.tool("get_project");
  assert.deepEqual(after.state.doc, before.state.doc);
  assert.ok(
    after.state.comments.some(
      (c) =>
        c.replyTo === result.commentId && c.proposalId === result.proposalId,
    ),
  );
  checks.push("real model proposal and reply; main document unchanged");
  const threadId = checkpoint.data.threadId;
  server.close();
  server = start();
  await server.initialize();
  const resumed = await server.resume(threadId, root, model);
  assert.equal(resumed.thread.id, threadId);
  checks.push("same persistent thread resumed after process restart");
  const controller = new AbortController();
  let started = false;
  const stop = (m) => {
    if (m.method === "turn/started" && m.params?.threadId === threadId) {
      started = true;
      controller.abort();
    }
  };
  server.on("notification", stop);
  await assert.rejects(
    server.turn(
      threadId,
      "Проверь формулировку замечания. Ответь коротким JSON. Не используй инструменты.",
      { signal: controller.signal },
    ),
    /interrupted/,
  );
  assert.equal(started, true);
  server.off("notification", stop);
  checks.push("live turn interrupted after server start notification");
  await new Promise((r) => setTimeout(r, 800));
  const interrupted = await server.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  assert.equal(interrupted.thread.turns.at(-1).status, "interrupted");
  checks.push("server confirms interrupted terminal status");
  const resumedSession = new ProjectReviewSession({
    client,
    server,
    root,
    model,
    checkpoint,
  });
  assert.deepEqual(await resumedSession.reviewNext(), { idle: true });
  const final = await client.tool("get_project");
  assert.equal(final.state.proposals.length, after.state.proposals.length);
  checks.push("review recovery does not duplicate an answered comment");
  await writeFile(
    "out/local-review/codex-live.json",
    JSON.stringify(
      { checks, model, threadId, proposalId: result.proposalId, toolUse },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, model, proposalId: result.proposalId }));
} finally {
  client?.close();
  server?.close();
  await checkpoint?.close();
}
