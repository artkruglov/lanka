import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle,DialogTrigger} from './ui/dialog';
import {Button} from './ui/button';
import {corporateContext} from '../lib/project/browser-context';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
type Role='owner'|'admin'|'member';
type Member={id:string;userId:string;name:string;identityDisabled?:boolean;role:Role;status:'active'|'suspended'};
type View={members:Member[];nextCursor:string|null;role:Role;userId:string;authzEpoch:string};
const labels:Record<Role,string>={owner:'Владелец организации',admin:'Администратор',member:'Участник'};
export function OrganizationMembers(){
 const [allowed,setAllowed]=useState(false),[open,setOpen]=useState(false),[view,setView]=useState<View|null>(null),[selected,setSelected]=useState<Member|null>(null),[role,setRole]=useState<Role>('member'),[status,setStatus]=useState<Member['status']>('active'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[search,setSearch]=useState(''),[loadedSearch,setLoadedSearch]=useState('');
 const pending=useRef<{requestId:string;expectedEpoch:string;userId:string;role:Role;status:Member['status']}|null>(null),lock=useRef(false);
 useEffect(()=>{let alive=true;const tenant=corporateContext()?.tenantId;void localFetch('/api/organizations').then(r=>r.json() as Promise<{organizations:{id:string;role:Role}[]}>).then(r=>{if(alive)setAllowed(r.organizations.some(o=>o.id===tenant&&o.role!=='member'));}).catch(()=>{});return()=>{alive=false;};},[]);
 const membersUrl=(query:string,cursor?:string,epoch?:string)=>{const params=new URLSearchParams({search:query});if(cursor)params.set('cursor',cursor);if(epoch)params.set('expectedEpoch',epoch);return '/api/members?'+params;};
 async function load(more=false){if(lock.current||more&&!view?.nextCursor)return;lock.current=true;setBusy(true);setError('');const query=more?loadedSearch:search;
  try{const r=await localFetch(membersUrl(query,more?view!.nextCursor!:undefined,more?view!.authzEpoch:undefined));const next=await r.json() as View;setView(old=>({...next,members:more&&old?[...old.members,...next.members]:next.members}));setLoadedSearch(query);setSelected(null);}
  catch(e){setError((e as Error).message);}finally{lock.current=false;setBusy(false);}}
 async function save(){if(lock.current||!view||!selected)return;lock.current=true;setBusy(true);setError('');setNotice('');
  const request=pending.current??{requestId:crypto.randomUUID(),expectedEpoch:view.authzEpoch,userId:selected.userId,role,status};pending.current=request;
  try{await localFetch('/api/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});pending.current=null;setSelected(null);setNotice('Изменение сохранено. Права проверяются при каждом обращении к организации.');
   try{const r=await localFetch(membersUrl(loadedSearch));setView(await r.json());}catch{setView(null);setNotice('Изменение сохранено. Управление командой больше недоступно вашему аккаунту.');}
  }catch(e){if(e instanceof LocalRequestError&&e.status!==undefined&&e.status<500)pending.current=null;setError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 if(!allowed)return null;
 return <Dialog open={open} onOpenChange={value=>{if(lock.current||pending.current)return;setOpen(value);setSelected(null);setNotice('');if(value)void load();}}><DialogTrigger asChild><button className="text-link">Участники организации</button></DialogTrigger>
  <DialogContent className="organization-members-dialog" showCloseButton={!busy&&!pending.current}><DialogTitle>Участники организации</DialogTitle><DialogDescription>Роли управляют организацией. Доступ к конкретным презентациям и папкам настраивается отдельно.</DialogDescription>
   {notice&&<p role="status">{notice}</p>}{error&&<p className="chat-error" role="alert">{error}</p>}
   {selected?<><h3>{selected.name}{selected.userId===view?.userId?' · это вы':''}</h3>
    <label>Роль<select aria-label="Роль участника" value={role} disabled={busy||!!pending.current} onChange={e=>setRole(e.target.value as Role)}>{(view?.role==='owner'?['member','admin','owner'] as const:['member'] as const).map(r=><option key={r} value={r}>{labels[r]}</option>)}</select></label>
    <label>Доступ к организации<select aria-label="Статус участника" value={status} disabled={busy||!!pending.current} onChange={e=>setStatus(e.target.value as Member['status'])}><option value="active">Активен</option><option value="suspended">Отключён</option></select></label>
    <p>{status==='suspended'?'Участник потеряет доступ к этой организации; выданные им ключи агента также перестанут работать. Владение его документами не передаётся. Ранее предоставленный коллегам доступ к документам сохраняется.':selected.status==='suspended'?'Участник снова получит доступ по сохранившимся правам. Его неистёкшие и неотозванные ключи агента также снова заработают.':'Изменится роль участника в организации; права на документы останутся прежними.'}</p>
    {role==='owner'&&selected.role!=='owner'&&<p>Новый владелец сможет назначать других владельцев и управлять администраторами. Это не передаёт ему личные документы коллег.</p>}
    {selected.userId===view?.userId&&<p>Вы меняете собственный доступ. После сохранения это окно может стать недоступно.</p>}
    <div className="chat-profile-actions"><Button disabled={busy||(role===selected.role&&status===selected.status)} onClick={()=>void save()}>{busy?'Сохраняем…':pending.current?'Повторить сохранение':'Подтвердить изменение'}</Button><Button variant="outline" disabled={busy||!!pending.current} onClick={()=>{setSelected(null);setError('');}}>Назад</Button></div>
    {!pending.current&&error&&<Button variant="outline" disabled={busy} onClick={()=>void load()}>Обновить список</Button>}
   </>:view?<><form className="member-search" onSubmit={e=>{e.preventDefault();void load();}}><label>Найти участника<input aria-label="Найти участника" maxLength={140} disabled={busy} value={search} onChange={e=>setSearch(e.target.value)}/></label><Button type="submit" variant="outline" disabled={busy}>Найти</Button></form><p role="status">Показано: {view.members.length}{view.nextCursor?' · есть ещё':''}{loadedSearch?' · поиск «'+loadedSearch+'»':''}</p><div className="organization-members-list">{view.members.map(m=><div className="organization-member" key={m.id}><div><strong>{m.name}{m.userId===view.userId?' · это вы':''}</strong><small>{labels[m.role]} · {m.identityDisabled?'Вход отключён администратором установки':m.status==='active'?'Активен':'Отключён'}</small></div><Button variant="outline" size="sm" disabled={busy||m.identityDisabled||(view.role!=='owner'&&m.role!=='member')} aria-label={'Изменить доступ: '+m.name} onClick={()=>{setSelected(m);setRole(m.role);setStatus(m.status);setNotice('');setError('');}}>Изменить</Button></div>)}</div>{!view.members.length&&<p>Участники не найдены. Измените запрос.</p>}{view.nextCursor&&<Button variant="outline" disabled={busy} onClick={()=>void load(true)}>Показать ещё 50</Button>}<Button variant="ghost" disabled={busy} onClick={()=>void load()}>Обновить список</Button><p className="hint">Здесь показаны уже добавленные участники. Новых пользователей подключает администратор установки через корпоративный вход.</p></>:busy?<p role="status">Загружаем участников…</p>:null}
  </DialogContent>
 </Dialog>;
}
