import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { authorizeExternal } from "./external-auth.mjs";
import { configuration } from "./configure.mjs";
const env = {
  ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  ACCESS_AUD: "test-audience",
  LANKA_WORKER_TOKEN: "a-test-worker-token-with-32-characters-minimum",
  LANKA_WORKER_ID: "codex-pilot",
  LANKA_WORKER_EMAIL: "codex-pilot@agents.lanka.invalid",
};
const request = (
  path = "/api/mcp",
  name = "list_tasks",
  token = env.LANKA_WORKER_TOKEN,
) =>
  new Request(`https://slides.example.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "oai-authenticated-user-id": "forged-owner",
      "oai-authenticated-user-email": "owner@example.test",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
test("External worker identity replaces forged headers and is confined to task MCP", async () => {
  const valid = await authorizeExternal(request(), env);
  assert.equal(valid.worker, true);
  assert.equal(
    valid.request.headers.get("oai-authenticated-user-id"),
    "agent:codex-pilot",
  );
  assert.equal(valid.request.headers.get("authorization"), null);
  for (const name of [
    "publish",
    "approve",
    "create_deck",
    "propose_changes",
    "add_comment",
  ]) {
    assert.equal(
      (await authorizeExternal(request("/api/mcp", name), env)).status,
      403,
    );
  }
  assert.equal(
    (await authorizeExternal(request("/api/studio"), env)).status,
    403,
  );
  assert.equal(
    (await authorizeExternal(request("/api/assets"), env)).status,
    403,
  );
  assert.equal(
    (await authorizeExternal(request("/api/mcp", "list_tasks", "wrong"), env))
      .status,
    401,
  );
});
test("Cloudflare Access validates actual signatures, audience and expiry before trusting identity", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  async function jwt(aud = env.ACCESS_AUD, expiry = "2h") {
    return new SignJWT({ email: "Person@example.test" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("person-id")
      .setIssuer(env.ACCESS_TEAM_DOMAIN)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  }
  const req = (token) =>
    new Request("https://slides.example.test/", {
      headers: {
        "cf-access-jwt-assertion": token,
        "oai-authenticated-user-id": "forged-owner",
      },
    });
  const good = await authorizeExternal(req(await jwt()), env, {
    keyResolver: publicKey,
  });
  assert.equal(
    good.request.headers.get("oai-authenticated-user-id"),
    "cf:person-id",
  );
  assert.equal(
    good.request.headers.get("oai-authenticated-user-email"),
    "person@example.test",
  );
  for (const token of [
    await jwt("different-app"),
    await jwt(env.ACCESS_AUD, "-1h"),
    (await jwt()).slice(0, -8) + "corrupt",
  ]) {
    assert.equal(
      (await authorizeExternal(req(token), env, { keyResolver: publicKey }))
        .status,
      401,
    );
  }
  assert.equal(
    (
      await authorizeExternal(
        new Request("https://slides.example.test/", {
          headers: {
            "oai-authenticated-user-id": "forged",
            "oai-authenticated-user-email": "owner@test.invalid",
          },
        }),
        env,
      )
    ).status,
    401,
  );
});
test("External auth fails closed on missing config and oversized worker requests", async () => {
  assert.equal((await authorizeExternal(request(), {})).status, 503);
  const oversized = new Request("https://slides.example.test/api/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LANKA_WORKER_TOKEN}` },
    body: "x".repeat(850001),
  });
  assert.equal((await authorizeExternal(oversized, env)).status, 400);
});
test("Deployment configuration requires actual identifiers and has no public Worker bypass", () => {
  assert.throws(() => configuration({}), /Fill/);
  const c = configuration({
    cloudflare: {
      accountId: "a".repeat(32),
      workerName: "lanka-studio",
      hostname: "slides.example.test",
      d1DatabaseId: "12345678-1234-4234-8234-123456789abc",
      d1DatabaseName: "lanka-db",
      r2BucketName: "lanka-assets",
    },
    access: {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      workerId: env.LANKA_WORKER_ID,
      workerEmail: env.LANKA_WORKER_EMAIL,
    },
    fly: { appName: "lanka-agent", primaryRegion: "ams" },
  });
  assert.equal(c.wrangler.workers_dev, false);
  assert.equal(c.wrangler.preview_urls, false);
  assert.equal(c.wrangler.assets.run_worker_first, true);
  assert.equal(c.wrangler.vars.LANKA_WORKER_TOKEN, undefined);
  assert.match(c.fly, /worker = "node worker.mjs"/);
  assert.ok(!c.fly.includes("http_service"));
});
