import {useEffect,useRef,useState,type ReactNode} from 'react';
import {corporateContext,libraryPath} from '../lib/project/browser-context';
import {localFetch} from '../lib/project/local-client';
export function CorporateFrame({children}:{children:ReactNode}) {
 const context=corporateContext();
 const loginLink=useRef<HTMLAnchorElement>(null);
 const [locked,setLocked]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{if(locked)loginLink.current?.focus();},[locked]);
 const [organizations,setOrganizations]=useState<{id:string;name:string;role:string}[]|null>(null);
 useEffect(()=>{
  if(!context)return;
  const expired=()=>{setLocked(true);setMessage('Войдите снова. Эта вкладка сохранит открытые правки.');};
  const controller=new AbortController();
  const load=()=>{if(!context.tenantId)void localFetch('/api/organizations',{signal:controller.signal}).then(r=>r.json() as Promise<{organizations:{id:string;name:string;role:string}[]}>).then(v=>{if(!controller.signal.aborted)setOrganizations(v.organizations);}).catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});};
  window.addEventListener('lanka:auth-required',expired);window.addEventListener('lanka:auth-restored',load);load();
  return()=>{controller.abort();window.removeEventListener('lanka:auth-required',expired);window.removeEventListener('lanka:auth-restored',load);};
 },[]);
 if(!context)return <>{children}</>;
 async function resume(){
  setBusy(true);try{const r=await fetch('/auth/session',{cache:'no-store',credentials:'same-origin'}),p=await r.json() as {principal?:{userId:string}};
   if(!r.ok||p.principal?.userId!==context!.userId)throw Error('Нужен тот же аккаунт, с которым открыта эта вкладка.');
   setLocked(false);setMessage('');window.dispatchEvent(new Event('lanka:auth-restored'));
  }catch(e){setMessage((e as Error).message);}finally{setBusy(false);}
 }
 async function logout(){
  setBusy(true);try{const r=await fetch('/auth/logout',{method:'POST',credentials:'same-origin'});if(!r.ok)throw Error('Не удалось выйти.');setLocked(true);setMessage('Вы вышли из Lanka. Открытые правки остаются в этой вкладке.');}
  catch(e){setMessage((e as Error).message);}finally{setBusy(false);}
 }
 return <>
  <div inert={locked} aria-hidden={locked||undefined}><header className="corporate-bar"><a href="/">LANKA · Организации</a><nav>{context.tenantId&&<a href={libraryPath()}>Презентации</a>}<button onClick={()=>void logout()} disabled={busy}>Выйти</button></nav></header>
  {context.tenantId?children:<main className="corporate-home"><h1>Ваши организации</h1><p>Выберите, где продолжить работу.</p>
   {message&&!locked&&<p role="alert">{message}</p>}
   {organizations===null?<p role="status">{message?"Список пока недоступен. Повторите вход или обновите страницу.":"Загружаем список…"}</p>:organizations.length?<div className="organization-grid">{organizations.map(o=><a href={`/organizations/${o.id}`} key={o.id}><strong>{o.name}</strong><span>{o.role==='owner'?'Владелец':o.role==='admin'?'Администратор':'Участник'} →</span></a>)}</div>:<p>Доступных организаций пока нет. Передайте администратору ваш код участника: <code>{context.userId}</code>.</p>}
  </main>}
  </div>{locked&&<div className="corporate-session-cover" role="dialog" aria-modal="true" aria-labelledby="session-title"><section><h1 id="session-title">Продолжить работу</h1><p>{message}</p><p>Вход откроется в новой вкладке. Вернитесь сюда после входа; обновлять редактор не нужно.</p><div><a ref={loginLink} href="/auth/login?returnTo=%2Fauth%2Fcomplete" target="_blank" rel="noopener noreferrer">Войти в аккаунт</a><button disabled={busy} onClick={()=>void resume()}>Я вошёл — продолжить</button></div></section></div>}
 </>;
}
