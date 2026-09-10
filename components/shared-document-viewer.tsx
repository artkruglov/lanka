import {ColleagueReviewButton} from './colleague-review';
import {DocumentPublicationsButton} from './document-publications';
import {SharedCopyButton} from './shared-copy';
import {AgentDelegationButton} from './agent-delegation';
import {SharedComments} from './shared-comments';
import {useEffect,useState} from 'react';
import {SceneCanvas} from './slide-canvas';
import {corporateContext,libraryPath} from '../lib/project/browser-context';
import {localFetch} from '../lib/project/local-client';
import type {DocumentView} from '../lib/project/document-view';
import {DocumentSharingButton} from './document-sharing';

/** This page consumes only the shared render DTO. It never loads the owner's editor package. */
export function SharedDocumentViewer() {
 const ctx=corporateContext()!,base=`/api/organizations/${ctx.tenantId}/documents/${ctx.documentId}`;
 const [view,setView]=useState<DocumentView|null>(null),[index,setIndex]=useState(0),[error,setError]=useState(''),[retry,setRetry]=useState(0),[imageError,setImageError]=useState(false),[elementId,setElementId]=useState<string|undefined>();
 useEffect(()=>setElementId(undefined),[index]);
 useEffect(()=>{setImageError(false);},[view?.revision]);
 useEffect(()=>{
  let alive=true,pending=false;const abort=new AbortController();
  const load=async()=>{
   if(pending||document.visibilityState==='hidden')return;pending=true;
   try {const r=await localFetch('/api/view',{cache:'no-store',signal:abort.signal}),next=await r.json() as DocumentView;
    if(alive){setView(next);setIndex(i=>Math.min(i,next.slides.length-1));setError('');}
   }catch(e){if(alive&&!abort.signal.aborted){setView(null);setError((e as Error).message);}}
   finally{pending=false;}
  };
  void load();const timer=setInterval(()=>void load(),5000);
  document.addEventListener('visibilitychange',load);window.addEventListener('lanka:auth-restored',load);
  return()=>{alive=false;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);window.removeEventListener('lanka:auth-restored',load);};
 },[base,retry]);
 const slide=view?.slides[index];
 return <main className="shared-document-viewer">
  <header><div><a href={libraryPath()+'#shared'}>К доступным презентациям</a><h1>{view?.title||'Общая презентация'}</h1><p>{view?`Просмотр · версия ${view.revision}`:'Проверяем доступ к текущей версии…'}</p></div><div className="sharing-toolbar">{view&&view.permission.role!=='viewer'&&<ColleagueReviewButton revision={view.revision}/>}{view&&<DocumentPublicationsButton revision={view.revision} canManage={view.permission.role==='manager'}/>}{view?.permission.canCopy&&<SharedCopyButton view={view}/>} {view&&<AgentDelegationButton canComment={view.permission.role!=="viewer"} canPropose={["editor","manager"].includes(view.permission.role)}/>}{view?.permission.role==='manager'&&<DocumentSharingButton/>}<button onClick={()=>{setImageError(false);setRetry(n=>n+1);}}>Обновить</button></div></header>
  {error&&<p role="alert" className="shared-view-error">{error} Слайды скрыты до восстановления доступа.</p>}
  {imageError&&<p role="alert" className="shared-view-error">Изображение недоступно или версия изменилась. Обновите презентацию.</p>}
  {view&&slide&&<><nav aria-label="Слайды общей презентации">{view.slides.map((s,i)=><button key={s.id} aria-current={i===index?'page':undefined} onClick={()=>setIndex(i)}>{i+1}</button>)}</nav>
   <section aria-label={slide.label} key={`${view.revision}:${slide.id}:${retry}`}><div style={{position:"relative",width:"100%",height:"100%"}}><SceneCanvas items={slide.items} title={slide.label} assetUrl={id=>`${base}/view-assets?revision=${view.revision}&id=${encodeURIComponent(id)}`} onImageError={()=>setImageError(true)}/><svg viewBox={`0 0 ${view.width} ${view.height}`} style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none'}} aria-label="Объекты для обсуждения" role="group">{slide.targets.map(t=><rect key={t.id} x={t.x} y={t.y} width={t.w} height={t.h} fill="transparent" stroke={elementId===t.id?'#6554c0':'none'} strokeWidth={3} role="button" tabIndex={0} aria-label={`Обсудить объект: ${t.label}`} aria-pressed={elementId===t.id} style={{pointerEvents:'all',cursor:'pointer'}} onClick={()=>setElementId(t.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setElementId(t.id);}}}/>)}</svg></div></section>
   <footer><button disabled={index===0} onClick={()=>setIndex(i=>i-1)}>Предыдущий</button><span>{index+1} из {view.slides.length}</span><button disabled={index===view.slides.length-1} onClick={()=>setIndex(i=>i+1)}>Следующий</button></footer>
   <SharedComments key={`${ctx.documentId}:${slide.id}`} documentId={ctx.documentId!} slideId={slide.id} revision={view.revision} selectedElementId={elementId} targets={slide.targets} onSelectElement={setElementId}/>
   <p className="hint">Обсуждайте слайды с коллегами. Агент с разрешением на предложения может подготовить правки для проверки владельцем.</p>
  </>}
 </main>;
}
