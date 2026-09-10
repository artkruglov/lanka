#!/usr/bin/env node
/** JSON-RPC stdio -> authenticated Lanka HTTP MCP. Never log credentials/stdout diagnostics. */
import { createInterface } from "node:readline";
const endpoint = process.env.LANKA_MCP_URL;
const bearer = process.env.LANKA_ACCESS_TOKEN;
if (!endpoint || !bearer) {
  process.stderr.write(
    "Set LANKA_MCP_URL and LANKA_ACCESS_TOKEN using your approved authentication gateway.\n",
  );
  process.exit(1);
}
const url = new URL(endpoint);
if (url.protocol !== "https:" && url.hostname !== "localhost")
  throw new Error("HTTPS required");
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(60_000),
    });
    if (message.id === undefined) continue;
    if (!res.ok) throw new Error(`MCP gateway returned ${res.status}`);
    const body = await res.json();
    process.stdout.write(JSON.stringify(body) + "\n");
  } catch (e) {
    if (message?.id !== undefined)
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: e.message },
        }) + "\n",
      );
    else process.stderr.write("Notification transport failed.\n");
  }
}
