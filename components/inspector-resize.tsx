import {useEffect,useRef,useState} from 'react';
import {scopedStorage} from '../lib/project/browser-context';

/** Changes only editor chrome. Slide geometry and selection remain untouched. */
export function InspectorResize(){
 const handle=useRef<HTMLDivElement>(null);
 const drag=useRef<{id:number;x:number;width:number}|null>(null);
 const preferred=useRef<number|null>(null);
 const [width,setWidth]=useState(310);
 const [maximum,setMaximum]=useState(560);
 function bounds(){return Math.max(280,Math.min(560,(handle.current?.closest('.project-columns')?.clientWidth??innerWidth)-440));}
 function apply(value:number,persist=true){
  const max=bounds(),next=Math.round(Math.max(280,Math.min(max,value)));
  const root=handle.current?.closest<HTMLElement>('.project-columns');
  if(root){root.style.setProperty('--inspector-width',`${next}px`);root.dataset.inspectorSized='true';}setWidth(next);setMaximum(max);
  if(persist)preferred.current=next;
  if(persist)try{scopedStorage(localStorage).setItem('lanka:inspector-width:v1',String(next));}catch{}
 }
 useEffect(()=>{
  let saved:number|null=null;
  try{const raw=scopedStorage(localStorage).getItem('lanka:inspector-width:v1');if(raw!==null&&Number.isFinite(Number(raw)))saved=Number(raw);}catch{}
  if(saved!==null){preferred.current=saved;apply(saved,false);}
  else {setWidth(Math.round(handle.current?.parentElement?.getBoundingClientRect().width??310));setMaximum(bounds());}
  const resize=()=>{const root=handle.current?.closest<HTMLElement>('.project-columns');if(root?.style.getPropertyValue('--inspector-width'))apply(preferred.current??parseFloat(root.style.getPropertyValue('--inspector-width')),false);else setMaximum(bounds());};
  const observer=new ResizeObserver(()=>setWidth(Math.round(handle.current?.parentElement?.getBoundingClientRect().width??310)));
  if(handle.current?.parentElement)observer.observe(handle.current.parentElement);
  window.addEventListener('resize',resize);return()=>{observer.disconnect();window.removeEventListener('resize',resize);};
 },[]);
 return <div ref={handle} className="inspector-resize" role="separator" tabIndex={0} aria-label="Ширина правой панели" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maximum} aria-valuenow={width} title="Потяните для изменения ширины. Стрелки — шаг 20 пикселей."
  onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:e.pointerId,x:e.clientX,width:e.currentTarget.parentElement!.getBoundingClientRect().width};}}
  onPointerMove={e=>{const d=drag.current;if(d&&d.id===e.pointerId)apply(d.width+d.x-e.clientX);}}
  onPointerUp={e=>{if(drag.current?.id===e.pointerId){drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}}}
  onLostPointerCapture={()=>{drag.current=null;}}
  onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const current=e.currentTarget.parentElement!.getBoundingClientRect().width;apply(e.key==='Home'?280:e.key==='End'?bounds():current+(e.key==='ArrowLeft'?20:-20));}} />;
}
