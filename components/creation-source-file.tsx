import {useEffect,useRef,useState} from 'react';
import {localFetch} from '../lib/project/local-client';
import {sourceIntakeViewSchema,type SourceIntakeView} from '../lib/domain/source-extraction';

export function CreationSourceFile({initialId,selectedId,disabled,onPreview,onSelect,onBlocked}:{initialId?:string;selectedId?:string;disabled:boolean;onPreview:(id:string|undefined)=>void;onSelect:(id:string|undefined)=>void;onBlocked:(blocked:boolean)=>void}){
  const [id,setId]=useState(initialId),[item,setItem]=useState<SourceIntakeView|null>(null),[selected,setSelected]=useState(selectedId),[loading,setLoading]=useState(!!initialId),[error,setError]=useState('');
  const [recent,setRecent]=useState<SourceIntakeView[]>([]);
  const retryFile=useRef<{file:File;requestId:string}|null>(null);
  useEffect(()=>{if(id)return;let active=true;void localFetch('/api/v1/source-intakes').then(r=>r.json()).then(v=>{if(active)setRecent(sourceIntakeViewSchema.array().parse(v));}).catch(()=>{});return()=>{active=false;};},[id]);
  useEffect(()=>{
    if(!initialId)return;
    let active=true;onBlocked(true);
    void localFetch(`/api/v1/source-intakes/${initialId}`).then(r=>r.json()).then(raw=>{if(!active)return;const next=sourceIntakeViewSchema.parse(raw);setItem(next);onBlocked(selectedId!==next.id||!['extracted','partial'].includes(next.extraction.status));}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
    // A reopened form restores the saved intake; later uploads manage their own lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  function select(value:string|undefined){setSelected(value);onSelect(value);onBlocked(!value&&!!id);}
  async function upload(file:File,retryId?:string){
    setError('');if(file.size>5_000_000){setError('Файл превышает 5 МБ.');return;}
    setLoading(true);onBlocked(true);
    const requestId=retryId||crypto.randomUUID();retryFile.current={file,requestId};setId(requestId);onPreview(requestId);
    try {
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать выбранный файл.'));reader.readAsDataURL(file);});
      const r=await localFetch('/api/v1/source-intakes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,name:file.name,base64})});
      const next=sourceIntakeViewSchema.parse(await r.json());setItem(next);setId(next.id);onPreview(next.id);
      select(next.extraction.status==='extracted'?next.id:undefined);
      onBlocked(next.extraction.status!=='extracted');
      retryFile.current=null;
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  }
  async function remove(){
    setLoading(true);setError('');onBlocked(true);
    try {if(id)await localFetch(`/api/v1/source-intakes/${id}/remove`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});retryFile.current=null;setItem(null);setId(undefined);onPreview(undefined);select(undefined);onBlocked(false);}
    catch(e){setError((e as Error).message);}finally{setLoading(false);}
  }
  const readable=item&&['extracted','partial'].includes(item.extraction.status)&&item.extraction.fragments.length>0;
  return <section className="creation-source-file" aria-label="Исходный файл для презентации">
    {!id&&<label>Добавить файл<input type="file" aria-label="Исходный файл" accept=".pdf,.pptx,.docx,.xlsx,.txt,.md,.csv,.json" disabled={disabled||loading} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void upload(file);}}/></label>}
    {!id&&recent.length>0&&<details><summary>Недавние файлы · {recent.length}</summary><div className="creation-source-excerpt">{recent.map(file=><p key={file.id}><button type="button" disabled={disabled||loading} onClick={()=>{setItem(file);setId(file.id);onPreview(file.id);select(undefined);onBlocked(true);}}>{file.name}</button> · {new Date(file.createdAt).toLocaleDateString('ru-RU')}</p>)}</div></details>}
    <small>PDF, Word, PowerPoint, Excel или текст · до 5 МБ. Текстовые файлы — до 200 КБ.</small>
    {loading&&<p role="status">Читаем файл…</p>}
    {error&&<p role="alert">{error}</p>}
    {error&&retryFile.current&&<button type="button" disabled={disabled||loading} onClick={()=>{const retry=retryFile.current;if(retry)void upload(retry.file,retry.requestId);}}>Повторить чтение</button>}
    {item&&<>
      <p><strong>{item.name}</strong> · {Math.ceil(item.size/1024)} КБ</p>
      <p role="status">{item.extraction.note}</p>
      {readable&&<>
        <details><summary>Посмотреть текст для агента</summary><div className="creation-source-excerpt">{item.extraction.fragments.map((f,i)=><p key={i}><strong>{f.locator}</strong><br/>{f.text}</p>)}</div></details>
        <label className="creation-source-selection"><input type="checkbox" checked={selected===item.id} disabled={disabled||loading} onChange={e=>select(e.target.checked?item.id:undefined)}/>{item.extraction.status==='partial'?'Использовать доступный текст, учитывая ограничения':'Использовать этот файл'}</label>
      </>}
      <small>{readable?'При использовании оригинал сохранится в презентации.':'Этот файл нельзя передать агенту.'} До прикрепления файл доступен 7 дней.</small>
    </>}
    {id&&<button type="button" disabled={disabled||loading} onClick={()=>void remove()}>Удалить файл из подготовки</button>}
  </section>;
}
