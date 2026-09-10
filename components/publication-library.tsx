import {LibraryCatalogCard} from './library-catalog-card';
import {DocumentReactions} from './document-reactions';
import {folderTree,type LibraryFolder} from '../lib/project/library-folders';
import {useEffect,useState} from 'react';
import {Search,RefreshCw,FolderOpen} from 'lucide-react';
import {LibraryViewSwitch,type LibraryView} from './library-view-switch';
import {localFetch} from '../lib/project/local-client';
import {corporateContext,documentPath} from '../lib/project/browser-context';
type Item={id:string;documentId:string;title:string;revision:number;publishedAt:string;publishedBy:string;slideCount:number;reactions?:{likes:number;liked:boolean;bookmarked:boolean}};
type Listing={folders?:LibraryFolder[];folder?:{id:string;name:string}|null;items:Item[];nextCursor:string|null};
export function PublicationLibrary({view,onViewChange}:{view:LibraryView;onViewChange:(view:LibraryView)=>void}){
 const readFolder=()=>location.hash.match(/^#publications\/([a-f0-9-]{36})$/)?.[1]??'';
 const [folderId,setFolderId]=useState(readFolder),[bookmarked,setBookmarked]=useState(false);
 const go=(id:string)=>{setFolderId(id);setSearch('');setCursors([]);history.replaceState(null,'',location.pathname+location.search+(id?'#publications/'+id:'#publications'));};
 useEffect(()=>{const sync=()=>{setFolderId(readFolder());setSearch('');setCursors([]);};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[]);
 const [search,setSearch]=useState(''),[cursors,setCursors]=useState<string[]>([]),[retry,setRetry]=useState(0),[loading,setLoading]=useState(false);
 const query=new URLSearchParams({search:search.trim()});if(cursors.length)query.set('cursor',cursors.at(-1)!);
 if(folderId)query.set('folderResourceId',folderId);
 if(bookmarked)query.set('bookmarked','true');
 const url='/api/publication-catalog?'+query;
 const [state,setState]=useState<{url:string;data:Listing|null;error:string}>({url:'',data:null,error:''});
 const current=state.url===url?state:{url,data:null,error:''};
 useEffect(()=>{
  let live=true,pending=false;const abort=new AbortController();
  const load=async()=>{
   if(pending||document.visibilityState==='hidden')return;pending=true;setLoading(true);
   try{const data=await(await localFetch(url,{signal:abort.signal,cache:'no-store'})).json() as Listing;if(live)setState({url,data,error:''});}
   catch(e){if(live&&!abort.signal.aborted)setState({url,data:null,error:(e as Error).message});}
   finally{pending=false;if(live)setLoading(false);}
  };
  void load();const timer=setInterval(()=>void load(),30000);
  window.addEventListener('focus',load);document.addEventListener('visibilitychange',load);window.addEventListener('lanka:auth-restored',load);
  return()=>{live=false;abort.abort();clearInterval(timer);window.removeEventListener('focus',load);document.removeEventListener('visibilitychange',load);window.removeEventListener('lanka:auth-restored',load);};
 },[url,retry]);
 const folders=folderTree(current.data?.folders??[]),selected=folders.find(f=>f.id===folderId),children=folders.filter(f=>(f.parentId??null)===(folderId||null));
 return <main className="library-main shared-library">
  <header><div><span className="eyebrow">БИБЛИОТЕКА ОРГАНИЗАЦИИ</span>{folderId&&<nav className="library-breadcrumbs" aria-label="Путь папки публикаций"><button onClick={()=>go('')}>Все публикации</button>{selected?.ancestors.map(id=><span key={id}> / <button onClick={()=>go(id)}>{folders.find(f=>f.id===id)?.name}</button></span>)}</nav>}<h1>{folderId?current.data?.folder?.name??'Папка публикаций':'Публикации'}</h1><p>{folderId?'Сохранённые версии документов этой папки.':'Проверенные версии для просмотра и повторного использования.'}</p></div><label className="library-search"><Search size={18} aria-hidden="true"/><input aria-label="Поиск публикаций" placeholder="Найти публикацию" maxLength={140} value={search} onChange={e=>{setSearch(e.target.value);setCursors([]);}}/></label></header>
  <div className="shared-library-toolbar library-display-toolbar"><LibraryViewSwitch view={view} onChange={onViewChange}/><button aria-pressed={bookmarked} onClick={()=>{setBookmarked(v=>!v);setCursors([]);}}>Избранные документы</button><p role="status">{current.error?'Список недоступен':!current.data?'Загружаем публикации…':`Показано ${current.data.items.length}${loading?' · обновляем…':''}`}</p><button className="shared-library-refresh" aria-label="Обновить публикации" disabled={loading} onClick={()=>setRetry(n=>n+1)}><RefreshCw size={16} aria-hidden="true"/>Обновить</button></div>
  {current.error&&<p className="project-alert" role="alert">{current.error} Список скрыт до восстановления доступа.</p>}
  {current.data&&<>{children.length>0&&<nav className="shared-library-toolbar library-child-folders" aria-label="Папки публикаций">{children.map(f=><button key={f.id} onClick={()=>go(f.id)}><FolderOpen size={18} aria-hidden="true"/>{f.name}</button>)}</nav>}<ul className={`shared-library-list${view==='list'?' shared-library-compact':''}`} aria-label="Опубликованные презентации">{current.data.items.map(item=><LibraryCatalogCard key={item.id} href={documentPath(item.documentId)+'?publication='+item.id} title={item.title} kind="publication" action="Открыть версию" cover={<PublicationCover item={item}/>} metadata={<><span>Версия {item.revision} · {item.slideCount} слайдов</span><span>{item.publishedBy} · <time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleString('ru-RU',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</time></span></>}>
   {item.reactions&&<DocumentReactions documentId={item.documentId} initial={item.reactions} onChanged={()=>setRetry(n=>n+1)}/>}
  </LibraryCatalogCard>)}</ul>
  {!current.data.items.length&&<div className="library-empty"><h2>{search.trim()?'Ничего не найдено':cursors.length?'На этой странице больше нет публикаций':bookmarked?'В избранном пока нет опубликованных документов':'Здесь появятся опубликованные версии'}</h2><p>{search.trim()?'Попробуйте другое название.':cursors.length?'Вернитесь на предыдущую страницу.':'Откройте документ и выберите «Публикации», чтобы сохранить проверенный вариант для коллег с доступом.'}</p></div>}
  {(cursors.length>0||current.data.nextCursor)&&<nav className="shared-library-pagination" aria-label="Страницы каталога публикаций"><button disabled={loading||!cursors.length} onClick={()=>setCursors(c=>c.slice(0,-1))}>Предыдущая</button><span>Страница {cursors.length+1}</span><button disabled={loading||!current.data.nextCursor} onClick={()=>setCursors(c=>[...c,current.data!.nextCursor!])}>Следующая</button></nav>}
  <p className="shared-library-note">Открывается сохранённая версия. Правки исходника её не меняют. Лайки и избранное относятся к документу и общие для его версий. Список обновляется при возвращении во вкладку и каждые 30 секунд.</p></>}
 </main>;
}
function PublicationCover({item}:{item:Item}){
 const [failed,setFailed]=useState(false);
 const src=`/api/organizations/${corporateContext()!.tenantId}/documents/${item.documentId}/publications/${item.id}/artifacts?kind=preview&page=1`;
 return <span className="publication-cover">{failed?<span>Предпросмотр недоступен</span>:<img src={src} loading="lazy" alt={`Обложка: ${item.title}`} onError={()=>setFailed(true)}/>}</span>;
}
