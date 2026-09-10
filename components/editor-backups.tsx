import {useState} from 'react';
import {editorUpgradeBackups} from '../lib/project/editor-backups';
import {scopedStorage} from '../lib/project/browser-context';
import {download} from '../lib/project/download';
import {Button} from './ui/button';

export function EditorBackups({documentId,onImport}:{documentId:string;onImport?:(raw:string)=>void}){
 const [backups,setBackups]=useState<ReturnType<typeof editorUpgradeBackups>>({items:[],unavailable:false});
 const [importError,setImportError]=useState('');
 const refresh=()=>{
   try{setBackups(editorUpgradeBackups(scopedStorage(window.localStorage),documentId));}
   catch{setBackups({items:[],unavailable:true});}
 };
 return <details onToggle={e=>{if(e.currentTarget.open)refresh();}}>
   <summary>Копии перед обновлением редактора</summary>
   <p>Исходные черновики с этого устройства. Скачайте файл, чтобы сохранить правки отдельно от браузера. Скачивание не меняет презентацию.</p>
   {onImport&&<label>Загрузить копию из файла <input type="file" accept=".json,application/json" aria-label="Файл копии черновика" onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setImportError('');if(file.size>4_000_000){setImportError('Файл копии превышает 4 МБ.');return;}try{onImport(await file.text());}catch{setImportError('Не удалось прочитать файл копии.');}}}/></label>}
   {importError&&<p role="alert">{importError}</p>}
   {backups.unavailable&&<p role="alert">Не удалось прочитать все копии из хранилища браузера. Уже найденные файлы доступны ниже.</p>}
   {!backups.items.length&&!backups.unavailable&&<p>Для этой презентации на устройстве нет копий перед обновлением.</p>}
   {backups.items.map((backup,i)=><div key={backup.key} className="history-row">
     <p><strong>{backup.title}</strong><br/>{backup.updatedAt?`Черновик от ${new Date(backup.updatedAt).toLocaleString('ru-RU')}`:'Дата черновика неизвестна'}{backup.revision?` · исходная версия ${backup.revision}`:''}</p>
     <Button variant="outline" onClick={()=>download(new Blob([backup.raw],{type:'application/json'}),`lanka-draft-backup-${documentId}-${i+1}.json`)}>Скачать копию {i+1}</Button>
     {onImport&&<Button variant="outline" onClick={()=>onImport(backup.raw)}>Посмотреть восстановление {i+1}</Button>}
   </div>)}
 </details>;
}
