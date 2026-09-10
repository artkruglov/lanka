import {libraryPath} from '../lib/project/browser-context';
import {SharingInheritance} from './sharing-inheritance';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle,DialogTrigger} from './ui/dialog';
import {Button} from './ui/button';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import type {DocumentSharing,ShareSubject,ShareSearch,ShareEntry} from '../lib/project/document-sharing';
import type {ResourceRole} from '../lib/server/resource-access';

const roles:Record<ResourceRole,string>={viewer:'Просмотр',commenter:'Комментирование',editor:'Комментарии и предложения правок',manager:'Управление доступом'};
type Pending={requestId:string;expectedEpoch:string;subject:{kind:'principal'|'group';id:string};role:ResourceRole|null;canCopy:boolean;person:ShareSubject;started:boolean};
const label=(s:ShareSubject)=>`${s.name} · ${s.kind==='group'?`группа, ${s.memberCount??0} участников`:'участник'} · ${s.id.slice(0,8)}`;
export function DocumentSharingButton({folder}:{folder?:{resourceId:string;name:string}}={}) {
 const api=folder?'/api/folder-sharing?'+new URLSearchParams({resourceId:folder.resourceId}):'/api/sharing',searchApi=folder?'/api/folder-sharing-subjects?'+new URLSearchParams({resourceId:folder.resourceId})+'&':'/api/sharing-subjects?';
 const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState<DocumentSharing|null>(null),[refresh,setRefresh]=useState(0);
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),lock=useRef(false);
 const [search,setSearch]=useState(''),[results,setResults]=useState<{query:string;value:ShareSearch}|null>(null),[searching,setSearching]=useState(false);
 const confirmRef=useRef<HTMLElement>(null);
 const [pending,setPending]=useState<Pending|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{if(pending){confirmRef.current?.focus();confirmRef.current?.scrollIntoView({block:'nearest'});}},[pending?.subject.id,pending?.role===null]);
 useEffect(()=>{if(!open)return;const resume=()=>setRefresh(n=>n+1);window.addEventListener('lanka:auth-restored',resume);return()=>window.removeEventListener('lanka:auth-restored',resume);},[open]);
 useEffect(()=>{
  if(!open)return;let alive=true;const abort=new AbortController();setLoading(true);setResults(null);
  void localFetch(api,{signal:abort.signal,cache:'no-store'}).then(r=>r.json() as Promise<DocumentSharing>).then(data=>{if(alive){setSnapshot(data);setError('');}})
   .catch(e=>{if(alive&&!abort.signal.aborted){setSnapshot(null);setError(e.message);}}).finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false;abort.abort();};
 },[open,refresh,api]);
 useEffect(()=>{
  if(!open||search.trim().length<2){setSearching(false);return;}
  let alive=true;const abort=new AbortController();setSearching(true);
  const timer=setTimeout(()=>{void localFetch(searchApi+new URLSearchParams({search:search.trim()}),{signal:abort.signal,cache:'no-store'})
   .then(r=>r.json() as Promise<ShareSearch>).then(value=>{if(alive)setResults({query:search,value});})
   .catch(e=>{if(alive&&!abort.signal.aborted){setResults(null);setError(e.message);}}).finally(()=>{if(alive)setSearching(false);});},200);
  return()=>{alive=false;abort.abort();clearTimeout(timer);};
 },[open,search,refresh,searchApi]);
 function prepare(person:ShareSubject,role:ResourceRole|null,canCopy=false,epoch=snapshot?.authzEpoch) {
  if(!snapshot||epoch!==snapshot.authzEpoch){setError('Права изменились. Обновите список перед выбором получателя.');return;}
  setPending({requestId:crypto.randomUUID(),expectedEpoch:epoch,subject:{kind:person.kind,id:person.id},role,canCopy,person,started:false});setError('');setNotice('');
 }
 async function apply() {
  if(!pending||lock.current)return;lock.current=true;setBusy(true);setError('');
  const request={requestId:pending.requestId,expectedEpoch:pending.expectedEpoch,subject:pending.subject,role:pending.role,canCopy:pending.canCopy};
  setPending({...pending,started:true});
  try {
   await localFetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
   setPending(null);setNotice('Изменение доступа сохранено.');setRefresh(n=>n+1);
  }catch(e){
   // An uncertain request retains exactly the same ID/body. Definitive conflicts require a new review.
   if(e instanceof LocalRequestError&&e.status!==undefined&&e.status<500){setPending(null);setSnapshot(null);}
   setError((e as Error).message);
  }finally{lock.current=false;setBusy(false);}
 }
 const found=results?.query===search?results.value:null;
 const entryButtons=(entry:ShareEntry)=>entry.origin==='direct'&&<span className="sharing-entry-actions"><button disabled={busy||loading||!!pending} onClick={()=>prepare(entry.subject,entry.role,entry.canCopy)}>Изменить</button><button disabled={busy||loading||!!pending} onClick={()=>prepare(entry.subject,null,false)}>Отозвать</button></span>;
 return <Dialog open={open} onOpenChange={value=>{if(lock.current)return;setOpen(value);if(!value&&!pending?.started)setPending(null);}}>
  <DialogTrigger asChild><Button variant="outline">{folder?'Доступ к папке':'Доступ'}</Button></DialogTrigger>
  <DialogContent className="document-sharing-dialog" showCloseButton={!busy}>
   <DialogTitle>{folder?'Доступ к папке «'+folder.name+'»':'Доступ к презентации'}</DialogTitle>
   <DialogDescription>{folder?'Разрешения действуют на папку и содержимое, которое наследует её доступ. Личные и ограниченные документы автоматически общими не станут.':'Выберите, кто может просматривать слайды, обсуждать их и предлагать правки. Независимое копирование разрешается отдельно.'}</DialogDescription>
   <div className="sharing-toolbar"><Button variant="outline" disabled={busy||loading} onClick={()=>{if(!pending?.started)setPending(null);setRefresh(n=>n+1);}}>Обновить права</Button><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText(folder?location.origin+libraryPath()+'#shared/'+folder.resourceId:location.origin+location.pathname);setNotice('Ссылка скопирована. Она работает только у тех, кому выдан доступ.');}catch{setError('Не удалось скопировать ссылку. Скопируйте адрес страницы из браузера.');}}}>Скопировать ссылку</Button></div>
   {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" className="project-alert">{error}</p>}{loading&&<p role="status">Проверяем права…</p>}
   {pending&&<section ref={confirmRef} tabIndex={-1} className="sharing-confirm" aria-label="Подтверждение изменения доступа"><h3>{pending.role===null?'Отозвать прямое разрешение':'Настроить прямой доступ'}</h3><p><strong>{label(pending.person)}</strong></p>
    {pending.role!==null&&<label>Разрешение<select aria-label="Разрешение получателя" value={pending.role} disabled={pending.started||busy} onChange={e=>setPending({...pending,requestId:crypto.randomUUID(),role:e.target.value as ResourceRole})}><option value="viewer">Просмотр</option><option value="commenter">Просмотр и комментарии</option><option value="editor">Комментарии и предложения правок</option><option value="manager">Просмотр и управление доступом</option></select></label>}
    {pending.role!==null&&<label><input type="checkbox" checked={pending.canCopy} disabled={pending.started||busy} onChange={e=>setPending({...pending,requestId:crypto.randomUUID(),canCopy:e.target.checked})}/> {folder?'Разрешить копирование слайдов наследующих документов':'Разрешить копию доступных слайдов'}</label>}
    {pending.canCopy&&pending.role!==null&&<p className="hint">Получатель сможет сохранить независимую редактируемую копию слайдов без личных заметок и исходных файлов. Отзыв доступа к оригиналу не удаляет уже сделанные копии.</p>}
    {pending.role==='manager'&&<p>Этот участник или каждый участник группы сможет выдавать и отзывать доступ другим людям.</p>}
    {pending.role===null&&<p>Удалится только это прямое разрешение. Доступ через другие группы или папки останется; итог показан в списке участников после сохранения.</p>}
    {pending.person.kind==='group'&&pending.role!==null&&<p>Доступ получит вся группа — сейчас {pending.person.memberCount??0} активных участников. Новые участники группы тоже получат доступ.</p>}
    {pending.started&&<p>Если ответ не пришёл, повтор отправит то же действие и не создаст второе разрешение.</p>}
    <div className="sharing-toolbar"><Button disabled={busy||loading||!snapshot} onClick={()=>void apply()}>{busy?'Сохраняем…':pending.started?'Повторить то же действие':pending.role===null?'Подтвердить отзыв':'Сохранить доступ'}</Button><Button variant="outline" disabled={busy} onClick={()=>{if(!pending.started)setPending(null);setRefresh(n=>n+1);}}>{pending.started?'Проверить права':'Отменить'}</Button></div>
   </section>}
   {snapshot&&<>
    <SharingInheritance api={api} snapshot={snapshot} disabled={busy||loading||!!pending} onSaved={()=>{setNotice('Режим доступа сохранён.');setRefresh(n=>n+1);}}/>
    {!pending&&<section className="sharing-search"><label>Добавить коллегу или группу<input aria-label="Поиск получателя доступа" placeholder="Введите минимум 2 символа имени" maxLength={140} value={search} disabled={busy||loading} onChange={e=>{setSearch(e.target.value);setError('');}}/></label>
     {searching&&<p role="status">Ищем…</p>}
     {search.trim().length>=2&&found&&!searching&&<><ul>{found.subjects.map(s=>{
      const existing=snapshot.entries.find(e=>e.origin==='direct'&&e.subject.kind===s.kind&&e.subject.id===s.id);
      return <li key={s.kind+s.id}><button disabled={busy||loading} onClick={()=>prepare(s,existing?.role??'viewer',existing?.canCopy??false,found.authzEpoch)}>{label(s)}{existing?' · уже есть прямой доступ':''}</button></li>;
     })}</ul>{!found.subjects.length&&<p>Совпадений нет. Участник должен сначала войти и быть добавлен в организацию.</p>}{found.hasMore&&<p>Показаны первые 20 совпадений. Уточните имя.</p>}</>}
    </section>}
    <section><h3>Разрешения</h3><ul className="sharing-entries">{snapshot.entries.map((entry,i)=><li key={`${entry.resourceId}:${entry.subject.kind}:${entry.subject.id}:${i}`}><div><strong>{label(entry.subject)}</strong><p>{entry.origin==='owner'?'Владелец':roles[entry.role]} · {entry.origin==='folder'?'через папку':entry.origin==='direct'?'напрямую':'постоянное право'}{entry.canCopy?' · копирование разрешено':''}{entry.subject.active?'':' · сейчас неактивен'}</p></div>{entryButtons(entry)}</li>)}</ul><p className="hint">Права от группы или папки сохраняются при удалении прямого разрешения. Их нужно менять в соответствующей группе или папке.</p></section>
    <details><summary>Кто сейчас может открыть: {snapshot.audienceCount}</summary><ul className="sharing-audience">{snapshot.audience.map(p=><li key={p.id}>{p.name} · {p.id.slice(0,8)} · {roles[p.role]}</li>)}</ul>{snapshot.audienceCount>snapshot.audience.length&&<p>Показаны первые {snapshot.audience.length} из {snapshot.audienceCount} участников.</p>}</details>
   </>}

  </DialogContent>
 </Dialog>;
}
