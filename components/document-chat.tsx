import {AgentInputRequest} from "./agent-input-request";
import {agentUsageText} from '../lib/project/agent-usage';
import {recoverableChatRequest} from '../lib/project/chat-retry';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, MessageNotSentError, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {chatMarkdownOptions} from "./chat-markdown";
import { ArrowUp, Check, ChevronRight, Circle, CircleMinus, ListChecks, LoaderCircle, MessageSquare, Plug, Square, Unplug } from "lucide-react";
import { Button } from "./ui/button";
import {Dialog,DialogContent,DialogDescription,DialogTitle} from "./ui/dialog";
import type { AgentConnectionView, ChatMessage, ChatSelection, ChatView } from "../lib/agents/contracts";
import type { Proposal, Slide } from "../lib/domain/model";
import { chatContext } from "../lib/project/chat-context";
import {proposalReviewState} from '../lib/project/proposal-review-state';

import { localFetch, LocalRequestError } from "../lib/project/local-client";
import { ChatDraft, selectionForScope } from "../lib/project/chat-draft";

const ReviewContext=createContext<{open:(id:string,slide:string)=>void;proposals:Proposal[];agentName:string;slides:readonly Slide[];waitingInput:boolean}>({open:()=>{},proposals:[],agentName:"Агент",slides:[],waitingInput:false});
async function request<T>(path:string,body?:unknown):Promise<T> {
  const response=await localFetch(path,body===undefined?{cache:"no-store"}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  try { return await response.json() as T; }
  catch { throw new LocalRequestError("Получен неполный ответ Lanka. Повторите действие; ключ отправки сохранён."); }
}
function MarkdownText() {return <MarkdownTextPrimitive className="chat-markdown" {...chatMarkdownOptions}/>;}
function ChatMessageBubble() {
  const message=useAuiState(s=>s.message);
  const metadata=message.metadata.custom as {selection?:ChatSelection;proposalId?:string;localStatus?:ChatMessage['status'];mode?:ChatMessage['mode']};
  const review=useContext(ReviewContext),proposal=review.proposals.find(p=>p.id===metadata.proposalId);
  const {decision,label:decisionLabel}=proposalReviewState(proposal);
  const isUser=message.role==="user";
  const emptyReply=metadata.localStatus==='streaming'?'Готовит ответ…':metadata.localStatus==='failed'?'Ответ не получен. Запуск завершился с ошибкой.':metadata.localStatus==='interrupted'?'Запуск остановлен до получения ответа.':metadata.proposalId?'Предложение подготовлено.':'Агент завершил работу без текстового ответа.';
  const context=metadata.selection?chatContext(metadata.selection,review.slides):null;
  return <MessagePrimitive.Root className={`chat-message ${isUser?"chat-message-user":"chat-message-assistant"}`}>
    <div className="chat-message-label">{isUser?"Вы":review.agentName}{metadata.mode&&<span> · {metadata.mode==='create'?'Создание':metadata.mode==='edit'?'Правка':'Обсуждение'}</span>}{metadata.localStatus==="interrupted"&&<span> · Остановлено</span>}{metadata.localStatus==="failed"&&<span> · Ошибка</span>}</div>
    {context&&<div className="chat-message-context" title={context.title}>{context.label}</div>}
    <MessagePrimitive.Parts components={{Text:MarkdownText}}/>
    {!isUser&&!message.content.length&&!(review.waitingInput&&metadata.localStatus==='streaming')&&<span className="chat-waiting">{emptyReply}</span>}
    {metadata.proposalId&&<button className="chat-proposal" data-decision={decision} onClick={()=>review.open(metadata.proposalId!,proposal?.changes[0]?.slideId||metadata.selection?.slideId||"")}>
      <span className="chat-proposal-icon" aria-hidden="true">{decision==='accepted'?<Check size={18}/>:decision==='rejected'?<CircleMinus size={18}/>:decision==='mixed'?<ListChecks size={18}/>:<MessageSquare size={18}/>}</span>
      <span><strong>{proposal?.title||"Предложение правки"}</strong><small>{decisionLabel}</small></span><ChevronRight size={18} aria-hidden="true"/>
    </button>}
  </MessagePrimitive.Root>;
}
function convertMessage(m:ChatMessage):ThreadMessageLike {
  return {id:m.id,role:m.role,content:m.text?[{type:"text",text:m.text}]:[],createdAt:new Date(m.createdAt),
    ...(m.role==="assistant"?{status:m.status==="streaming"?{type:"running" as const}:m.status==="complete"?{type:"complete" as const,reason:"stop" as const}:{type:"incomplete" as const,reason:"cancelled" as const}}:{}),
    metadata:{custom:{selection:m.selection,proposalId:m.proposalId,localStatus:m.status,mode:m.mode}}};
}
type Props={documentId:string;revision:number;selection:ChatSelection;elementLabel?:string;slideIndex:number;slideTitle:string;slides:readonly Slide[];enabled:boolean;dirty:boolean;proposals:Proposal[];onReview:(id:string,slideId:string)=>void;onRestoreSelection:(selection:ChatSelection)=>boolean};

export function DocumentChat(props:Props) {
  const [draft] = useState(() => {
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { /* Keep the draft in memory if storage is unavailable. */ }
    return new ChatDraft(storage, props.documentId);
  });
  const [syncError,setSyncError]=useState("");
  const [composerHasText,setComposerHasText]=useState(!!draft.text);
  const [restoredRequestId,setRestoredRequestId]=useState<string|null>(null);
  const [missingSelection,setMissingSelection]=useState(false);
  const [storageWarning,setStorageWarning]=useState(!draft.persistent);
  const [connection,setConnection]=useState<AgentConnectionView|null>(null),[view,setView]=useState<ChatView|null>(null);
  const [mode,setMode]=useState<"discuss"|"edit">(draft.options.mode),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [scope,setScope]=useState<"slide"|"element"|"document">(draft.text?draft.options.scope:props.selection.elementId?"element":draft.options.scope==="element"?"slide":draft.options.scope);
  const missingElement=scope==="element"&&(!props.selection.elementId||!props.elementLabel);
  const [connectingStream,setConnectingStream]=useState(false),[mcp,setMcp]=useState("");
  const [sessionId,setSessionId]=useState<string|null>(null);
  const current=useRef(props);
  const currentView=useRef(view);
  useLayoutEffect(()=>{current.current=props;currentView.current=view;});
  const copyId=useRef(crypto.randomUUID());
  const creationRetryId=useRef(crypto.randomUUID());
  const recoveryAttempt=useRef<{requestId:string;failedRunId:string}|null>(null);
  const [confirmRecovery,setConfirmRecovery]=useState(false);
  const [confirmIsolation,setConfirmIsolation]=useState(false);
  const [connectionDetailsOpen,setConnectionDetailsOpen]=useState(()=>typeof document==="undefined"||document.body.dataset.ui!=="refresh");
  const isolationButton=useRef<HTMLButtonElement>(null);
  const restored=useRef(false);
  useLayoutEffect(()=>{
    if(restored.current)return;restored.current=true;
    if(draft.text&&draft.selection&&!props.onRestoreSelection(draft.selection)&&draft.options.scope!=="document")setMissingSelection(true);
  },[draft,props]);
  const previousElement=useRef(props.selection.elementId);
  useEffect(()=>{
    if(props.selection.elementId!==previousElement.current&&props.selection.elementId&&props.elementLabel){setScope("element");setMissingSelection(false);}
    previousElement.current=props.selection.elementId;
  },[props.selection.elementId,props.elementLabel]);
  useEffect(()=>{const selection=selectionForScope(props.selection,scope);if(selection&&!missingSelection&&!missingElement)draft.setSelection(selection);},[draft,props.selection.slideId,props.selection.field,props.selection.elementId,scope,missingSelection,missingElement]);
  const load=useCallback(async(id:string)=>{
    const next=await request<ChatView>(`/api/v1/agent-sessions/${id}`);setView(old=>!old||old.sessionId!==next.sessionId||next.cursor>=old.cursor?next:old);return next;
  },[]);
  useEffect(()=>{
    let alive=true, pending=false, hasSession=false;
    const connect=async()=>{
      if(pending)return;pending=true;
      try {
        const next=await request<AgentConnectionView>("/api/v1/agent-connections");
        if(!alive)return;setConnection(next);
        if(props.enabled&&!hasSession) {
          const session=await request<{sessionId:string}>(`/api/v1/materials/${props.documentId}/agent-sessions`,{});
          if(!alive)return;setSessionId(session.sessionId);hasSession=true;
        }
        if(alive&&!props.enabled)setSyncError("");
      } catch(e) {
        if(alive){setSyncError((e as Error).message);setConnection(old=>old?{...old,status:"offline"}:old);}
      } finally {pending=false;}
    };
    void connect();const timer=setInterval(()=>void connect(),5000);
    return()=>{alive=false;clearInterval(timer);};
  },[props.documentId,props.enabled]);
  useEffect(()=>{
    if(!sessionId)return;
    let alive=true,events:EventSource|undefined,pending=false;
    const open=(cursor:number)=>{
      events?.close();setConnectingStream(true);
      events=new EventSource(`/api/v1/agent-sessions/${sessionId}/events?after=${cursor}`);
      events.addEventListener("update",()=>{setConnectingStream(false);void refresh();});
      events.addEventListener("unavailable",()=>{events?.close();events=undefined;setConnectingStream(true);});
      events.onopen=()=>{if(alive)setConnectingStream(false);};
      events.onerror=()=>{if(alive)setConnectingStream(true);};
    };
    const refresh=async()=>{
      if(pending||!alive)return;pending=true;
      try {
        const snapshot=await load(sessionId);
        if(!alive)return;setSyncError("");
        if(document.visibilityState==="visible"&&snapshot.active) {
          if(!events||events.readyState===EventSource.CLOSED)open(snapshot.cursor);
        } else {events?.close();events=undefined;setConnectingStream(false);}
      } catch(e) {if(alive){setSyncError((e as Error).message);setConnectingStream(true);}}
      finally {pending=false;}
    };
    const visibility=()=>{
      if(document.visibilityState!=="visible"){events?.close();events=undefined;setConnectingStream(false);}
      else void refresh();
    };
    document.addEventListener("visibilitychange",visibility);
    void refresh();const fallback=setInterval(()=>{if(document.visibilityState==="visible")void refresh();},2000);
    return()=>{alive=false;events?.close();clearInterval(fallback);document.removeEventListener("visibilitychange",visibility);};
  },[sessionId,load]);
  async function connectionAction(action:string) {
    setBusy(true);setError("");
    try {
      setConnection(await request<AgentConnectionView>(`/api/v1/agent-connections/local-codex/${action}`,{}));
      if(action==='isolate'){
        setConfirmIsolation(false);setConfirmRecovery(false);
        if(view?.recovery)restoreLastRequest();
        if(sessionId)await load(sessionId);
      }
    }
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const onNew=useCallback(async(message:AppendMessage)=>{
    if(!sessionId)throw new MessageNotSentError("Беседа ещё подключается. Текст сохранён.");
    const text=message.content.filter(p=>p.type==="text").map(p=>(p as {text:string}).text).join("\n");
    const p=current.current,selection=selectionForScope(p.selection,scope);
    if(missingSelection||!selection||scope==="element"&&!p.elementLabel)throw new MessageNotSentError("Выберите доступный объект или явно смените область поручения. Текст сохранён.");
    const question=currentView.current?.creationQuestion;
    const creationQuestionId=mode==='edit'&&p.revision===1?question?.id:undefined;
    const payload={text,mode,selection:creationQuestionId?{slideId:p.slides[0].id,field:null,scope:'document' as const}:selection,expectedRevision:p.revision,...(creationQuestionId?{creationQuestionId}:{})};
    const input=draft.prepare(payload);
    setError("");setBusy(true);
    try {
      await request(`/api/v1/agent-sessions/${sessionId}/messages`,input);
      draft.acknowledge(input.requestId);
      // The server accepted the message. A failed refresh must not restore a sendable duplicate draft.
      await load(sessionId).catch(()=>setError("Сообщение принято. Восстанавливаем отображение беседы…"));
    }
    catch(e){
      if(e instanceof LocalRequestError&&e.status&&e.status>=400&&e.status<500)draft.acknowledge(input.requestId);
      const message=e instanceof LocalRequestError&&!e.status
        ?"Отправка не подтверждена. Текст сохранён; повторите отправку после восстановления связи."
        :(e as Error).message;
      setError(message);
      throw new MessageNotSentError(message);
    }finally{setBusy(false);}
  },[sessionId,mode,scope,load,draft,missingSelection]);
  const onCancel=useCallback(async()=>{
    const active=currentView.current?.active;if(!sessionId||!active)return;
    setError("");
    try {await request(`/api/v1/agent-runs/${active.id}/cancel`,{sessionId,requestId:crypto.randomUUID()});await load(sessionId);}
    catch(e){setError((e as Error).message);}
  },[sessionId,load]);
  const sendBlockedReason=missingSelection||missingElement?"Выберите доступный объект или смените область поручения."
    :view?.active?.status==="unknown"?"Связь с агентом потеряна. Остановите поручение, чтобы продолжить."
    :busy?"Дождитесь завершения текущего действия."
    :connection?.status==="auth_required"?"Войдите в аккаунт агента выше. Текст останется в черновике."
    :connection?.status==="offline"?"Агент недоступен. Проверьте подключение выше."
    :connection?.status==="disabled"?"Подключите агента, чтобы отправить сообщение."
    :connection?.status==="not_configured"?"Подключение агента ещё не настроено."
    :connection?.status!=="ready"?"Проверяем подключение к агенту…"
    :!sessionId?"Открываем беседу…"
    :connection?.usage?.remaining===0?agentUsageText(connection.usage)
    :props.dirty?"Дождитесь сохранения правок слайда. Если сохранение не удалось, исправьте ошибку в редакторе."
    :null;
  const runtime=useExternalStoreRuntime({messages:view?.messages||[],convertMessage,isRunning:!!view?.active&&view.active.status!=="unknown",isDisabled:false,
    isSendDisabled:!!sendBlockedReason,onNew,onCancel});
  const hydrated=useRef(false);
  useEffect(()=>{
    const composer=runtime.thread.composer;
    if(!hydrated.current){hydrated.current=true;if(!composer.getState().text)composer.setText(draft.text);}
    return composer.subscribe(()=>{draft.setText(composer.getState().text);setComposerHasText(!!composer.getState().text);setStorageWarning(!draft.persistent);});
  },[runtime,draft]);
  useEffect(()=>{draft.setOptions({mode,scope});setStorageWarning(!draft.persistent);},[draft,mode,scope]);
  const [answeredInputIds,setAnsweredInputIds]=useState<string[]>([]);
  useEffect(()=>setAnsweredInputIds([]),[sessionId]);
  const waitingInput=!!view?.active&&!!view.inputRequests?.some(input=>!answeredInputIds.includes(input.id));
  const inputAnswerSent=!!view?.active&&!!view.inputRequests?.some(input=>answeredInputIds.includes(input.id));
  const review=useMemo(()=>({open:props.onReview,proposals:props.proposals,agentName:connection?.name||"Агент",slides:props.slides,waitingInput:waitingInput||inputAnswerSent}),[props.onReview,props.proposals,connection?.name,props.slides,waitingInput,inputAnswerSent]);
  const status=connection?.status;
  const label=status==="ready"?"Подключён":status==="auth_required"?"Нужен вход":status==="offline"?"Недоступен":status==="disabled"?"Не подключён":status==="not_configured"?"Не настроен":"Проверяем подключение…";
  const fieldLabel=({title:"Заголовок",body:"Основной текст",takeaway:"Вывод"} as const)[props.selection.field as "title"|"body"|"takeaway"];
  const scopeChoice=scope==="slide"&&fieldLabel?"field":scope;
  const chooseScope=(choice:"field"|"slide"|"element"|"document")=>{
    if(choice==="slide"){
      const selection:ChatSelection={slideId:props.selection.slideId,field:null,scope:"slide"};
      if(!props.onRestoreSelection(selection)){setMissingSelection(true);return;}
      draft.setSelection(selection);
    }
    setScope(choice==="field"?"slide":choice);setMissingSelection(false);
  };
  const creationQuestion=props.revision===1?view?.creationQuestion:undefined;
  useEffect(()=>{if(creationQuestion&&!draft.text){setMode('edit');setScope('document');}},[creationQuestion?.id,draft]);
  const sendLabel=mode==='edit'&&creationQuestion?'Продолжить создание':mode==="discuss"?"Обсудить":"Предложить правки";
  const retryRequest=recoverableChatRequest(view);
  function restoreLastRequest(){
    const previous=view?.messages.findLast(m=>m.role==='user');
    if(!previous||previous.mode==='create'||runtime.thread.composer.getState().text)return;
    const restored=props.onRestoreSelection(previous.selection);
    setMissingSelection(!restored&&previous.selection.scope!=='document');
    setScope(previous.selection.scope||'slide');setMode(previous.mode);
    runtime.thread.composer.setText(previous.text);
    setRestoredRequestId(previous.id);
  }
  async function restartContext(){
    if(!sessionId||!view?.recovery)return;
    const failedRunId=view.recovery.failedRunId;
    if(recoveryAttempt.current?.failedRunId!==failedRunId)recoveryAttempt.current={requestId:crypto.randomUUID(),failedRunId};
    setBusy(true);setError('');
    try{
      await request(`/api/v1/agent-sessions/${sessionId}/restart-context`,recoveryAttempt.current);
      setConfirmRecovery(false);restoreLastRequest();await load(sessionId);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="document-chat" aria-label="Обсуждение с агентом">
    <div className="chat-connection">
      <span className={`chat-connection-dot ${status==="ready"?"ready":""}`}><Circle size={9} fill="currentColor"/></span>
      <div><strong title={connection?.version}>{connection?.name||"Codex"}</strong><small>{busy&&status!=="ready"?"Проверяем…":label}{status==="ready"&&connection?.model?` · ${connection.model}`:""}</small></div>
      {status==="ready"?<Button variant="ghost" size="icon" title="Отключить агента" aria-label="Отключить агента" disabled={busy} onClick={()=>void connectionAction("disconnect")}><Unplug size={17}/></Button>:status==='auth_required'?null:
        <Button variant="outline" size="sm" disabled={busy||!connection} onClick={()=>void connectionAction(status==="offline"?"probe":"connect")}>{status==="offline"?"Проверить":"Подключить"}</Button>}
    </div>
    <details className="chat-settings-disclosure" open={connectionDetailsOpen} onToggle={e=>setConnectionDetailsOpen(e.currentTarget.open)}>
      <summary>Настройки подключения и лимиты</summary>
    {connection?.runtimeMode&&<div className="chat-profile">
      <span>{connection.runtimeMode==='dedicated'?'Отдельный профиль Lanka':'Настроенный профиль Codex'}</span>
      {connection.runtimeMode==='configured'&&<Button ref={isolationButton} size="sm" variant="ghost" disabled={busy} onClick={()=>{setError('');setConfirmIsolation(true);}}>Отдельное подключение для Lanka</Button>}
    </div>}
    {connection?.usage&&<p className="chat-stream-status" role="status">{agentUsageText(connection.usage)}</p>}
    <details className="chat-connection-details" onToggle={e=>{if(e.currentTarget.open&&!mcp)void request<unknown>(`/api/connection?documentId=${props.documentId}`).then(c=>setMcp(JSON.stringify({mcpServers:{lanka:c}},null,2))).catch(e=>setError(e.message));}}><summary>О сессии и подключении через MCP</summary><p>Этот чат — отдельная сессия вашего Codex. Внешний агент через MCP работает с этой же презентацией, но его беседа не зеркалируется сюда. Добавьте конфигурацию в свой MCP-клиент на этом компьютере.</p>
      <pre className="connection-config">{mcp}</pre></details>
    </details>
    {!connectionDetailsOpen&&connection?.usage?.remaining===0&&<p className="chat-stream-status" role="status">{agentUsageText(connection.usage)}</p>}
    <Dialog open={confirmIsolation} onOpenChange={open=>{if(!busy)setConfirmIsolation(open);}}>
      <DialogContent showCloseButton={!busy} onCloseAutoFocus={event=>{if(isolationButton.current){event.preventDefault();isolationButton.current.focus();}}}>
        <DialogTitle>Отдельное подключение Codex для Lanka</DialogTitle>
        <DialogDescription>Изменится подключение во всех ваших презентациях этой установки. Потребуется вход в ваш аккаунт Codex.</DialogDescription>
        <p>Переписка, комментарии и предложения сохранятся. Агент сможет прочитать историю из Lanka в новых сессиях. Настройки прежнего профиля автоматически не переносятся.</p>
        {(view?.active||props.dirty)&&<p role="status">{view?.active?'Дождитесь завершения поручения или остановите его в чате.':'Сначала дождитесь сохранения правок презентации.'}</p>}
        {error&&<p className="chat-error" role="alert">{error}</p>}
        <div className="chat-profile-actions"><Button disabled={busy||!!view?.active||props.dirty} onClick={()=>void connectionAction('isolate')}>{busy?'Проверяем подключение…':'Перейти к отдельному входу'}</Button><Button variant="outline" disabled={busy} onClick={()=>setConfirmIsolation(false)}>Отмена</Button></div>
      </DialogContent>
    </Dialog>
    {status==="auth_required"&&<div className="chat-auth">
      {!connection?.auth&&connection?.message&&<p role="status">{connection.message}</p>}
      {connection?.auth?<><p>Откройте страницу входа и введите код:</p><strong className="chat-login-code">{connection.auth.code}</strong><a href={connection.auth.url} target="_blank" rel="noopener noreferrer">Открыть вход в Codex ↗</a><Button variant="ghost" size="sm" onClick={()=>void connectionAction("cancel-login")}>Отменить вход</Button></>:
        <><p>{connection?.runtimeMode==='dedicated'?'Войдите в свой аккаунт Codex для работы в Lanka. Беседы и авторизация этого подключения хранятся отдельно от настольного приложения.':'Используйте свой аккаунт Codex. Авторизация остаётся у установленного агента.'}</p><Button onClick={()=>void connectionAction("login")} disabled={busy}>Войти в Codex</Button></>}
    </div>}
    {(error||syncError)&&<p className="chat-error" role="alert">{error||syncError}</p>}
    {!props.enabled?<div className="chat-legacy">
      <Plug size={24}/><h3>Обсудить эту презентацию</h3>
      <p>Для чата с вашим Codex создадим отдельную копию с сохранённой беседой. Исходная презентация останется в библиотеке.</p>
      <Button disabled={busy||props.dirty||!connection?.available} onClick={async()=>{
        setBusy(true);setError("");try{const copy=await request<{id:string}>(`/api/v1/materials/${props.documentId}/chat-copy`,{requestId:copyId.current,expectedRevision:props.revision});location.href=`/documents/${copy.id}?chat`;}catch(e){setError((e as Error).message);setBusy(false);}
      }}>Создать копию для чата</Button>
    </div>:<AssistantRuntimeProvider runtime={runtime}><ReviewContext.Provider value={review}>
      <ThreadPrimitive.Root className="lanka-chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          <ThreadPrimitive.Empty><div className="chat-empty"><MessageSquare size={26}/><h3>{status==="ready"?"Что подготовить или улучшить?":status==="auth_required"?"Войдите в аккаунт агента":status==="offline"?"Восстановите подключение":status==="disabled"?"Подключите своего агента":status==="not_configured"?"Настройте подключение агента":"Подключаем беседу…"}</h3><p>{status==="ready"?"Выберите «Предложить правки», чтобы изменить слайд. Агент подготовит вариант, который вы сможете сравнить и принять.":"Состояние подключения и доступные действия — над беседой. Сообщение можно подготовить заранее: текст останется в черновике."}</p><span>Личная беседа · сохраняется вместе с работой</span></div></ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{UserMessage:ChatMessageBubble,AssistantMessage:ChatMessageBubble}}/>
          {view?.contextRestartedAt&&<p className="chat-stream-status">Контекст агента обновлён {new Date(view.contextRestartedAt).toLocaleString('ru-RU')}. Прежняя переписка доступна агенту через Lanka; история другого клиента не переносится автоматически.</p>}
          {view?.recovery&&<div className="chat-recovery" role="region" aria-label="Восстановление беседы">
            <strong>Продолжить работу в Lanka</strong>
            {confirmRecovery?<><p>Создадим новый контекст Codex при следующей отправке. Переписка, комментарии и предложения останутся здесь; агент сможет прочитать прежние сообщения. Беседа в другом клиенте не остановится. Её последующие сообщения сюда не попадут.</p>
              <Button size="sm" disabled={busy||!!view.active||props.dirty} onClick={()=>void restartContext()}>Создать новый контекст</Button>{' '}
              <Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirmRecovery(false)}>Отмена</Button></>:
              <><p>Можно освободить беседу в другом клиенте и отправить сообщение снова либо явно начать новый контекст здесь.</p>
                {connection?.runtimeMode==='configured'&&<><Button size="sm" disabled={busy} onClick={()=>setConfirmIsolation(true)}>Отдельное подключение для Lanka</Button><p>При повторной блокировке используйте отдельный профиль и вход для Lanka.</p></>}
                <Button size="sm" variant="outline" disabled={busy} onClick={()=>setConfirmRecovery(true)}>Продолжить в новом контексте</Button>{' '}
                <Button size="sm" variant="ghost" disabled={busy||composerHasText||view.messages.findLast(m=>m.role==='user')?.mode==='create'} onClick={restoreLastRequest}>Вернуть сообщение в поле ввода</Button></>}
          </div>}
          {!view?.recovery&&retryRequest&&restoredRequestId!==retryRequest.request.id&&<div className="chat-recovery" role="region" aria-label="Повторить незавершённый запрос">
            <strong>{retryRequest.status==='interrupted'?'Поручение остановлено':'Поручение не завершено'}</strong>
            <p>Верните запрос в поле ввода, проверьте текст и отправьте снова. Сохраним режим и область поручения; повтор будет работать с текущей версией презентации.</p>
            <Button size="sm" variant="outline" disabled={busy||composerHasText} onClick={restoreLastRequest}>Вернуть запрос в поле ввода</Button>
            {composerHasText&&<p>В поле уже есть новый текст. Отправьте его или очистите поле, чтобы вернуть предыдущий запрос.</p>}
          </div>}
          {!view?.active&&view?.messages.at(-1)?.mode==="create"&&["failed","interrupted"].includes(view.messages.at(-1)!.status)&&props.revision===1&&<Button disabled={busy||props.dirty||connection?.usage?.remaining===0} title={connection?.usage?.remaining===0?agentUsageText(connection.usage)||undefined:undefined} onClick={async()=>{
            if(!sessionId)return;setBusy(true);setError("");
            try{await request(`/api/v1/agent-sessions/${sessionId}/retry-creation`,{requestId:creationRetryId.current});creationRetryId.current=crypto.randomUUID();await load(sessionId);}
            catch(e){setError((e as Error).message);}finally{setBusy(false);}
          }}>Повторить создание</Button>}
          {!!view?.active&&<div className="chat-run-state" role="status">{view.active.status==="unknown"?<><span>Связь с агентом прервалась</span><button onClick={()=>void onCancel()}>Остановить поручение</button></>:inputAnswerSent&&!waitingInput?<><Check size={15} aria-hidden="true"/><span>Ответ отправлен · обновляем состояние</span></>:waitingInput?<><MessageSquare size={15} aria-hidden="true"/><span>Ждёт вашего ответа</span></>:<><LoaderCircle size={15} className="chat-spin"/><span>{view.active.status==="queued"?"В очереди":view.active.activity|| (view.active.mode==="create"?"Создаёт презентацию":view.active.mode==="edit"?"Готовит предложение правки":"Отвечает")}</span></>}</div>}
        {view?.active&&sessionId&&view.inputRequests?.map(input=><AgentInputRequest key={input.id} request={input} onAnswer={async(id,answers)=>{
          const active=currentView.current?.active;if(!active)throw Error("Вопрос закрыт");
          try{await request(`/api/v1/agent-runs/${active.id}/answer-input`,{sessionId,id,answers});}
          catch(error){await load(sessionId).catch(()=>{});throw error;}
          setAnsweredInputIds(ids=>ids.includes(id)?ids:[...ids,id]);
          // A failed refresh must not turn a confirmed answer into a resend prompt.
          await load(sessionId).catch(()=>{});
        }}/>) }
        {creationQuestion&&!view?.active&&<p className="chat-stream-status">Агент ждёт уточнения. Напишите ответ и выберите «Продолжить создание» — работа продолжится в этой презентации.</p>}
        </ThreadPrimitive.Viewport>
        {(missingSelection||missingElement)&&<p className="chat-error">Объект или слайд поручения недоступен. Выберите объект заново или явно смените область ниже. Текст сохранён.</p>}
        <ComposerPrimitive.Root className="chat-composer">
          <div className="chat-mode" role="group" aria-label="Режим агента"><button type="button" aria-pressed={mode==="discuss"} onClick={()=>setMode("discuss")}>Обсудить</button><button type="button" aria-pressed={mode==="edit"} onClick={()=>{setMode("edit");if(creationQuestion)setScope("document");}}>{creationQuestion?'Продолжить создание':'Предложить правки'}</button></div>
          <label className="chat-scope">Область <select disabled={!!creationQuestion&&mode==='edit'} aria-label="Область поручения" title={scope==="element"?props.elementLabel:props.slideTitle} value={scopeChoice} onChange={e=>chooseScope(e.target.value as "field"|"slide"|"element"|"document")}>
            <option value="element" disabled={!props.selection.elementId||!props.elementLabel}>Выбранный объект</option>
            {fieldLabel&&<option value="field">{fieldLabel} · Слайд {props.slideIndex+1}</option>}
            <option value="slide">Весь слайд {props.slideIndex+1}</option>
            <option value="document">Вся презентация</option>
          </select></label>
          {scope==="element"&&props.elementLabel&&<p className="chat-object-label" title={props.elementLabel}>«{props.elementLabel}» · только этот объект</p>}
          <ComposerPrimitive.Input aria-label="Сообщение агенту" placeholder={creationQuestion&&mode==='edit'?"Ваш ответ на вопрос агента":mode==="discuss"?"Что здесь можно улучшить?":(scope==="document"?"Например, сократи текст во всей презентации":"Например, сократи заголовок")} maxLength={8000} minRows={2} maxRows={6} addAttachmentOnPaste={false} unstable_insertNewlineOnTouchEnter/>
          <div className="chat-composer-footer"><span role="status">{waitingInput?"Ответьте в карточке вопроса выше или остановите поручение.":inputAnswerSent?"Ответ отправлен. Восстанавливаем состояние поручения.":sendBlockedReason||(mode==='edit'&&creationQuestion?"Ответ продолжит создание презентации с учётом исходного поручения.":mode==="discuss"?"Только ответ в чате. Для изменений выберите «Предложить правки».":"Сначала просмотр и ваше принятие правок.")}</span>
            {view?.active?<Button size="sm" variant="outline" title="Остановить поручение" aria-label="Остановить поручение" onClick={()=>void onCancel()}><Square size={15}/>Остановить</Button>:<ComposerPrimitive.Send asChild><Button size="sm" title={sendBlockedReason||sendLabel} aria-label={sendLabel}><ArrowUp size={16}/>{sendLabel}</Button></ComposerPrimitive.Send>}
          </div>
        </ComposerPrimitive.Root>
        {storageWarning&&<p className="chat-stream-status">Хранилище вкладки недоступно: текст сохраняется только до её закрытия или обновления.</p>}
        {connectingStream&&<p className="chat-stream-status">Восстанавливаем связь с беседой…</p>}
      </ThreadPrimitive.Root>
    </ReviewContext.Provider></AssistantRuntimeProvider>}
  </section>;
}
