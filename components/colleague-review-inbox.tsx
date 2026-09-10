import {useEffect,useState} from 'react';
import {localFetch} from '../lib/project/local-client';
import {documentPath} from '../lib/project/browser-context';
type Page={items:{id:string;documentId:string;title:string;senderName:string;target:{revision:number};note:string}[];nextCursor:string|null;authzEpoch:string};
export function ColleagueReviewInbox(){
 const [expanded,setExpanded]=useState(false);
 const [pages,setPages]=useState<{cursor:string;epoch:string}[]>([]),[retry,setRetry]=useState(0);
 const cursor=pages.at(-1),url='/api/review-inbox'+(cursor?'?cursor='+cursor.cursor+'&expectedEpoch='+cursor.epoch:'');
 const [state,setState]=useState<{url:string;data:Page|null;error:string}>({url:'',data:null,error:''});
 const data=state.url===url?state.data:null,error=state.url===url?state.error:'';
 useEffect(()=>{
  let live=true,loading=false;const controller=new AbortController();
  const load=async()=>{if(loading)return;loading=true;try{const response=await localFetch(url,{signal:controller.signal,cache:'no-store'});const data=await response.json() as Page;if(live)setState({url,data,error:''});}catch(e){if(live&&!controller.signal.aborted)setState({url,data:null,error:(e as Error).message});}finally{loading=false;}};
  void load();const focus=()=>{if(document.visibilityState==='visible')void load();};const timer=setInterval(focus,15000);window.addEventListener('focus',focus);
  return()=>{live=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);};
 },[url,retry]);
 return <section className="library-attention colleague-review-inbox" aria-label="Коллеги ждут проверки">
  <div className="library-recents-heading"><h2>Коллеги ждут проверки</h2></div>
  {error?<div role="alert"><p>{error}</p><button onClick={()=>{setPages([]);setRetry(n=>n+1);}}>Обновить очередь проверок</button></div>:!data?<p role="status">Загружаем запросы коллег…</p>:<>
   {!data.items.length?<p>{pages.length?'На этой странице запросов больше нет.':'Входящих запросов пока нет.'}</p>:<ul>{(expanded?data.items:data.items.slice(0,4)).map(item=><li key={item.id}><a href={documentPath(item.documentId)+'?reviewRequest='+item.id}><span><strong>{item.title}</strong><small>{item.senderName} · проверить версию {item.target.revision}</small>{item.note&&<small className="colleague-review-preview">{item.note}</small>}</span><span className="library-attention-action">Открыть проверку →</span></a></li>)}</ul>}
   {data.items.length>4&&<button aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'Свернуть входящие проверки':'Показать все проверки на странице'}</button>}
   {(pages.length>0||data.nextCursor)&&<nav className="shared-library-pagination" aria-label="Страницы входящих проверок"><button disabled={!pages.length} onClick={()=>{setExpanded(false);setPages(p=>p.slice(0,-1));}}>Предыдущая страница проверок</button><span>{pages.length+1}</span><button disabled={!data.nextCursor} onClick={()=>{setExpanded(false);setPages(p=>[...p,{cursor:data.nextCursor!,epoch:data.authzEpoch}]);}}>Следующая страница проверок</button></nav>}
  </>}
 </section>;
}
