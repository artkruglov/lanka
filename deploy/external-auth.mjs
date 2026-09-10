import { createRemoteJWKSet, jwtVerify } from "jose";

const keysets = new Map();
const identityHeaders = [
  "oai-authenticated-user-id",
  "oai-authenticated-user-email",
  "oai-authenticated-user-full-name",
  "oai-authenticated-user-full-name-encoding",
];
export const workerToolNames = new Set([
  "list_tasks",
  "get_task",
  "claim_task",
  "task_heartbeat",
  "read_task_source",
  "report_task_extraction",
  "ask_task_questions",
  "submit_story_plan",
  "check_task_candidate",
  "submit_task_candidate",
  "fail_task",
]);
const denied = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
async function sameSecret(a, b) {
  if (!a || !b || a.length > 1000 || b.length < 32) return false;
  const hash = async (value) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [aa, bb] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
export async function boundedJson(req, max = 850_000) {
  if (!req.body) throw new Error("Missing body");
  const reader = req.body.getReader(),
    chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
export async function authorizeExternal(
  request,
  env,
  { verify = jwtVerify, keyResolver } = {},
) {
  const url = new URL(request.url),
    headers = new Headers(request.headers);
  for (const name of identityHeaders) headers.delete(name);
  let issuer;
  try {
    issuer = new URL(env.ACCESS_TEAM_DOMAIN);
    if (
      issuer.protocol !== "https:" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com") ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password
    )
      throw new Error();
  } catch {
    return denied(503, "External authentication is not configured");
  }
  if (!env.ACCESS_AUD)
    return denied(503, "External authentication is not configured");
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (bearer) {
    if (url.pathname !== "/api/mcp" || request.method !== "POST")
      return denied(403, "Worker credentials are restricted to task tools");
    if (!(await sameSecret(bearer, env.LANKA_WORKER_TOKEN)))
      return denied(401, "Invalid worker credential");
    if (!env.LANKA_WORKER_ID || !env.LANKA_WORKER_EMAIL?.includes("@"))
      return denied(503, "Worker identity is not configured");
    let rpc;
    try {
      rpc = await boundedJson(request.clone());
    } catch {
      return denied(400, "Invalid request");
    }
    const allowed =
      ["initialize", "notifications/initialized", "tools/list"].includes(
        rpc?.method,
      ) ||
      (rpc?.method === "tools/call" && workerToolNames.has(rpc.params?.name));
    if (!allowed || Array.isArray(rpc))
      return denied(403, "This tool is unavailable to the worker");
    headers.set("oai-authenticated-user-id", `agent:${env.LANKA_WORKER_ID}`);
    headers.set(
      "oai-authenticated-user-email",
      env.LANKA_WORKER_EMAIL.toLowerCase(),
    );
    headers.delete("authorization");
    return { request: new Request(request, { headers }), worker: true, rpc };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16000)
    return denied(401, "Sign in through Cloudflare Access");
  try {
    let resolver = keyResolver;
    if (!resolver) {
      resolver = keysets.get(issuer.origin);
      if (!resolver) {
        if (keysets.size > 8) keysets.clear();
        resolver = createRemoteJWKSet(
          new URL("/cdn-cgi/access/certs", issuer.origin),
          { timeoutDuration: 5000 },
        );
        keysets.set(issuer.origin, resolver);
      }
    }
    const { payload } = await verify(token, resolver, {
      issuer: issuer.origin,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "email", "exp", "iat"],
      clockTolerance: 5,
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.email !== "string" ||
      !payload.email.includes("@")
    )
      return denied(401, "Invalid user identity");
    headers.set("oai-authenticated-user-id", `cf:${payload.sub}`);
    headers.set("oai-authenticated-user-email", payload.email.toLowerCase());
    headers.delete("cf-access-jwt-assertion");
    headers.delete("cookie");
    return { request: new Request(request, { headers }), worker: false };
  } catch {
    return denied(401, "Invalid or expired Access identity");
  }
}
