import {scopedApiPath} from '../lib/project/browser-context';
import {useEffect,useState} from 'react';
import type {CanvasElement,Source} from '@/lib/domain/model';
import {defaultImageFrame} from '@/lib/domain/image-frame';
import {assertUprightImage} from '@/lib/domain/image-orientation';
import {imageSources} from '@/lib/domain/image-source';
type ImageElement=Extract<CanvasElement,{kind:'image'}>;
export function ImageControls({element,sources,disabled,cropping,onCrop,onChange}:{element:ImageElement;sources:Source[];disabled?:boolean;cropping:boolean;onCrop:()=>void;onChange:(value:ImageElement)=>void}){
 const [size,setSize]=useState<{assetId:string;width:number;height:number}|null>(null);
 const [error,setError]=useState('');
 const [refreshUI]=useState(()=>typeof document!=='undefined'&&document.body.dataset.ui==='refresh');
 useEffect(()=>{
   let live=true;const image=new Image();setError('');
   const url=scopedApiPath(`/api/assets?id=${encodeURIComponent(element.assetId)}`);
   const loaded=new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(Error('Не удалось загрузить изображение.'));});
   const inspected=fetch(url).then(async r=>{if(!r.ok)throw Error('Не удалось загрузить изображение.');assertUprightImage(await r.arrayBuffer(),r.headers.get('content-type')?.split(';')[0]??'');});
   void Promise.all([loaded,inspected]).then(()=>{if(live)setSize({assetId:element.assetId,width:image.naturalWidth,height:image.naturalHeight});}).catch(e=>{if(live)setError((e as Error).message);});
   image.src=url;
   return()=>{live=false;};
 },[element.assetId]);
 const frame=element.frame??(size?.assetId===element.assetId?defaultImageFrame(size.width,size.height):null);
 return <>
   <label>Заменить <select aria-label="Заменить изображение" value={element.assetId} disabled={disabled} onChange={e=>onChange({...element,assetId:e.target.value,frame:undefined})}>
     {sources.filter(s=>s.id===element.assetId||imageSources(sources).includes(s)).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}
   </select></label>
   {error&&<span role="alert">{error}</span>}
   {!frame&&!error&&<span>Загружаем параметры изображения…</span>}
   {frame&&!error&&<>
     <label>В рамке <select aria-label="Режим изображения" value={frame.fit} disabled={disabled} onChange={e=>onChange({...element,frame:{...frame,fit:e.target.value as 'contain'|'cover'}})}>
       <option value="contain">Целиком</option><option value="cover">Заполнить рамку</option>
     </select></label>
     {frame.fit==='cover'&&<>
       <button disabled={disabled} aria-pressed={cropping} onClick={onCrop}>{cropping?'Готово: кадр':'Кадрировать'}</button>
       {(!refreshUI||cropping)&&<>
       <label>Масштаб <input aria-label="Масштаб изображения" type="range" min={1} max={8} step={.05} value={frame.zoom} disabled={disabled} onChange={e=>onChange({...element,frame:{...frame,zoom:Number(e.target.value)}})}/><span>{Math.round(frame.zoom*100)}%</span></label>
       <label>По горизонтали <input aria-label="Кадр по горизонтали" type="range" min={0} max={1} step={.01} value={frame.focusX} disabled={disabled} onChange={e=>onChange({...element,frame:{...frame,focusX:Number(e.target.value)}})}/></label>
       <label>По вертикали <input aria-label="Кадр по вертикали" type="range" min={0} max={1} step={.01} value={frame.focusY} disabled={disabled} onChange={e=>onChange({...element,frame:{...frame,focusY:Number(e.target.value)}})}/></label>
       <button disabled={disabled} onClick={()=>onChange({...element,frame:{...frame,zoom:1,focusX:.5,focusY:.5}})}>Сбросить кадр</button>
       </>}
     </>}
   </>}
 </>;
}
