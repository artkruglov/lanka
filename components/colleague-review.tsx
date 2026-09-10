import {ColleagueReviewDraft} from '../lib/project/colleague-review-draft';
import {corporateContext,scopedStorage} from '../lib/project/browser-context';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogTrigger} from './ui/dialog';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import {SlideCanvas} from './slide-canvas';
import type {ColleagueReview} from '../lib/domain/colleague-review';
import type {DeckDoc} from '../lib/domain/model';
type Item=ColleagueReview&{senderName:string;recipientName:string};
type Page={items:Item[];nextCursor:string|null;authzEpoch:string;headRevision:number;actorId:string;canRequest:boolean;target:ColleagueReview['target']|null};
type People={items:{id:string;name:string}[];nextCursor:string|null;authzEpoch:string};
type View={review:ColleagueReview;headRevision:number;hasNewVersion:boolean;version:{document:DeckDoc}};
const json=async<T,>(path:string):Promise<T>=>(await localFetch(path,{cache:'no-store'})).json();
export function ColleagueReviewButton({revision,disabled=false}:{revision:number;disabled?:boolean}){
 const [draft]=useState(()=>{let storage:Storage|null=null;try{storage=scopedStorage(sessionStorage);}catch{}return new ColleagueReviewDraft(storage,corporateContext()!.documentId!);});
 const initial=draft.snapshot;
 const [linkedId]=useState(()=>{const id=new URLSearchParams(location.search).get('reviewRequest');return id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:null;});
 const linked=useRef(linkedId);
 const clearLink=()=>{linked.current=null;const url=new URL(location.href);if(url.searchParams.has('reviewRequest')){url.searchParams.delete('reviewRequest');history.replaceState(history.state,'',url.pathname+url.search+url.hash);}};
 const [saveProblem,setSaveProblem]=useState('');
 const persist=(fn:()=>void)=>{try{fn();setSaveProblem('');}catch{setSaveProblem('Не удалось сохранить черновик в этой вкладке. Не закрывайте страницу; отправка требует сохранённой копии.');}};
 const [open,setOpen]=useState(!!linkedId),[page,setPage]=useState<Page|null>(null),[people,setPeople]=useState<People|null>(null),[view,setView]=useState<View|null>(null);
 const [recipient,setRecipient]=useState(initial.recipient??''),[note,setNote]=useState(initial.note),[answer,setAnswer]=useState(''),[outcome,setOutcome]=useState('reviewed'),[search,setSearch]=useState(initial.search);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[imageProblem,setImageProblem]=useState(false),[retry,setRetry]=useState(!!initial.pending);
 const lock=useRef(false),operation=useRef<Record<string,unknown>|null>(initial.pending),generation=useRef(0);
 const currentView=useRef<View|null>(null);currentView.current=view;
 const load=async()=>{
  const token=++generation.current;try{const next=await json<Page>('/api/review-requests?status=all');if(token===generation.current){setPage(next);setError('');const selected=currentView.current;const restored=linked.current??draft.snapshot.selected;if(!selected&&restored&&!operation.current){const resumed=await json<View>('/api/review-requests/'+restored+'/version');if(token===generation.current){const a=draft.snapshot.answers[restored];setAnswer(a?.text??'');setOutcome(a?.outcome??'reviewed');setView(resumed);if(linked.current){persist(()=>draft.edit({selected:restored}));linked.current=null;}}}if(selected){const refreshed=await json<Pick<View,'review'|'headRevision'|'hasNewVersion'>>('/api/review-requests/'+selected.review.id);if(token===generation.current&&currentView.current?.review.id===selected.review.id)setView({...selected,...refreshed});}}}
  catch(e){if(token===generation.current){setPage(null);setPeople(null);setView(null);setError((e as Error).message);}}
 };
 useEffect(()=>{if(!open)return;void load();const focus=()=>{if(!lock.current&&document.visibilityState==='visible')void load();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);const timer=setInterval(focus,5000);return()=>{generation.current++;clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};},[open]);
 const work=async(fn:()=>Promise<void>)=>{if(lock.current)return;generation.current++;lock.current=true;setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError((e as Error).message);if(e instanceof LocalRequestError&&[401,403,404].includes(e.status??0)){setView(null);setPeople(null);setPage(null);}else if(e instanceof LocalRequestError&&e.status===409&&currentView.current){const selected=currentView.current;try{const latest=await json<Pick<View,'review'|'headRevision'|'hasNewVersion'>>('/api/review-requests/'+selected.review.id);setView({...selected,...latest});}catch{setView(null);setPage(null);}}}finally{lock.current=false;setBusy(false);}};
 const recipients=async(more=false)=>work(async()=>{
  const suffix=more&&people?.nextCursor?'&cursor='+people.nextCursor+'&expectedEpoch='+people.authzEpoch:'';
  const next=await json<People>('/api/review-recipients?search='+encodeURIComponent(search)+suffix);
  setPeople({...next,items:more?[...(people?.items??[]),...next.items]:next.items});if(!more&&recipient&&!next.items.some(p=>p.id===recipient)){setRecipient('');persist(()=>draft.edit({recipient:null}));}
 });
 const inspect=async(id:string)=>work(async()=>{clearLink();setView(null);setImageProblem(false);const saved=draft.snapshot.answers[id];setAnswer(saved?.text??'');setOutcome(saved?.outcome??'reviewed');setView(await json<View>('/api/review-requests/'+id+'/version'));persist(()=>draft.edit({selected:id}));});
 const send=async(command?:Record<string,unknown>)=>work(async()=>{
  const recovering=!!operation.current;const input=operation.current??command;if(!input)return;const op=draft.stage(input);operation.current=op;setRetry(false);
  try{
   await localFetch('/api/review-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(op)});
   draft.settle(op.requestId,true);operation.current=null;clearLink();setView(null);setNote(draft.snapshot.note);setAnswer('');setNotice('Сохранено.');await load();
  }catch(e){if(!recovering&&e instanceof LocalRequestError&&e.status&&e.status<500){draft.settle(op.requestId,false);operation.current=null;}else setRetry(true);throw e;}
 });
 const pending=!!operation.current;
 return <Dialog open={open} onOpenChange={v=>{if(!lock.current){setOpen(v);if(!v){clearLink();setView(null);setPeople(null);}}}}>
  <DialogTrigger asChild><button type="button">Проверка</button></DialogTrigger>
  <DialogContent className="colleague-review-dialog"><DialogTitle>Проверка с коллегой</DialogTitle><DialogDescription>Коллега проверяет выбранную версию слайдов. Личная переписка и исходные материалы не передаются.</DialogDescription>
   {saveProblem&&<p role="alert">{saveProblem}</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {retry&&<button disabled={busy} onClick={()=>void send()}>Повторить отправку</button>}
   {pending&&<p>Результат отправки уточняется. Повтор использует тот же запрос.</p>}
   {!view?<>
    <button disabled={busy||pending} onClick={()=>void load()}>Обновить список</button>
    {page?.canRequest&&<fieldset disabled={busy||pending||disabled}><legend>Попросить проверить версию {page.target?.revision??revision}</legend>
     {disabled&&<p>Сначала сохраните изменения презентации.</p>}
     <label>Имя коллеги<input aria-label="Имя коллеги" value={search} onChange={e=>{const value=e.target.value;setSearch(value);setPeople(null);setRecipient('');persist(()=>draft.edit({search:value,recipient:null}));}} maxLength={140}/></label><button onClick={()=>void recipients()}>Найти коллегу</button>
     {people&&<><label>Коллега<select aria-label="Коллега" value={recipient} onChange={e=>{setRecipient(e.target.value);persist(()=>draft.edit({recipient:e.target.value||null}));}}><option value="">Выберите участника</option>{people.items.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{!people.items.length&&<p>Нет коллег с правом комментировать эту презентацию.</p>}{people.nextCursor&&<button onClick={()=>void recipients(true)}>Ещё участники</button>}</>}
     <label>Что проверить<textarea aria-label="Что проверить" value={note} onChange={e=>{setNote(e.target.value);persist(()=>draft.edit({note:e.target.value}));}} maxLength={2000}/></label>
     {page.target?.revision!==revision&&<p>Версия изменилась. Обновите список перед отправкой.</p>}
     <button className="colleague-review-primary" disabled={!recipient||!page.target||page.target.revision!==revision} onClick={()=>void send({action:'create',requestId:crypto.randomUUID(),recipientId:recipient,target:page.target,note})}>Отправить на проверку</button>
    </fieldset>}
    <h3>Запросы этой презентации</h3>{page&&!page.items.length&&<p>Запросов пока нет.</p>}
    <ul>{page?.items.map(item=><li key={item.id} data-review-id={item.id}><button disabled={busy||pending} onClick={()=>void inspect(item.id)}>Версия {item.target.revision} · {item.senderId===page.actorId?'Для '+item.recipientName:'От '+item.senderName} · {item.status==='pending'?'Ждёт ответа':item.status==='cancelled'?'Отменён':'Есть ответ'}</button></li>)}</ul>
    {page?.nextCursor&&<button disabled={busy||pending} onClick={()=>void work(async()=>{const next=await json<Page>('/api/review-requests?status=all&cursor='+page.nextCursor+'&expectedEpoch='+page.authzEpoch);setPage({...next,items:[...page.items,...next.items]});})}>Ещё запросы</button>}
   </>:<>
    <button disabled={busy||pending} onClick={()=>{clearLink();setView(null);persist(()=>draft.edit({selected:null}));}}>К списку запросов</button><h3>Версия {view.review.target.revision}</h3>
    {view.hasNewVersion&&<p role="status">После отправки презентация изменилась. Здесь версия, которую попросили проверить.</p>}
    {view.review.note&&<p className="colleague-review-note">{view.review.note}</p>}
    <div className="colleague-review-slides">{view.version.document.slides.map((slide,i)=><SlideCanvas key={slide.id} slide={slide} brand={view.version.document.brand} design={view.version.document.design} index={i} total={view.version.document.slides.length} assetBaseUrl={'/api/review-requests/'+view.review.id+'/assets'} onImageError={()=>setImageProblem(true)}/>)}</div>
    {imageProblem&&<p role="alert">Изображение не загрузилось. Откройте просмотр заново перед ответом.</p>}
    {view.review.status==='responded'&&<p>Ответ: {view.review.response.outcome==='reviewed'?'Проверено':'Нужны правки'}. {view.review.response.note}</p>}
    {view.review.status==='cancelled'&&<p>Запрос отменён.</p>}
    {view.review.status!=='pending'&&answer&&<label>Черновик ответа<textarea aria-label="Черновик ответа" readOnly value={answer}/><span>Этот текст не отправлен. Его можно скопировать.</span></label>}
    {view.review.status==='pending'&&view.review.recipientId===page?.actorId&&<fieldset disabled={busy||pending||imageProblem}><legend>Ваш ответ</legend><label>Результат<select aria-label="Результат" value={outcome} onChange={e=>{const v=e.target.value as 'reviewed'|'changes_requested';setOutcome(v);persist(()=>draft.answer(view.review.id,answer,v));}}><option value="reviewed">Проверено</option><option value="changes_requested">Нужны правки</option></select></label><label>Комментарий<textarea aria-label="Комментарий" value={answer} onChange={e=>{setAnswer(e.target.value);persist(()=>draft.answer(view.review.id,e.target.value,outcome as 'reviewed'|'changes_requested'));}} maxLength={2000}/></label><button className="colleague-review-primary" disabled={outcome==='changes_requested'&&!answer.trim()} onClick={()=>void send({action:'respond',requestId:crypto.randomUUID(),id:view.review.id,expectedStatusVersion:view.review.statusVersion,target:view.review.target,outcome,note:answer})}>Отправить ответ</button></fieldset>}
    {view.review.status==='pending'&&view.review.senderId===page?.actorId&&<button disabled={busy||pending} onClick={()=>void send({action:'cancel',requestId:crypto.randomUUID(),id:view.review.id,expectedStatusVersion:view.review.statusVersion})}>Отменить запрос</button>}
   </>}
  </DialogContent>
 </Dialog>;
}
