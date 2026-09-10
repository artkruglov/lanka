import {useEffect,useState} from 'react';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import {scopedStorage} from '../lib/project/browser-context';
import type {SharedDiscussionRequest,SharedCommentsView} from '../lib/project/shared-comments';

/** Mount with a document/slide key: drafts and uncertain writes never move to another slide. */
export function SharedComments({documentId,slideId,revision,disabled=false,selectedElementId,targets=[],onSelectElement}:{documentId:string;slideId:string;revision:number;disabled?:boolean;selectedElementId?:string;targets?:{id:string;label:string}[];onSelectElement?:(id:string)=>void}) {
 const key=`lanka-shared-comment:${documentId}:${slideId}`;
 const [initial]=useState(()=>{try{return JSON.parse(scopedStorage(sessionStorage).getItem(key)||'{}') as {text?:string;pending?:SharedDiscussionRequest;replyTo?:string;elementId?:string};}catch{return {};}});
 const [text,setText]=useState(initial.text||''),[pending,setPending]=useState<SharedDiscussionRequest|null>(initial.pending||null),[replyTo,setReplyTo]=useState<string|undefined>(initial.replyTo),[elementId,setElementId]=useState<string|undefined>(initial.elementId);
 const [view,setView]=useState<SharedCommentsView|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false),[storageError,setStorageError]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{try{scopedStorage(sessionStorage).setItem(key,JSON.stringify({text,pending,replyTo,elementId}));setStorageError(false);}catch{setStorageError(true);}},[key,text,pending,replyTo,elementId]);
 useEffect(()=>{
  let alive=true,loading=false;const abort=new AbortController();
  const load=async()=>{if(loading||document.visibilityState==='hidden')return;loading=true;
   try{const response=await localFetch('/api/shared-comments',{cache:'no-store',signal:abort.signal});const next=await response.json() as SharedCommentsView;if(alive){setView(next);setReadError('');}}
   catch(e){if(alive&&!abort.signal.aborted){setView(null);setReadError((e as Error).message);}}
   finally{loading=false;}
  };
  void load();const timer=setInterval(()=>void load(),5000);document.addEventListener('visibilitychange',load);window.addEventListener('lanka:auth-restored',load);
  return()=>{alive=false;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);window.removeEventListener('lanka:auth-restored',load);};
 },[documentId,reload]);
 const send=async(statusRequest?:SharedDiscussionRequest)=>{
  const request=pending??statusRequest??{requestId:crypto.randomUUID(),expectedRevision:revision,slideId,text:text.trim(),...(replyTo?{replyTo}:elementId?{elementId}:{})};
  // Persist exact bytes before dispatch so reload after a lost response can safely replay.
  try{scopedStorage(sessionStorage).setItem(key,JSON.stringify({text,pending:request,replyTo,elementId}));}catch{setError('Не удалось сохранить запрос в этой вкладке. Освободите хранилище перед отправкой.');return;}
  setPending(request);setBusy(true);setError('');
  try{await localFetch('/api/shared-comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});setPending(null);if(!('action' in request)){setText('');setReplyTo(undefined);setElementId(undefined);}setReload(n=>n+1);}
  catch(e){setError((e as Error).message);if(e instanceof LocalRequestError&&[400,403,404,409,413,415].includes(e.status??0))setPending(null);setReload(n=>n+1);}
  finally{setBusy(false);}
 };
 const comments=view?.comments.filter(c=>c.slideId===slideId)??[];
 return <section className="shared-comments" aria-label="Общее обсуждение слайда">
  <h2>Обсуждение слайда</h2><p className="hint">Видно всем, у кого есть доступ к презентации.</p>
  {(error||readError)&&<p role="alert">{error||readError}</p>}
  {view&&comments.filter(c=>!c.replyTo).map(c=><article key={c.id}>
   <small>{c.author} · версия {c.revision}{c.resolved?' · Решено':''}</small><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{c.text}</p>
   {c.anchor&&<div className="comment-object-anchor"><small>К объекту · версия {c.anchor.revision}</small><blockquote>{c.anchor.quote||'Пустой текст'}</blockquote>{targets.some(t=>t.id===c.anchor!.elementId)?<button onClick={()=>onSelectElement?.(c.anchor!.elementId)}>Показать объект</button>:<p className="hint">Объект удалён. Исходная цитата сохранена.</p>}</div>}
   {comments.filter(r=>r.replyTo===c.id).map(r=><blockquote key={r.id}><small>{r.author} · версия {r.revision}</small><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.text}</p></blockquote>)}
   {c.statusHistory.length>0&&<details><summary>История статуса · {c.statusHistory.length}</summary>{c.statusHistory.map(e=><p key={e.version}><small>{e.author} · {new Date(e.createdAt).toLocaleString('ru-RU')}</small><br/>{e.resolved?'Отмечено решённым':'Открыто снова'}</p>)}</details>}
   {view.manageableIds.includes(c.id)&&<button disabled={!!pending||busy||disabled} onClick={()=>void send({requestId:crypto.randomUUID(),action:'set_status',commentId:c.id,expectedStatusVersion:c.statusVersion,resolved:!c.resolved})}>{c.resolved?'Открыть снова':'Отметить решённым'}</button>}
   {view.canComment&&<button disabled={!!pending||busy} onClick={()=>setReplyTo(c.id)}>Ответить {c.author}</button>}
  </article>)}
  {pending&&'action' in pending&&<button disabled={busy||disabled} onClick={()=>void send()}>Повторить изменение статуса</button>}
  {view&&!comments.length&&<p className="hint">Обсуждений пока нет.</p>}
  {view?.canComment?<>
   {replyTo&&<p>Ответ в обсуждении <button disabled={!!pending||busy} onClick={()=>setReplyTo(undefined)}>Отменить ответ</button></p>}
   {!replyTo&&<div className="row"><button disabled={busy||!!pending} onClick={()=>setElementId(undefined)}>Ко всему слайду</button>{selectedElementId&&<button disabled={busy||!!pending} onClick={()=>setElementId(selectedElementId)}>К выбранному объекту</button>}</div>}
   {!replyTo&&<p className="hint">{elementId?`К объекту: ${targets.find(t=>t.id===elementId)?.label??'Объект удалён — выберите адресата заново'}`:'Ко всему слайду'}</p>}
   <textarea aria-label="Общий комментарий" rows={3} maxLength={2000} value={text} disabled={busy||!!pending} onChange={e=>setText(e.target.value)} placeholder="Что стоит изменить на этом слайде?"/>
   {storageError&&<p role="alert">Хранилище вкладки недоступно. Сохранение черновика не гарантируется.</p>}
   {disabled&&<p className="hint">Сначала сохраните изменения слайда.</p>}
   {!pending&&view.revision!==revision&&<p className="hint">Версия слайда изменилась. Обновите презентацию перед отправкой.</p>}
   <button disabled={!!pending&&'action' in pending||busy||disabled||(!pending&&!replyTo&&!!elementId&&!targets.some(t=>t.id===elementId))||!text.trim()||(!pending&&view.revision!==revision)} onClick={()=>void send()}>{busy?'Отправляем…':pending?'Повторить отправку':'Отправить всем участникам'}</button>
   {pending&&<p className="hint">Запрос сохранён. Повторная отправка не создаст второй комментарий.</p>}
  </>:view&&<p className="hint">Чтобы написать комментарий, попросите роль «Комментатор».</p>}
 </section>;
}
