import {useEffect,useRef,useState} from 'react';
import {localFetch} from '../lib/project/local-client';
import {sourceIntakeViewSchema,type SourceIntakeView} from '../lib/domain/source-extraction';
export type AgentSourceSelection={id:string;sha256:string;acceptPartial:boolean};
/** Selection is only a draft; access is granted atomically with the new key. */
export function AgentSourcePicker({value,onChange,disabled,onBusy,purpose='agent'}:{purpose?:'agent'|'document';value:AgentSourceSelection[];onChange:(v:AgentSourceSelection[])=>void;disabled:boolean;onBusy:(busy:boolean)=>void}){
 const [files,setFiles]=useState<SourceIntakeView[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[uploading,setUploading]=useState(false),[removing,setRemoving]=useState(false);
 const retry=useRef<{file:File;requestId:string}|null>(null);
 useEffect(()=>{let active=true;void localFetch('/api/workspace-source-intakes').then(r=>r.json()).then(v=>{if(active)setFiles(sourceIntakeViewSchema.array().parse(v));}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 async function upload(file:File,requestId=crypto.randomUUID()){
  if(file.size>5_000_000){setError('Файл превышает 5 МБ.');return;}
  retry.current={file,requestId};setUploading(true);onBusy(true);setError('');
  try{
   const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать файл.'));reader.readAsDataURL(file);});
   const response=await localFetch('/api/workspace-source-intakes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,name:file.name,base64})});
   const saved=sourceIntakeViewSchema.parse(await response.json());setFiles(old=>[saved,...old.filter(f=>f.id!==saved.id)]);retry.current=null;
  }catch(e){setError((e as Error).message);}finally{setUploading(false);onBusy(false);}
 }
 async function remove(file:SourceIntakeView){
  setRemoving(true);setUploading(true);onBusy(true);setError('');
  try{await localFetch(`/api/workspace-source-intakes?id=${encodeURIComponent(file.id)}&sha256=${file.sha256}`,{method:'DELETE'});setFiles(old=>old.filter(f=>f.id!==file.id));onChange(value.filter(s=>s.id!==file.id));}
  catch(e){setError((e as Error).message);}finally{setRemoving(false);setUploading(false);onBusy(false);}
 }
 return <section aria-label={purpose==='document'?'Материалы для презентации':'Материалы для агента'} className="space-y-2 source-picker">
  <h3>{purpose==='document'?'Материалы для презентации':'Материалы для агента'} · {value.length} из 8</h3>
  <p className="hint">{purpose==='document'?'Отметьте файлы для новой презентации. Оригиналы и извлечённый текст сохранятся в её источниках. Слайды останутся пустыми; продолжить работу можно в редакторе и чате.':'Отметьте файлы для этого подключения. Агент увидит извлечённый текст и сможет приложить оригиналы к новой презентации. Остальные материалы ему не передаются.'}</p>
  <label>Добавить материал<input type="file" aria-label={purpose==='document'?'Добавить материал в презентацию':'Добавить материал для агента'} accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.json" disabled={disabled||uploading} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}}/></label>
  <p className="hint">До 5 МБ на файл; текст — до 200 КБ. Временные материалы хранятся 7 дней. {purpose==='agent'?'Доступ прекращается при отзыве или истечении ключа.':'Доступ коллег к слайдам не открывает им исходные файлы автоматически.'} Удаление из подготовки закрывает доступ к этому временному файлу у всех ключей; оригиналы в созданных презентациях сохраняются.</p>
  {(loading||uploading)&&<p role="status">{removing?'Удаляем из подготовки…':uploading?'Читаем материал…':'Загружаем список…'}</p>}
  {error&&<p role="alert">{error}</p>}
  {error&&retry.current&&<button disabled={disabled||uploading} onClick={()=>{const v=retry.current;if(v)void upload(v.file,v.requestId);}}>Повторить загрузку</button>}
  <div className="max-h-64 overflow-y-auto space-y-3">{files.map(file=>{
   const selected=value.some(s=>s.id===file.id),readable=['extracted','partial'].includes(file.extraction.status)&&file.extraction.fragments.length>0;
   return <article key={file.id} className="space-y-1"><label className="flex gap-2 items-start"><input type="checkbox" disabled={disabled||uploading||!readable||(!selected&&value.length>=8)} checked={selected} onChange={e=>onChange(e.target.checked?[...value,{id:file.id,sha256:file.sha256,acceptPartial:file.extraction.status==='partial'}]:value.filter(s=>s.id!==file.id))}/><span>{file.name}{file.extraction.status==='partial'?' — передать только доступный текст с учётом ограничений':''}</span></label>
    <p className="hint">{file.extraction.note}</p>
    <details><summary>{purpose==='document'?'Извлечённый текст':'Текст для агента'}: {file.name}</summary><div className="whitespace-pre-wrap break-words text-sm">{file.extraction.fragments.map((f,i)=><p key={i}><strong>{f.locator}</strong><br/>{f.text}</p>)}</div></details>
    <button type="button" disabled={disabled||uploading} onClick={()=>void remove(file)}>Удалить из подготовки: {file.name}</button>
   </article>;
  })}</div>
  {!loading&&!files.length&&<p className="hint">{purpose==='document'?'Материалы не выбраны. Можно создать презентацию без файлов.':'Материалы не выбраны. Можно подключить агента без файлов.'}</p>}
 </section>;
}
