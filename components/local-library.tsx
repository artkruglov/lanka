import {ColleagueReviewInbox} from './colleague-review-inbox';
import {CorporatePendingReviews} from './corporate-pending-reviews';
import {PublicationLibrary} from './publication-library';
import {LibraryViewSwitch} from './library-view-switch';
import {Button} from './ui/button';
import {Popover,PopoverTrigger,PopoverContent} from './ui/popover';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from './ui/dialog';
import {WorkspaceChat} from './workspace-chat';
import {DocumentReactions} from './document-reactions';
import {OrganizationMembers} from './organization-members';
import {DocumentSharingButton} from './document-sharing';
import {folderTree,type LibraryFolder} from '../lib/project/library-folders';
import {readLibraryWindow} from '../lib/project/library-refresh';
import {AgentDelegationButton} from './agent-delegation';
import {agentUsageText} from '../lib/project/agent-usage';
import {corporateContext,documentPath,libraryPath,scopedStorage} from '../lib/project/browser-context';
import type { AgentConnectionView } from "../lib/agents/contracts";
import { CreationDraft } from "../lib/project/creation-draft";
import { CreationDesignPicker } from "./creation-design-picker";
import { CreationSourceFile } from "./creation-source-file";
import { localFetch,LocalRequestError } from "../lib/project/local-client";
/* eslint-disable @next/next/no-html-link-for-pages -- Standalone esbuild application, outside the Next router. */
import { useEffect, useRef, useState } from "react";
import {
  Home,
  LayoutTemplate,
  ChevronDown,
  MoreHorizontal,
  FolderOpen,
  Plus,
  Search,
  X,
  Trash2,
  ArrowLeft,
  ArrowRight,
  FileText,
  Users,
  RefreshCw,
} from "lucide-react";
import { SlideCanvas } from "./slide-canvas";
import type { Brand, Slide } from "../lib/domain/model";
import type { Design } from "../lib/domain/design";
import {SharedLibrary} from './shared-library';
type Listing = {
  nextCursor?:string|null;
  folders: (LibraryFolder&{resourceId?:string})[];
  documents: {
    id: string;
    title: string;
    folderId: string | null;
    inSharedFolder?:boolean;
    reactions?:{likes:number;liked:boolean;bookmarked:boolean};
    trashed: boolean;
    revision: number;
    slideCount: number;
    design: Design;
    pending: number;
    updatedAt: string;
    preview: { slide: Slide; brand: Brand } | null;
  }[];
};
function LibraryCardActions({title, compact, children}: {title:string;compact:boolean;children:React.ReactNode}) {
  if(!compact)return <footer>{children}</footer>;
  return <Popover><PopoverTrigger asChild><Button className="library-card-menu" variant="ghost" size="icon" aria-label={`Действия: ${title}`}><MoreHorizontal size={20}/></Button></PopoverTrigger>
    <PopoverContent align="end" className="library-document-actions" aria-label={`Действия с презентацией: ${title}`}><p className="library-actions-title">{title}</p>{children}</PopoverContent>
  </Popover>;
}
export function LocalLibrary() {
  const corporate=!!corporateContext();
  const refreshUi=typeof document!=="undefined"&&document.body.dataset.ui==="refresh";
  const [libraryView,setLibraryView]=useState<'cards'|'list'>(()=>{try{return scopedStorage(localStorage).getItem('lanka:library-view:v1')==='list'?'list':'cards';}catch{return 'cards';}});
  const chooseView=(next:'cards'|'list')=>{setLibraryView(next);try{scopedStorage(localStorage).setItem('lanka:library-view:v1',next);}catch{}};
  const [publicationsOpen,setPublicationsOpen]=useState(()=>corporate&&/^#publications(?:\/|$)/.test(location.hash));
  const [sharedOpen,setSharedOpen]=useState(()=>corporate&&/^#shared(?:\/|$)/.test(location.hash));
  useEffect(()=>{if(!corporate)return;const sync=()=>{setSharedOpen(/^#shared(?:\/|$)/.test(location.hash));setPublicationsOpen(/^#publications(?:\/|$)/.test(location.hash));};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[corporate]);
  const selectShared=(open:boolean)=>{setSharedOpen(open);if(corporate)history.replaceState(null,'',location.pathname+location.search+(open?'#shared':''));window.dispatchEvent(new Event('hashchange'));};
  const [data, setData] = useState<Listing>({ folders: [], documents: [] }),
    [folder, setFolderState] = useState(()=>refreshUi?readLocalView():"all"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function readLocalView(){const hash=location.hash;return hash==='#templates'?'templates':hash==='#documents'?'all':hash==='#trash'?'trash':/^#folder\/[a-f0-9-]{36}$/.test(hash)?hash.slice(8):'home';}
  function setFolder(next:string){
    setFolderState(next);
    if(refreshUi){const hash=next==='templates'?'#templates':next==='home'?'#home':next==='all'?'#documents':next==='trash'?'#trash':'#folder/'+encodeURIComponent(next);if(location.hash!==hash)history.pushState(null,'',location.pathname+location.search+hash);}
  }
  useEffect(()=>{if(!refreshUi)return;const sync=()=>{if(corporate&&/^#(?:shared|publications)(?:\/|$)/.test(location.hash))return;setFolderState(readLocalView());};window.addEventListener('hashchange',sync);window.addEventListener('popstate',sync);return()=>{window.removeEventListener('hashchange',sync);window.removeEventListener('popstate',sync);};},[refreshUi,corporate]);
  const homeView=refreshUi&&folder==='home'&&!sharedOpen&&!publicationsOpen;
  const [workspaceChatRequest,setWorkspaceChatRequest]=useState(0);
  const [allPending,setAllPending]=useState(false);
  const [navigationExpanded,setNavigationExpanded]=useState(false);
  const [loadedUrl,setLoadedUrl]=useState("");
  const [creationDraft]=useState(()=>{let storage:Storage|null=null;try{storage=scopedStorage(sessionStorage);}catch{}return new CreationDraft(storage);});
  const [profile,setProfile]=useState(corporate?"focus-v2":creationDraft.profile);
  const [prompt,setPrompt]=useState(creationDraft.text);
  const [fileBlocked,setFileBlocked]=useState(!!creationDraft.intakePreviewId);
  const [materialName,setMaterialName]=useState(creationDraft.materialName),[materialText,setMaterialText]=useState(creationDraft.materialText);
  const [agent,setAgent]=useState<AgentConnectionView|null>(null);
  const [agentCheckError,setAgentCheckError]=useState("");
  const [confirmIsolation,setConfirmIsolation]=useState(false);
  const isolationButton=useRef<HTMLButtonElement>(null);
  const [mcpConfig,setMcpConfig]=useState("");
  const [mcpStatus,setMcpStatus]=useState("");
  const [showMcp,setShowMcp]=useState(false);
  async function openMcp() {
    setShowMcp(true);setMcpStatus("Загружаем настройки…");
    try {
      const response=await localFetch("/api/workspace-connection");
      if(!response.ok)throw new Error("Не удалось получить настройки подключения.");
      const config=await response.json();
      setMcpConfig(JSON.stringify({mcpServers:{lanka:config}},null,2));setMcpStatus("");
    }catch(e){setMcpStatus((e as Error).message);}
  }
  const retry = useRef<{ payload: string; requestId: string } | null>(null);
  const [form, setForm] = useState<"document" | "generate" | "folder" | "rename" | null>(
      null,
    ),
    [name, setName] = useState("");
  useEffect(()=>{
    if(form!=="generate")return;
    setAgent(null);setAgentCheckError("");
    let active=true;
    let pending=false;
    let controller:AbortController|null=null;
    const refresh=()=>{
      if(pending)return;
      pending=true;const request=new AbortController();controller=request;
      const deadline=setTimeout(()=>request.abort(),20_000);
      void localFetch("/api/v1/agent-connections",{signal:request.signal})
        .then(r=>r.json() as Promise<AgentConnectionView>)
        .then(v=>{if(active){setAgent(v);setAgentCheckError("");}})
        .catch(()=>{if(active){setAgent(null);setAgentCheckError("Не удалось проверить подключение. Повторяем проверку автоматически; ваше поручение сохранено.");}})
        .finally(()=>{clearTimeout(deadline);pending=false;if(controller===request)controller=null;});
    };
    refresh();const timer=setInterval(refresh,5000);
    return ()=>{active=false;clearInterval(timer);controller?.abort();};
  },[form]);
  async function connectAgent(action:"connect"|"login"|"probe"|"isolate") {
    setBusy(true);setError("");
    try {const r=await localFetch(`/api/v1/agent-connections/local-codex/${action}`,{method:"POST"});setAgent(await r.json());setAgentCheckError("");if(action==="isolate")setConfirmIsolation(false);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const libraryUrl=()=>{if(!corporate)return "/api/library";const q=new URLSearchParams();if(folder==="trash")q.set("trash","1");else if(folder!=="all"&&folder!=="home"&&folder!=="templates")q.set("folderId",folder);if(search)q.set("search",search);return "/api/library?"+q;};
  const viewUrl=libraryUrl(),view=useRef({url:viewUrl,generation:0}),loadedPages=useRef(1),inFlight=useRef(0);
  const [syncing,setSyncing]=useState(false),[syncError,setSyncError]=useState(''),[updatedAt,setUpdatedAt]=useState<Date|null>(null);
  if(view.current.url!==viewUrl){view.current={url:viewUrl,generation:view.current.generation+1};loadedPages.current=1;}
  async function refresh(appendCursor?:string,signal?:AbortSignal) {
    const url=view.current.url,generation=++view.current.generation;inFlight.current++;setSyncing(true);
    const live=()=>!signal?.aborted&&view.current.url===url&&view.current.generation===generation;
    try {
      const load=async(cursor?:string)=>{const r=await localFetch(url+(cursor?`${url.includes('?')?'&':'?'}cursor=${encodeURIComponent(cursor)}`:''),{signal,cache:'no-store'});return await r.json() as Listing;};
      const next=appendCursor?await load(appendCursor):await readLibraryWindow(load,loadedPages.current);
      if(!live())return;
      setSyncError('');setLoadedUrl(url);setUpdatedAt(new Date());
      if(appendCursor)loadedPages.current++;
      setData(old=>appendCursor?{...next,documents:[...old.documents,...next.documents.filter(n=>!old.documents.some(o=>o.id===n.id))]}:JSON.stringify(old)===JSON.stringify(next)?old:next);
    } catch(e){
      if(live()){
        setSyncError((e as Error).message);
        if(e instanceof LocalRequestError&&[401,403,404].includes(e.status??0)){setData({folders:[],documents:[]});setLoadedUrl('');}
      }
      throw e;
    } finally {inFlight.current--;if(view.current.generation===generation)setSyncing(false);}
  }
  useEffect(() => {
    const controller=new AbortController();
    void refresh(undefined,controller.signal).catch(()=>{});
    return()=>controller.abort();
  },[viewUrl]);
  useEffect(()=>{
    const abort=new AbortController();
    const resume=()=>{if(document.visibilityState==='hidden'||busy||inFlight.current>0)return;void refresh(undefined,abort.signal).catch(()=>{});};
    const timer=setInterval(resume,5000);
    document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);window.addEventListener('lanka:auth-restored',resume);
    return()=>{abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume);window.removeEventListener('lanka:auth-restored',resume);};
  },[viewUrl,busy]);
  async function mutate(command: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const payload = JSON.stringify(command);
    if (retry.current?.payload !== payload)
      retry.current = { payload, requestId: crypto.randomUUID() };
    try {
      const r = await localFetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: retry.current.requestId, command }),
      });
      const result = (await r.json()) as { id?: string; error?: string };
      if (!r.ok) throw new Error(result.error);
      await refresh();
      retry.current = null;
      setForm(null);
      return result;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const folders=folderTree(data.folders);
  const current = folders.find((f) => f.id === folder);
  const listLoading=loadedUrl!==viewUrl;
  const docs = (listLoading?[]:data.documents)
    .filter(
      (d) =>
        (folder === "trash"
          ? d.trashed
          : !d.trashed && (folder === "all" || folder === "home" || d.folderId === folder)) &&
        d.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waiting=docs.filter(d=>d.pending>0);
  const pendingPreviewCount=refreshUi?2:4;
  const attentionSection=homeView&&!corporate&&!syncError&&waiting.length>0&&<section className="library-attention" aria-labelledby="library-attention-title">
          <div className="library-recents-heading"><h2 id="library-attention-title">Предложения на проверке</h2><span>{waiting.length} документов</span></div>
          <p>Посмотрите предложенные изменения и решите, какие сохранить.</p>
          <ul>{(allPending?waiting:waiting.slice(0,pendingPreviewCount)).map(d=><li key={d.id}><a href={documentPath(d.id)+"?review=1"}><span><strong>{d.title}</strong><small>Предложений: {d.pending} · текущая версия {d.revision}</small></span><span className="library-attention-action">Проверить <ArrowRight size={16} aria-hidden="true"/></span></a></li>)}</ul>
          {waiting.length>pendingPreviewCount&&<button className="text-link" aria-expanded={allPending} onClick={()=>setAllPending(v=>!v)}>{allPending?'Свернуть':`Показать все · ${waiting.length}`}</button>}
        </section>;
  return (
    <div className="local-library">
      <aside className="library-sidebar">
        <div className="library-brand-row">
        <a className="library-logo" href={libraryPath()}>
          LANKA<span>Презентации</span>
        </a>
        <button
          className="library-primary"
          onClick={() => {
            selectShared(false);
            if(folder==="templates")setFolder("home");
            setName("");
            setForm(corporate?"document":"generate");
          }}
        >
          <Plus size={18} />
          {corporate&&sharedOpen?'Новая личная презентация':'Новая презентация'}
        </button>
        </div>
        {refreshUi&&<button className="library-navigation-toggle" aria-expanded={navigationExpanded} aria-controls="library-navigation" onClick={()=>setNavigationExpanded(open=>!open)}>Разделы и папки <ChevronDown size={18}/></button>}
        <nav id="library-navigation" aria-label="Библиотека" data-expanded={navigationExpanded} onClick={e=>{if((e.target as HTMLElement).closest('button'))setNavigationExpanded(false);}}>
          {refreshUi&&<button aria-current={homeView?"page":undefined} onClick={()=>{selectShared(false);setSearch("");setFolder("home");}}><Home size={18}/>Главная</button>}
          <button
            aria-current={!sharedOpen&&!publicationsOpen&&folder === "all" ? "page" : undefined}
            onClick={() => {selectShared(false);setFolder("all");}}
          >
            <FileText size={18} />
            {corporate?'Мои презентации':'Все презентации'}
          </button>
          {refreshUi&&<button aria-current={!sharedOpen&&!publicationsOpen&&folder==='templates'?'page':undefined} onClick={()=>{selectShared(false);setSearch('');setForm(null);setFolder('templates');}}><LayoutTemplate size={18}/>Шаблоны</button>}
          {corporate&&<button aria-current={publicationsOpen?'page':undefined} onClick={()=>{history.replaceState(null,'',location.pathname+location.search+'#publications');window.dispatchEvent(new Event('hashchange'));}}><FileText size={18}/>Публикации</button>}
          {corporate&&<button aria-current={sharedOpen?'page':undefined} onClick={()=>selectShared(true)}><Users size={18}/>Доступные мне</button>}
          <div className="library-section">
            <span>Папки</span>
            <button
              aria-label="Создать папку"
              onClick={() => {
                selectShared(false);
                if(folder==="templates")setFolder("all");
                setName("");
                setForm("folder");
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {folders.map((f) => (
            <button
              key={f.id}
              title={f.path}
              aria-label={f.path}
              style={{paddingLeft:12+Math.min(f.depth,8)*14}}
              aria-current={!sharedOpen&&!publicationsOpen&&folder === f.id ? "page" : undefined}
              onClick={() => {selectShared(false);setFolder(f.id);}}
            >
              <FolderOpen size={18} />
              {f.name}
            </button>
          ))}
          <button
            className="library-trash"
            aria-current={!sharedOpen&&!publicationsOpen&&folder === "trash" ? "page" : undefined}
            onClick={() => {selectShared(false);setFolder("trash");}}
          >
            <Trash2 size={18} />
            Корзина
          </button>
        </nav>
        {corporate&&<div className="library-agent-actions"><WorkspaceChat openRequest={workspaceChatRequest}/><AgentDelegationButton workspace/><OrganizationMembers/></div>}
        {!corporate&&<button className="text-link" onClick={()=>void openMcp()}>Подключить своего агента</button>}
        <p className="library-local">{corporate?"Личные документы в организации":"На этом компьютере"}</p>
      </aside>
      {corporate&&publicationsOpen?<PublicationLibrary view={libraryView} onViewChange={chooseView}/>:corporate&&sharedOpen?<SharedLibrary view={libraryView} onViewChange={chooseView}/>:refreshUi&&folder==='templates'?<main className="library-main library-templates">
        <header><div><span className="eyebrow">ОФОРМЛЕНИЕ ПРЕЗЕНТАЦИЙ</span><h1>Шаблоны</h1><p>Сравните композиции и выберите основу для новой презентации.</p></div></header>
        <CreationDesignPicker expanded value={profile as "focus-v2"|"focus-v3"} onChange={value=>{setProfile(value);creationDraft.setProfile(value);}}/>
        <div className="library-template-create"><p>{corporate?"Задайте название и создайте документ в выбранном оформлении. Продолжить работу можно в редакторе со своим агентом.":"Выбранное оформление откроется в форме создания. Текст и материалы можно добавить следующим шагом."}</p><Button onClick={()=>{setFolder('home');setName('');setForm(corporate?'document':'generate');}}>Создать презентацию <ArrowRight size={16}/></Button></div>
      </main>:<main className="library-main">
        <header>
          <div>
            <span className="eyebrow">ВАША БИБЛИОТЕКА</span>
            {current&&<nav className="library-breadcrumbs" aria-label="Путь папки"><button className="text-link" onClick={()=>setFolder("all")}>Мои презентации</button>{current.ancestors.map(id=><span key={id}> / <button className="text-link" onClick={()=>setFolder(id)}>{folders.find(f=>f.id===id)?.name}</button></span>)}<span> / {current.name}</span></nav>}
            <h1>
              {current?.name ||
                (homeView?"Главная":folder === "trash" ? "Корзина" : corporate?"Мои презентации":"Все презентации")}
            </h1>
            <p>
              {listLoading?"Загрузка…":homeView?"Начните новую презентацию или продолжите работу":`${docs.length} документов`}
              {current && (
                <button
                  className="text-link"
                  onClick={() => {
                    setName(current.name);
                    setForm("rename");
                  }}
                >
                  Переименовать папку
                </button>
              )}
            </p>
          </div>
          <div className="library-search" role="search" aria-label="Поиск в библиотеке">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="Поиск презентаций"
              placeholder="Найти презентацию"
              maxLength={140}
              value={search}
              onChange={(e) => {if(homeView)setFolder("all");setSearch(e.target.value);}}
              onKeyDown={e=>{if(e.key==='Escape'&&search){e.preventDefault();setSearch('');}}}
            />
            {search&&<button type="button" className="library-search-clear" aria-label="Очистить поиск" onClick={e=>{e.currentTarget.parentElement?.querySelector('input')?.focus();setSearch('');}}><X size={16} aria-hidden="true"/></button>}
          </div>
        </header>
        <div className="library-home-actions" data-paired={Boolean(attentionSection)&&!form&&!search}>
        {homeView&&!corporate&&!search&&!form&&<section className="library-start" aria-labelledby="library-start-title">
          <div className="library-start-copy"><h2 id="library-start-title">Что подготовим?</h2><p>Материалы и оформление — на следующем шаге.</p></div>
          <form className="library-start-composer" onSubmit={e=>{e.preventDefault();setForm("generate");}}>
            <textarea aria-label="Замысел презентации" maxLength={8000} rows={3} value={prompt} onChange={e=>{setPrompt(e.target.value);creationDraft.setText(e.target.value);}} placeholder="Например, итоги квартала для команды: результаты, выводы и следующие шаги"/>
            <div><button type="button" className="text-link" aria-label="Начать с пустого слайда" onClick={()=>{setName("");setForm("document");}}>Пустой слайд</button><Button type="submit">Продолжить <ArrowRight size={16}/></Button></div>
            {(materialText||creationDraft.intakePreviewId)&&<small>Исходные материалы сохранены в черновике</small>}
            {!creationDraft.persistent&&<small role="status">Замысел сохранится только до обновления страницы.</small>}
          </form>
        </section>}
        {homeView&&corporate&&!form&&<section className="library-start" aria-labelledby="corporate-start-title">
          <div className="library-start-copy"><span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2 id="corporate-start-title">Подготовим презентацию</h2><p>Обсудите задачу с подключённым агентом организации или начните с пустого документа.</p></div>
          <div className="library-start-composer"><Button onClick={()=>setWorkspaceChatRequest(n=>n+1)}>Обсудить со своим агентом</Button><p className="hint">В беседе можно выбрать создание презентации и увидеть результаты работы. Подключение и разрешения проверяются в чате.</p><button className="text-link" onClick={()=>{setName("");setForm("document");}}>Создать пустую презентацию</button></div>
        </section>}
        {!form&&attentionSection}
        </div>
        {corporate&&current?.resourceId&&<div className="shared-library-toolbar"><button onClick={()=>{history.replaceState(null,'',location.pathname+location.search+'#shared/'+current.resourceId);window.dispatchEvent(new Event('hashchange'));}}>Все документы папки, включая работы коллег</button><DocumentSharingButton key={current.resourceId} folder={{resourceId:current.resourceId,name:current.name}}/></div>}
        {!homeView&&<div className="shared-library-toolbar library-display-toolbar"><LibraryViewSwitch view={libraryView} onChange={chooseView}/><p role="status">{syncError?'Не удалось обновить список':syncing?'Обновляем…':updatedAt?'Изменения появляются автоматически':'Загружаем библиотеку…'}</p><button disabled={syncing||busy} onClick={()=>void refresh().catch(()=>{})}><RefreshCw size={16} aria-hidden="true"/>Обновить</button></div>}
        {syncError&&<p className="project-alert" role="alert">{syncError} Список может быть неактуален.</p>}
        {current&&folders.some(f=>f.parentId===current.id)&&<nav aria-label="Вложенные папки" className="shared-library-toolbar library-child-folders">{folders.filter(f=>f.parentId===current.id).map(f=><button key={f.id} onClick={()=>setFolder(f.id)}><FolderOpen size={16} aria-hidden="true"/>{f.name}</button>)}</nav>}
        {showMcp&&<section className="library-create" aria-label="Подключение своего агента">
          <div style={{minWidth:0,flex:1}}>
            <h2>Работайте из своего агента</h2>
            <p>Одно MCP-подключение даёт доступ к папкам, презентациям, шаблонам и созданию новых документов в этой локальной библиотеке.</p>
            <p>Передайте настройки агенту или добавьте их в его конфигурацию MCP. Затем попросите: «Открой библиотеку Lanka, подбери шаблон и создай презентацию».</p>
            {mcpConfig&&<textarea aria-label="Настройки MCP библиотеки" readOnly value={mcpConfig} rows={9} style={{width:"100%",fontFamily:"monospace"}}/>}
            <p>Изменения сохраняются в Lanka. Переписка внешнего агента пока не зеркалируется в чат редактора.</p>
            <p role="status">{mcpStatus}</p>
            <button type="button" disabled={!mcpConfig} onClick={async()=>{try{await navigator.clipboard.writeText(mcpConfig);setMcpStatus("Настройки скопированы.");}catch{setMcpStatus("Выделите и скопируйте настройки из поля.");}}}>Скопировать настройки</button>
          </div>
          <button type="button" onClick={()=>setShowMcp(false)}>Закрыть</button>
        </section>}
        {error && (
          <p role="alert" className="project-alert">
            {error}
          </p>
        )}
        {form==="generate"&&<form className="library-create library-generate" onSubmit={async e=>{
          e.preventDefault();if(busy||fileBlocked)return;setBusy(true);setError("");
          try {
            const input=creationDraft.prepare(current?.id||null);
            const r=await localFetch("/api/v1/presentations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
            const result=await r.json() as {id:string};
            creationDraft.acknowledge();location.assign(documentPath(result.id)+"?chat");
          }catch(e){setError((e as Error).message);setBusy(false);}
        }}>
          <label>Что подготовить?
            <textarea autoFocus required readOnly={busy} aria-label="Задача для новой презентации" maxLength={8000} rows={4} value={prompt} onChange={e=>{setPrompt(e.target.value);creationDraft.setText(e.target.value);}} placeholder="Например, 6 слайдов для команды: зачем нужна единая библиотека презентаций, как начать и что проверить. Добавьте факты, которые нужно использовать."/>
            {!agent&&<small role="status">{agentCheckError||"Проверяем подключение агента…"}</small>}
            {agent&&<small>{agent.status==="ready"?`${agent.name} подключён`:agent.message||"Подключите своего агента для создания слайдов."}</small>}
            {agent&&agent.status!=="ready"&&<small>Пока агент не подключён, можно создать пустую презентацию и редактировать её самостоятельно. Ваше поручение сохранится.</small>}
            {agent?.auth&&<small>Код входа: <strong>{agent.auth.code}</strong> · <a href={agent.auth.url} target="_blank" rel="noopener noreferrer">Открыть вход в Codex</a></small>}
            <small>Агент подготовит слайды. Вы сможете обсудить результат и исправить его в редакторе.</small>
            {!creationDraft.persistent&&<small role="status">Черновик поручения сохраняется только до обновления страницы.</small>}
          </label>
          {agent?.runtimeMode&&<div className="library-agent-profile">
            <span>{agent.runtimeMode==='dedicated'?'Отдельный профиль Lanka':'Настроенный профиль Codex'}</span>
            {agent.runtimeMode==='configured'&&<Button type="button" variant="outline" size="sm" ref={isolationButton} disabled={busy} onClick={()=>{setError('');setConfirmIsolation(true);}}>Отдельное подключение для Lanka</Button>}
          </div>}
          <Dialog open={confirmIsolation} onOpenChange={open=>{if(!busy)setConfirmIsolation(open);}}>
            <DialogContent showCloseButton={!busy} onCloseAutoFocus={event=>{if(isolationButton.current){event.preventDefault();isolationButton.current.focus();}}}>
              <DialogTitle>Отдельное подключение Codex для Lanka</DialogTitle>
              <DialogDescription>Изменится подключение во всех ваших презентациях этой установки. Потребуется вход в ваш аккаунт Codex.</DialogDescription>
              <p>Переписка, комментарии и предложения сохранятся. Настройки прежнего профиля автоматически не переносятся. Ваше поручение для новой презентации останется в форме.</p>
              <p>Если агент сейчас выполняет поручение, сначала дождитесь его завершения или остановите его в чате.</p>
              {error&&<p role="alert">{error}</p>}
              <div className="library-generate-actions"><Button type="button" disabled={busy} onClick={()=>void connectAgent('isolate')}>{busy?'Проверяем подключение…':'Перейти к отдельному входу'}</Button><Button type="button" variant="outline" disabled={busy} onClick={()=>setConfirmIsolation(false)}>Отмена</Button></div>
            </DialogContent>
          </Dialog>
          <details open={!!materialText||!!creationDraft.intakePreviewId||undefined}>
            <summary>Исходные материалы · необязательно</summary>
            <p>Добавьте файл или вставьте текст отчёта. Выбранный материал сохранится в источниках презентации и будет передан подключённому агенту.</p>
            <CreationSourceFile initialId={creationDraft.intakePreviewId} selectedId={creationDraft.sourceIntakeId} disabled={busy} onPreview={id=>creationDraft.setIntakePreview(id)} onSelect={id=>creationDraft.setSourceIntake(id)} onBlocked={setFileBlocked}/>
            <label>Название источника<input readOnly={busy} aria-label="Название исходного материала" maxLength={140} value={materialName} onChange={e=>{setMaterialName(e.target.value);creationDraft.setMaterial(e.target.value,materialText);}}/></label>
            <label>Текст материала<textarea readOnly={busy} aria-label="Текст исходного материала" rows={6} maxLength={12000} value={materialText} onChange={e=>{setMaterialText(e.target.value);creationDraft.setMaterial(materialName,e.target.value);}} placeholder="Данные, даты, единицы измерения и пояснения к ним"/></label>
          </details>
          <CreationDesignPicker value={profile as "focus-v2"|"focus-v3"} disabled={busy} onChange={value=>{setProfile(value);creationDraft.setProfile(value);}}/>
          <div className="library-generate-actions">
            {agent?.usage&&<p role="status">{agentUsageText(agent.usage)}</p>}
            <button className={agent?.status==="ready"?"library-primary":undefined} title={agent?.usage?.remaining===0?agentUsageText(agent.usage)||undefined:fileBlocked?"Проверьте файл и подтвердите его использование или удалите его из подготовки":agent?.status!=="ready"?"Сначала подключите агента или создайте пустую презентацию":!prompt.trim()?"Опишите, какую презентацию подготовить":undefined} disabled={busy||fileBlocked||!prompt.trim()||agent?.status!=="ready"||agent?.usage?.remaining===0}>{busy?"Начинаем…":"Создать с агентом"}</button>
            {agent&&agent.status!=="ready"&&<button type="button" disabled={busy} onClick={()=>void connectAgent(agent.status==="auth_required"&&!agent.auth?"login":agent.auth||agent.status==="offline"?"probe":"connect")}>{agent.status==="auth_required"&&!agent.auth?"Войти в Codex":agent.auth||agent.status==="offline"?"Проверить подключение":"Подключить Codex"}</button>}
            <button type="button" className={agent?.status!=="ready"?"library-primary":undefined} disabled={busy} onClick={()=>setForm("document")}>Создать пустую</button>
            <button type="button" disabled={busy} onClick={()=>setForm(null)}>Отмена</button>
          </div>
        </form>}
        {form && form!=="generate" && (
          <form
            className="library-create"
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await mutate(
                form === "folder"
                  ? { action: "create_folder", name }
                  : form === "rename"
                    ? { action: "rename_folder", id: folder, name }
                    : {
                        action: "create_document",
                        title: name,
                        folderId: current?.id || null,
                        ...(!corporate?{empty:true}:{}),
                        profile,
                      },
              );
              if (result?.id && form === "document")
                location.assign(documentPath(result.id));
            }}
          >
            {form==="document"&&corporate&&<label>Шаблон<select value={profile} onChange={e=>setProfile(e.target.value as "focus-v2"|"focus-v3")}><option value="focus-v2">Focus 2</option><option value="focus-v3">Focus 3</option></select></label>}
            {form==="document"&&<p>Оформление: {profile==="focus-v3"?"Focus 3":"Focus 2"}</p>}
            <label>
              {form === "document" ? "Название презентации" : "Название папки"}
              <input
                autoFocus
                required
                maxLength={form==="document"?140:180}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="library-primary" disabled={busy || !name.trim()}>
              {form === "rename" ? "Сохранить" : "Создать"}
            </button>
            <button type="button" onClick={() => setForm(null)}>
              Отмена
            </button>
          </form>
        )}
        {!listLoading&&data.nextCursor&&<button disabled={busy} onClick={async()=>{setBusy(true);try{await refresh(data.nextCursor!);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Показать ещё презентации</button>}
        {homeView&&corporate&&<><ColleagueReviewInbox/><CorporatePendingReviews/></>}
        {form&&attentionSection}
        {homeView&&docs.length>0&&<div className="library-recents-heading"><h2>{corporate?"Мои недавние презентации":"Недавние презентации"}</h2><button className="text-link" onClick={()=>setFolder("all")}>Все документы →</button></div>}
        {homeView&&<div className="shared-library-toolbar library-display-toolbar"><LibraryViewSwitch view={libraryView} onChange={chooseView}/><p role="status">{syncError?'Не удалось обновить список':syncing?'Обновляем…':updatedAt?'Изменения появляются автоматически':'Загружаем библиотеку…'}</p><button disabled={syncing||busy} onClick={()=>void refresh().catch(()=>{})}><RefreshCw size={16} aria-hidden="true"/>Обновить</button></div>}
        <div className={`library-grid${libraryView==='list'?' library-list':''}`}>
          {(homeView?docs.slice(0,6):docs).map((d) => (
            <article className="library-card" key={d.id}>
              <a
                href={d.trashed ? undefined : documentPath(d.id)}
                aria-label={`Открыть: ${d.title}`}
                className="library-preview"
              >
                {d.preview ? (
                  <SlideCanvas
                    {...d.preview}
                    assetBaseUrl={`/api/assets?documentId=${d.id}`}
                    design={d.design}
                    total={d.slideCount}
                  />
                ) : (
                  <FileText size={40} />
                )}
              </a>
              <div className="library-card-info">
                <a href={d.trashed ? undefined : documentPath(d.id)}>
                  <h2>{d.title}</h2>
                </a>
                <p>
                  {d.slideCount} слайдов · версия {d.revision}
                </p>
                {Number.isFinite(Date.parse(d.updatedAt))&&<p><time dateTime={d.updatedAt}>Изменена {new Date(d.updatedAt).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",...(new Date(d.updatedAt).getFullYear()!==new Date().getFullYear()?{year:"numeric"}: {})})}</time></p>}
                {d.pending > 0 && (
                  <a
                    className="pending-chip"
                    href={documentPath(d.id)+"?review=1"}
                  >
                    {d.pending} на проверке →
                  </a>
                )}
                <LibraryCardActions title={d.title} compact={refreshUi&&!d.trashed}>
                  {d.trashed ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate({
                          action: "trash_document",
                          id: d.id,
                          trashed: false,
                        })
                      }
                    >
                      <ArrowLeft size={14} />
                      Восстановить
                    </button>
                  ) : (
                    <>
                      <button type="button" disabled={busy||!d.revision} aria-label={`Создать копию: ${d.title}`} onClick={()=>void mutate({action:'duplicate_document',id:d.id,expectedRevision:d.revision,title:(d.title+' — копия').slice(0,140),folderId:d.folderId}).then(result=>{if(result?.id)location.assign(documentPath(result.id));})}>Создать копию</button>
                      {refreshUi&&<span className="library-actions-title">Переместить в папку</span>}
                      <select
                        aria-label={`Папка: ${d.title}`}
                        value={d.inSharedFolder?"shared":d.folderId || ""}
                        disabled={busy}
                        onChange={(e) =>
                          void mutate({
                            action: "move_document",
                            id: d.id,
                            folderId: e.target.value || null,
                          })
                        }
                      >
                        {d.inSharedFolder&&<option value="shared" disabled>В общей папке</option>}
                        <option value="">Без папки</option>
                        {folders.map((f) => (
                          <option value={f.id} key={f.id}>
                            {f.path}
                          </option>
                        ))}
                      </select>
                      <button
                        aria-label={`В корзину: ${d.title}`}
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            action: "trash_document",
                            id: d.id,
                            trashed: true,
                          })
                        }
                      >
                        <Trash2 size={15} />{refreshUi&&"В корзину"}
                      </button>
                    </>
                  )}
                </LibraryCardActions>
                {corporate&&!d.trashed&&d.reactions&&<DocumentReactions documentId={d.id} initial={d.reactions} onChanged={()=>void refresh().catch(()=>{})}/>}
              </div>
            </article>
          ))}
        </div>
        {listLoading&&!error&&<p role="status">Загружаем презентации…</p>}
        {!listLoading&&!docs.length && (
          <div className="library-empty">
            <FolderOpen size={36} />
            <h2>
              {search
                ? "Ничего не найдено"
                : folder === "trash"
                  ? "Корзина пуста"
                  : "Здесь пока нет презентаций"}
            </h2>
            <p>
              {search
                ? "Попробуйте другое название."
                : "Создайте документ или переместите его сюда из библиотеки."}
            </p>
          </div>
        )}
      </main>}
    </div>
  );
}
