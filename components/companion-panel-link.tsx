import {useEffect,useState} from 'react';
import {companionPanelLink} from '../lib/project/companion-panel-link.mjs';
import {corporateContext,scopedStorage} from '../lib/project/browser-context';
export function CompanionPanelLink({sessionId}:{sessionId:string}){
 const [saved,setSaved]=useState(''),[draft,setDraft]=useState(''),[editing,setEditing]=useState(false),[error,setError]=useState('');
 const storageKey='companion-panel:'+sessionId;
 function scopedLink(value:string){const context=corporateContext();return companionPanelLink(value,sessionId,context?.tenantId?`${location.origin}/mcp/organizations/${context.tenantId}`:undefined);}
 useEffect(()=>{try{const value=scopedStorage(sessionStorage).getItem(storageKey);if(value)setSaved(scopedLink(value));}catch{setSaved('');}},[sessionId,storageKey]);
 function save(){try{const value=scopedLink(draft);scopedStorage(sessionStorage).setItem(storageKey,value);setSaved(value);setDraft('');setError('');setEditing(false);}catch{setError('Вставьте локальную ссылку из терминала панели, целиком со знаком #. Она должна относиться к этой беседе.');}}
 return <details className="workspace-chat-panel-link"><summary>Локальная панель агента</summary>
  {saved&&!editing?<p><a href={saved} target="_blank" rel="noopener noreferrer">Открыть панель агента ↗</a> <button onClick={()=>setEditing(true)}>Сменить ссылку</button></p>:<><p>Если панель уже запущена на этом компьютере, вставьте её ссылку из терминала. Она сохранится только в этой вкладке браузера.</p><label>Ссылка локальной панели<input type="password" autoComplete="off" value={draft} onChange={e=>setDraft(e.target.value)} placeholder="http://127.0.0.1:…/#…" /></label><button disabled={!draft.trim()} onClick={save}>Сохранить ссылку</button>{saved&&<button onClick={()=>{setEditing(false);setDraft('');setError('');}}>Отмена</button>}</>}
  {error&&<p role="alert">{error}</p>}
 </details>;
}
