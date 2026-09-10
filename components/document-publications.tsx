import {SharedCopyButton} from './shared-copy';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogTrigger} from './ui/dialog';
import {Button} from './ui/button';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import {scopedApiPath} from '../lib/project/browser-context';
import type {DocumentSharing} from '../lib/project/document-sharing';
import type {DeckDoc} from '../lib/domain/model';
type Publication={id:string;revision:number;title:string;withdrawn:boolean};
type Preview={id:string;hash:string;sourceRevision:number;headRevision?:number;expiresAt:string;audienceEpoch:string;document:DeckDoc};
type SourceHistory={items:{revision:number;createdAt:string;incomplete:boolean}[];nextCursor:number|null;canReadHistory:boolean};
type Operation={path:string;body:Record<string,unknown>};
export function DocumentPublicationsButton({revision,disabled=false,canManage=true}:{revision:number;disabled?:boolean;canManage?:boolean}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[items,setItems]=useState<Publication[]>([]),[preview,setPreview]=useState<Preview|null>(null),[audience,setAudience]=useState<DocumentSharing|null>(null);
 const [selected,setSelected]=useState<Publication|null>(null),[copyPending,setCopyPending]=useState(false),[copyOpen,setCopyOpen]=useState(false),[copyAllowed,setCopyAllowed]=useState(false),[hasDependencies,setHasDependencies]=useState(false),[pages,setPages]=useState(0),[remove,setRemove]=useState<Publication|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(false),[now,setNow]=useState(Date.now());
 const [sourceRevision,setSourceRevision]=useState(''),[historyItems,setHistoryItems]=useState<{revision:number;createdAt:string;incomplete:boolean}[]>([]),[historyCursor,setHistoryCursor]=useState<number|null>(null),[historyLoading,setHistoryLoading]=useState(false);
 const [cursors,setCursors]=useState<string[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null);
 const [canReadWithdrawn,setCanReadWithdrawn]=useState(false),[includeWithdrawn,setIncludeWithdrawn]=useState(false);
 const listUrl='/api/publications?includeWithdrawn='+includeWithdrawn+(cursors.length?'&cursor='+encodeURIComponent(cursors.at(-1)!):'');
 const operation=useRef<Operation|null>(null),lock=useRef(false);
 const expired=!!preview&&(now>=Date.parse(preview.expiresAt)||(preview.headRevision??preview.sourceRevision)!==revision);
 const [loaded,setLoaded]=useState<string[]>([]),[imageError,setImageError]=useState(false);
 const refresh=async()=>{const r=await localFetch(listUrl,{cache:'no-store'});const value=await r.json() as {items:Publication[];canReadWithdrawn?:boolean;nextCursor?:string|null};setCanReadWithdrawn(value.canReadWithdrawn===true);setItems(value.items);setNextCursor(value.nextCursor??null);};
 useEffect(()=>{
  if(!open)return;let live=true,pending=false;
  const load=async()=>{
   if(pending)return;pending=true;
   try{
    const r=await(await localFetch(listUrl,{cache:'no-store'})).json() as {items:Publication[];canReadWithdrawn?:boolean;nextCursor?:string|null};
    if(live){setCanReadWithdrawn(r.canReadWithdrawn===true);setItems(r.items);setNextCursor(r.nextCursor??null);}
    if(selected){const value=await(await localFetch('/api/publications/'+selected.id,{cache:'no-store'})).json() as {permission?:{canCopy:boolean}};if(live)setCopyAllowed(value.permission?.canCopy===true);}
   }catch(e){if(live){setCanReadWithdrawn(false);setIncludeWithdrawn(false);setItems([]);setNextCursor(null);setSelected(null);setCopyAllowed(false);setPreview(null);setAudience(null);setRemove(null);setError((e as Error).message);}}finally{pending=false;}
  };
  const focus=()=>{if(document.visibilityState==='visible')load();};load();const timer=setInterval(()=>{setNow(Date.now());focus();},5000);
  window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
  return()=>{live=false;clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
 },[open,listUrl,selected?.id]);
 useEffect(()=>{const id=new URLSearchParams(location.search).get('publication');if(id&&/^[a-f0-9-]{36}$/.test(id)){setOpen(true);void view({id,revision:0,title:'',withdrawn:false});}},[]);
 useEffect(()=>{
  if(!open||!canManage){setHistoryItems([]);setHistoryCursor(null);return;}let live=true;
  void localFetch('/api/publications?history=1',{cache:'no-store'}).then(r=>r.json() as Promise<SourceHistory>).then(r=>{if(live){setHistoryItems(r.items);setHistoryCursor(r.nextCursor);}}).catch(()=>{if(live){setHistoryItems([]);setHistoryCursor(null);}});
  return()=>{live=false;};
 },[open,canManage,revision]);
 async function moreHistory(){
  if(historyCursor===null||historyLoading)return;setHistoryLoading(true);
  try{const r=await(await localFetch('/api/publications?history=1&before='+historyCursor,{cache:'no-store'})).json() as SourceHistory;setHistoryItems(old=>[...old,...r.items.filter((item:{revision:number})=>!old.some(p=>p.revision===item.revision))]);setHistoryCursor(r.nextCursor);}catch(e){setError((e as Error).message);}finally{setHistoryLoading(false);}
 }
 useEffect(()=>{setCopyOpen(false);setCopyPending(false);},[selected?.id]);
 useEffect(()=>{if(!canManage){setPreview(null);setAudience(null);setRemove(null);}},[canManage]);
 useEffect(()=>{setLoaded([]);setImageError(false);},[preview?.id,selected?.id]);
 async function prepare(){
  if(lock.current||operation.current)return;lock.current=true;setBusy(true);setError('');setNotice('');setPreview(null);setSelected(null);setRemove(null);
  try{
   const p=await(await localFetch('/api/publications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',expectedRevision:revision,...(sourceRevision?{sourceRevision:Number(sourceRevision)}:{})})})).json() as Preview;
   const a=await(await localFetch('/api/sharing',{cache:'no-store'})).json() as DocumentSharing;
   if(a.authzEpoch!==p.audienceEpoch)throw Error('Аудитория изменилась. Подготовьте предпросмотр заново.');
   setAudience(a);setPreview(p);setNow(Date.now());
  }catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 async function apply(next?:Operation){
  if(lock.current)return;const op=operation.current??next;if(!op)return;operation.current=op;lock.current=true;setBusy(true);setError('');setRetry(false);
  try{
   const result=await(await localFetch(op.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(op.body)})).json() as Publication;
   operation.current=null;setPreview(null);setSelected(null);setRemove(null);setNotice(result.withdrawn?'Публикация снята. Новые просмотры и скачивания закрыты.':'Версия опубликована. Правки исходника не изменят эту публикацию.');await refresh();
  }catch(e){
   setError((e as Error).message);
   if(operation.current){if(e instanceof LocalRequestError&&e.status&&e.status<500){operation.current=null;setPreview(null);setRemove(null);}else setRetry(true);}
  }finally{lock.current=false;setBusy(false);}
 }
 async function view(item:Publication){
  if(lock.current||operation.current)return;lock.current=true;setBusy(true);setError('');setPreview(null);setSelected(null);setRemove(null);
  try{const value=await(await localFetch('/api/publications/'+item.id,{cache:'no-store'})).json() as {document:DeckDoc;origin:{revision:number};hasDependencies?:boolean;permission?:{canCopy:boolean}};setCopyAllowed(value.permission?.canCopy===true);setHasDependencies(value.hasDependencies===true);setPages(value.document.slides.length);setSelected({...item,title:value.document.title,revision:value.origin?.revision??item.revision});const url=new URL(location.href);url.searchParams.set('publication',item.id);history.replaceState(null,'',url);}catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}
 }
 const count=preview?.document.slides.length??(selected?pages:0),id=preview?.id??selected?.id;
 const artifact=(kind:string,page=0)=>scopedApiPath(`/api/publications/${id}/artifacts?kind=${kind}&page=${page}${preview?'&prepared=true':''}`);
 return <Dialog open={open} onOpenChange={value=>{if(value||!copyPending){setOpen(value);if(!value){const url=new URL(location.href);url.searchParams.delete('publication');history.replaceState(null,'',url);}}}}>
  <DialogTrigger asChild><Button variant="outline">Публикации</Button></DialogTrigger>
  <DialogContent className="publication-dialog" onEscapeKeyDown={e=>{if(copyOpen){e.preventDefault();if(!copyPending)setCopyOpen(false);}}}><DialogTitle>Опубликованные версии</DialogTitle><DialogDescription>{canManage?'Сохраните проверенную версию для коллег. Дальнейшие правки останутся в исходнике.':'Просматривайте и скачивайте версии, опубликованные для вас.'}</DialogDescription>
   {canManage&&historyItems.length>0&&<div className="publication-actions"><label>Версия для публикации <select aria-label="Версия для публикации" disabled={busy||copyPending||!!operation.current} value={sourceRevision} onChange={e=>{setSourceRevision(e.target.value);setPreview(null);setSelected(null);}}><option value="">Текущая · {revision}</option>{historyItems.map(item=><option key={item.revision} value={item.revision}>Версия {item.revision} · {new Date(item.createdAt).toLocaleDateString('ru-RU')}{item.incomplete?' · неполный архив':''}</option>)}</select></label>{historyCursor!==null&&<Button variant="ghost" disabled={historyLoading} onClick={()=>void moreHistory()}>Более ранние версии</Button>}</div>}
   {sourceRevision&&<p>Историческая версия будет заново отрисована из сохранённых источников. Проверьте все страницы перед публикацией.</p>}
   {canManage&&<div className="publication-actions"><Button onClick={()=>void prepare()} disabled={busy||copyPending||disabled||!!operation.current}>Подготовить версию {sourceRevision||revision}</Button><span>Для людей с доступом к документу</span></div>}
   {canManage&&disabled&&<p role="status">Сначала дождитесь сохранения правок в редакторе.</p>}
   {busy&&<p role="status">{preview||remove||retry?'Сохраняем действие…':'Подготавливаем слайды…'}</p>}
   {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {retry&&<Button disabled={busy} onClick={()=>void apply()}>Повторить ту же операцию</Button>}
   {preview&&<section className="publication-audience"><h3>Кто сможет открыть: {audience?.audienceCount}</h3><p>Используется текущий доступ документа. Публикация не добавляет получателей.</p><ul>{audience?.audience.map(person=><li key={person.id}>{person.name}</li>)}</ul>{audience&&audience.audienceCount>audience.audience.length&&<p>Показаны первые {audience.audience.length} участников. Полный состав проверьте в «Доступ».</p>}<p>Версия {preview.sourceRevision}. Проверьте все страницы перед публикацией.</p>{expired&&<p role="alert">Предпросмотр устарел. Подготовьте версию заново.</p>}</section>}
   {selected&&<h3>Версия {selected.revision} · {selected.title}</h3>}
   {id&&<section className="publication-pages" aria-label="Страницы публикации">{Array.from({length:count},(_,i)=><figure key={id+':'+i}><img src={artifact('preview',i+1)} alt={`Слайд ${i+1} из ${count}`} onLoad={()=>setLoaded(old=>old.includes(id+':'+i)?old:[...old,id+':'+i])} onError={()=>{setImageError(true);setError('Страница недоступна. Обновите предпросмотр или проверьте доступ.');}}/><figcaption>{i+1} / {count}</figcaption></figure>)}</section>}
   {id&&<div className="publication-actions"><a href={artifact('pdf')}>Скачать PDF</a><a href={artifact('pptx')}>Скачать PowerPoint</a>{(preview||hasDependencies)&&<a href={artifact('dependencies')}>Шрифты и сведения о версии</a>}</div>}
   {selected&&copyAllowed&&(copyOpen?<SharedCopyButton key={selected.id} inline onPendingChange={setCopyPending} onCancel={()=>setCopyOpen(false)} view={{title:selected.title,revision:selected.revision}} publicationId={selected.id}/>:<Button variant="outline" onClick={()=>setCopyOpen(true)}>Создать на основе</Button>)}
   {preview&&<Button disabled={busy||copyPending||disabled||expired||imageError||loaded.filter(key=>key.startsWith(preview.id+':')).length!==count||!!operation.current} onClick={()=>void apply({path:'/api/publications',body:{action:'publish',requestId:crypto.randomUUID(),preparedId:preview.id,expectedHash:preview.hash,audience:'current-document-access'}})}>Опубликовать версию {preview.sourceRevision}</Button>}
   {remove&&<section className="publication-withdraw"><p>Снять версию {remove.revision}? Скачанные коллегами файлы останутся у них.</p><Button disabled={busy||copyPending||!!operation.current} onClick={()=>void apply({path:'/api/publications/'+remove.id,body:{action:'withdraw',requestId:crypto.randomUUID()}})}>Снять публикацию</Button><Button variant="ghost" disabled={busy||copyPending||!!operation.current} onClick={()=>setRemove(null)}>Оставить</Button></section>}
   <section><h3>Сохранённые публикации</h3>{canReadWithdrawn&&<Button variant="outline" aria-pressed={includeWithdrawn} disabled={busy||copyPending} onClick={()=>{setIncludeWithdrawn(v=>!v);setItems([]);setCursors([]);setNextCursor(null);}}>Показать снятые</Button>}{!items.length&&<p>Пока нет опубликованных версий.</p>}<ul className="publication-list">{items.map(item=><li key={item.id}>{item.withdrawn?<span>Версия {item.revision} · {item.title} · Снята. Просмотр и скачивание закрыты.</span>:<button disabled={busy||copyPending||!!operation.current} onClick={()=>void view(item)}>Версия {item.revision} · {item.title}</button>}{canManage&&!item.withdrawn&&<Button variant="ghost" disabled={busy||copyPending||!!operation.current} onClick={()=>{setRemove(item);setPreview(null);setSelected(null);}}>Снять…</Button>}</li>)}</ul>{(cursors.length>0||nextCursor)&&<nav className="shared-library-pagination" aria-label="Страницы публикаций"><Button variant="outline" disabled={busy||copyPending||!cursors.length} onClick={()=>{setItems([]);setNextCursor(null);setCursors(c=>c.slice(0,-1));}}>Предыдущая</Button><span>Страница {cursors.length+1}</span><Button variant="outline" disabled={busy||copyPending||!nextCursor} onClick={()=>{setItems([]);setNextCursor(null);setCursors(c=>[...c,nextCursor!]);}}>Следующая</Button></nav>}</section>
  </DialogContent>
 </Dialog>;
}
