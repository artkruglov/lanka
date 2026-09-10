'use client';
import {useEffect,useRef,useState,useReducer,useMemo} from 'react';
import type {Source,DeckDoc} from '@/lib/domain/model';
import {renderDataObject,minimumDataBox,type DataObject} from '@/lib/domain/data-object';
import {SlideCanvas} from './slide-canvas';
import {dataSizeOptions,objectBox,sameBox} from '@/lib/domain/data-layout';
import {DataWindowDraft,dataRecordSaved,type DataWindowRecord} from '@/lib/project/data-window-draft';
import {dataConflictText,type DataChoices,type DataConflict} from '@/lib/domain/data-merge';
import {downloadJson} from '@/lib/export';
import {applyDataDraft,resolveDataDraft,applyDataObjectChange,DataDraftConflict,type DataDraft} from '@/lib/domain/data-draft';
export function DataObjectEditor({element,current,saved,revision,documentId,previewDoc,slideId,owner,recovered,sources,onApply,onClose,onJournalChange}:{element:DataObject;current?:DataObject;saved?:DataObject;revision:number;documentId:string;previewDoc:DeckDoc;slideId:string;owner:string;recovered?:DataWindowRecord;sources:Source[];onApply:(e:DataObject,expected:DataObject)=>boolean;onClose:()=>void;onJournalChange:()=>void}){
 const [session]=useState(()=>new DataWindowDraft({documentId,slideId,owner,base:element},undefined,recovered));
 const [,render]=useReducer(n=>n+1,0),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const [conflicts,setConflicts]=useState<DataConflict[]>([]),[choices,setChoices]=useState<DataChoices>({});
 const conflictPanel=useRef<HTMLElement>(null),composing=useRef(false);
 useEffect(()=>{if(conflicts.length){conflictPanel.current?.focus();conflictPanel.current?.scrollIntoView({block:'nearest'});}},[conflicts]);
 const draft=session.record.draft,changed=session.changed;
 const preview=useMemo(()=>{
  if(!current)return {problem:'Объект удалён или редактор занят. Черновик остаётся доступным.'};
  try{
   const value=resolveDataDraft(draft,session.record.base,current,choices),rendered=renderDataObject(value);
   const next=applyDataObjectChange(previewDoc,slideId,value,current),index=next.slides.findIndex(s=>s.id===slideId);
   return {slide:next.slides[index],index,overflow:rendered.overflow,canResize:!!minimumDataBox(value),wideLabels:rendered.meta?.variant==='bars-wide-labels',sizes:dataSizeOptions(value,current,next.slides[index].canvas!)};
  }catch(e){return {problem:e instanceof Error?e.message:'Проверьте данные.'};}
 },[draft,current,choices,previewDoc,slideId,session]);
 const panel=useRef<HTMLDivElement>(null),mounted=useRef(false),savedRef=useRef({saved,revision}),callbacks=useRef({onApply,onClose,onJournalChange});
 savedRef.current={saved,revision};callbacks.current={onApply,onClose,onJournalChange};
 const settled=()=>{if(mounted.current)render();callbacks.current.onJournalChange();};
 useEffect(()=>{
  mounted.current=true;const previous=document.activeElement as HTMLElement|null;panel.current?.focus();
  void session.start().finally(settled);
  const warn=(e:BeforeUnloadEvent)=>{if(!session.protected&&!dataRecordSaved(session.record,savedRef.current.saved,savedRef.current.revision)){e.preventDefault();e.returnValue='';}};
  window.addEventListener('beforeunload',warn);
  return()=>{mounted.current=false;window.removeEventListener('beforeunload',warn);previous?.focus();};
 },[session]);
 const set=(fn:(d:DataDraft)=>void)=>{
  try{const next=structuredClone(session.record.draft);fn(next);const writing=session.set(next);render();void writing.finally(settled);setError('');setConflicts([]);setChoices({});}
  catch(e){setError((e as Error).message);}
 };
 const close=async()=>{
  setWorking(true);await session.flush();
  if(!changed){try{await session.discard();callbacks.current.onJournalChange();}catch{setError('Не удалось убрать предыдущую копию черновика с устройства.');if(mounted.current)setWorking(false);return;}}
  if(session.protected||dataRecordSaved(session.record,savedRef.current.saved,savedRef.current.revision))callbacks.current.onClose();
  else setError('Последние правки не сохранены на устройстве. Скачайте копию данных или явно отмените правки.');
  if(mounted.current)setWorking(false);
 };
 const discard=async()=>{
  setWorking(true);try{await session.discard();callbacks.current.onJournalChange();callbacks.current.onClose();}
  catch{setError('Не удалось удалить черновик на устройстве. Его копия может оставаться доступной после открытия страницы.');}
  finally{if(mounted.current)setWorking(false);}
 };
 const apply=async()=>{
  setWorking(true);
  try{
   if(!current)throw Error('Объект удалён или недоступен. Можно скачать копию данных; существующий слайд не перезаписан.');
   const value=applyDataDraft(draft,session.record.base,current,choices);
   await session.stage(value,savedRef.current.revision);
   const durable=callbacks.current.onApply(value,current);
   if(durable){try{await session.discard();}catch{/* The saved editor copy owns the edit; an older data fallback may remain. */}}
   if(durable||session.protected)callbacks.current.onClose();
   else setError('Правки применены, но копия на устройстве пока недоступна. Дождитесь сохранения презентации или скачайте копию данных.');
   settled();
  }catch(e){if(e instanceof DataDraftConflict)setConflicts(e.conflicts);setError(e instanceof Error?e.message:'Проверьте данные.');}
  finally{if(mounted.current)setWorking(false);}
 };
 const reorder=(index:number,delta:number)=>set(d=>{const rows=d.data.rows;[rows[index],rows[index+delta]]=[rows[index+delta],rows[index]];});
 return <div className="data-editor-backdrop"><div ref={panel} className="data-editor" data-kind={draft.kind} role="dialog" aria-modal="true" aria-label={draft.kind==='chart'?'Данные диаграммы':'Данные таблицы'} tabIndex={-1} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{
  if(composing.current||e.nativeEvent.isComposing||e.keyCode===229){e.stopPropagation();return;}
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!working)void close();}
  if((e.metaKey||e.ctrlKey)&&(e.key.toLowerCase()==='s'||e.key==='Enter')){e.preventDefault();e.stopPropagation();if(!working)void apply();}
  if(e.key==='Tab'){const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')??[]).filter(el=>el.getClientRects().length>0);const first=controls[0],last=controls.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}>
 <div className="data-editor-body"><h3>{draft.kind==='chart'?'Данные диаграммы':'Данные таблицы'}</h3>
 <p>Измените данные и нажмите «Применить». Соседние элементы сохранятся. Размер объекта изменится только при выборе нового варианта.</p>
 <p role="status">{session.pending?'Сохраняем черновик…':session.problem||(!changed?'Изменений в данных пока нет.':session.persistent?'Черновик сохранён на этом устройстве.':'Черновик ещё не сохранён.')}{recovered?' Восстановлена незавершённая правка.':''}</p>
 <div className="data-editor-workarea"><fieldset disabled={working}>
 {!!conflicts.length&&<section ref={conflictPanel} tabIndex={-1} aria-label="Конфликты данных"><p>Эти данные также изменили в другой вкладке или сессии. Выберите значения, затем нажмите «Применить».</p><h4>Выберите значения</h4>{conflicts.map(c=><div className="data-conflict" key={c.key}><strong>{c.label}</strong>{([['mine','Мои правки',c.mine],['current','В презентации',c.current]] as const).map(([option,label,value])=><label key={option}><input type="radio" name={c.key} checked={choices[c.key]===option} onChange={()=>setChoices(old=>({...old,[c.key]:option}))}/><span>{label}<pre>{dataConflictText(session.record.base,c.path,value,sources)}</pre></span></label>)}</div>)}</section>}
 <label>Источник <select value={draft.data.sourceId??''} onChange={e=>set(d=>{if(e.target.value)d.data.sourceId=e.target.value;else delete d.data.sourceId;})}><option value="">Не указан</option>{draft.data.sourceId&&!sources.some(s=>s.id===draft.data.sourceId)&&<option value={draft.data.sourceId}>Недоступный источник</option>}{sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
 {draft.kind==='chart'&&<label>Единицы <input aria-label="Единицы диаграммы" maxLength={20} value={draft.data.unit} onChange={e=>set(d=>{if(d.kind==='chart')d.data.unit=e.target.value;})}/></label>}
 <div className="data-editor-scroll" role="region" aria-label="Ячейки данных" tabIndex={0}><table><thead><tr>{draft.kind==='chart'?<><th>Подпись</th><th>Значение</th></>:draft.data.columns.map((c,j)=><th key={c.id}>
 <input aria-label={`Название колонки ${j+1}`} maxLength={60} value={c.label} onChange={e=>set(d=>{if(d.kind==='table')d.data.columns[j].label=e.target.value;})}/>
 <select aria-label={`Тип колонки ${j+1}`} value={c.valueType} onChange={e=>set(d=>{if(d.kind==='table'){const c=d.data.columns[j];c.valueType=e.target.value as 'text'|'number';if(c.valueType==='number')c.role='number';else if(c.role==='number')c.role='text';}})}><option value="text">Текст</option><option value="number">Число</option></select>
 <input aria-label={`Единицы колонки ${j+1}`} placeholder="Единицы" maxLength={20} value={c.unit} onChange={e=>set(d=>{if(d.kind==='table')d.data.columns[j].unit=e.target.value;})}/>
 <button aria-label={`Сдвинуть колонку ${j+1} влево`} disabled={j===0} onClick={()=>set(d=>{if(d.kind==='table')[d.data.columns[j-1],d.data.columns[j]]=[d.data.columns[j],d.data.columns[j-1]];})}>←</button>
 <button aria-label={`Удалить колонку ${j+1}`} disabled={draft.data.columns.length<=2} onClick={()=>set(d=>{if(d.kind==='table'){d.data.columns=d.data.columns.filter(v=>v.id!==c.id);d.data.rows.forEach(r=>delete r.cells[c.id]);}})}>Удалить</button>
 </th>)}<th>Строка</th></tr></thead><tbody>
 {draft.data.rows.map((row,i)=><tr key={row.id}>
 {draft.kind==='chart'?<><td><input aria-label={`Подпись строки ${i+1}`} maxLength={50} value={draft.data.rows[i].label} onChange={e=>set(d=>{if(d.kind==='chart')d.data.rows[i].label=e.target.value;})}/></td><td><input aria-label={`Значение строки ${i+1}`} inputMode="decimal" value={draft.data.rows[i].value} onChange={e=>set(d=>{if(d.kind==='chart')d.data.rows[i].value=e.target.value;})}/></td></>:draft.data.columns.map(c=><td key={c.id}><input aria-label={`${c.label}, строка ${i+1}`} inputMode={c.valueType==='number'?'decimal':'text'} maxLength={160} value={draft.data.rows[i].cells[c.id]} onChange={e=>set(d=>{if(d.kind==='table')d.data.rows[i].cells[c.id]=e.target.value;})}/></td>)}
 <td><button aria-label={`Строка ${i+1} вверх`} disabled={i===0} onClick={()=>reorder(i,-1)}>↑</button><button aria-label={`Строка ${i+1} вниз`} disabled={i===draft.data.rows.length-1} onClick={()=>reorder(i,1)}>↓</button><button aria-label={`Удалить строку ${i+1}`} disabled={draft.data.rows.length<=1} onClick={()=>set(d=>{d.data.rows=d.data.rows.filter(r=>r.id!==row.id) as typeof d.data.rows;})}>Удалить</button></td></tr>)}
 </tbody></table></div>
 <div className="data-editor-actions"><button disabled={draft.data.rows.length>=(draft.kind==='chart'?8:6)} onClick={()=>set(d=>{const id=crypto.randomUUID();if(d.kind==='chart')d.data.rows.push({id,label:'',value:''});else d.data.rows.push({id,cells:Object.fromEntries(d.data.columns.map(c=>[c.id,'']))});})}>Добавить строку</button>
 {draft.kind==='table'&&<button disabled={draft.data.columns.length>=4} onClick={()=>set(d=>{if(d.kind==='table'){const id=crypto.randomUUID();d.data.columns.push({id,label:'Колонка',valueType:'text',role:'text',unit:''});d.data.rows.forEach(r=>r.cells[id]='');}})}>Добавить колонку</button>}
 <button onClick={()=>downloadJson(session.record,'lanka-data-draft.json')}>Скачать копию</button><button onClick={()=>void discard()}>Отменить правки</button></div>

 </fieldset><aside className="data-editor-preview"><details open><summary>Предпросмотр слайда</summary>
 {preview.slide?<><SlideCanvas slide={preview.slide} brand={previewDoc.brand} design={previewDoc.design} index={preview.index} total={previewDoc.slides.length}/>
 <p role="status">{preview.overflow?(preview.sizes?.length?'Данные не помещаются в прежнюю рамку. Выберите размер и проверьте результат.':preview.canResize?'Подходящего свободного места не найдено. Сократите подписи или освободите место на слайде.':'В этой композиции подписи не помещаются. Сократите их или разделите данные на слайды.'):preview.wideLabels?'Для длинных подписей подобрана более широкая колонка. Данные сохраняются целиком.':'Так будет выглядеть слайд после применения данных.'}</p>
 {!!preview.sizes?.length&&<div aria-label="Варианты размера">{preview.sizes.map(option=><button key={option.id} disabled={working} onClick={()=>set(d=>Object.assign(d,option.box))}>{option.label}</button>)}</div>}</>:<p role="status">{preview.problem}</p>}
 {!sameBox(draft,session.record.base)&&<div><p>Выбран новый размер. Данные и размер применятся вместе.</p><button disabled={working} onClick={()=>set(d=>Object.assign(d,objectBox(session.record.base)))}>Вернуть прежний размер</button></div>}
 <p>Предпросмотр не меняет презентацию. Нажмите «Применить», когда результат подходит.</p>
 </details></aside></div>
 {error&&<p role="alert">{error}</p>}
 </div><div className="data-editor-footer"><button disabled={working} onClick={()=>void close()}>Закрыть</button><button disabled={working} className="data-apply-action" onClick={()=>void apply()}>Применить</button></div>
 </div></div>;
}
