import {useState,useRef} from 'react';
import {CreationSourceFile} from './creation-source-file';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import {Button} from './ui/button';

type Saved={previewId?:string;selectedId?:string;requestId?:string;revision?:number};
export function DocumentSourceAttachment({documentId,revision,disabled,onBusy,onAttached}:{documentId:string;revision:number;disabled:boolean;onBusy:(busy:boolean)=>void;onAttached:()=>Promise<void>}){
 const key='lanka-document-source:'+documentId;
 const [saved,setSaved]=useState<Saved>(()=>{try{return JSON.parse(sessionStorage.getItem(key)||'{}');}catch{return {};}});
 const current=useRef(saved),[open,setOpen]=useState(!!saved.previewId),[blocked,setBlocked]=useState(!!saved.previewId),[error,setError]=useState(''),[notice,setNotice]=useState('');
 function update(patch:Partial<Saved>){const next={...current.current,...patch};current.current=next;setSaved(next);try{sessionStorage.setItem(key,JSON.stringify(next));}catch{setError('Не удалось сохранить подготовку файла. Не закрывайте вкладку до прикрепления.');}}
 async function attach(){
   if(disabled||blocked||!saved.selectedId)return;
   const attempt=current.current;
   if(!attempt.requestId)update({requestId:crypto.randomUUID(),revision});
   const request=current.current;onBusy(true);setError('');
   try{
     await localFetch(`/api/v1/materials/${documentId}/source-intakes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:request.requestId,expectedRevision:request.revision,sourceIntakeId:request.selectedId})});
     current.current={};setSaved({});try{sessionStorage.removeItem(key);}catch{}
     setOpen(false);setNotice('Источник добавлен. Выберите в чате «Вся презентация» и попросите агента обновить её по этому файлу.');await onAttached();
   }catch(e){
     if(e instanceof LocalRequestError&&e.status&&e.status>=400&&e.status<500){update({requestId:undefined,revision:undefined});await onAttached();}
     setError((e as Error).message);
   }finally{onBusy(false);}
 }
 return <section className="panel-section" aria-label="Добавить материал в презентацию">
   {!open?<Button size="sm" variant="outline" disabled={disabled} onClick={()=>{setOpen(true);setNotice('');}}>Добавить исходный файл</Button>:<>
     <p className="hint">Добавьте новый материал для агента. Старые источники сохранятся; текст слайдов меняется отдельно через правки.</p>
     <CreationSourceFile initialId={saved.previewId} selectedId={saved.selectedId} disabled={disabled} onPreview={previewId=>update({previewId,selectedId:undefined,requestId:undefined})} onSelect={selectedId=>update({selectedId,requestId:undefined})} onBlocked={setBlocked}/>
     <Button size="sm" disabled={disabled||blocked||!saved.selectedId} onClick={()=>void attach()}>Прикрепить к презентации</Button>{' '}
     <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>setOpen(false)}>Свернуть</Button>
   </>}
   {disabled&&open&&<p className="hint">Дождитесь сохранения правок перед прикреплением.</p>}
   {error&&<p className="chat-error" role="alert">{error}</p>}
   {notice&&<p className="hint" role="status">{notice}</p>}
 </section>;
}
