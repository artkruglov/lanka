'use client';
import {useEffect,useState} from 'react';

/** Preserve incomplete keyboard input without putting an invalid size into the document. */
export function TextSizeInput({value,disabled,onChange}:{value:number;disabled?:boolean;onChange:(value:number)=>void}){
 const [draft,setDraft]=useState(String(value));
 useEffect(()=>setDraft(String(value)),[value]);
 const valid=draft.trim()!==''&&Number.isFinite(Number(draft))&&Number(draft)>=8&&Number(draft)<=240;
 return <input aria-label="Размер текста" type="number" min={8} max={240} value={draft} disabled={disabled}
  aria-invalid={!valid} title={valid?undefined:'Введите размер от 8 до 240. Пустое или неверное значение не меняет текст.'}
  onChange={e=>{const raw=e.target.value,size=e.target.valueAsNumber;setDraft(raw);if(Number.isFinite(size)&&size>=8&&size<=240&&size!==value)onChange(size);}}
  onBlur={()=>setDraft(String(value))}
  onKeyDown={e=>{if(e.nativeEvent.isComposing||e.keyCode===229)return;if(e.key==='Escape'||e.key==='Enter'){e.preventDefault();e.stopPropagation();setDraft(String(value));e.currentTarget.blur();}}}/>;
}
