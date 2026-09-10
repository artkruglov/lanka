import application from "../dist/server/index.js";
import { authorizeExternal, workerToolNames } from "./external-auth.mjs";
import { taskTools } from "../lib/task-tools.ts";

/** External-only entry point. The private Sites deployment continues using its own dispatcher. */
export default {
  async fetch(request, env, ctx) {
    const result = await authorizeExternal(request, env);
    if (result instanceof Response) return result;
    if (result.worker && result.rpc.method === "tools/list")
      return Response.json({
        jsonrpc: "2.0",
        id: result.rpc.id,
        result: { tools: taskTools.filter((t) => workerToolNames.has(t.name)) },
      });
    const path = new URL(request.url).pathname;
    if (
      !result.worker &&
      request.method === "GET" &&
      (path.startsWith("/assets/") ||
        path.startsWith("/fonts/") ||
        path === "/favicon.ico" ||
        path === "/favicon.svg")
    )
      return env.ASSETS.fetch(result.request);
    return application.fetch(result.request, env, ctx);
  },
};
