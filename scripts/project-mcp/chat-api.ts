import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ChatDatabase } from "../../lib/adapters/postgres/chat-database";
import { ChatService } from "../../lib/agents/chat-service";
import { CodexChatConnection, LocalChatRunner } from "../../lib/agents/codex-chat";
import type { ProjectRepository } from "../../lib/project/repository";
import { materialPath } from "../../lib/project/package";
import {getSourceIntake,stageSourceIntake,listSourceIntakes,attachSourceIntake} from '../../lib/agents/source-intake';

import { localChatConfigSchema as configSchema } from "../../lib/agents/local-config";

export async function openLocalChat(workspaceRoot:string,path=resolve(import.meta.dirname,"../work/agent-chat/config.json")) {
  let config;
  try {config=configSchema.parse(JSON.parse(await readFile(path,"utf8")));}
  catch(e) {if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw new Error("Local chat configuration is invalid");}
  if(resolve(workspaceRoot)!==config.workspaceRoot)return null;
  const db=new ChatDatabase(config);await db.init();
  const service=new ChatService(db),connection=new CodexChatConnection(service,{...config,configPath:path,mcpCommand:process.execPath,mcpServerPath:resolve(import.meta.dirname,"server.mjs")}),runner=new LocalChatRunner(service,connection);
  runner.start();
  return {db,service,connection,runner,configPath:path,async close(){await runner.stop();await db.close();}};
}
export type LocalChat=NonNullable<Awaited<ReturnType<typeof openLocalChat>>>;

export async function chatApi(chat:LocalChat|null,req:IncomingMessage,res:ServerResponse,url:URL,readBody:()=>Promise<unknown>,getLegacy:(id:string)=>Promise<ProjectRepository>) {
  if(!url.pathname.startsWith("/api/v1/"))return false;
  const json=(value:unknown,status=200)=>{res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});res.end(JSON.stringify(value));};
  if(!chat) {json({available:false,enabled:false,status:"not_configured",name:"Агент",capabilities:{chat:false},message:"Чат ещё не настроен для этой установки."},503);return true;}
  const {db,service,connection,runner}=chat;
  if(url.pathname==='/api/v1/source-intakes'&&req.method==='POST'){json(await stageSourceIntake(db,await readBody()));return true;}
  if(url.pathname==='/api/v1/source-intakes'&&req.method==='GET'){json(await listSourceIntakes(db));return true;}
  const attach=url.pathname.match(/^\/api\/v1\/materials\/([a-f0-9-]{36})\/source-intakes$/)?.[1];
  if(attach&&req.method==='POST'){json(await attachSourceIntake(db,attach,await readBody()));return true;}
  const intake=url.pathname.match(/^\/api\/v1\/source-intakes\/([a-f0-9-]{36})(\/remove)?$/);
  if(intake&&req.method==='GET'&&!intake[2]){json(await getSourceIntake(db,intake[1]));return true;}
  if(intake&&req.method==='POST'&&intake[2]){await db.tx(c=>c.query('DELETE FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,intake[1]]));json({removed:true});return true;}
  const restart=url.pathname.match(/^\/api\/v1\/agent-sessions\/([a-f0-9-]{36})\/restart-context$/)?.[1];
  if(restart&&req.method==='POST'){json(await service.restartContext(restart,await readBody()));return true;}
  if(url.pathname==="/api/v1/agent-connections"&&req.method==="GET") {json({...await connection.probe(),usage:await service.usage()});return true;}
  const connectionAction=url.pathname.match(/^\/api\/v1\/agent-connections\/local-codex\/(connect|probe|login|cancel-login|disconnect|isolate)$/)?.[1];
  if(connectionAction&&req.method==="POST") {
    const connectionJson=async(value:unknown)=>json({...value as object,usage:await service.usage()});
    if(connectionAction==="connect")await connectionJson(await connection.connect());
    if(connectionAction==='isolate'){z.object({}).strict().parse(await readBody());await connectionJson(await connection.isolate());}
    if(connectionAction==="probe")await connectionJson(await connection.probe(true));
    if(connectionAction==="login")await connectionJson(await connection.login());
    if(connectionAction==="cancel-login"){await connection.cancelLogin();await connectionJson(await connection.probe(true));}
    if(connectionAction==="disconnect"){const state=await connection.disconnect();await runner.cancel();await connectionJson(state);}
    return true;
  }
  if(url.pathname==="/api/v1/presentations"&&req.method==="POST") {
    json(await service.startPresentation(await readBody()),202);void runner.pump();return true;
  }
  const retryCreation=url.pathname.match(/^\/api\/v1\/agent-sessions\/([a-f0-9-]{36})\/retry-creation$/)?.[1];
  if(retryCreation&&req.method==="POST") {
    const a=z.object({requestId:z.string().uuid()}).strict().parse(await readBody());
    json(await service.retryCreation(retryCreation,a.requestId),202);void runner.pump();return true;
  }
  const copy=url.pathname.match(/^\/api\/v1\/materials\/([a-f0-9-]{36})\/chat-copy$/)?.[1];
  if(copy&&req.method==="POST") {
    const a=z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive()}).strict().parse(await readBody());
    const source=await getLegacy(copy),p=await source.read();
    if(!p||p.state.revision!==a.expectedRevision)throw new Error("Исходная презентация изменилась.");
    const blobs=[];let size=0;
    for(const s of p.state.sources){const bytes=await source.readFile(materialPath(s.sha256));size+=bytes.length;if(size>40_000_000)throw new Error("Материалы превышают лимит.");blobs.push({hash:s.sha256,bytes});}
    const doc=structuredClone(p.state.doc);doc.id=a.requestId;doc.title=`${doc.title.slice(0,120)} · обсуждение`;
    json(await db.create(a.requestId,doc,null,p.state.sources,blobs,{action:"chat-copy",sourceId:copy,expectedRevision:a.expectedRevision}));return true;
  }
  const material=url.pathname.match(/^\/api\/v1\/materials\/([a-f0-9-]{36})\/agent-sessions$/)?.[1];
  if(material&&req.method==="POST") {json({sessionId:await db.ensureSession(material)});return true;}
  const route=url.pathname.match(/^\/api\/v1\/agent-sessions\/([a-f0-9-]{36})(?:\/(messages|events))?$/);
  if(route) {
    const [,id,action]=route;
    if(!action&&req.method==="GET"){const view=await service.view(id);json({...view,inputRequests:view.active?await runner.inputView(id):[]});return true;}
    if(action==="messages"&&req.method==="POST"){json(await service.enqueue(id,await readBody()),202);void runner.pump();return true;}
    if(action==="events"&&req.method==="GET") {
      let cursor=Number(req.headers["last-event-id"]||url.searchParams.get("after")||0);
      if(!Number.isSafeInteger(cursor)||cursor<0)throw new Error("Неверный cursor.");
      const snapshot=await service.view(id);
      if(cursor>snapshot.cursor)cursor=0;
      res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","Connection":"keep-alive","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"});res.setTimeout(0);res.flushHeaders();
      // HTTP/1.1 browsers share a small connection pool across all tabs. Bound each
      // stream so even older clients cannot occupy every slot indefinitely.
      res.write("retry: 1000\n\n");
      let busy=false,closed=false,lastWrite=Date.now();
      const lease=setTimeout(()=>{closed=true;clearInterval(timer);res.end();},10000);lease.unref();
      const timer=setInterval(async()=>{
        if(closed||busy)return;busy=true;
        try {
          const events=await service.events(id,cursor);
          if(closed)return;
          if(events.length){cursor=events.at(-1)!.sequence;res.write(`id: ${cursor}\nevent: update\ndata: ${JSON.stringify({cursor,kinds:events.map(e=>e.kind)})}\n\n`);lastWrite=Date.now();}
          else if(Date.now()-lastWrite>15000){res.write(": keep-alive\n\n");lastWrite=Date.now();}
        } catch {if(closed)return;closed=true;clearInterval(timer);res.write('event: unavailable\ndata: {}\n\n');res.end();}
        finally {busy=false;}
      },350);timer.unref();
      res.on("close",()=>{closed=true;clearInterval(timer);clearTimeout(lease);});return true;
    }
  }
  const inputRun=url.pathname.match(/^\/api\/v1\/agent-runs\/([a-f0-9-]{36})\/answer-input$/)?.[1];
  if(inputRun&&req.method==="POST") {
    const a=z.object({sessionId:z.string().uuid(),id:z.string().uuid(),answers:z.record(z.string().min(1).max(200),z.object({answers:z.array(z.string().max(16000)).length(1)}).strict())}).strict().parse(await readBody());
    json(await runner.answerInput(a.sessionId,inputRun,a.id,a.answers));return true;
  }
  const cancel=url.pathname.match(/^\/api\/v1\/agent-runs\/([a-f0-9-]{36})\/cancel$/)?.[1];
  if(cancel&&req.method==="POST") {
    const a=z.object({sessionId:z.string().uuid(),requestId:z.string().uuid()}).strict().parse(await readBody());
    json(await service.cancel(a.sessionId,cancel,a.requestId));await runner.cancel(cancel);return true;
  }
  json({error:"Операция недоступна."},404);return true;
}
