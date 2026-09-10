import {LibraryCatalogCard} from './library-catalog-card';
import {LibraryViewSwitch,type LibraryView} from './library-view-switch';
import {DocumentCover} from './document-cover';
import {DocumentReactions} from './document-reactions';
import {SharedCreation} from './shared-creation';
import {folderTree} from '../lib/project/library-folders';
import {DocumentSharingButton} from './document-sharing';
import {useEffect,useState} from 'react';
import {FolderOpen,RefreshCw,Search,Users} from 'lucide-react';
import {localFetch} from '../lib/project/local-client';
import {documentPath} from '../lib/project/browser-context';
import type {SharedLibrary as Listing} from '../lib/project/shared-library';

/** Shared metadata has its own read contract; never render an owner's library DTO here. */
export function SharedLibrary({view,onViewChange}:{view:LibraryView;onViewChange:(view:LibraryView)=>void}) {
 const readFolder=()=>location.hash.match(/^#shared\/([a-f0-9-]{36})$/)?.[1]??'';
 const [folderId,setFolderId]=useState(readFolder);
 const go=(id:string)=>{setFolderId(id);setSearch('');setCursors([]);history.replaceState(null,'',location.pathname+location.search+(id?'#shared/'+id:'#shared'));};
 useEffect(()=>{const sync=()=>{setFolderId(readFolder());setCursors([]);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 const [bookmarked,setBookmarked]=useState(false);
 const [search,setSearch]=useState(''),[cursors,setCursors]=useState<string[]>([]),[retry,setRetry]=useState(0);
 const query=new URLSearchParams({search:search.trim()});if(cursors.length)query.set('cursor',cursors.at(-1)!);
 if(bookmarked)query.set('bookmarked','1');
 if(folderId)query.set('folderResourceId',folderId);
 const url='/api/shared-library?'+query;
 const [state,setState]=useState<{url:string;data:Listing|null;error:string}>({url:'',data:null,error:''});
 const [loading,setLoading]=useState(false);
 const current=state.url===url?state:{url,data:null,error:''};
 useEffect(()=>{
  let alive=true,pending=false;const abort=new AbortController();
  const load=async()=>{
   if(pending||document.visibilityState==='hidden')return;
   pending=true;setLoading(true);
   try {
    const response=await localFetch(url,{signal:abort.signal,cache:'no-store'}),data=await response.json() as Listing;
    if(alive)setState({url,data,error:''});
   }catch(e){if(alive&&!abort.signal.aborted)setState({url,data:null,error:(e as Error).message});}
   finally{pending=false;if(alive)setLoading(false);}
  };
  void load();const timer=setInterval(()=>void load(),30_000);
  document.addEventListener('visibilitychange',load);window.addEventListener('lanka:auth-restored',load);
  return()=>{alive=false;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);window.removeEventListener('lanka:auth-restored',load);};
 },[url,retry]);
 const folders=folderTree(current.data?.folders??[]),selected=folders.find(f=>f.id===folderId),children=folders.filter(f=>f.parentId===(folderId||null));
 return <main className="library-main shared-library">
  <header><div><span className="eyebrow">БИБЛИОТЕКА ОРГАНИЗАЦИИ</span>{folderId&&<nav className="library-breadcrumbs" aria-label="Путь общей папки"><button onClick={()=>go('')}>Доступные мне</button>{selected?.ancestors.map(id=><span key={id}> / <button onClick={()=>go(id)}>{folders.find(f=>f.id===id)?.name}</button></span>)}</nav>}<h1>{folderId?current.data?.folder?.name??'Общая папка':'Доступные мне'}</h1><p>{folderId?'Документы этой папки, к которым у вас есть доступ.':'Папки и презентации коллег, к которым у вас есть доступ.'}</p></div>
   <label className="library-search"><Search size={18} aria-hidden="true"/><input aria-label="Поиск доступных презентаций" placeholder="Найти презентацию" maxLength={140} value={search} onChange={e=>{setSearch(e.target.value);setCursors([]);}}/></label>
  </header>
  <div className="shared-library-toolbar library-display-toolbar"><LibraryViewSwitch view={view} onChange={onViewChange}/><p role="status">{current.error?'Список недоступен':!current.data?'Загружаем презентации…':`Показано ${current.data.documents.length}${loading?' · обновляем…':''}`}</p><label className="shared-bookmark-filter"><input type="checkbox" checked={bookmarked} onChange={e=>{setBookmarked(e.target.checked);setCursors([]);}}/>Только моё избранное</label><button className="shared-library-refresh" aria-label="Обновить список" disabled={loading} onClick={()=>setRetry(n=>n+1)}><RefreshCw size={16} aria-hidden="true"/><span>Обновить</span></button></div>
  {current.error&&<p className="project-alert" role="alert">{current.error} Список скрыт до восстановления доступа.</p>}
  {current.data&&<>
   {current.data.folder?.role==='manager'&&<div className="shared-library-toolbar"><SharedCreation key={current.data.folder.id+'doc'} folder={current.data.folder} kind="document" onCreated={()=>setRetry(n=>n+1)}/><SharedCreation key={current.data.folder.id+'folder'} folder={current.data.folder} kind="folder" onCreated={()=>setRetry(n=>n+1)}/><DocumentSharingButton key={current.data.folder.id} folder={{resourceId:current.data.folder.id,name:current.data.folder.name}}/></div>}
   {children.length>0&&<nav className="shared-library-toolbar library-child-folders" aria-label="Общие папки">{children.map(f=><button key={f.id} onClick={()=>go(f.id)}><FolderOpen size={18} aria-hidden="true"/>{f.name}</button>)}</nav>}
   <ul className={`shared-library-list${view==='list'?' shared-library-compact':''}`} aria-label="Доступные презентации">{current.data.documents.map(d=><LibraryCatalogCard key={d.id} href={documentPath(d.id)} kind="document" title={d.title} action="Открыть просмотр" cover={<DocumentCover key={d.id+':'+d.revision} documentId={d.id} revision={d.revision} title={d.title}/>} metadata={<span>Версия {d.revision} · Изменено <time dateTime={d.updatedAt}>{new Date(d.updatedAt).toLocaleString('ru-RU',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</time></span>}>
    {d.reactions&&<DocumentReactions documentId={d.id} initial={d.reactions} onChanged={()=>setRetry(n=>n+1)}/>}
   </LibraryCatalogCard>)}</ul>
   {!current.data.documents.length&&<div className="library-empty"><Users size={36} aria-hidden="true"/><h2>{search.trim()?'Ничего не найдено':bookmarked?'В избранном пока нет доступных презентаций':cursors.length?'На этой странице больше нет презентаций':folderId?'В этой папке нет доступных презентаций':'Здесь появятся презентации коллег'}</h2><p>{search.trim()?'Попробуйте другое название.':cursors.length?'Вернитесь на предыдущую страницу: доступ или порядок документов мог измениться.':'Документ появится здесь, когда вам выдадут доступ напрямую, через группу или папку.'}</p></div>}
   {(cursors.length>0||current.data.nextCursor)&&<nav className="shared-library-pagination" aria-label="Страницы доступных презентаций"><button disabled={loading||!cursors.length} onClick={()=>setCursors(c=>c.slice(0,-1))}>Предыдущая</button><span>Страница {cursors.length+1}</span><button disabled={loading||!current.data.nextCursor} onClick={()=>setCursors(c=>[...c,current.data!.nextCursor!])}>Следующая</button></nav>}
   <p className="shared-library-note">Откройте презентацию для просмотра слайдов и доступных вам действий. Список обновляется каждые 30 секунд и при возвращении на вкладку.</p>
  </>}
 </main>;
}
