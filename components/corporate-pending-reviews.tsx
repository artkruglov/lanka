import {useEffect,useState} from 'react';
import {ArrowRight} from 'lucide-react';
import {localFetch} from '../lib/project/local-client';
import {documentPath} from '../lib/project/browser-context';
type Page={documents:{id:string;title:string;pending:number;revision:number}[];nextCursor?:string|null};
/** Personal proposals only. Shared review assignments require a separate contract. */
export function CorporatePendingReviews(){
 const [cursors,setCursors]=useState<string[]>([]),[expanded,setExpanded]=useState(false),[retry,setRetry]=useState(0);
 const cursor=cursors.at(-1),url='/api/library?pending=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
 const [state,setState]=useState<{url:string;data:Page|null;error:string}>({url:'',data:null,error:''});
 const current=state.url===url?state:{url,data:null,error:''};
 useEffect(()=>{
  let live=true,pending=false;const controller=new AbortController();
  const load=async()=>{if(pending)return;pending=true;try{const response=await localFetch(url,{signal:controller.signal,cache:'no-store'});const data=await response.json() as Page;if(live)setState({url,data,error:''});}catch(e){if(live&&!controller.signal.aborted)setState({url,data:null,error:(e as Error).message});}finally{pending=false;}};
  void load();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},30000);window.addEventListener('focus',load);
  return()=>{live=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',load);};
 },[url,retry]);
 const data=current.data;
 if(data&&!data.documents.length&&!cursors.length)return null;
 return <section className="library-attention" aria-label="Предложения в моих документах">
  <div className="library-recents-heading"><h2>Предложения в моих документах</h2></div>
  <p>Проверьте изменения, которые ещё не приняты. Общие задания коллег сюда не входят.</p>
  {current.error?<div role="alert"><p>{current.error}</p><button className="text-link" onClick={()=>setRetry(n=>n+1)}>Повторить загрузку предложений</button></div>:!data?<p role="status">Загружаем предложения…</p>:<>
   {!data.documents.length?<p>На этой странице предложений больше нет. Вернитесь на предыдущую.</p>:<ul>{(expanded?data.documents:data.documents.slice(0,4)).map(d=><li key={d.id}><a href={documentPath(d.id)+'?review=1'}><span><strong>{d.title}</strong><small>Предложений: {d.pending} · текущая версия {d.revision}</small></span><span className="library-attention-action">Проверить <ArrowRight size={16} aria-hidden="true"/></span></a></li>)}</ul>}
   {data.documents.length>4&&<button className="text-link" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'Свернуть':`Показать всю страницу · ${data.documents.length}`}</button>}
   {(cursors.length>0||data.nextCursor)&&<nav className="shared-library-pagination" aria-label="Страницы моих предложений"><button disabled={!cursors.length} onClick={()=>{setExpanded(false);setCursors(c=>c.slice(0,-1));}}>Предыдущая</button><span>Страница {cursors.length+1}</span><button disabled={!data.nextCursor} onClick={()=>{setExpanded(false);setCursors(c=>[...c,data.nextCursor!]);}}>Следующая</button></nav>}
  </>}
 </section>;
}
