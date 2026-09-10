"use client";
import {useState} from 'react';
import type {Source} from '../lib/domain/model';
import {Checkbox} from './ui/checkbox';

export function SlideSources({sources,selected,linked=[],editable,onChange,onDownload}:{sources:Source[];selected:string[];linked?:string[];editable:boolean;onChange:(ids:string[])=>void;onDownload?:(source:Source)=>Promise<void>}){
  const [pending,setPending]=useState<string|null>(null),[error,setError]=useState<{id:string;text:string}|null>(null);
  async function save(source:Source){if(pending||!onDownload)return;setPending(source.id);setError(null);try{await onDownload(source);}catch(e){setError({id:source.id,text:(e as Error).message});}finally{setPending(null);}}
  return <details className="panel-section">
    <summary>Источники · {new Set([...selected,...linked]).size}</summary>
    <div className="mt-4 space-y-4">
      {sources.map(source=><div key={source.id} className="space-y-2">
        <label className="row items-start text-sm">
          <Checkbox disabled={!editable||linked.includes(source.id)} checked={selected.includes(source.id)||linked.includes(source.id)} onCheckedChange={checked=>onChange(checked?[...selected.filter(id=>id!==source.id),source.id]:selected.filter(id=>id!==source.id))}/>
          <span className="min-w-0 break-words">{source.name}{linked.includes(source.id)&&<span className="block text-xs text-muted-foreground">Используется в объекте слайда</span>}</span>
        </label>
        <details className="text-sm">
          <summary>Посмотреть источник: {source.name}</summary>
          {source.extraction?<>
            <p className="mt-2 font-medium">{({extracted:'Текст извлечён',partial:'Прочитана только часть файла',unsupported:'Формат не прочитан',failed:'Не удалось прочитать файл'} as const)[source.extraction.status]}</p>
            {source.extraction.note&&<p className="hint">{source.extraction.note}</p>}
            <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words space-y-3 mt-2" tabIndex={0} aria-label={`Извлечённый текст: ${source.name}`}>
              {source.extraction.fragments.map((fragment,index)=><p key={index}><strong>{fragment.locator}</strong><br/>{fragment.text}</p>)}
            </div>
          </>:<p className="max-h-64 overflow-auto whitespace-pre-wrap break-words mt-2">{source.excerpt||'Текстовая выдержка не сохранена.'}</p>}
          <p className="hint mt-2">Это сохранённый материал, а не подтверждение достоверности его утверждений.</p>
          {onDownload&&<button className="underline text-sm" disabled={!!pending} onClick={()=>void save(source)}>{pending===source.id?"Скачиваем…":"Скачать оригинал"}</button>}
          {error?.id===source.id&&<p role="alert">{error.text}</p>}
        </details>
      </div>)}
      {!sources.length&&<p className="hint">К презентации пока не прикреплены источники.</p>}
    </div>
  </details>;
}
