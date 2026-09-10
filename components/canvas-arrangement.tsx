import {useState} from 'react';
import type {CanvasElement} from '../lib/domain/model';
import {reorderCanvasLayer,type LayerDirection} from '../lib/domain/canvas-layer';
import {Popover,PopoverContent,PopoverTrigger} from './ui/popover';

type Props={active:CanvasElement;objects:CanvasElement[];compact:boolean;disabled?:boolean;onAlign:(direction:string)=>void;onLayer:(direction:LayerDirection)=>void;onDuplicate:()=>void;onRemove:()=>void};
export function CanvasArrangement(p:Props){
 const [open,setOpen]=useState(false);
 const act=(callback:()=>void)=>{setOpen(false);callback();};
 const controls=<>
  <label>По слайду <select aria-label="Выровнять объект по слайду" value="" disabled={p.disabled} onChange={e=>{if(e.target.value)act(()=>p.onAlign(e.target.value));}}>
   <option value="">Выровнять…</option>
   <option value="left">По левому краю</option><option value="center">По центру горизонтально</option><option value="right">По правому краю</option>
   <option value="top">По верхнему краю</option><option value="middle">По центру вертикально</option><option value="bottom">По нижнему краю</option>
  </select></label>
  <label>Порядок <select aria-label="Порядок объекта" value="" disabled={p.disabled} onChange={e=>{if(e.target.value)act(()=>p.onLayer(e.target.value as LayerDirection));}}>
   <option value="">Переместить…</option>
   {([['forward','На слой вперёд'],['backward','На слой назад'],['front','На передний план'],['back','На задний план']] as const).map(([direction,label])=><option key={direction} value={direction} disabled={reorderCanvasLayer(p.objects,p.active.id,direction)===p.objects}>{label}</option>)}
  </select></label>
  <button type="button" aria-label="Дублировать объект" disabled={p.disabled} onClick={()=>act(p.onDuplicate)}>Дублировать</button>
  <button type="button" className="canvas-remove-action" aria-label="Удалить объект" disabled={p.disabled} onClick={()=>act(p.onRemove)}>Удалить</button>
 </>;
 if(!p.compact)return controls;
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><button type="button" disabled={p.disabled} aria-label="Расположение и действия объекта">Расположение ···</button></PopoverTrigger>
  <PopoverContent align="end" className="canvas-arrangement-menu" aria-label="Расположение и действия объекта">{controls}</PopoverContent>
 </Popover>;
}
