import {EditorUpgradeError} from '../../lib/project/editor-contract';
import {sourceDownload} from '../../lib/project/source-download';
import {PostgresMcpRepository} from '../../lib/adapters/postgres/mcp-repository';
import {uploadImage} from './image-upload';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ProjectStore } from "./store";
import { LibraryStore } from "./library";
import { humanCommand } from "./human";
import { renderProjectExport } from "./export";
import { materialPath } from "../../lib/project/package";
import { z } from "zod";
import { openLocalChat, chatApi } from "./chat-api";
import { LocalWorkspace } from "./workspace";
const mode = process.argv.includes("--workspace") ? "--workspace" : "--root";
const root = process.argv[process.argv.indexOf(mode) + 1];
if (!process.argv.includes(mode) || !root?.startsWith("/")) throw new Error("Pass --root or --workspace with an absolute directory");
const requestedPort = process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : 4317;
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Invalid port");
const library = mode === "--workspace" ? new LibraryStore(resolve(root)) : null;
const singleStore = library ? null : new ProjectStore(resolve(root));
if(library) await library.init(); else await singleStore!.checkRoot();
const chatConfig=process.argv.includes("--chat-config")?process.argv[process.argv.indexOf("--chat-config")+1]:undefined;
const chat=library?await openLocalChat(resolve(root),chatConfig):null;
const workspace=library?new LocalWorkspace(library,chat?.db):null;
const uiStyle = process.env.LANKA_UI_REFRESH === "1" ? "refresh" : "classic";
const session = randomBytes(32).toString("hex");
let origin = "";
let cookieName = "";
const staticFiles = new Map([
  ["/project.js", ["project.js", "text/javascript; charset=utf-8"]],
  ["/project.css", ["project.css", "text/css; charset=utf-8"]],
  ["/fonts/DejaVuSans.ttf", ["../public/fonts/DejaVuSans.ttf", "font/ttf"]],
  ["/fonts/DejaVuSans-Bold.ttf", ["../public/fonts/DejaVuSans-Bold.ttf", "font/ttf"]],
  ["/fonts/focus3-fonts.zip", ["focus3-fonts.zip", "application/zip"]],
  ["/fonts/IBMPlexSans-Regular.ttf", ["../public/fonts/IBMPlexSans-Regular.ttf", "font/ttf"]],
  ["/fonts/IBMPlexSans-SemiBold.ttf", ["../public/fonts/IBMPlexSans-SemiBold.ttf", "font/ttf"]],
  ["/fonts/IBMPlexMono-Medium.ttf", ["../public/fonts/IBMPlexMono-Medium.ttf", "font/ttf"]],
]);
function send(res: ServerResponse, code: number, type: string, data: string | Uint8Array) {
  res.writeHead(code, {"Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin"});
  res.end(data);
}
async function body(req: IncomingMessage,limit=1_500_000) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request exceeds limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server = createServer(async (req, res) => {
  try {
    if (!origin || req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
      send(res, 403, "text/plain", "Origin denied"); return;
    }
    const url = new URL(req.url || "/", origin);
    if(req.method==='GET'&&workspace&&/^\/documents\/[a-f0-9-]{36}$/.test(url.pathname)){
      const old=url.pathname.split('/')[2],actual=await workspace.resolveId(old);
      if(actual!==old){res.writeHead(302,{Location:`/documents/${actual}${url.search}`,'Cache-Control':'no-store'});res.end();return;}
    }
    if (req.method === "GET" && (url.pathname === "/" || (library && /^\/documents\/[a-f0-9-]{36}$/.test(url.pathname)))) {
      res.setHeader("Set-Cookie", `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      send(res, 200, "text/html; charset=utf-8", '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lanka — презентации</title><link rel="stylesheet" href="/project.css"></head><body data-ui="' + uiStyle + '" data-workspace="' + Boolean(library) + '"><div id="root"></div><script src="/project.js" defer></script></body></html>'); return;
    }
    if (!(req.headers.cookie || "").split("; ").includes(`${cookieName}=${session}`)) {
      if (url.pathname.startsWith("/api/")) send(res,403,"application/json",JSON.stringify({code:"LOCAL_SESSION_EXPIRED",error:"Соединение с локальным сервером обновилось. Восстановите подключение."}));
      else send(res, 403, "text/plain", "Open the project page first");
      return;
    }
    if (req.method === "GET" && staticFiles.has(url.pathname)) {
      const [path, type] = staticFiles.get(url.pathname)!;
      send(res, 200, type, await readFile(resolve(import.meta.dirname, path))); return;
    }
    if(url.pathname.startsWith("/api/v1/")) {
      if(req.method!=="GET"&&(req.method!=="POST"||req.headers.origin!==origin||!req.headers["content-type"]?.startsWith("application/json"))){send(res,403,"text/plain","Origin denied");return;}
      try {await chatApi(chat,req,res,url,()=>body(req,url.pathname==='/api/v1/source-intakes'?6_700_000:1_500_000),id=>workspace!.repository(id));}
      catch(e){const message=e instanceof z.ZodError?"Неверные поля запроса.":(e as Error).message;send(res,400,"application/json",JSON.stringify({error:/[А-Яа-яЁё]/.test(message)?message:"Не удалось выполнить действие. Проверьте подключение и повторите."}));}
      return;
    }
    if (library && url.pathname === "/api/library") {
      if(req.method === "GET") {send(res,200,"application/json",JSON.stringify(await workspace!.listing()));return;}
      if(req.method === "POST" && req.headers.origin === origin && req.headers["content-type"]?.startsWith("application/json")) {
        send(res,200,"application/json",JSON.stringify(await workspace!.mutate(await body(req))));return;
      }
    }
    if(workspace&&req.method==="GET"&&url.pathname==="/api/workspace-connection") {
      send(res,200,"application/json",JSON.stringify({command:process.execPath,args:[resolve(import.meta.dirname,"server.mjs"),"--workspace",root,...(chat?["--library-config",chat.configPath]:[]),"--editor-origin",origin]}));return;
    }

    const requestedDocumentId=url.searchParams.get("documentId") || new URL(req.headers.referer || origin).pathname.split("/")[2] || "";
    const documentId=workspace?await workspace.resolveId(requestedDocumentId):requestedDocumentId;
    const chatDocument=!!(chat&&await chat.db.owns(documentId));
    const store = chatDocument?chat!.db.repository(documentId):library?await library.project(documentId):singleStore!;
    if(req.method==='GET'&&url.pathname==='/api/export-artifacts'){
      const id=url.searchParams.get('artifactId');
      if(!id){send(res,200,'application/json',JSON.stringify(await store.listExportArtifacts(url.searchParams.get('cursor')??undefined)));return;}
      const manifest=await store.readExportManifest(id),part=url.searchParams.get('part')??'manifest';
      if(part==='manifest'){res.setHeader('Content-Disposition',`attachment; filename="export-v${manifest.revision}-manifest.json"`);send(res,200,'application/json',JSON.stringify(manifest,null,2));return;}
      if(part!=='file')throw Error('Неизвестная часть экспорта.');
      const bytes=await store.readExportArtifact(id);
      res.setHeader('Content-Disposition',`attachment; filename="presentation-v${manifest.revision}.${manifest.output.format}"`);
      res.setHeader('X-Lanka-Revision',String(manifest.revision));
      send(res,200,manifest.output.format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation',bytes);return;
    }
    if(req.method==="GET"&&url.pathname==="/api/exports"&&chatDocument) {
      const key=url.searchParams.get("key")||"",bytes=await chat!.db.repository(documentId).readExport(key);
      const name=key.split("/").at(-1)!;
      res.setHeader("Content-Disposition",`attachment; filename="${name}"`);
      send(res,200,name.endsWith(".pdf")?"application/pdf":name.endsWith(".pptx")?"application/vnd.openxmlformats-officedocument.presentationml.presentation":"application/json",bytes);return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const p=await store.read(), revision=Number(url.searchParams.get("revision"));
      if(revision) {
        const entry=p?.history?.find(h=>h.revision===revision);
        if(!entry)throw new Error("Версия недоступна");
        const doc=await store.readSnapshot(entry.hash);
        send(res,200,"application/json",JSON.stringify(url.searchParams.get('include')==='sources'?{doc,sourceSnapshot:await store.readRevisionSources(revision)}:doc));
      } else send(res,200,"application/json",JSON.stringify(p?.history || []));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/connection") {
      if(chatDocument){send(res,200,"application/json",JSON.stringify({command:process.execPath,args:[resolve(import.meta.dirname,"server.mjs"),"--library-config",chat!.configPath,"--document-id",documentId]}));return;}
      send(res,200,"application/json",JSON.stringify({command:process.execPath,args:[resolve(import.meta.dirname,"server.mjs"),"--root",store.root]}));return;
    }
    if (req.method === "GET" && url.pathname === "/api/project") {
      const p = await store.read();
      send(res, 200, "application/json", JSON.stringify(p ? {format: p.format, title: p.title, state: p.state,chatEnabled:chatDocument} : {empty: true})); return;
    }
    if(req.method === "GET" && url.pathname === "/api/sources") {
      const file=await sourceDownload(store,url.searchParams.get("id")??"");
      res.writeHead(200,file.headers);res.end(file.bytes);return;
    }
    if (req.method === "GET" && url.pathname === "/api/assets") {
      if(url.searchParams.has('revision')){
        if(!('readRevisionAsset' in store)||!store.readRevisionAsset)throw Error('Для этой версии нет проверяемого архива источников.');
        const asset=await store.readRevisionAsset(Number(url.searchParams.get('revision')),url.searchParams.get('id')??'');
        res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');send(res,200,asset.contentType,asset.bytes);return;
      }
      const p = await store.read();
      const source = p?.state.sources.find(s => s.id === url.searchParams.get("id") && s.kind === "image");
      if (!source || !["image/png", "image/jpeg"].includes(source.contentType)) throw new Error("Image is outside project");
      const bytes = await store.readFile(materialPath(source.sha256));
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Source hash mismatch");
      send(res, 200, source.contentType, bytes); return;
    }
    if (req.method === "POST" && req.headers.origin === origin && req.headers["content-type"]?.startsWith("application/json")) {
      if(url.pathname==="/api/images"){
        const writable=chatDocument?new PostgresMcpRepository(chat!.db,documentId):library?await library.project(documentId):singleStore!;
        send(res,200,"application/json",JSON.stringify(await uploadImage(writable,await body(req,7_000_000))));return;
      }
      if (url.pathname === "/api/project") {
        const input=await body(req);
        const result = await humanCommand(store, input,{requireEditorContract:true});
        send(res, 200, "application/json", JSON.stringify(result)); return;
      }
      if (url.pathname === "/api/export") {
        const a = z.object({deckId: z.string(), expectedRevision: z.number().int().positive(), format: z.enum(["pdf", "pptx"])}).strict().parse(await body(req));
        const p = await store.read();
        if (!p || p.state.doc.id !== a.deckId || p.state.revision !== a.expectedRevision) throw new Error("Конфликт версии экспорта.");
        const result = await renderProjectExport(store, p, a.format);
        res.setHeader("Content-Disposition", `attachment; filename="presentation.${a.format}"`);
        res.setHeader("X-Lanka-Revision", String(result.revision));
        res.setHeader('X-Lanka-Artifact',result.artifactId);
        send(res, 200, a.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation", result.bytes); return;
      }
    }
    send(res, 404, "text/plain", "Not found");
  } catch (e) {
    if(e instanceof EditorUpgradeError){send(res,426,"application/json",JSON.stringify({error:e.message,code:"EDITOR_UPGRADE_REQUIRED"}));return;}
    send(res, 400, "application/json", JSON.stringify({error: (e as Error).message}));
  }
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void chat?.close().finally(()=>process.exit(0));if(!chat)process.exit(0);});
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot bind project editor");
  origin = `http://127.0.0.1:${address.port}`;
  cookieName = `lanka_project_${address.port}`;
  process.stdout.write(`Lanka project editor: ${origin}\n`);
});
