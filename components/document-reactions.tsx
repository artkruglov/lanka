import {useEffect,useRef,useState} from 'react';
import {Heart,Bookmark} from 'lucide-react';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
type Reactions={likes:number;liked:boolean;bookmarked:boolean};
export function DocumentReactions({documentId,initial,onChanged}:{documentId:string;initial:Reactions;onChanged:()=>void}){
 const [value,setValue]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef<{requestId:string;kind:'like'|'bookmark';active:boolean}|null>(null),lock=useRef(false);
 useEffect(()=>{if(!pending.current)setValue(initial);},[initial]);
 async function change(kind:'like'|'bookmark'){
  if(lock.current)return;const request=pending.current??{requestId:crypto.randomUUID(),kind,active:kind==='like'?!value.liked:!value.bookmarked};pending.current=request;lock.current=true;setBusy(true);setError('');
  try{const r=await localFetch('/api/reactions?documentId='+documentId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});setValue(await r.json() as Reactions);pending.current=null;onChanged();}
  catch(e){if(e instanceof LocalRequestError&&e.status!==undefined&&e.status<500)pending.current=null;setError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 return <div className="document-reactions"><button disabled={busy||!!pending.current} aria-pressed={value.liked} aria-label={value.liked?'Убрать лайк':'Нравится'} onClick={()=>void change('like')}><Heart size={16} fill={value.liked?'currentColor':'none'}/><span>{value.likes}</span></button><button disabled={busy||!!pending.current} aria-pressed={value.bookmarked} aria-label={value.bookmarked?'Убрать из избранного':'В избранное'} onClick={()=>void change('bookmark')}><Bookmark size={16} fill={value.bookmarked?'currentColor':'none'}/><span>{value.bookmarked?'В избранном':'Сохранить'}</span></button>{error&&<span role="alert">{error}</span>}{pending.current&&!busy&&<button onClick={()=>void change(pending.current!.kind)}>Повторить сохранение</button>}</div>;
}
