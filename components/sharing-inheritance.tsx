import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle,DialogTrigger} from './ui/dialog';
import {Button} from './ui/button';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import type {DocumentSharing} from '../lib/project/document-sharing';
const roles={viewer:'просмотр',commenter:'комментарии',editor:'предложения правок',manager:'управление доступом'};
/** Preview resolves the complete audience at one ACL epoch; saving preserves that exact reviewed epoch. */
export function SharingInheritance({api,snapshot,disabled,onSaved}:{api:string;snapshot:DocumentSharing;disabled:boolean;onSaved:()=>void}){
 const [open,setOpen]=useState(false),[preview,setPreview]=useState<DocumentSharing|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 const pending=useRef<{action:'inheritance';requestId:string;expectedEpoch:string;inheritance:'inherit'|'restricted'}|null>(null),lock=useRef(false);
 const nextMode=snapshot.inheritance?.mode==='inherit'?'restricted':'inherit';
 const [target,setTarget]=useState<'inherit'|'restricted'>(nextMode),mode=target;
 useEffect(()=>{if(!open)return;let alive=true;const abort=new AbortController();setPreview(null);setError('');
  void localFetch(api+(api.includes('?')?'&':'?')+'inheritance='+mode,{signal:abort.signal,cache:'no-store'}).then(r=>r.json() as Promise<DocumentSharing>).then(p=>{if(alive)setPreview(p);}).catch(e=>{if(alive&&!abort.signal.aborted)setError(e.message);});
  return()=>{alive=false;abort.abort();};
 },[open,api,mode,refresh]);
 async function save(){if(lock.current||!preview)return;lock.current=true;setBusy(true);setError('');
  const request=pending.current??{action:'inheritance' as const,requestId:crypto.randomUUID(),expectedEpoch:preview.authzEpoch,inheritance:mode};pending.current=request;
  try{await localFetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});pending.current=null;setOpen(false);onSaved();}
  catch(e){if(e instanceof LocalRequestError&&e.status!==undefined&&e.status<500){pending.current=null;setPreview(null);}setError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 if(!snapshot.inheritance?.hasParent)return null;
 return <section className="sharing-inheritance"><h3>Доступ через папку</h3><p>{snapshot.inheritance.mode==='inherit'?'Используются разрешения папки и прямые разрешения.':'Используется отдельный список. Разрешения папки не применяются.'}</p>
  <Dialog open={open} onOpenChange={value=>{if(lock.current||pending.current)return;if(value)setTarget(nextMode);setOpen(value);}}>
   <DialogTrigger asChild><Button variant="outline" disabled={disabled||(nextMode==='inherit'&&!snapshot.inheritance.canInherit)}>{nextMode==='inherit'?'Использовать доступ папки':'Настроить отдельный доступ'}</Button></DialogTrigger>
   <DialogContent className="document-sharing-dialog" showCloseButton={!busy&&!pending.current}><DialogTitle>{mode==='inherit'?'Использовать доступ папки?':'Отключить доступ через папку?'}</DialogTitle>
    <DialogDescription>Ниже показано, кто сможет открыть документ или папку после сохранения. Прямые разрешения и права владельца сохранятся. Для папки изменение затронет наследующее содержимое.</DialogDescription>
    {error&&<p role="alert" className="project-alert">{error}</p>}
    {!preview&&!error&&<p role="status">Проверяем получателей…</p>}
    {preview&&<><h3>Участников после сохранения: {preview.audienceCount}</h3><ul className="sharing-audience">{preview.audience.map(p=><li key={p.id}>{p.name} · {p.id.slice(0,8)} · {roles[p.role]}{p.canCopy?' · копирование разрешено':''}</li>)}</ul>{preview.audienceCount>preview.audience.length&&<p>Показаны первые {preview.audience.length} из {preview.audienceCount} участников.</p>}</>}
    {pending.current&&<p>Ответ не подтверждён. Повтор сохранит то же действие; не закрывайте окно до проверки.</p>}
    <div className="sharing-toolbar"><Button disabled={busy||!preview} onClick={()=>void save()}>{busy?'Сохраняем…':pending.current?'Повторить сохранение':'Сохранить режим доступа'}</Button>{!pending.current&&<Button variant="outline" disabled={busy} onClick={()=>{if(error)setRefresh(n=>n+1);else setOpen(false);}}>{error?'Обновить предпросмотр':'Отменить'}</Button>}</div>
   </DialogContent>
  </Dialog>
  {nextMode==='inherit'&&!snapshot.inheritance.canInherit&&<p className="hint">Для включения наследования нужны права управления родительской папкой.</p>}
 </section>;
}
