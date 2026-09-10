import {InspectorResize} from './inspector-resize';
import {Popover,PopoverContent,PopoverTrigger} from './ui/popover';
import {EditorCollaboration} from './editor-collaboration';
import {TemplateLayoutReset} from './template-layout-reset';
import {WorkspaceChat} from './workspace-chat';
import {downloadSourceOriginal} from '../lib/project/download-source';
import {SharedComments} from './shared-comments';
import {EDITOR_UPGRADE_MESSAGE} from '../lib/project/editor-contract';
import {DocumentSourceAttachment} from './document-source-attachment';
import {corporateContext,libraryPath,scopedStorage,scopedApiPath} from '../lib/project/browser-context';
import {CorporateFrame} from './corporate-frame';
import {SharedDocumentViewer} from './shared-document-viewer';
import { EditorDraft, recoverableEditorDrafts } from "../lib/project/editor-draft";
import {imageUploadRequest,imageUploadJournal} from '../lib/project/image-upload';
import type {ImageUpload} from '../lib/domain/image-source';
import { mergeDocuments, conflictLabel, type MergeChoices } from "../lib/domain/document-merge";
import { CommentDraft, type CommentTarget } from "../lib/project/comment-draft";
import { localFetch, LocalRequestError } from "../lib/project/local-client";
/* eslint-disable @next/next/no-html-link-for-pages -- Standalone esbuild application, outside the Next router. */
import { editBriefField } from "../lib/domain/briefing";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LocalLibrary } from "./local-library";
import { ProjectHistory } from "./project-history";
import { DocumentChat } from "./document-chat";
import { sameDocument } from "../lib/domain/editing";
import {designReview} from '../lib/domain/design-review';
import { createRoot } from "react-dom/client";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { SlideCanvas } from "./slide-canvas";
import {DataObjectEditor} from './data-object-editor';
import {browserDataWindowStore,dataRecordSaved,type DataWindowRecord} from '../lib/project/data-window-draft';
import {dataObjectFor,applyDataObjectChange} from '../lib/domain/data-draft';
import type {DataObject} from '../lib/domain/data-object';
import {layoutConflictCanvas} from '../lib/domain/document-merge';
import {dataConflictText} from '../lib/domain/data-merge';
import { EditableSlideCanvas } from "./editable-slide-canvas";
import { SlideInspector } from "./slide-inspector";
import { ProposalBoard } from "./proposal-board";
import { designOptions, designNames, type Design } from "../lib/domain/design";
import { scene } from "../lib/domain/scene";
import { canvasFromScene } from "../lib/domain/canvas";
import {
  lintDoc,
  type DeckDoc,
  type State,
  type Slide,
  type Deck,
  blankSlide,
} from "../lib/domain/model";
import { inspectNarrative } from "../lib/domain/narrative";
import { download, safeName } from "../lib/export";
import {
  Play,
  Undo2,
  Redo2,
  Save,
  Download,
  RefreshCw,
  FolderOpen,
  MessageSquare,
  ArrowRight,
} from "lucide-react";

type Project = { empty?: false; title: string; state: State; canProposeDraft?: boolean; chatEnabled?: boolean };
const documentId = location.pathname.match(
  /^(?:\/organizations\/[a-f0-9-]{36})?\/documents\/([a-f0-9-]{36})$/,
)?.[1];
const isCorporate=!!corporateContext();
const isLibrary = document.body.dataset.workspace === "true";
const editorSlot=(()=>{try{const key="lanka:editor-tab:v1",old=sessionStorage.getItem(key);if(old)return old;const id=crypto.randomUUID();sessionStorage.setItem(key,id);return id;}catch{return crypto.randomUUID();}})();
async function api(path: string, body?: unknown, options?: {signal?: AbortSignal}) {
  if (documentId)
    path += `${path.includes("?") ? "&" : "?"}documentId=${documentId}`;
  const r = await localFetch(
    path,
    body === undefined
      ? { cache: "no-store", signal: options?.signal }
      : {
          method: "POST",
          signal: options?.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!r.ok) {
    const message = await r.text();
    try {
      throw new Error(JSON.parse(message).error || message);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(message);
      throw e;
    }
  }
  return r;
}
function Workbench() {
  const [exportEpoch,setExportEpoch]=useState(0);
  const [downloadMenuOpen,setDownloadMenuOpen]=useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraftState] = useState<DeckDoc | null>(null);
  const draftRef=useRef<DeckDoc|null>(null);
  const recovery=useRef<EditorDraft|null>(null);
  const savedForData=useRef<{doc:DeckDoc;revision:number}|null>(null),dataRead=useRef(0);
  const [dataRecords,setDataRecords]=useState<DataWindowRecord[]>([]),[dataRecordProblem,setDataRecordProblem]=useState('');
  const [dataEditing,setDataEditing]=useState<{id:string;slideId:string;element:DataObject;recovered?:DataWindowRecord}|null>(null);
  async function refreshDataRecords(){
    const snapshot=savedForData.current;if(!snapshot)return;const attempt=++dataRead.current;
    try{
      const found=await browserDataWindowStore.list(snapshot.doc.id),kept:DataWindowRecord[]=[];
      for(const record of found){
        const current=savedForData.current;
        if(current?.doc.id===record.documentId&&!recovery.current?.needsSave&&dataRecordSaved(record,dataObjectFor(current.doc,record.slideId,record.base.id),current.revision)){
          if(!await browserDataWindowStore.remove(record))kept.push(record);
        }else kept.push(record);
      }
      if(attempt===dataRead.current){setDataRecords(kept);setDataRecordProblem('');}
    }catch{if(attempt===dataRead.current)setDataRecordProblem('Не удалось прочитать черновики окна данных на устройстве.');}
  }
  function openData(element:DataObject,slideId:string,recovered?:DataWindowRecord){
    const matches=dataRecords.filter(r=>r.slideId===slideId&&r.base.id===element.id);
    const owned=matches.filter(r=>r.owner===editorSlot);
    const restored=recovered??(owned.length===1?owned[0]:matches.length===1?matches[0]:undefined);
    setDataEditing({id:crypto.randomUUID(),slideId,element:structuredClone(restored?.base??element),recovered:restored});
  }
  function applyData(value:DataObject,expected:DataObject){
    const current=draftRef.current;
    if(!current||!dataEditing||latest.current.busy)throw Error('Редактор занят. Черновик данных сохранён отдельно.');
    const next=applyDataObjectChange(current,dataEditing.slideId,value,expected);
    if(!sameDocument(next,current))edit(next,`data:${dataEditing.slideId}:${crypto.randomUUID()}`);
    const targetIndex=next.slides.findIndex(s=>s.id===dataEditing.slideId);
    if(targetIndex>=0)setIndex(targetIndex);
    setSelectedField(`element:${value.id}`);setView("slides");setMobilePanel("slides");
    return !!recovery.current?.persistent;
  }
  const saveFlight=useRef(false);
  const [saving,setSaving]=useState(false);
  const imageRequest=useRef<ImageUpload|null>(null);
  const [imagePending,setImagePending]=useState(false),[imageProblem,setImageProblem]=useState(''),[imageJournalReady,setImageJournalReady]=useState(false),[imagePersistent,setImagePersistent]=useState(false);
  const [saveProblem,setSaveProblem]=useState("");
  const [savePaused,setSavePaused]=useState(false);
  const failures=useRef(0);
  const [draftStorageWarning,setDraftStorageWarning]=useState(false);
  const [choices,setChoices]=useState<MergeChoices>({});
  const [upgradePreview,setUpgradePreview]=useState<ReturnType<EditorDraft['previewUpgrade']>|null>(null);
  const [backupImport,setBackupImport]=useState<{raw:string;choices:MergeChoices;preview:ReturnType<EditorDraft['previewBackup']>}|null>(null);
  function previewBackup(raw:string,selected:MergeChoices={}){try{setBackupImport({raw,choices:selected,preview:recovery.current!.previewBackup(raw,selected)});}catch(e){setBackupImport(null);setError((e as Error).message);}}
  const [otherDrafts,setOtherDrafts]=useState<ReturnType<typeof recoverableEditorDrafts>>([]);
  function publishDraft(doc:DeckDoc|null){if(doc&&draftRef.current&&sameDocument(doc,draftRef.current))return;draftRef.current=doc;setDraftState(doc);}
  function setDraft(value:DeckDoc|null|((old:DeckDoc|null)=>DeckDoc|null)){
    const next=typeof value==="function"?value(draftRef.current):value;
    if(next)recovery.current?.edit(next);
    publishDraft(next);latest.current.dirty=true;
    setSaveProblem("");setSavePaused(false);failures.current=0;
    setDraftStorageWarning(!recovery.current?.persistent);
  }
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const positionDocument=useRef<string|null>(null);
  useEffect(()=>{
    const slideId=draft?.slides[index]?.id;
    if(!draft||!slideId)return;
    try{scopedStorage(sessionStorage).setItem(`lanka:slide-position:v1:${draft.id}`,slideId);}catch{}
  },[draft?.id,draft?.slides[index]?.id]);
  const [view, setView] = useState(
    new URLSearchParams(location.search).has("review") ? "changes" : "slides",
  );
  const [mobilePanel, setMobilePanel] = useState(new URLSearchParams(location.search).has("chat")?"chat":"slides");
  const [sidePanel, setSidePanel] = useState(new URLSearchParams(location.search).has("chat")?"agent":"edit");
  const [chatOpened,setChatOpened]=useState(new URLSearchParams(location.search).has("chat"));
  const [focusedProposalId,setFocusedProposalId]=useState<string|null>(()=>{const id=new URLSearchParams(location.search).get("review");return id&&/^[a-f0-9-]{36}$/.test(id)?id:null;});
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [refreshUI]=useState(()=>document.body.dataset.ui==='refresh');
  const DesignSettings = refreshUI ? 'details' : 'div';
  const [wideEditor,setWideEditor]=useState(()=>matchMedia('(min-width:901px)').matches);
  const [propertiesHost,setPropertiesHost]=useState<HTMLDivElement|null>(null);
  useEffect(()=>{const query=matchMedia('(min-width:901px)'),update=()=>setWideEditor(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);

  const workbenchRef = useRef<HTMLDivElement>(null);
  // Header buttons and the save status wrap at narrow widths. Reserve their actual height for chat.
  useLayoutEffect(() => {
    const root = workbenchRef.current, columns = root?.querySelector<HTMLElement>(".project-columns");
    if (!root || !columns) return;
    const header = root.querySelector(".project-topbar"), nav = root.querySelector(".project-mobile-nav");
    const measure = () => {
      const chrome = columns.getBoundingClientRect().top + window.scrollY + (nav?.getBoundingClientRect().height || 0);
      root.style.setProperty("--editor-chrome-height", `${Math.max(0, Math.ceil(chrome))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    if (nav) observer.observe(nav);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  });
  const [presenting, setPresenting] = useState(false);
  const presentationDialog=useRef<HTMLDialogElement>(null);
  useLayoutEffect(()=>{
    if(!presenting)return;
    const origin=document.activeElement as HTMLElement|null;
    presentationDialog.current?.showModal();
    return()=>{origin?.focus();};
  },[presenting]);
  const [undo, setUndo] = useState<DeckDoc[]>([]);
  const [redo, setRedo] = useState<DeckDoc[]>([]);
  const lastEdit = useRef(0);
  const lastEditGroup = useRef("");
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTarget,setNoteTarget]=useState<CommentTarget|null>(null);
  const noteDraft=useRef<CommentDraft|null>(null);
  const [noteStorageWarning,setNoteStorageWarning]=useState(false);
  useEffect(()=>{
    if(!project)return;
    let storage:Storage|null=null;try{storage=scopedStorage(window.sessionStorage);}catch{}
    const saved=new CommentDraft(storage,project.state.doc.id);noteDraft.current=saved;
    setNote(saved.text);setNoteTarget(saved.target);setNoteStorageWarning(!saved.persistent);
    if(saved.text){
      setSidePanel("comments");setMobilePanel("feedback");
      const targetIndex=project.state.doc.slides.findIndex(s=>s.id===saved.target?.slideId);
      if(targetIndex>=0){setIndex(targetIndex);if(saved.target?.elementId)setSelectedField(`element:${saved.target.elementId}`);}
    }
  },[project?.state.doc.id]);
  function updateNote(text:string,target:CommentTarget|null){
    noteDraft.current?.set(text,target);setNote(text);setNoteTarget(target);setNoteStorageWarning(!noteDraft.current?.persistent);
  }
  const [markdown, setMarkdown] = useState("");
  const dirty = !!recovery.current?.pending || !!draft && !sameDocument(draft, project?.state.doc || draft);
  const conflicts=recovery.current?.conflicts??[];
  const conflictKey=JSON.stringify(conflicts);
  useEffect(()=>setChoices({}),[conflictKey]);
  const latest = useRef({ dirty, busy, project });
  useEffect(()=>{
    const id=project?.state.doc.id;if(!id)return;let live=true;
    void imageUploadJournal(id,editorSlot,'read').then(request=>{if(live&&request){imageRequest.current=request;setImagePending(true);setImagePersistent(true);setImageProblem('Есть незавершённая загрузка изображения. Повторите её, чтобы проверить результат.');}}).catch(()=>{}).finally(()=>{if(live)setImageJournalReady(true);});
    return()=>{live=false;};
  },[project?.state.doc.id]);
  useLayoutEffect(() => {
    latest.current = { dirty, busy, project };
  });
  const ticket = useRef(0);
  const retry = useRef<{ payload: string; requestId: string } | null>(null);
  async function refresh(force = false,discard = false) {
    if(saveFlight.current)return;
    const current = ++ticket.current;
    try {
      const p = (await (await api("/api/project")).json()) as
        | Project
        | { empty: true; state?: undefined };
      if (current !== ticket.current) return;
      setSyncError("");
      setLoaded(true);
      if(!force&&latest.current.busy)return;
      if(p.empty){savedForData.current=null;setDataRecords([]);setProject(null);publishDraft(null);recovery.current=null;return;}
      let journal=recovery.current;
      if(!journal||journal.doc.id!==p.state.doc.id){
        let storage:Storage|null=null;try{storage=scopedStorage(localStorage);}catch{}
        journal=new EditorDraft(storage,p.state.doc.id,{doc:p.state.doc,revision:p.state.revision},editorSlot);recovery.current=journal;
        if(journal.recovered)setNotice("Восстановлены правки из этой вкладки.");
      } else {
        const previous=journal.base;
        if(discard)journal.reset({doc:p.state.doc,revision:p.state.revision});
        else journal.receive({doc:p.state.doc,revision:p.state.revision});
        if(previous.revision!==journal.base.revision){
          if(!journal.conflicts.length){setSavePaused(false);setSaveProblem("");}
          // Undo may undo this author's changes, never an independently received edit.
          const rebase=(history:DeckDoc[])=>history.flatMap(doc=>{const result=mergeDocuments(previous.doc,doc,p.state.doc);return result.conflicts.length?[]:[result.doc];});
          setUndo(rebase);setRedo(rebase);
        }
      }
      try{setOtherDrafts(recoverableEditorDrafts(scopedStorage(localStorage),p.state.doc.id,editorSlot));}catch{}
      savedForData.current={doc:p.state.doc,revision:p.state.revision};void refreshDataRecords();
      let restoredPosition:number|null=null;
      if(positionDocument.current!==journal.doc.id){
        positionDocument.current=journal.doc.id;
        try{const slideId=scopedStorage(sessionStorage).getItem(`lanka:slide-position:v1:${journal.doc.id}`);const position=journal.doc.slides.findIndex(s=>s.id===slideId);restoredPosition=Math.max(0,position);}catch{restoredPosition=0;}
      }
      setProject(p);publishDraft(structuredClone(journal.doc));
      setDraftStorageWarning(!journal.persistent);
      if(discard){setUndo([]);setRedo([]);setSaveProblem("");setSavePaused(false);setNotice("");}
      setIndex(i=>restoredPosition??Math.max(0,Math.min(i,journal.doc.slides.length-1)));
    } catch (e) {
      setSyncError((e as Error).message);
    }
  }
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => {
      if (!latest.current.busy) void refresh();
    }, 2500);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty && draftStorageWarning || note.trim() && noteStorageWarning || imagePending&&!imagePersistent) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty,draftStorageWarning,note,noteStorageWarning,imagePending,imagePersistent]);
  async function sendImageUpload(request:ImageUpload){
    const response=await localFetch(`/api/images${documentId?`?documentId=${documentId}`:''}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
    const result=await response.json() as {elementId:string;revision:number};
    if(typeof result.elementId!=='string'||!Number.isSafeInteger(result.revision))throw Error('Не подтверждён результат загрузки.');
    const journal=recovery.current;
    if(journal&&!journal.needsSave&&journal.base.revision===request.expectedRevision){
      // Read the exact saved revision so Undo removes our image but retains later remote edits.
      const saved=await api(`/api/history?revision=${result.revision}`).then(r=>r.json() as Promise<DeckDoc>).catch(()=>null);
      if(saved){const before=journal.adoptSavedChange({doc:saved,revision:result.revision},request.expectedRevision);if(before){setUndo(all=>[...all,before].slice(-50));setRedo([]);publishDraft(structuredClone(journal.doc));}}
    }
    imageRequest.current=null;setImagePending(false);setImageProblem('');setSelectedField(`element:${result.elementId}`);
    await imageUploadJournal(request.deckId,editorSlot,'delete').catch(()=>{});
  }
  async function uploadImageFile(file?:File,elementId?:string){
    if(latest.current.busy||saveFlight.current||latest.current.dirty)return;
    const current=latest.current.project;if(!current||!draftRef.current)return;
    latest.current.busy=true;setBusy(true);ticket.current++;setImageProblem('');
    try{
      let request=imageRequest.current;
      if(file){
        if(request)throw Error('Сначала завершите предыдущую загрузку.');
        setImagePending(true);setImagePersistent(false);
        request=await imageUploadRequest(file,{deckId:current.state.doc.id,expectedRevision:current.state.revision,slideId:draftRef.current.slides[index].id,...(elementId?{elementId}:{})});
        imageRequest.current=request;
        try{await imageUploadJournal(request.deckId,editorSlot,'write',request);setImagePersistent(true);}catch{}
      }
      if(request)await sendImageUpload(request);
    }catch(e){
      const authRequired=e instanceof LocalRequestError&&(e.status===401||e.code==='ACCOUNT_CHANGED');
      const definite=e instanceof LocalRequestError&&!!e.status&&e.status>=400&&e.status<500&&!authRequired;
      if(definite||!imageRequest.current){
        const request=imageRequest.current;imageRequest.current=null;setImagePending(false);
        if(request)await imageUploadJournal(request.deckId,editorSlot,'delete').catch(()=>{});
        setImageProblem((e as Error).message);
      }else setImageProblem('Загрузка пока не подтверждена. Повторите отправку: тот же запрос не создаст дубликат.');
    }finally{latest.current.busy=false;setBusy(false);void refresh(true);}
  }
  async function saveNow(){
    const journal=recovery.current;if(!journal||saveFlight.current||latest.current.busy||journal.conflicts.length||!journal.needsSave)return;
    saveFlight.current=true;setSaving(true);ticket.current++;setSaveProblem("");
    let request:ReturnType<EditorDraft["prepare"]>=null;
    try{
      request=journal.prepare();if(!request)return;
      const response=await localFetch(`/api/project${documentId?`?documentId=${documentId}`:""}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});
      const result=await response.json() as {revision:number};journal.acknowledge(request.requestId,result.revision);
      publishDraft(structuredClone(journal.doc));failures.current=0;setSavePaused(false);setNotice("");
      setProject(old=>old?{...old,state:{...old.state,doc:structuredClone(journal.base.doc),revision:journal.base.revision,approvedRevision:null,approvedBy:null}}:old);
    }catch(e){
      const definite=e instanceof LocalRequestError&&!!e.status&&e.status>=400&&e.status<500;
      if(request&&definite)journal.rejected(request.requestId);
      setSavePaused(definite||!request);failures.current++;
      setSaveProblem(definite||!request?(e as Error).message:"Сохранение пока не подтверждено. Правки остаются на экране и в доступном локальном хранилище; повторим отправку при восстановлении связи.");
    }finally{
      saveFlight.current=false;setSaving(false);setDraftStorageWarning(!journal.persistent);
      void refresh();
    }
  }
  useEffect(()=>{
    if(!recovery.current?.needsSave||saving||busy||conflicts.length||savePaused)return;
    const timer=setTimeout(()=>{if(navigator.onLine!==false)void saveNow();},failures.current?Math.min(30000,2000*2**Math.min(failures.current-1,4)):900);
    return()=>clearTimeout(timer);
  },[draft,saving,busy,savePaused,conflictKey,saveProblem]);
  useEffect(()=>{const online=()=>{setSavePaused(false);void saveNow();};window.addEventListener("online",online);const restored=()=>{void refresh().then(()=>{setSavePaused(false);void saveNow();});};window.addEventListener("lanka:auth-restored",restored);return()=>{window.removeEventListener("online",online);window.removeEventListener("lanka:auth-restored",restored);};},[]);
  function resolveVersions(){
    const journal=recovery.current;if(!journal)return;
    try{const remote=journal.remoteSnapshot!;journal.resolve(choices);publishDraft(structuredClone(journal.doc));setUndo([structuredClone(remote.doc)]);setRedo([]);setSavePaused(false);setSaveProblem("");}
    catch(e){setSaveProblem((e as Error).message);}
  }
  async function command(value: Record<string, unknown>) {
    if(value.action==="save"){setSavePaused(false);await saveNow();return;}
    if (latest.current.busy||saveFlight.current||latest.current.dirty) return;
    latest.current.busy = true;
    ticket.current++;
    setBusy(true);
    setError("");
    const payload = {
      deckId: project?.state.doc.id,
      expectedRevision: project?.state.revision,
      command: value,
    };
    const bytes = JSON.stringify(payload);
    if (retry.current?.payload !== bytes)
      retry.current = { payload: bytes, requestId: crypto.randomUUID() };
    let commentRequestId:string|undefined;
    try {
      const request=value.action==="comment"&&noteDraft.current
        ?noteDraft.current.prepare(project!.state.revision,value)
        :{...payload,requestId:retry.current.requestId};
      commentRequestId=request.requestId;
      await api("/api/project", request);
      retry.current = null;
      if (value.action !== "save") {
        setUndo([]);
        setRedo([]);
      }
      await refresh(true);
      if (value.action === "comment") {
        noteDraft.current?.acknowledge(request.requestId);
        setNote(noteDraft.current?.text??"");setNoteTarget(noteDraft.current?.target??null);
        setNoteStorageWarning(!noteDraft.current?.persistent);
      }
    } catch (e) {
      if(commentRequestId&&value.action==="comment"&&e instanceof LocalRequestError&&e.status&&e.status>=400&&e.status<500)
        noteDraft.current?.rejected(commentRequestId);
      setError((e as Error).message);
    } finally {
      latest.current.busy = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const save = (e: KeyboardEvent) => {
      if(e.isComposing||e.keyCode===229)return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !busy) void command({ action: "save", doc: draft });
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  });
  async function exportFile(format: "pdf" | "pptx") {
    if (!project || dirty || latest.current.busy||saveFlight.current) return;
    latest.current.busy = true;
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/export", {
        deckId: project.state.doc.id,
        expectedRevision: project.state.revision,
        format,
      });
      download(
        await r.blob(),
        `${safeName(project.state.doc.title)}-v${project.state.revision}.${format}`,
      );
      setExportEpoch(v=>v+1);
      setNotice(`Файл версии ${project.state.revision} готов. Сохранённые выгрузки доступны в «Истории».${format==='pptx'&&project.state.doc.design==='focus-v3'?' Там же можно скачать шрифты Focus 3 для PowerPoint и Keynote.':''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      latest.current.busy = false;
      setBusy(false);
    }
  }
  function edit(next: DeckDoc, group = "document") {
    const previous=draftRef.current;
    if (previous && (Date.now() - lastEdit.current > 700 || lastEditGroup.current !== group)) {
      setUndo((all) => [...all, structuredClone(previous)].slice(-50));
    }
    lastEdit.current = Date.now();
    lastEditGroup.current = group;
    setRedo([]);
    latest.current.dirty = true;
    setDraft(next);
  }
  function change(patch: Partial<Slide>, group = "slide") {
    if (draft)
      edit({
        ...draft,
        slides: draft.slides.map((s, i) =>
          i === index ? { ...s, ...patch } : s,
        ),
      }, group);
  }
  function moveSlide(delta: number) {
    if (!draft || index + delta < 0 || index + delta >= draft.slides.length)
      return;
    const slides = [...draft.slides];
    [slides[index], slides[index + delta]] = [
      slides[index + delta],
      slides[index],
    ];
    edit({ ...draft, slides });
    setIndex(index + delta);
  }
  function showChanges() {
    setFocusedProposalId(null);
    setView("changes");
    setMobilePanel("slides");
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (presenting && e.key === "Tab") {
        const buttons=Array.from(presentationDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
        const first=buttons[0],last=buttons[buttons.length-1];
        if(first&&last&&((e.shiftKey&&document.activeElement===first)||(!e.shiftKey&&document.activeElement===last))){e.preventDefault();(e.shiftKey?last:first).focus();}
      }
      if (e.key === "Escape") setPresenting(false);
      if (presenting && ["ArrowRight", "ArrowLeft", "PageDown", "PageUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const last=(draft?.slides.length || 1)-1;
        setIndex(i=>e.key==='Home'?0:e.key==='End'?last:Math.max(0,Math.min(last,i+(["ArrowRight","PageDown"].includes(e.key)?1:-1))));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [presenting, draft?.slides.length]);
  const slide = draft?.slides[index];
  // Template slides show generated objects. Map the canonical `element:<id>` selection back to the
  // semantic field it was rendered from (title, body, metric:<id>:label, …) so the inspector and chat
  // can follow it. `selectedField` itself stays `element:<id>`: the canvas highlight depends on it.
  const sourceField = useMemo(() => {
    if (!draft || !slide || slide.canvas || !selectedField?.startsWith("element:")) return null;
    const object = canvasFromScene(scene(slide, draft.brand, index, draft.slides.length, draft.design)).find(e => e.id === selectedField.slice(8));
    return object?.kind === "text" ? object.sourceField ?? null : null;
  }, [draft, slide, index, selectedField]);
  const semanticField = sourceField ?? selectedField;
  const selectedObject=slide?.canvas?.find(e=>`element:${e.id}`===selectedField);
  const inspectedObject=useMemo(()=>{
    if(!refreshUI||!draft||!slide||!selectedField?.startsWith('element:'))return null;
    return (slide.canvas??canvasFromScene(scene(slide,draft.brand,index,draft.slides.length,draft.design))).find(e=>e.id===selectedField.slice(8))??null;
  },[refreshUI,draft,slide,index,selectedField]);
  const showObjectInspector=!!inspectedObject&&view==='slides'&&sidePanel==='edit'&&(wideEditor||mobilePanel==='edit');

  const commentTarget=noteTarget??{slideId:slide?.id??"",...(selectedObject?{elementId:selectedObject.id}:{})};
  const commentSlide=draft?.slides.find(s=>s.id===commentTarget.slideId);
  const commentObject=commentSlide?.canvas?.find(e=>e.id===commentTarget.elementId);
  const commentTargetMissing=!commentSlide||!!commentTarget.elementId&&!commentObject;
  const pending =
    project?.state.proposals.filter((p) => p.status === "pending").length || 0;
  const brief = draft?.brief || { audience: "", decision: "", keyMessage: "" };
  const deck: Deck | null = project
    ? {
        id: project.state.doc.id,
        owner: "local-owner",
        version: project.state.revision,
        updatedAt: "",
        state: project.state,
        role: "owner",
      }
    : null;
  const designChecks=useMemo(()=>draft?designReview(draft):null,[draft]);
  const compositionAdvice=designChecks?.composition?.advisories??[];
  const issues = useMemo(()=>draft ? [...lintDoc(draft), ...inspectNarrative(draft), ...(designChecks?.issues??[])] : [],[draft,designChecks]);
  // One readable save state for the top bar; the same reason explains every button that waits for a saved revision.
  const saveState = saving
    ? { tone: "saving", text: "Сохраняем…", title: "Отправляем правки на сервер." }
    : conflicts.length
      ? { tone: "error", text: "Нужен выбор версии", title: "Одни и те же данные изменены в двух версиях. Выберите вариант в уведомлении ниже." }
      : saveProblem
        ? { tone: "error", text: savePaused ? "Не сохранено" : "Не подтверждено · повторим", title: saveProblem }
        : dirty
          ? { tone: "pending", text: "Сохраним после паузы во вводе", title: "Правки на экране ещё не сохранены. Автосохранение сработает примерно через секунду после паузы во вводе; кнопка «Сохранить» отправит их сразу." }
          : project
            ? { tone: "saved", text: `Сохранено · версия ${project.state.revision}`, title: "Все правки сохранены." }
            : { tone: "idle", text: "Локальный документ", title: "" };
  const blockedReason = !project
    ? ""
    : conflicts.length
      ? "Сначала выберите версию в уведомлении о конфликте."
      : saving
        ? "Дождитесь окончания сохранения."
        : saveProblem
          ? saveProblem===EDITOR_UPGRADE_MESSAGE ? "Сначала перенесите правки в актуальный редактор. Повтор сохранения в этой вкладке не поможет." : "Сохранение не подтверждено. Нажмите «Сохранить» или дождитесь восстановления связи."
          : dirty
            ? "Дождитесь сохранения правок: автосохранение сработает после паузы во вводе."
            : busy
              ? "Дождитесь завершения текущей операции."
              : "";
  const saveBlocked = !!project && (!!conflicts.length || saving || !!saveProblem || dirty);
  const alertIsError = !!(error || saveProblem || syncError || draftStorageWarning);
  return (
    <div className="project-workbench" ref={workbenchRef}>
      <header className="project-topbar">
        <div className="editor-document-title">
          {isLibrary && (
            <a href={libraryPath()} aria-label="Все презентации" className="editor-back">
              ←
            </a>
          )}
          <div>
            <input
              aria-label="Название презентации"
              value={draft?draft.title:"Новая презентация"}
              placeholder="Название презентации"
              disabled={!draft || busy}
              maxLength={140}
              onChange={(e) =>
                draft && edit({ ...draft, title: e.target.value })
              }
            />
            <span className="hint">
              {draft
                ? designNames[draft.design || "classic-v1"]
                : "Локальный документ"}
            </span>
          </div>
        </div>
        <span className="save-state" role="status" data-tone={saveState.tone} title={saveState.title || undefined}>
          <span className="save-state-dot" aria-hidden="true" />
          {saveState.text}
        </span>
        <div className="row flex-wrap">
          {isCorporate&&project&&<EditorCollaboration revision={project.state.revision} disabled={busy||dirty}/>}
          <Button
            variant="ghost"
            title="Отменить правку"
            className="editor-history-action"
            aria-label="Отменить правку"
            disabled={busy || !undo.length}
            onClick={() => {
              const d = undo.at(-1);
              if (d && draft) {
                setUndo(undo.slice(0, -1));
                setRedo([...redo, draft]);
                setDraft(d);
                lastEdit.current = 0;
              }
            }}
          >
            <Undo2 size={16} aria-hidden="true"/>
          </Button>
          <Button
            variant="ghost"
            title="Повторить правку"
            className="editor-history-action"
            aria-label="Повторить правку"
            disabled={busy || !redo.length}
            onClick={() => {
              const d = redo.at(-1);
              if (d && draft) {
                setRedo(redo.slice(0, -1));
                setUndo([...undo, draft]);
                setDraft(d);
              }
            }}
          >
            <Redo2 size={16} aria-hidden="true"/>
          </Button>
          <Button
            variant="outline"
            disabled={!project}
            className="editor-discuss-action"
            onClick={()=>{setChatOpened(true);setSidePanel("agent");setMobilePanel("chat");setView("slides");}}
          >
            <MessageSquare size={16}/>
            Обсудить
          </Button>
          <Button
            variant="outline"
            disabled={!project}
            className="editor-present-action"
            aria-label="Показать"
            title="Показать презентацию"
            onClick={() => {
              setPresenting(true);
              setView("slides");
            }}
          >
            <Play size={16} aria-hidden="true"/><span>Показать</span>
          </Button>
          <Button
            variant="outline"
            className="editor-save-action"
            data-needed={dirty||saving||!!saveProblem}
            disabled={busy || saving || !dirty || !!conflicts.length}
            onClick={() => void command({ action: "save", doc: draft })}
          >
            <Save size={16} />
            Сохранить
          </Button>
          <Button
            variant="outline"
            disabled={!project || busy || saving || dirty}
            className="editor-inline-export"
            title={blockedReason || "Скачать PDF последней сохранённой версии"}
            onClick={() => void exportFile("pdf")}
          >
            <Download size={16} />
            PDF
          </Button>
          <Button
            disabled={!project || busy || saving || dirty}
            className="editor-inline-export"
            title={blockedReason || "Редактируемые объекты и данные. PowerPoint может изменить интервалы; точная композиция — в PDF."}
            onClick={() => void exportFile("pptx")}
          >
            <span className="desktop-export-label">PowerPoint</span>
            <span className="mobile-export-label">PPTX</span>
            <ArrowRight size={16} />
          </Button>
          <div className="editor-mobile-download">
            <Popover open={downloadMenuOpen} onOpenChange={setDownloadMenuOpen}>
              <PopoverTrigger asChild><Button disabled={!project} aria-label="Скачать презентацию"><Download size={16} aria-hidden="true"/><span>Скачать</span></Button></PopoverTrigger>
              <PopoverContent align="end" className="editor-download-options" aria-label="Скачать презентацию">
                <p className="editor-download-version">Сохранённая версия {project?.state.revision}</p>
                {blockedReason&&<p role="status" className="hint">{blockedReason}</p>}
                <Button variant="ghost" disabled={!project||busy||saving||dirty} onClick={()=>{setDownloadMenuOpen(false);void exportFile('pdf');}}><span>PDF<small>Для просмотра и отправки</small></span></Button>
                <Button variant="ghost" disabled={!project||busy||saving||dirty} onClick={()=>{setDownloadMenuOpen(false);void exportFile('pptx');}}><span>PowerPoint<small>Редактируемые объекты · PPTX</small></span></Button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </header>
      {(error || syncError || notice || saveProblem || draftStorageWarning) && (
        <div className={`project-alert${alertIsError ? "" : " project-alert-status"}`} role={alertIsError ? "alert" : "status"}>
          <p>{error || (saveProblem&&conflicts.length?"Правки этой вкладки остаются на экране. Выберите нужные варианты ниже и нажмите «Объединить выбранные правки».":saveProblem) || syncError || notice || "Хранилище устройства недоступно. До подтверждения сервером не закрывайте страницу."}</p>
          {!alertIsError && (
            <Button variant="ghost" size="sm" onClick={() => setNotice("")}>
              Скрыть
            </Button>
          )}
          {dirty && (
            <Button
              variant="outline"
              onClick={() =>
                download(
                  new Blob([JSON.stringify(draft, null, 2)], {
                    type: "application/json",
                  }),
                  "unsaved-deck.json",
                )
              }
            >
              Скачать мои правки
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || saving || dirty}
            title={busy || saving || dirty ? blockedReason : "Перечитать сохранённую версию с сервера"}
            onClick={() => {
              setError("");
              void refresh(true);
            }}
          >
            <RefreshCw size={15} />
            Обновить
          </Button>
          {dirty && (
            <details>
              <summary>Взять сохранённую версию</summary>
              <p>
                Правки на экране будут заменены последней сохранённой версией.
                Сначала скачайте их, если они нужны.
              </p>
              <Button
                variant="outline"
                disabled={busy||saving||!!recovery.current?.pending}
                onClick={() => {
                  setError("");
                  void refresh(true,true);
                }}
              >
                Заменить мои правки
              </Button>
            </details>
          )}
        </div>
      )}
      {backupImport&&<section className="project-alert backup-import-panel" aria-label="Восстановление копии">
        <h3>Проверить восстановление черновика</h3>
        <p>Совместимые изменения будут объединены с текущей презентацией. Сохранение создаст новую версию.</p>
        {backupImport.preview.conflicts.map(c=><div key={c.key}><strong>{conflictLabel(backupImport.preview.before,c.path)}</strong>{(['local','remote'] as const).map(side=><div key={side}><p>{side==='local'?'Из копии':'В текущей презентации'}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{typeof c[side]==='string'?c[side]:JSON.stringify(c[side],null,2)??'Удалено'}</pre><Button onClick={()=>previewBackup(backupImport.raw,{...backupImport.choices,[c.key]:side})}>Выбрать {side==='local'?'копию':'текущий вариант'}</Button></div>)}</div>)}
        {backupImport.preview.after&&<><p>Название: {backupImport.preview.before.title} → {backupImport.preview.after.title}</p>{backupImport.preview.after.slides.map((after,i)=>{const before=backupImport.preview.before.slides.find(s=>s.id===after.id);if(before&&JSON.stringify(before)===JSON.stringify(after))return null;return <details key={after.id} open><summary>Слайд {i+1} · {after.title}</summary><div className="review-pair"><div><p>Сейчас</p>{before?<SlideCanvas slide={before} brand={backupImport.preview.before.brand} design={backupImport.preview.before.design}/>:<p>Новый слайд</p>}</div><div><p>После восстановления</p><SlideCanvas slide={after} brand={backupImport.preview.after!.brand} design={backupImport.preview.after!.design}/></div></div></details>;})}{backupImport.preview.before.slides.filter(s=>!backupImport.preview.after!.slides.some(a=>a.id===s.id)).map(s=><p key={s.id}>Будет удалён слайд: {s.title}</p>)}</>}
        <Button disabled={busy||saving||dirty||!!blockedReason||!backupImport.preview.after} onClick={()=>{try{const next=recovery.current!.confirmBackup(backupImport.raw,backupImport.preview.stamp,backupImport.choices);edit(next);setBackupImport(null);}catch(e){setBackupImport(null);setError((e as Error).message);}}}>Восстановить и сохранить</Button>
        <Button variant="ghost" onClick={()=>setBackupImport(null)}>Отмена</Button>
      </section>}
      {recovery.current?.needsUpgrade&&dirty&&<section className="project-alert" aria-label="Перенос старого черновика">
        <h3>Продолжить работу с сохранённым черновиком</h3>
        <p>Сравните его с актуальной презентацией. После подтверждения сохраним резервную копию на этом устройстве и отправим проверенный вариант. Спорные правки сначала нужно разобрать ниже.</p>
        <Button disabled={busy||saving||!!recovery.current?.pending||!!conflicts.length} onClick={()=>{try{setUpgradePreview(recovery.current!.previewUpgrade());}catch(e){setSaveProblem((e as Error).message);}}}>Посмотреть перенос</Button>
        {upgradePreview&&<div>
          <p>Название: {upgradePreview.before.title} → {upgradePreview.after.title}</p>
          {upgradePreview.after.slides.map((after,i)=>{const before=upgradePreview.before.slides.find(s=>s.id===after.id);if(before&&JSON.stringify(before)===JSON.stringify(after))return null;return <details key={after.id} open><summary>Слайд {i+1} · {after.title}</summary><div className="review-pair"><div><p>Сохранено на сервере</p>{before?<SlideCanvas slide={before} brand={upgradePreview.before.brand} design={upgradePreview.before.design} total={upgradePreview.before.slides.length}/>:<p>Новый слайд</p>}</div><div><p>После переноса</p><SlideCanvas slide={after} brand={upgradePreview.after.brand} design={upgradePreview.after.design} total={upgradePreview.after.slides.length}/></div></div></details>;})}
          {upgradePreview.before.slides.filter(s=>!upgradePreview.after.slides.some(a=>a.id===s.id)).map(s=><p key={s.id}>Будет удалён слайд: {s.title}</p>)}
          <details><summary>Все данные переносимого документа</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(upgradePreview.after,null,2)}</pre></details>
          <Button disabled={busy||saving||!!conflicts.length} onClick={()=>{try{recovery.current!.confirmUpgrade(upgradePreview.stamp);publishDraft(structuredClone(recovery.current!.doc));setUpgradePreview(null);setSaveProblem('');setSavePaused(false);}catch(e){setUpgradePreview(null);setSaveProblem((e as Error).message);}}}>Подтвердить перенос и сохранить</Button>
          <Button variant="outline" onClick={()=>setUpgradePreview(null)}>Отмена</Button>
        </div>}
      </section>}
      {(imagePending||imageProblem)&&<div className="project-alert" role="status"><p>{imageProblem||'Загружаем изображение…'}</p>{imagePending&&!busy&&<Button disabled={dirty||saving} onClick={()=>void uploadImageFile()}>Повторить загрузку</Button>}{imagePending&&!imagePersistent&&<p>Копия загрузки не сохранена на устройстве. Не закрывайте вкладку до подтверждения.</p>}</div>}
      {!!dataRecordProblem&&<div className="project-alert" role="status">{dataRecordProblem}</div>}
      {!!dataRecords.length&&draft&&<details className="project-alert" open><summary>Незавершённые правки данных · {dataRecords.length}</summary>
        <p>Черновики таблиц и диаграмм хранятся на этом устройстве отдельно от презентации. Можно продолжить правку или скачать копию, даже если объект удалён.</p>
        {dataRecords.map(record=>{const position=draft.slides.findIndex(s=>s.id===record.slideId);return <div key={record.id}><span>{position>=0?`Слайд ${position+1}`:'Удалённый слайд'} · {record.base.kind==='chart'?'Диаграмма':'Таблица'} · {new Date(record.updatedAt).toLocaleString()}</span> <Button disabled={busy||!!dataEditing} onClick={()=>{if(position>=0){setIndex(position);setSelectedField(`element:${record.base.id}`);setView('slides');setMobilePanel('slides');}openData(record.base,record.slideId,record);}}>Продолжить правку</Button></div>;})}
      </details>}
      {!!otherDrafts.length&&!dirty&&<details className="project-alert"><summary>На этом устройстве есть несохранённые копии · {otherDrafts.length}</summary>
        <p>Они могут принадлежать другой открытой вкладке. Можно восстановить копию здесь; другая вкладка останется без изменений.</p>
        {otherDrafts.map(copy=><div key={copy.key}><span>{copy.title||"Без названия"} · {new Date(copy.updatedAt).toLocaleString()}</span> <Button disabled={busy||saving} onClick={()=>{try{recovery.current!.adopt(copy.raw);publishDraft(structuredClone(recovery.current!.doc));setUndo([]);setRedo([]);setSaveProblem("");setSavePaused(false);}catch(e){setSaveProblem((e as Error).message);}}}>Восстановить копию</Button></div>)}
      </details>}
      {!!conflicts.length&&draft&&<section className="project-alert" aria-label="Конфликт версий">
        <h3>Одни и те же данные изменены в двух версиях</h3>
        <p>Выберите вариант для каждого спорного поля. Независимые правки обеих версий сохранятся.</p>
        {conflicts.map(c=><div className="property-card" key={c.key}>
          <strong>{conflictLabel(draft,c.path)}</strong>
          <div className="review-text-diff">{([['local','Мои правки',c.local],['remote','На сервере',c.remote]] as const).map(([choice,label,value])=><div key={choice}>
            <p>{label}</p>{c.path.length===3&&c.path[2]==="canvas"&&Array.isArray(value)?<><p>{c.layoutIds?"Выберите положение конфликтующих объектов. Независимые данные и тексты сохранятся.":"Изменился порядок или состав объектов. Выберите одну версию композиции."}</p>{c.layoutIds?.some(id=>!value.some(e=>e.id===id))&&<p>Новые объекты, отсутствующие в этом варианте, не будут добавлены.</p>}<SlideCanvas slide={{...draft.slides.find(s=>s.id===c.path[1])!,canvas:layoutConflictCanvas(draft.slides.find(s=>s.id===c.path[1])!.canvas??[],value as NonNullable<Slide["canvas"]>,c.layoutIds)}} brand={draft.brand} design={draft.design}/></>:<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{(()=>{const object=c.path[2]==='canvas'?dataObjectFor(draft,c.path[1],c.path[3]):undefined;return object&&(c.path[4]==='data'||c.path[4]==='dataContent')?dataConflictText(object,c.path[4]==='dataContent'?['data']:c.path.slice(5),value,project?.state.sources??[]):value===undefined?'Удалено':typeof value==='string'?value:JSON.stringify(value,null,2);})()}</pre>}
            <Button variant={choices[c.key]===choice?"default":"outline"} onClick={()=>setChoices(v=>({...v,[c.key]:choice}))}>{choices[c.key]===choice?"Выбрано: ":"Выбрать: "}{label}</Button>
          </div>)}</div>
        </div>)}
        <Button disabled={busy||saving||conflicts.some(c=>!choices[c.key])} onClick={resolveVersions}>Объединить выбранные правки</Button>
      </section>}
      {!loaded ? (
        <p className="p-8">Открываем проект…</p>
      ) : !project || !draft || !slide ? (
        <main className="project-empty">
          <FolderOpen size={32} />
          <h1>История начинается здесь.</h1>
          <p>
            Создайте презентацию из структуры или поручите её агенту,
            подключённому к этой папке.
          </p>
          <Textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={10}
            placeholder={
              "# Название\n\n## Первый слайд\nГлавная мысль\n\n## Следующий шаг\nЧто нужно решить"
            }
          />
          <Button
            disabled={!markdown.trim() || busy}
            onClick={() => void command({ action: "create", markdown })}
          >
            Создать из структуры
            <ArrowRight size={16} />
          </Button>
        </main>
      ) : (
        <main className="project-columns" data-panel={mobilePanel} data-chat={sidePanel==="agent"}>
          <nav className="project-mobile-nav" aria-label="Панели редактора">
            {[
              ["slides", "Слайды"],
              ["edit", "Содержание"],
              ["feedback", "Комментарии"],
              ["chat", "Агент"],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={mobilePanel === key}
                onClick={() => {
                  setMobilePanel(key);
                  setSidePanel(key === "feedback" ? "comments" :key==="chat"?"agent": "edit");
                  if(key==="chat")setChatOpened(true);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <aside className="project-slides">
            <div className="project-panel-title">
              <strong>Слайды · {draft.slides.length}</strong>
              <button
                aria-label="Добавить слайд"
                disabled={busy || draft.slides.length >= 40}
                onClick={() => {
                  const slides = [...draft.slides];
                  slides.splice(index + 1, 0, blankSlide("content"));
                  edit({ ...draft, slides });
                  setIndex(index + 1);
                }}
              >
                ＋
              </button>
            </div>
            <div className="project-filmstrip">
              {draft.slides.map((s, i) => (
                <button
                  key={s.id}
                  className={i === index ? "selected" : ""}
                  aria-label={`Слайд ${i + 1}: ${s.title}`}
                  aria-pressed={i === index}
                  onClick={() => {
                    setIndex(i);
                    setView("slides");
                    setSelectedField(null);
                  }}
                >
                  <span>{i + 1}</span>
                  <SlideCanvas
                    slide={s}
                    brand={draft.brand}
                    design={draft.design}
                    index={i}
                    total={draft.slides.length}
                  />
                </button>
              ))}
            </div>
          </aside>
          <section className="project-stage">
            <div className="editor-toolbar">
              <Tabs value={view} onValueChange={value=>{setFocusedProposalId(null);setView(value);}}>
                <TabsList>
                  <TabsTrigger value="slides">Слайд</TabsTrigger>
                  <TabsTrigger value="changes">
                    Изменения{pending ? ` · ${pending}` : ""}
                  </TabsTrigger>
                  <TabsTrigger value="history">История</TabsTrigger>
                </TabsList>
              </Tabs>
              <span className="hint">
                {index + 1} / {draft.slides.length}
              </span>
            </div>
            {pending > 0 && view !== "changes" && (
              <button className="editor-review-banner" onClick={showChanges}>
                <strong>На проверке: {pending}</strong>
                <span>Посмотреть до и после →</span>
              </button>
            )}
            {view !== "slides" && blockedReason && (
              <p className="hint editor-blocked-hint">
                {view === "history" ? "Восстановление версий пока недоступно" : "Принятие и отклонение правок пока недоступны"}: {blockedReason}
              </p>
            )}
            {view === "history" ? (
              <ProjectHistory
                onImportBackup={previewBackup}
                exportEpoch={exportEpoch}
                doc={project.state.doc}
                sources={project.state.sources}
                revision={project.state.revision}
                disabled={busy || saving || dirty}
                api={api}
                onRestore={(revision) =>
                  void command({ action: "restore", revision })
                }
              />
            ) : view === "changes" && deck ? (
              <ProposalBoard
                deck={deck}
                focusedProposalId={focusedProposalId}
                focusedSlideId={slide.id}
                onSelectSlide={id=>{const position=draft.slides.findIndex(s=>s.id===id);if(position>=0)setIndex(position);}}
                onShowAll={()=>setFocusedProposalId(null)}
                disabled={busy || saving || dirty}
                onAction={(action, payload) =>
                  void command({ action, ...payload })
                }
              />
            ) : (
              <>
                <div className="project-main-slide">
                  <EditableSlideCanvas
                    key={slide.id}
                    slide={slide}
                    brand={draft.brand}
                    design={draft.design}
                    index={index}
                    total={draft.slides.length}
                    sources={project.state.sources}
                    disabled={busy}
                    imageUploadDisabled={dirty||saving||imagePending||!imageJournalReady}
                    imageUploadBlockedReason={imagePending?"Сначала завершите или повторите незавершённую загрузку изображения.":!imageJournalReady?"Проверяем незавершённые загрузки на этом устройстве…":blockedReason}
                    onImageUpload={(file,elementId)=>void uploadImageFile(file,elementId)}
                    onChange={change}
                    onEditData={e=>openData(e,slide.id)}
                    onSelect={setSelectedField}
                    propertiesTarget={showObjectInspector?propertiesHost:null}
                    onShowCanvas={()=>{setMobilePanel("slides");setView("slides");}}
                    selectedId={selectedField?.startsWith("element:")?selectedField.slice(8):null}
                  />
                </div>
                <div className="editor-slide-actions" data-save-blocked={saveBlocked?"true":"false"}>
                  <span className="hint">
                    {saveBlocked
                      ? `${blockedReason} До этого экспорт, загрузка изображений и отправка агенту недоступны.`
                      : "Автосохранение · правки сохраняются после паузы во вводе"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || index === 0}
                    onClick={() => moveSlide(-1)}
                  >
                    ← Выше
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || index === draft.slides.length - 1}
                    onClick={() => moveSlide(1)}
                  >
                    Ниже →
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || draft.slides.length === 1}
                    onClick={() => {
                      edit({
                        ...draft,
                        slides: draft.slides.filter((s) => s.id !== slide.id),
                      });
                      setIndex(Math.max(0, index - 1));
                    }}
                  >
                    Удалить слайд
                  </Button>
                </div>
                {scene(
                  slide,
                  draft.brand,
                  index,
                  draft.slides.length,
                  draft.design,
                ).overflow && (
                  <p className="project-alert">
                    Текст не помещается: сократите его или выберите другую
                    композицию.
                  </p>
                )}
                <details className="project-checks">
                  <summary>
                    {issues.length
                      ? `Проверка презентации · замечания: ${issues.length}`
                      : compositionAdvice.length ? "Рекомендации по композиции" : "Автопроверка: замечаний нет"}
                  </summary>
                  {issues
                    .map((x, i) => (
                      <p key={i}>{x.slideId?`Слайд ${draft.slides.findIndex(s=>s.id===x.slideId)+1}: `:''}{x.message}{'elementId' in x&&x.elementId&&<Button size="sm" variant="ghost" aria-label={`Показать объект замечания ${i+1}`} onClick={()=>{const position=draft.slides.findIndex(s=>s.id===x.slideId);if(position>=0){setIndex(position);setSelectedField(`element:${x.elementId}`);setView('slides');setMobilePanel('slides');}}}>Показать объект</Button>}</p>
                    ))}
                  {compositionAdvice.map(advice=><div key={advice.code}><p><strong>Рекомендация по всей презентации.</strong> {advice.message}</p><p>Это не ошибка и не блокирует экспорт. Ручные композиции и титульные слайды в этой проверке не оцениваются.</p>{advice.slideIds.map(id=><Button key={id} variant="ghost" size="sm" onClick={()=>setIndex(draft.slides.findIndex(s=>s.id===id))}>Слайд {draft.slides.findIndex(s=>s.id===id)+1}</Button>)}</div>)}
                </details>
              </>
            )}
          </section>
          <aside className={`project-inspector ${sidePanel === "agent" ? "is-chat" : ""}`}>
            {refreshUI&&wideEditor&&<InspectorResize/>}
            <nav className="editor-side-tabs" aria-label="Инструменты слайда">
              {[
                ["edit", "Содержание"],
                ["comments", "Комментарии"],
                ["agent", "Агент"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={sidePanel === key}
                  onClick={() => {
                    setSidePanel(key);
                    if(key==="agent")setChatOpened(true);
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <section className="object-inspector" hidden={!showObjectInspector} aria-label="Свойства выбранного объекта">
              <header><h2>{inspectedObject?.kind==='text'?'Текст':inspectedObject?.kind==='image'?'Изображение':inspectedObject?.kind==='chart'?'Диаграмма':inspectedObject?.kind==='table'?'Таблица':'Фигура'}</h2><Button variant="ghost" size="sm" onClick={()=>setSelectedField(null)}>Свойства слайда</Button></header>
              {inspectedObject?.locked&&<p className="hint">Объект заблокирован.</p>}
              <div ref={setPropertiesHost}/>
            </section>
            {chatOpened&&<div className="editor-chat-panel" hidden={sidePanel!=="agent"}>
              {isCorporate?<WorkspaceChat emptyDraft={project.canProposeDraft===true} key={project.state.doc.id} documentId={project.state.doc.id} embedded selection={{documentId:project.state.doc.id,revision:project.state.revision,slideId:slide.id,...(selectedObject?{elementId:selectedObject.id}:!slide.canvas&&(semanticField==="title"||semanticField==="body"||semanticField==="takeaway")?{field:semanticField}:{})}} selectionLabel={`Слайд ${index+1}${selectedObject?' · выбранный объект':!slide.canvas&&semanticField==='title'?' · заголовок':''}`} documentBusy={busy||saving||dirty} onReview={id=>{setFocusedProposalId(id);setView("changes");setMobilePanel("slides");}}/>:<DocumentChat documentId={project.state.doc.id} enabled={!!project.chatEnabled} revision={project.state.revision}
                selection={{slideId:slide.id,field:!slide.canvas&&(semanticField==="title"||semanticField==="body"||semanticField==="takeaway")?semanticField:null,...(slide.canvas&&selectedField?.startsWith("element:")?{scope:"element",elementId:selectedField.slice(8)}:{})}}
                elementLabel={(()=>{const e=slide.canvas?.find(e=>`element:${e.id}`===selectedField);return e?(e.kind==="text"?e.text.slice(0,100)||"Пустой текст":e.kind==="image"?"Изображение":e.kind==="chart"?"Диаграмма":e.kind==="table"?"Таблица":"Фигура"):undefined;})()}
                onRestoreSelection={selection=>{const position=draft.slides.findIndex(s=>s.id===selection.slideId);if(position<0||selection.elementId&&!draft.slides[position].canvas?.some(e=>e.id===selection.elementId))return false;setIndex(position);setSelectedField(selection.elementId?`element:${selection.elementId}`:selection.field);return true;}}
                slideIndex={index} slideTitle={slide.title} slides={draft.slides} dirty={dirty} proposals={project.state.proposals}
                onReview={(proposalId,slideId)=>{const position=draft.slides.findIndex(v=>v.id===slideId);if(position>=0)setIndex(position);setFocusedProposalId(proposalId);setView("changes");setMobilePanel("slides");}}/>}
            </div>}
            {sidePanel === "comments" ? (
              <div className="editor-feedback">
                {isCorporate&&<SharedComments key={`${project.state.doc.id}:${slide.id}`} documentId={project.state.doc.id} slideId={slide.id} revision={project.state.revision} disabled={busy||saving||dirty} selectedElementId={selectedObject?.id} targets={(slide.canvas??[]).map(e=>({id:e.id,label:e.kind==="text"?e.text.slice(0,160):e.kind}))} onSelectElement={id=>{setSelectedField(`element:${id}`);setView("slides");setMobilePanel("slides");}}/>}
                {" "}
                <div className="project-panel-title">
                  <MessageSquare size={18} />
                  <strong>{isCorporate?"Личные заметки владельца":"Замечания агенту"}</strong>
                </div>
                <p className="hint">
                  {commentTarget.elementId?`К объекту: ${commentObject?.kind==="text"?commentObject.text.slice(0,100):commentObject?"Выбранный объект":"Объект удалён"}`:`К слайду ${(draft.slides.findIndex(s=>s.id===commentTarget.slideId))+1}`}.
                  {isCorporate?"Личная заметка доступна только владельцу. Для коллег используйте общее обсуждение выше.":"Замечание сохраняется вместе с презентацией и попадёт в следующее поручение агента в этой области."}
                </p>
                <div className="row">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={()=>updateNote(note,{slideId:slide.id})}>Ко всему слайду</Button>
                  {selectedObject&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>updateNote(note,{slideId:slide.id,elementId:selectedObject.id})}>К выбранному объекту</Button>}
                </div>
                <Textarea
                  aria-label="Текст замечания"
                  rows={4}
                  value={note}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(e) => updateNote(e.target.value,noteTarget??commentTarget)}
                  placeholder="Что изменить и почему?"
                />
                <Button
                  className="w-full mt-3"
                  disabled={busy || dirty || !note.trim() || commentTargetMissing}
                  title={commentTargetMissing ? "Адресат замечания удалён. Выберите объект или слайд заново." : busy || dirty ? blockedReason : !note.trim() ? "Введите текст замечания." : undefined}
                  onClick={() =>
                    void command({
                      action: "comment",
                      ...commentTarget,
                      text: note,
                    })
                  }
                >
                  Сохранить замечание
                </Button>
                {!!note&&<div className="mt-3">
                  <p className="hint">{noteStorageWarning?"Хранилище вкладки недоступно: черновик сохранён только до обновления страницы.":"Черновик и его адресат сохраняются в этой вкладке до отправки."}</p>
                  {commentTargetMissing&&<p className="narrative-warning">Адресат черновика удалён. Выберите новый объект или слайд явно; текст сохранён.</p>}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={()=>{noteDraft.current?.clear();setNote("");setNoteTarget(null);}}>Удалить черновик</Button>
                </div>}
                {project.state.comments
                  .filter((c) => c.slideId === slide.id && !c.replyTo && (!isCorporate||c.visibility!=="shared"))
                  .map((c) => (
                    <article className="project-comment" key={c.id}>
                      <small>
                        {c.author} · {c.resolved ? "Решено" : "Открыто"}
                      </small>
                      <p>{c.text}</p>
                      {c.anchor&&<div className="comment-object-anchor">
                        <small>К объекту · версия {c.anchor.revision}</small>
                        <blockquote>{c.anchor.quote||"Пустой текст"}</blockquote>
                        {slide.canvas?.some(e=>e.id===c.anchor!.elementId)?<>
                          <Button size="sm" variant="ghost" onClick={()=>{setSelectedField(`element:${c.anchor!.elementId}`);setView("slides");setMobilePanel("slides");}}>Показать объект</Button>
                          <Button size="sm" variant="ghost" onClick={()=>{setSelectedField(`element:${c.anchor!.elementId}`);setView("slides");setSidePanel("agent");setChatOpened(true);setMobilePanel("chat");}}>Обсудить с агентом</Button>
                        </>:<p className="hint">Объект удалён. Исходная цитата сохранена.</p>}
                      </div>}
                      {project.state.comments
                        .filter((r) => r.replyTo === c.id)
                        .map((reply) => (
                          <div className="project-reply" key={reply.id}>
                            <small>Ответ агента</small>
                            <p>{reply.text}</p>
                            {reply.proposalId && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={()=>{setFocusedProposalId(reply.proposalId!);setView("changes");setMobilePanel("slides");}}
                              >
                                Проверить изменения
                              </Button>
                            )}
                          </div>
                        ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || saving || dirty}
                        title={busy || saving || dirty ? blockedReason : undefined}
                        onClick={() =>
                          void command({
                            action: "resolve_comment",
                            commentId: c.id,
                          })
                        }
                      >
                        {c.resolved ? "Открыть снова" : "Отметить решённым"}
                      </Button>
                    </article>
                  ))}
                <p className="hint mt-6">
                  Агент подключается отдельно к этой презентации. Предложения появятся
                  на вкладке «Изменения».
                </p>
              </div>
            ) : sidePanel === "agent" ? null : refreshUI && view === "history" ? (
              <section className="panel-section history-inspector-context">
                <h2>Просмотр истории</h2>
                <p className="hint">Выберите сохранённую версию и сравните её с текущей. Восстановление создаст новую версию презентации.</p>
                <Button variant="outline" onClick={()=>{setView("slides");setMobilePanel("slides");}}>Вернуться к редактированию</Button>
              </section>
            ) : (
              <>
                <div hidden={showObjectInspector}>
                <details className="project-brief">
                  <summary>Замысел презентации</summary>
                  <p className="hint">Для кого готовим, к какому решению ведём и что важно запомнить. Эти ответы сохраняются с документом; допущения стоит проверить.</p>
                  {(
                    [
                      ["audience", "Для кого"],
                      ["decision", "Какое решение нужно"],
                      ["keyMessage", "Главная мысль"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="field" key={key}>
                      <span>{label}{brief.origins?.[key]==="assumption"?" · Допущение":""}</span>
                      <Textarea
                        rows={2}
                        maxLength={key==='audience'?400:800}
                        disabled={busy}
                        value={brief[key]}
                        onChange={(e) => {
                          edit({...draft,brief:editBriefField(brief,key,e.target.value)},`brief:${key}`);
                        }}
                      />
                    </label>
                  ))}
                </details>
                {" "}
                <DesignSettings className="panel-section presentation-design-settings">
                  {refreshUI&&<summary><span>Дизайн презентации</span><small>{designNames[draft.design || "classic-v1"]}</small></summary>}
                  <label className="field">
                    <span>Дизайн всей презентации</span>
                    <Select
                      value={draft.design || "classic-v1"}
                      disabled={busy || draft.slides.some(s=>!!s.canvas)}
                      onValueChange={(v) => {
                        edit({...draft,design:v as Design},"design");
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {designOptions.map((d) => (
                          <SelectItem key={d} value={d}>
                            {designNames[d]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {draft.slides.some(s=>!!s.canvas)&&<small className="hint">Слайды с ручными объектами сохраняют оформление. Автоматическая смена шаблона для них пока недоступна.</small>}
                  </label>
                </DesignSettings>
                <TemplateLayoutReset key={slide.id} slide={slide} brand={draft.brand} design={draft.design} index={index} total={draft.slides.length} disabled={busy||saving||imagePending} onApply={()=>{change({canvas:undefined},`${slide.id}:template-reset`);setSelectedField(null);}}/>
                <SlideInspector
                  slide={slide}
                  sources={project.state.sources}
                  onSourceDownload={source=>downloadSourceOriginal(draft.id,source)}
                  index={index}
                  editable={!busy}
                  onChange={change}
                  selectedField={semanticField}
                  focusSelection={!selectedField?.startsWith("element:")}
                />
                {project.chatEnabled&&!corporateContext()&&<DocumentSourceAttachment documentId={draft.id} revision={project.state.revision} disabled={busy||dirty||saving} onBusy={setBusy} onAttached={()=>refresh(true)}/>}
                </div>
              </>
            )}
          </aside>
        </main>
      )}
      {dataEditing&&draft&&project&&<DataObjectEditor key={dataEditing.id} documentId={draft.id} previewDoc={draft} slideId={dataEditing.slideId} owner={editorSlot} element={dataEditing.element} recovered={dataEditing.recovered}
        current={busy?undefined:dataObjectFor(draft,dataEditing.slideId,dataEditing.element.id)} saved={dataObjectFor(project.state.doc,dataEditing.slideId,dataEditing.element.id)} revision={project.state.revision}
        sources={project.state.sources} onApply={applyData} onClose={()=>{setDataEditing(null);void refreshDataRecords();}} onJournalChange={()=>void refreshDataRecords()}/>}
      {presenting && draft && slide && (
        <dialog ref={presentationDialog}
          className="local-presentation"
          aria-label="Показ презентации"
          onCancel={()=>setPresenting(false)}
        >
          <SlideCanvas
            slide={slide}
            brand={draft.brand}
            design={draft.design}
            index={index}
            total={draft.slides.length}
          />
          <nav>
            <Button
              variant="outline"
              aria-label="Предыдущий слайд"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
            >
              ←
            </Button>
            <span aria-live="polite" aria-atomic="true">
              {index + 1} / {draft.slides.length}
            </span>
            <Button
              variant="outline"
              aria-label="Следующий слайд"
              disabled={index === draft.slides.length - 1}
              onClick={() => setIndex((i) => i + 1)}
            >
              →
            </Button>
            <Button variant="outline" onClick={() => setPresenting(false)}>
              Закрыть · Esc
            </Button>
          </nav>
        </dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <CorporateFrame>{isCorporate&&document.body.dataset.documentMode==='view'?<SharedDocumentViewer/>:isLibrary && !documentId ? <LocalLibrary /> : <Workbench />}</CorporateFrame>,
);
