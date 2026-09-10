import {AgentSourcePicker,type AgentSourceSelection} from './agent-source-picker';
import {useRef,useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle,DialogTrigger} from './ui/dialog';
import {Button} from './ui/button';
import {CreationDesignPicker} from './creation-design-picker';
import type {CreationDesign} from '../lib/domain/creation-design';
import {localFetch,LocalRequestError} from '../lib/project/local-client';
import {documentPath} from '../lib/project/browser-context';
export function SharedCreation({folder,kind,onCreated}:{folder:{id:string;name:string};kind:'document'|'folder';onCreated:()=>void}){
 const [open,setOpen]=useState(false),[name,setName]=useState(''),[profile,setProfile]=useState<CreationDesign>('focus-v3'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [sources,setSources]=useState<AgentSourceSelection[]>([]),[sourceBusy,setSourceBusy]=useState(false);
 const pending=useRef<{requestId:string;command:Record<string,unknown>}|null>(null),lock=useRef(false);
 async function create(){if(lock.current||sourceBusy||!name.trim())return;lock.current=true;setBusy(true);setError('');
  const request=pending.current??{requestId:crypto.randomUUID(),command:kind==='document'?{action:'create_document',title:name.trim(),folderId:null,folderResourceId:folder.id,empty:true,profile,...(sources.length?{sources}:{})}:{action:'create_folder',name:name.trim(),parentFolderResourceId:folder.id}};pending.current=request;
  try{const r=await localFetch('/api/shared-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}),result=await r.json() as {id:string};pending.current=null;setOpen(false);setName('');setSources([]);if(kind==='document')location.assign(documentPath(result.id));else onCreated();}
  catch(e){if(e instanceof LocalRequestError&&e.status!==undefined&&e.status<500)pending.current=null;setError((e as Error).message);}
  finally{lock.current=false;setBusy(false);}
 }
 return <Dialog open={open} onOpenChange={value=>{if(lock.current||sourceBusy||pending.current)return;setOpen(value);setError('');}}><DialogTrigger asChild><Button className={kind==='document'?'shared-create-document':undefined} variant={kind==='document'?'default':'outline'}>{kind==='document'?'Новая презентация в папке':'Вложенная папка'}</Button></DialogTrigger>
  <DialogContent className="document-sharing-dialog shared-creation-dialog" showCloseButton={!busy&&!sourceBusy&&!pending.current}><DialogTitle>{kind==='document'?'Новая презентация':'Новая папка'} в «{folder.name}»</DialogTitle><DialogDescription>Вы будете владельцем. Доступ наследуется от выбранной папки: её участники смогут видеть содержимое в пределах своих прав. Личные заметки и переписка презентации остаются приватными.</DialogDescription>
   <label>Название<input autoFocus aria-label="Название в общей папке" maxLength={kind==='document'?140:180} value={name} disabled={busy||!!pending.current} onChange={e=>setName(e.target.value)}/></label>
   {kind==='document'&&<CreationDesignPicker value={profile} onChange={setProfile} disabled={busy||!!pending.current}/>}
   {kind==='document'&&<details><summary>Исходные материалы · необязательно</summary><AgentSourcePicker purpose="document" value={sources} onChange={setSources} disabled={busy||!!pending.current} onBusy={setSourceBusy}/></details>}
   {error&&<p role="alert" className="project-alert">{error}</p>}{pending.current&&<p>Ответ ещё не подтверждён. Повтор отправит то же действие.</p>}
   <Button disabled={busy||sourceBusy||!name.trim()} onClick={()=>void create()}>{busy?'Создаём…':pending.current?'Повторить создание':kind==='document'?'Создать и открыть':'Создать папку'}</Button>
  </DialogContent>
 </Dialog>;
}
