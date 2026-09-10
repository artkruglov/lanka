import {useEffect,useRef,useState} from 'react';
import {SceneCanvas} from './slide-canvas';
import {localFetch} from '../lib/project/local-client';
import {scopedApiPath} from '../lib/project/browser-context';
import type {ViewPrimitive} from '../lib/project/document-view';
type Cover={format:'lanka-document-cover/v1';id:string;title:string;revision:number;slide:{id:string;label:string;items:ViewPrimitive[]}|null};
export function DocumentCover({documentId,revision,title}:{documentId:string;revision:number;title:string}){
 const host=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(false),[cover,setCover]=useState<Cover|null>(null),[error,setError]=useState(false);
 useEffect(()=>{if(!host.current)return;if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'240px'});observer.observe(host.current);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(!visible)return;let alive=true;const abort=new AbortController();setCover(null);setError(false);
  void localFetch('/api/cover?documentId='+documentId+'&revision='+revision,{signal:abort.signal,cache:'no-store'}).then(r=>r.json() as Promise<Cover>).then(data=>{if(alive){if(data.id!==documentId||data.revision!==revision||data.format!=='lanka-document-cover/v1')throw Error('Cover changed');setCover(data);}}).catch(()=>{if(alive&&!abort.signal.aborted)setError(true);});return()=>{alive=false;abort.abort();};
 },[visible,documentId,revision]);
 const base=scopedApiPath('/api/view-assets?documentId='+documentId+'&revision='+revision);
 return <div ref={host} className="document-cover">{error?<span>Превью недоступно · обновите список</span>:cover?.slide?<SceneCanvas title={'Обложка: '+title} items={cover.slide.items} assetUrl={id=>base+'&id='+encodeURIComponent(id)} onImageError={()=>setError(true)}/>:<span>{cover?'Пустая презентация':'Загружаем обложку…'}</span>}</div>;
}
