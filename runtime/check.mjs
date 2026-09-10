import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "./app-server.mjs";
const dir = await mkdtemp(join(tmpdir(), "lanka-codex-check-"));
const server = new CodexAppServer({ cwd: dir, codexHome: dir });
try {
  await server.initialize();
  if (process.env.OPENAI_API_KEY) await server.authenticate();
  const status = await server.request("account/read", { refreshToken: false });
  process.stdout.write(
    JSON.stringify({
      appServerReady: true,
      authenticated: Boolean(status.account),
      modelConfigured: Boolean(process.env.LANKA_CODEX_MODEL),
      gatewayConfigured: Boolean(
        process.env.LANKA_MCP_URL && process.env.LANKA_ACCESS_TOKEN,
      ),
    }) + "\n",
  );
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
