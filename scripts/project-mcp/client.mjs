import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
export class ProjectClient {
  constructor(root) {
    this.n = 0;
    this.pending = new Map();
    this.child = spawn(
      process.execPath,
      [resolve(".project-runtime/server.mjs"), ...(typeof root==='string'?["--root",root]:root.workspaceRoot?["--workspace",root.workspaceRoot,...(root.configPath?["--library-config",root.configPath]:[]),...(root.editorOrigin?["--editor-origin",root.editorOrigin]:[])]:["--library-config",root.configPath,"--document-id",root.documentId,...(root.runId?["--run-id",root.runId,"--fence",String(root.fence)]:[])])],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.stderr = "";
    this.child.stderr.on("data", (b) => {
      this.stderr = (this.stderr + b).slice(-2000);
    });
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      const r = JSON.parse(line),
        p = this.pending.get(r.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(r.id);
        p.resolve(r);
      }
    });
    this.child.on("exit", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Project MCP stopped"));
      }
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP timeout"));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async tool(name, args = {}) {
    const r = await this.call("tools/call", { name, arguments: args });
    if (r.error) throw new Error(r.error.message);
    if (r.result.isError) throw new Error(r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  }
  close() {
    this.child.stdin.end();
    this.reader.close();
    this.child.kill();
  }
}
