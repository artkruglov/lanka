import {useEffect,useState} from 'react';
import {localFetch} from '../lib/project/local-client';
import type {SourceExtraction} from '../lib/domain/source-extraction';
export type DocumentSourceConsent={id:string;sha256:string;contentHash:string;acceptPartial:boolean};
type Item=Omit<DocumentSourceConsent,'acceptPartial'>&{name:string;kind:string;contentType:string;excerpt:string;extraction?:SourceExtraction};
export function DocumentAgentSourcePicker({value,onChange,disabled,onBusy,documentId}:{documentId?:string;value:DocumentSourceConsent[];onChange:(value:DocumentSourceConsent[],revision:number)=>void;disabled:boolean;onBusy:(value:boolean)=>void}){
 const [items,setItems]=useState<Item[]>([]),[revision,setRevision]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let live=true;setLoading(true);onBusy(true);void localFetch('/api/agent-delegations?sourcePreview=1'+(documentId?'&documentId='+encodeURIComponent(documentId):''),{cache:'no-store'}).then(r=>r.json() as Promise<{revision:number;items:Item[]}>).then(r=>{if(live){setItems(r.items);setRevision(r.revision);onChange([],r.revision);setError('');}}).catch(e=>{if(live){setItems([]);setError(e.message);}}).finally(()=>{if(live){setLoading(false);onBusy(false);}});return()=>{live=false;};},[refresh,documentId]);
 return <section className="source-picker" aria-label="Источники этой презентации">
 <p>Владелец может передать выбранные тексты этому подключению. Оригиналы файлов, изображения и остальные источники не открываются. Изменение текста требует нового разрешения.</p>
 {loading&&<p role="status">Читаем источники…</p>}{error&&<p role="status">{error}</p>}
 {items.map(item=><article key={item.id}><label><input type="checkbox" checked={value.some(v=>v.id===item.id)} disabled={disabled||loading||(!value.some(v=>v.id===item.id)&&value.length>=8)} onChange={e=>onChange(e.target.checked?[...value,{id:item.id,sha256:item.sha256,contentHash:item.contentHash,acceptPartial:item.extraction?.status==='partial'}]:value.filter(v=>v.id!==item.id),revision)}/>{item.name}{item.extraction?.status==='partial'?' — разрешить доступный текст с учётом ограничений':''}</label><details><summary>Что увидит агент: {item.name}</summary><p>{item.extraction?.note}</p><p className="whitespace-pre-wrap break-words">{item.excerpt}</p>{item.extraction?.fragments.map((f,i)=><p className="whitespace-pre-wrap break-words" key={i}><strong>{f.locator}</strong><br/>{f.text}</p>)}</details></article>)}
 {!loading&&!error&&!items.length&&<p>Нет доступных текстовых источников. Можно выдать подключение без материалов.</p>}
 <p>Выбрано: {value.length} из 8.</p><button type="button" disabled={disabled||loading} onClick={()=>{onChange([],0);setRefresh(v=>v+1);}}>Обновить список источников</button>
 </section>;
}
