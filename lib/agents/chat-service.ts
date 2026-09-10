import {agentUsage} from '../adapters/postgres/agent-usage';
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { commentInSelection } from "../domain/comment-anchor";
import { ChatDatabase, fingerprint, type DbTx } from "../adapters/postgres/chat-database";
import { chatInputSchema, runInputSchema, createPresentationSchema, editAnswerSchema, type ChatView, type ChatSelection } from "./contracts";
import { compileCommands } from "../domain/commands";
import { propose, validateReferences, type DeckDoc } from "../domain/model";

import { creationProfile } from "./creation-profile";
import { emptyDraft } from "../project/empty-draft";
import { composePresentation } from "./create-presentation";
import { assertEditDesign } from "./edit-design";
import { isSlideBackground } from "../domain/canvas-lock";

export type ClaimedRun = {
  id:string; sessionId:string; materialId:string; fence:number; mode:"discuss"|"edit"|"create";
  selection:ChatSelection; text:string; input:Record<string,unknown>; contextEpoch:number;
  nativeThreadId:string|null; model:string|null; inputHash:string;
};

export class ChatService {
  constructor(readonly db:ChatDatabase) {}
  async usage() {return this.db.tx(c=>this.usageIn(c));}
  private usageIn(c:DbTx) {return agentUsage(c,this.db.tenant,this.db.owner);}
  private async checkCapacity(c:DbTx) {
    const usage=await this.usageIn(c);
    if(!usage.remaining)throw Error(`Лимит Lanka: ${usage.limit} запусков в сутки. Использовано ${usage.used}, в очереди ${usage.queued}. Лимит обновится ${usage.resetsAt.slice(0,10)} в 00:00 UTC. Текст не отправлен.`);
  }
  async runtimeMode():Promise<'configured'|'dedicated'> {
    const r=await this.db.pool.query("SELECT runtime_mode FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2 AND id='local-codex'",[this.db.tenant,this.db.owner]);
    if(!r.rows[0])throw Error('Подключение недоступно.');
    return r.rows[0].runtime_mode;
  }
  async useDedicatedRuntime() {
    return this.db.tx(async c=>{
      const connection=await c.query("SELECT runtime_mode FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2 AND id='local-codex' FOR UPDATE",[this.db.tenant,this.db.owner]);
      if(!connection.rowCount)throw Error('Подключение недоступно.');
      if(connection.rows[0].runtime_mode==='dedicated')return false; // Lost response retry must not disconnect again.
      const active=await c.query("SELECT 1 FROM lanka.jobs j JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id WHERE j.tenant_id=$1 AND s.owner_id=$2 AND j.status IN ('queued','running','unknown')",[this.db.tenant,this.db.owner]);
      if(active.rowCount)throw Error('Дождитесь завершения или остановите поручения во всех своих презентациях перед сменой подключения.');
      await c.query("UPDATE lanka.agent_connections SET runtime_mode='dedicated',enabled=false,config_version=config_version+1 WHERE tenant_id=$1 AND owner_id=$2 AND id='local-codex'",[this.db.tenant,this.db.owner]);
      const sessions=await c.query("UPDATE lanka.agent_sessions SET context_epoch=context_epoch+1,native_thread_id=NULL,native_context_epoch=NULL,model=NULL WHERE tenant_id=$1 AND owner_id=$2 AND connection_id='local-codex' RETURNING id",[this.db.tenant,this.db.owner]);
      for(const s of sessions.rows)await this.db.event(c,s.id,null,'context.restarted',{reason:'dedicated_runtime'});
      return true;
    });
  }
  async enabled() {
    const r=await this.db.pool.query("SELECT enabled FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2 AND id='local-codex'",[this.db.tenant,this.db.owner]);return !!r.rows[0]?.enabled;
  }
  async setEnabled(enabled:boolean) {
    await this.db.tx(async c=>{
      await c.query("UPDATE lanka.agent_connections SET enabled=$3,config_version=config_version+1 WHERE tenant_id=$1 AND owner_id=$2 AND id='local-codex'",[this.db.tenant,this.db.owner,enabled]);
      if(!enabled) {
        const sessions=await c.query("SELECT id FROM lanka.agent_sessions WHERE tenant_id=$1 AND owner_id=$2 AND connection_id='local-codex'",[this.db.tenant,this.db.owner]);
        for(const s of sessions.rows) {
          const runs=await c.query("SELECT id FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running','unknown')",[this.db.tenant,s.id]);
          for(const run of runs.rows)await this.cancelIn(c,s.id,run.id,"Подключение отключено.");
        }
        await c.query("UPDATE lanka.agent_sessions SET context_epoch=context_epoch+1,native_thread_id=NULL,native_context_epoch=NULL WHERE tenant_id=$1 AND owner_id=$2 AND connection_id='local-codex'",[this.db.tenant,this.db.owner]);
      }
    });
  }
  async startPresentation(input: unknown) {
    const a=createPresentationSchema.parse(input),payload={action:"create_presentation",...a};
    const shell=await emptyDraft(a.requestId,"Новая презентация",a.profile||"focus-v2");
    shell.draftShell!.allowTitle=true;
    const blobs:{hash:string;bytes:Buffer}[]=[];
    if(a.material){
      const bytes=Buffer.from(a.material.text,'utf8'),sha256=createHash('sha256').update(bytes).digest('hex');
      shell.state.sources=[{id:randomUUID(),name:a.material.name,kind:'text',sha256,createdAt:new Date().toISOString(),contentType:'text/plain; charset=utf-8',excerpt:a.material.text}];
      shell.draftShell!.sourceHash=fingerprint(shell.state.sources);
      blobs.push({hash:sha256,bytes});
    }
    return this.db.tx(async c=>{
      const prior=await this.db.receipt(c,a.requestId,a.requestId,payload);if(prior)return prior.result;
      if(a.sourceIntakeId){
        const {adoptSourceIntake}=await import('./source-intake');
        await adoptSourceIntake(this.db,c,a.sourceIntakeId,shell,blobs);
      }
      const doc=shell.state.doc;
      await this.db.createProjectIn(c,randomUUID(),shell,a.folderId,blobs,{action:"creation_shell",id:doc.id},{id:doc.id,revision:1});
      const sessionId=await this.db.ensureSessionIn(c,doc.id);
      const run=await this.enqueueIn(c,sessionId,{requestId:randomUUID(),text:a.prompt,mode:"create",expectedRevision:1,selection:{slideId:doc.slides[0].id,field:null,scope:"document"}});
      const result={id:doc.id,...run};
      await this.db.remember(c,a.requestId,doc.id,payload,result);return result;
    });
  }
  async enqueue(sessionId:string,input:unknown) {
    const a=chatInputSchema.parse(input);
    return this.db.tx(async c=>{
      if(!a.creationQuestionId)return this.enqueueIn(c,sessionId,a);
      const s=await this.db.session(c,sessionId);
      if(a.mode!=='edit'||a.selection.scope!=='document')throw Error('Ответ продолжает создание всей презентации.');
      const next={...a,mode:'create' as const};
      const prior=await this.db.receipt(c,a.requestId,s.material_id,{sessionId,...next});if(prior)return prior.result;
      const question=await this.creationQuestion(c,sessionId);
      if(!question||question.id!==a.creationQuestionId)throw Error('Вопрос уже обработан. Обновите чат; текст ответа сохранён.');
      const result=await this.enqueueIn(c,sessionId,next);
      await this.db.event(c,sessionId,null,'creation.answer',{questionId:question.id,messageId:result.messageId});
      return result;
    });
  }
  async retryCreation(sessionId:string,requestId:string) {
    return this.db.tx(async c=>{
      const s=await this.db.session(c,sessionId);
      const last=await c.query("SELECT text,selection FROM lanka.agent_messages WHERE tenant_id=$1 AND session_id=$2 AND mode='create' AND role='user' ORDER BY sequence DESC LIMIT 1",[this.db.tenant,sessionId]);
      if(!last.rows[0])throw new Error("Поручение создания не найдено.");
      const input={requestId,text:last.rows[0].text,mode:"create",expectedRevision:1,selection:last.rows[0].selection};
      const prior=await this.db.receipt(c,requestId,s.material_id,{sessionId,...input});if(prior)return prior.result;
      if(await this.creationQuestion(c,sessionId))throw Error('Ответьте на вопрос агента, чтобы продолжить создание.');
      return this.enqueueIn(c,sessionId,input);
    });
  }
  async restartContext(sessionId:string,input:unknown) {
    const a=z.object({requestId:z.string().uuid(),failedRunId:z.string().uuid()}).strict().parse(input);
    return this.db.tx(async c=>{
      const s=await this.db.session(c,sessionId),payload={action:'restart_context',sessionId,...a};
      const prior=await this.db.receipt(c,a.requestId,s.material_id,payload);if(prior)return prior.result;
      const pending=await c.query("SELECT 1 FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2 AND status IN ('queued','running','unknown')",[this.db.tenant,sessionId]);
      if(pending.rowCount)throw Error('Дождитесь завершения или остановите текущее поручение.');
      const last=await c.query("SELECT r.id,r.error_code,r.context_epoch FROM lanka.agent_runs r JOIN lanka.agent_messages m ON m.tenant_id=r.tenant_id AND m.id=r.user_message_id WHERE r.tenant_id=$1 AND r.session_id=$2 ORDER BY m.sequence DESC LIMIT 1",[this.db.tenant,sessionId]);
      const r=last.rows[0];
      if(!r||r.id!==a.failedRunId||r.error_code!=='NATIVE_THREAD_IN_USE'||r.context_epoch!==s.context_epoch)throw Error('Состояние беседы изменилось. Обновите чат перед восстановлением.');
      await c.query("UPDATE lanka.agent_sessions SET context_epoch=context_epoch+1,native_thread_id=NULL,native_context_epoch=NULL WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.db.tenant,this.db.owner,sessionId]);
      await this.db.event(c,sessionId,null,'context.restarted',{previousNativeThreadId:s.native_thread_id,failedRunId:r.id});
      const result={sessionId,restarted:true};await this.db.remember(c,a.requestId,s.material_id,payload,result);return result;
    });
  }
  private async enqueueIn(c:DbTx,sessionId:string,input:unknown) {
    const a=runInputSchema.parse(input);
      const s=await this.db.session(c,sessionId),p=await this.db.project(c,s.material_id);
      const prior=await this.db.receipt(c,a.requestId,s.material_id,{sessionId,...a});if(prior)return prior.result;
      await this.checkCapacity(c);
      const connection=await c.query("SELECT enabled FROM lanka.agent_connections WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.db.tenant,this.db.owner,s.connection_id]);
      if(!connection.rows[0]?.enabled)throw new Error("Подключите агента перед отправкой.");
      if(a.expectedRevision!==p.state.revision)throw new Error("Презентация изменилась. Обновите сохранённую версию перед отправкой.");
      const slide=p.state.doc.slides.find(v=>v.id===a.selection.slideId);
      if(!slide)throw new Error("Выбранный слайд недоступен.");
      if(a.selection.elementId) {
        const object=slide.canvas?.find(e=>e.id===a.selection.elementId);
        if(!object)throw new Error("Выбранный объект недоступен. Выберите объект заново; область поручения не расширена.");
        const editableBackground=slide.canvas?.[0]===object&&isSlideBackground(object);
        if(a.mode==="edit"&&object.locked&&!editableBackground)throw new Error("Выбранный объект заблокирован.");
      }
      if(a.mode==="create"&&(p.state.revision!==1||p.state.doc.slides.length!==1||slide.body||slide.notes||slide.metrics.length||slide.chart.length||slide.table||slide.assetId||(p.draftShell?.sourceHash?p.draftShell.sourceHash!==fingerprint(p.state.sources):p.state.sources.length>0)||p.state.proposals.length||p.state.comments.length||p.state.approvedRevision!==null))throw new Error("Создание доступно только в новом пустом черновике. Существующие правки сохранены.");
      const unresolved=await c.query("SELECT 1 FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2 AND status='unknown'",[this.db.tenant,sessionId]);
      if(unresolved.rowCount)throw new Error("Остановите прерванное поручение перед продолжением беседы.");
      const count=await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status IN ('queued','running'))::int AS pending FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2",[this.db.tenant,sessionId]);
      if(a.mode==="create"&&count.rows[0].pending>0)throw new Error("Создание уже в очереди. Дождитесь результата или остановите поручение.");
      if(count.rows[0].total>=100||count.rows[0].pending>=5)throw new Error("Достигнут лимит беседы или очереди.");
      const slides=a.selection.scope==="document"?p.state.doc.slides:[slide];
      const slideIds=new Set(slides.map(v=>v.id));
      const sourceIds=new Set(slides.flatMap(v=>[...v.sourceIds,...v.metrics.map(m=>m.sourceId).filter(Boolean),...(v.table?.sourceId?[v.table.sourceId]:[]),...(v.assetId?[v.assetId]:[]),...(v.canvas?.flatMap(e=>e.kind==="image"?[e.assetId]:(e.kind==="chart"||e.kind==="table")&&e.data.sourceId?[e.data.sourceId]:[])??[])]));
      const manifest={documentId:p.state.doc.id,revision:p.state.revision,title:p.state.doc.title,brief:p.state.doc.brief,selection:a.selection,slide,
        ...(a.selection.scope==="document"?{slides}:{}),...(a.mode==="create"?{document:p.state.doc}:{}),
        conversation:{messagesBefore:Number(s.next_message_seq),tool:'read_conversation'},
        design:{id:p.state.doc.design,brand:p.state.doc.brand},
        ...((a.mode==="create"||a.mode==="edit")&&(p.state.doc.design==="focus-v2"||p.state.doc.design==="focus-v3")?{designProfile:{...await creationProfile(p.state.doc.design),brand:p.state.doc.brand}}:{}),
        comments:p.state.comments.filter(v=>slideIds.has(v.slideId)&&!v.resolved&&commentInSelection(v,a.selection)).map(v=>({id:v.id,slideId:v.slideId,text:v.text,replyTo:v.replyTo||null,...(v.anchor?{anchor:v.anchor}:{})})),
        outline:p.state.doc.slides.map(v=>({id:v.id,title:v.title})),sources:p.state.sources.filter(v=>a.mode==="create"||a.selection.scope==="document"||sourceIds.has(v.id)).map(v=>({id:v.id,name:v.name,sha256:v.sha256,excerpt:v.excerpt,...(v.extraction?{extraction:v.extraction}:{})})),mode:a.mode};
      if(JSON.stringify(manifest).length>60000)throw new Error("Контекст слишком большой для этого подключения. Выберите отдельный слайд; содержание не обрезано.");
      const runId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),seq=Number(s.next_message_seq);
      await c.query("UPDATE lanka.agent_sessions SET next_message_seq=next_message_seq+2 WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.db.tenant,this.db.owner,sessionId]);
      for(const [id,role,text,status,sequence] of [[userId,"user",a.text,"complete",seq+1],[assistantId,"assistant","","streaming",seq+2]]) {
        await c.query("INSERT INTO lanka.agent_messages(tenant_id,id,session_id,sequence,role,text,status,mode,selection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[this.db.tenant,id,sessionId,sequence,role,text,status,a.mode,JSON.stringify(a.selection)]);
      }
      await c.query("INSERT INTO lanka.jobs(tenant_id,id,session_id,status) VALUES($1,$2,$3,'queued')",[this.db.tenant,runId,sessionId]);
      await c.query("INSERT INTO lanka.agent_runs(tenant_id,id,session_id,material_id,user_message_id,assistant_message_id,base_revision,input_manifest,input_hash,context_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[this.db.tenant,runId,sessionId,s.material_id,userId,assistantId,p.state.revision,JSON.stringify(manifest),fingerprint(manifest),s.context_epoch]);
      await this.db.event(c,sessionId,runId,"run.queued",{messageId:userId,mode:a.mode,selection:a.selection});
      const result={sessionId,runId,messageId:userId};await this.db.remember(c,a.requestId,s.material_id,{sessionId,...a},result);return result;
  }
  private async creationQuestion(c:DbTx,sessionId:string) {
    const q=await c.query(`SELECT e.payload FROM lanka.agent_events e JOIN lanka.jobs j ON j.tenant_id=e.tenant_id AND j.id=e.run_id
      WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.kind='creation.question' AND j.status='completed'
      AND NOT EXISTS(SELECT 1 FROM lanka.agent_events a WHERE a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.kind='creation.answer' AND a.payload->>'questionId'=e.payload->>'id')
      ORDER BY e.sequence DESC LIMIT 1`,[this.db.tenant,sessionId]);
    return q.rows[0]?.payload as {id:string;question:string}|undefined;
  }
  async view(sessionId:string):Promise<ChatView> {
    return this.db.tx(async c=>{
      const s=await this.db.session(c,sessionId);
      const messages=await c.query("SELECT * FROM lanka.agent_messages WHERE tenant_id=$1 AND session_id=$2 ORDER BY sequence",[this.db.tenant,sessionId]);
      const jobs=await c.query("SELECT j.id,j.status,r.interrupt_acknowledged,m.mode FROM lanka.jobs j JOIN lanka.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.id JOIN lanka.agent_messages m ON m.tenant_id=r.tenant_id AND m.id=r.user_message_id WHERE j.tenant_id=$1 AND j.session_id=$2 AND j.status IN ('running','queued','unknown') ORDER BY m.sequence",[this.db.tenant,sessionId]);
      const active=jobs.rows.find(r=>r.status!=="queued")||jobs.rows[0];
      const latest=await c.query("SELECT r.id,r.error_code,r.context_epoch FROM lanka.agent_runs r JOIN lanka.agent_messages m ON m.tenant_id=r.tenant_id AND m.id=r.user_message_id WHERE r.tenant_id=$1 AND r.session_id=$2 ORDER BY m.sequence DESC LIMIT 1",[this.db.tenant,sessionId]);
      const failed=latest.rows[0],recovery=!active&&failed?.error_code==='NATIVE_THREAD_IN_USE'&&failed.context_epoch===s.context_epoch?{failedRunId:failed.id}:undefined;
      const restarted=await c.query("SELECT created_at FROM lanka.agent_events WHERE tenant_id=$1 AND session_id=$2 AND kind='context.restarted' ORDER BY sequence DESC LIMIT 1",[this.db.tenant,sessionId]);
      const progress=active?await c.query("SELECT kind,payload FROM lanka.agent_events WHERE tenant_id=$1 AND run_id=$2 AND kind IN ('tool.started','tool.completed','proposal.ready','document.created') ORDER BY sequence DESC LIMIT 1",[this.db.tenant,active.id]):null;
      const last=progress?.rows[0];
      const names:Record<string,string>={propose_brief:"Предлагает уточнить замысел",get_project:"Читает презентацию",get_authoring_guide:"Изучает правила",get_design_profile:"Изучает шаблон",get_story:"Читает сценарий",get_briefing_questions:"Проверяет бриф",lint_deck:"Проверяет содержание",render_slides:"Проверяет вид слайдов",suggest_data_size:"Подбирает размер объекта",list_exports:"Читает готовые файлы",get_export_artifact:"Проверяет версию файла",populate_draft:"Сохраняет презентацию",propose_commands:"Готовит предложение",propose_changes:"Готовит предложение",reply_to_feedback:"Отвечает на замечание"};
      const activity=last?.kind==="proposal.ready"?"Предложение сохранено · проверяет результат":last?.kind==="document.created"?"Презентация сохранена · проверяет результат":last?names[last.payload.name]:undefined;
      const creationQuestion=await this.creationQuestion(c,sessionId);
      return {sessionId,...(creationQuestion?{creationQuestion}:{}),...(recovery?{recovery}:{}),...(restarted.rows[0]?{contextRestartedAt:restarted.rows[0].created_at.toISOString()}:{}),messages:messages.rows.map(m=>({id:m.id,role:m.role,text:m.text,status:m.status,mode:m.mode,selection:m.selection,proposalId:m.proposal_id,createdAt:m.created_at.toISOString()})),cursor:Number(s.next_event_seq),active:active?{id:active.id,status:active.status,mode:active.mode,interruptAcknowledged:active.interrupt_acknowledged,...(activity?{activity}:{})}:null,queued:jobs.rows.filter(r=>r.status==="queued").length};
    });
  }
  async events(sessionId:string,after:number) {
    await this.db.session(this.db.pool,sessionId);
    const r=await this.db.pool.query("SELECT sequence,kind,payload,run_id FROM lanka.agent_events WHERE tenant_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 200",[this.db.tenant,sessionId,after]);
    return r.rows.map(r=>({sequence:Number(r.sequence),kind:r.kind,payload:r.payload,runId:r.run_id}));
  }
  async claim():Promise<ClaimedRun|null> {
    return this.db.tx(async c=>{
      const r=await c.query(`SELECT r.*,j.fence,m.mode,m.selection,m.text,s.native_thread_id,s.model,s.context_epoch AS session_epoch,s.native_context_epoch
        FROM lanka.jobs j JOIN lanka.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.id
        JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id
        JOIN lanka.materials d ON d.tenant_id=s.tenant_id AND d.id=s.material_id
        JOIN lanka.agent_messages m ON m.tenant_id=r.tenant_id AND m.id=r.user_message_id
        JOIN lanka.agent_connections a ON a.tenant_id=s.tenant_id AND a.owner_id=s.owner_id AND a.id=s.connection_id
        WHERE j.tenant_id=$1 AND s.owner_id=$2 AND s.connection_id='local-codex' AND s.scope_kind='material' AND j.status='queued' AND a.enabled AND NOT d.trashed
        AND NOT EXISTS(SELECT 1 FROM lanka.jobs other WHERE other.tenant_id=j.tenant_id AND other.session_id=j.session_id AND other.status IN ('running','unknown'))
        ORDER BY j.created_at,m.sequence LIMIT 1 FOR UPDATE OF j`,[this.db.tenant,this.db.owner]);
      const run=r.rows[0];if(!run)return null;
      if(run.context_epoch!==run.session_epoch) {await this.cancelIn(c,run.session_id,run.id,"Контекст подключения изменился.");return null;}
      const usage=await this.usageIn(c);
      if(usage.used>=usage.limit) {await this.cancelIn(c,run.session_id,run.id,"На сегодня достигнут лимит 20 запусков агента.");return null;}
      await c.query("UPDATE lanka.jobs SET status='running',fence=fence+1,lease_until=now()+interval '45 seconds',deadline_at=now()+interval '4 minutes',updated_at=now() WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id]);
      await this.db.event(c,run.session_id,run.id,"run.started",{mode:run.mode});
      return {id:run.id,sessionId:run.session_id,materialId:run.material_id,fence:run.fence+1,mode:run.mode,selection:run.selection,text:run.text,input:run.input_manifest,inputHash:run.input_hash,contextEpoch:run.context_epoch,nativeThreadId:run.native_context_epoch===run.session_epoch?run.native_thread_id:null,model:run.model};
    });
  }
  private async live(c:DbTx,run:ClaimedRun) {
    await this.db.session(c,run.sessionId);
    const r=await c.query(`SELECT r.* FROM lanka.agent_runs r JOIN lanka.jobs j ON j.tenant_id=r.tenant_id AND j.id=r.id
      JOIN lanka.agent_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
      JOIN lanka.agent_connections a ON a.tenant_id=s.tenant_id AND a.owner_id=s.owner_id AND a.id=s.connection_id
      WHERE r.tenant_id=$1 AND s.owner_id=$2 AND r.id=$3 AND r.session_id=$4 AND j.status='running' AND j.fence=$5
      AND j.lease_until>clock_timestamp() AND j.deadline_at>clock_timestamp() AND r.context_epoch=s.context_epoch AND a.enabled FOR UPDATE OF j`,[this.db.tenant,this.db.owner,run.id,run.sessionId,run.fence]);
    if(!r.rows[0])throw new Error("RUN_FENCED");return r.rows[0];
  }
  async authorizeInput(run:ClaimedRun) {
    await this.db.tx(async c=>{await this.live(c,run);});
  }
  async heartbeat(run:ClaimedRun) {
    await this.db.tx(async c=>{await this.live(c,run);await c.query("UPDATE lanka.jobs SET lease_until=LEAST(now()+interval '45 seconds',deadline_at),updated_at=now() WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id]);});
  }
  async native(run:ClaimedRun,threadId:string,model:string,turnId?:string) {
    if(!threadId||threadId.length>200||model.length>200||(turnId&&turnId.length>200))throw new Error("Неверная сессия исполнителя.");
    await this.db.tx(async c=>{
      await this.live(c,run);
      await c.query("UPDATE lanka.agent_sessions SET native_thread_id=$4,native_context_epoch=context_epoch,model=$5 WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.db.tenant,this.db.owner,run.sessionId,threadId,model]);
      if(turnId)await c.query("UPDATE lanka.agent_runs SET native_turn_id=$3 WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id,turnId]);
    });
  }
  async append(run:ClaimedRun,delta:string) {
    if(!delta)return;
    await this.db.tx(async c=>{
      const r=await this.live(c,run);
      const updated=await c.query("UPDATE lanka.agent_messages SET text=text||$3 WHERE tenant_id=$1 AND id=$2 AND length(text)+length($3)<=20000 RETURNING id",[this.db.tenant,r.assistant_message_id,delta]);
      if(!updated.rowCount)throw new Error("Ответ слишком длинный.");
      await this.db.event(c,run.sessionId,run.id,"message.delta",{messageId:r.assistant_message_id,delta});
    });
  }
  async complete(run:ClaimedRun,raw:string, beforeCommit?:()=>void) {
    if(!raw.trim()||raw.length>60000)throw new Error("Агент не вернул подходящий ответ.");
    let reply=raw,edit:null|ReturnType<typeof editAnswerSchema.parse>=null;
    if(run.mode==="edit") {
      if(run.selection.elementId)throw new Error("Редактирование объекта требует native MCP; старый JSON-исполнитель не поддерживает эту область.");
      edit=editAnswerSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*/,"").replace(/\s*```$/, "")));reply=edit.reply;
      const fieldOp={title:"set_title",body:"set_body",takeaway:"set_takeaway"};
      const allowedSlides=run.selection.scope==="document"
        ?new Set((run.input.slides as {id:string}[]).map(v=>v.id))
        :new Set([run.selection.slideId]);
      if(edit.commands.some(op=>!allowedSlides.has(op.slideId)||(run.selection.field&&op.op!==fieldOp[run.selection.field])))throw new Error("Агент попытался изменить другую область.");
    }
    const created=run.mode==="create"?composePresentation(run.input.document as DeckDoc,raw):null;
    if(created)reply=created.reply;
    return this.db.tx(async c=>{
      await this.db.session(c,run.sessionId);
      const receiptPayload={operation:"complete_run",runId:run.id,fence:run.fence,outputHash:fingerprint(raw)};
      const prior=await this.db.receipt(c,run.id,run.materialId,receiptPayload);if(prior)return prior.result;
      const r=await this.live(c,run),p=await this.db.project(c,run.materialId,true);
      let proposalId:string|null=null;
      if(created) {
        if(p.state.revision!==r.base_revision||fingerprint(p.state.doc)!==fingerprint(run.input.document)||p.state.comments.length||p.state.proposals.length||(p.draftShell?.sourceHash?p.draftShell.sourceHash!==fingerprint(p.state.sources):p.state.sources.length>0)||p.state.approvedRevision!==null)throw new Error("Исходная версия изменилась. Сохранённые ручные правки защищены; создайте новую презентацию.");
        p.state.doc=created.doc;p.title=created.doc.title;p.state.revision++;delete p.draftShell;
        await this.db.saveProject(c,run.materialId,p,"Агент создал черновик");
        await this.db.event(c,run.sessionId,run.id,"document.created",{revision:p.state.revision,slideCount:created.doc.slides.length,issues:created.checks.issues});
      }
      if(edit?.commands.length) {
        if(p.state.revision!==r.base_revision)throw new Error("Исходная версия изменилась. Сохранённые ручные правки защищены; повторите поручение на новой версии.");
        const changes=compileCommands(p.state.doc,edit.commands);
        assertEditDesign(p.state.doc,changes);
        const proposal=propose(p.state,changes,edit.title,"Агент Codex");
        if(p.state.proposals.filter(v=>v.status==="pending").length>=12)throw new Error("Сначала обработайте ожидающие предложения.");
        p.state.proposals.push(proposal);proposalId=proposal.id;validateReferences(p.state);
        await this.db.saveProject(c,run.materialId,p,"Предложены изменения");
      }
      await c.query("UPDATE lanka.agent_messages SET text=$3,status='complete',proposal_id=$4 WHERE tenant_id=$1 AND id=$2",[this.db.tenant,r.assistant_message_id,reply,proposalId]);
      await c.query("UPDATE lanka.jobs SET status='completed',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id]);
      await this.db.event(c,run.sessionId,run.id,"message.completed",{messageId:r.assistant_message_id,proposalId});
      if(proposalId)await this.db.event(c,run.sessionId,run.id,"proposal.ready",{proposalId,slideId:edit!.commands[0].slideId,scope:run.selection.scope||"slide"});
      await this.db.event(c,run.sessionId,run.id,"run.completed",{});
      const result={proposalId};await this.db.remember(c,run.id,run.materialId,receiptPayload,result);
      beforeCommit?.();return result;
    });
  }
  /** MCP already committed its effect. Finalization only records the answer/status;
   * it never compiles a second proposal or fills the draft again. */
  async completeNative(run:ClaimedRun,raw:string,beforeCommit?:()=>void) {
    if(!raw.trim()||raw.length>20000)throw new Error("Агент не вернул подходящий ответ.");
    return this.db.tx(async c=>{
      await this.db.session(c,run.sessionId);
      const payload={operation:"complete_native_run",runId:run.id,fence:run.fence,outputHash:fingerprint(raw)};
      const prior=await this.db.receipt(c,run.id,run.materialId,payload);if(prior)return prior.result;
      const r=await this.live(c,run),p=await this.db.project(c,run.materialId);
      const message=await c.query("SELECT proposal_id FROM lanka.agent_messages WHERE tenant_id=$1 AND id=$2",[this.db.tenant,r.assistant_message_id]);
      const proposalId=message.rows[0].proposal_id;
      const events=await c.query("SELECT sequence,kind,payload FROM lanka.agent_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence",[this.db.tenant,run.id]);
      const effect=events.rows.find(e=>e.kind===(run.mode==="create"?"document.created":"proposal.ready"));
      const question=events.rows.find(e=>e.kind==="creation.question");
      if(run.mode==="create"&&!effect&&!question)throw new Error("NATIVE_CREATION_MISSING");
      if(effect) {
        const proposal=proposalId?p.state.proposals.find(v=>v.id===proposalId):null;
        const ids=run.mode==="create"?p.state.doc.slides.map(v=>v.id):proposal?.changes.map(v=>v.slideId)||[];
        const seen=new Set(events.rows.filter(e=>e.kind==="tool.completed"&&e.payload.name==="render_slides"&&Number(e.sequence)>Number(effect.sequence)&&e.payload.revision===p.state.revision&&e.payload.proposalId===(proposalId||null)).flatMap(e=>e.payload.slideIds||[]));
        const briefOnly=run.mode==='edit'&&run.selection.scope==='document'&&!!proposal?.briefChanges?.length&&!proposal.changes.length;
        if(!briefOnly&&(!ids.length||ids.some(id=>!seen.has(id))))throw new Error("NATIVE_PREVIEW_REQUIRED");
      }
      const reply=run.mode==="create"&&question&&!effect?question.payload.question:run.mode==="edit"&&!proposalId?`Изменения не предложены.\n\n${raw}`:raw;
      await c.query("UPDATE lanka.agent_messages SET text=$3,status='complete' WHERE tenant_id=$1 AND id=$2",[this.db.tenant,r.assistant_message_id,reply]);
      await c.query("UPDATE lanka.jobs SET status='completed',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id]);
      await this.db.event(c,run.sessionId,run.id,"message.completed",{messageId:r.assistant_message_id,proposalId});
      await this.db.event(c,run.sessionId,run.id,"run.completed",{transport:"native_mcp"});
      const result={proposalId};await this.db.remember(c,run.id,run.materialId,payload,result);
      beforeCommit?.();return result;
    });
  }
  async checkEdit(run:ClaimedRun,raw:string) {
    const edit=editAnswerSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*/,"").replace(/\s*```$/, "")));
    if(!edit.commands.length)return;
    await this.db.tx(async c=>{
      const r=await this.live(c,run),p=await this.db.project(c,run.materialId);
      if(p.state.revision!==r.base_revision)throw new Error("Исходная версия изменилась. Повторите поручение на новой версии.");
      assertEditDesign(p.state.doc,compileCommands(p.state.doc,edit.commands));
    });
  }
  async fail(run:ClaimedRun,message:string,code="AGENT_FAILED") {
    return this.db.tx(async c=>{
      const r=await this.live(c,run);
      await c.query("UPDATE lanka.jobs SET status='failed',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id]);
      await c.query("UPDATE lanka.agent_runs SET error_code=$3 WHERE tenant_id=$1 AND id=$2",[this.db.tenant,run.id,code]);
      await c.query("UPDATE lanka.agent_messages SET text=$3,status='failed' WHERE tenant_id=$1 AND id=$2",[this.db.tenant,r.assistant_message_id,message]);
      await this.db.event(c,run.sessionId,run.id,"run.failed",{message});
    }).catch(e=>{if(e.message!=="RUN_FENCED"&&e.message!=="Беседа недоступна.")throw e;});
  }
  private async cancelIn(c:DbTx,sessionId:string,runId:string,message="Остановлено. Уже сохранённые правки остаются в документе.") {
    const r=await c.query("UPDATE lanka.jobs SET status='cancelled',fence=fence+1,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND status IN ('queued','running','unknown') RETURNING id",[this.db.tenant,sessionId,runId]);
    if(!r.rowCount)return;
    await c.query("UPDATE lanka.agent_messages SET status='interrupted',text=CASE WHEN text='' THEN $3 ELSE text END WHERE tenant_id=$1 AND id IN (SELECT assistant_message_id FROM lanka.agent_runs WHERE tenant_id=$1 AND id=$2)",[this.db.tenant,runId,message]);
    await this.db.event(c,sessionId,runId,"run.cancelled",{message});
  }
  async cancel(sessionId:string,runId:string,requestId:string) {
    return this.db.tx(async c=>{
      const s=await this.db.session(c,sessionId),payload={operation:"cancel",sessionId,runId};
      const prior=await this.db.receipt(c,requestId,s.material_id,payload);if(prior)return prior.result;
      const run=await c.query("SELECT id FROM lanka.jobs WHERE tenant_id=$1 AND session_id=$2 AND id=$3",[this.db.tenant,sessionId,runId]);if(!run.rowCount)throw new Error("Поручение недоступно.");
      await this.cancelIn(c,sessionId,runId);
      const result={ok:true,runId};await this.db.remember(c,requestId,s.material_id,payload,result);return result;
    });
  }
  async interruptAcknowledged(run:ClaimedRun) {
    await this.db.tx(async c=>{
      await this.db.session(c,run.sessionId);
      await c.query("UPDATE lanka.agent_runs SET interrupt_acknowledged=true WHERE tenant_id=$1 AND id=$2 AND session_id=$3",[this.db.tenant,run.id,run.sessionId]);
      await this.db.event(c,run.sessionId,run.id,"run.interrupt_acknowledged",{});
    });
  }
  async recoverExpired() {
    await this.db.tx(async c=>{
      const runs=await c.query("SELECT j.id,j.session_id FROM lanka.jobs j JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id WHERE j.tenant_id=$1 AND s.owner_id=$2 AND s.connection_id='local-codex' AND j.status='running' AND (j.lease_until<now() OR j.deadline_at<now())",[this.db.tenant,this.db.owner]);
      for(const r of runs.rows) {
        await c.query("UPDATE lanka.jobs SET status='unknown',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND id=$2",[this.db.tenant,r.id]);
        await c.query("UPDATE lanka.agent_messages SET status='interrupted',text=CASE WHEN text='' THEN 'Связь с исполнителем потеряна. Остановите поручение и продолжите беседу.' ELSE text END WHERE tenant_id=$1 AND id IN (SELECT assistant_message_id FROM lanka.agent_runs WHERE tenant_id=$1 AND id=$2)",[this.db.tenant,r.id]);
        await this.db.event(c,r.session_id,r.id,"run.recovering",{outcome:"unknown"});
      }
    });
  }
}
