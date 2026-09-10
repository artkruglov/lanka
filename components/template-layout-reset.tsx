import {useRef,useState} from 'react';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from './ui/dialog';
import {SlideCanvas} from './slide-canvas';
import type {Brand,Slide} from '../lib/domain/model';
import type {Design} from '../lib/domain/design';

export function TemplateLayoutReset({slide,brand,design,index,total,disabled,onApply}:{slide:Slide;brand:Brand;design?:Design;index:number;total:number;disabled:boolean;onApply:()=>void}){
 const opener=useRef<HTMLButtonElement>(null),cancel=useRef<HTMLButtonElement>(null);
 const [snapshot,setSnapshot]=useState<{slide:Slide;brand:Brand;design?:Design;index:number;total:number}|null>(null);
 if(!slide.canvas)return null;
 const changed=!!snapshot&&JSON.stringify(snapshot)!==JSON.stringify({slide,brand,design,index,total});
 return <>
  <Button ref={opener} variant="outline" disabled={disabled} onClick={()=>setSnapshot(structuredClone({slide,brand,design,index,total}))}>Вернуть композицию шаблона…</Button>
  <Dialog open={!!snapshot} onOpenChange={open=>{if(!open)setSnapshot(null);}}>
   <DialogContent className="template-layout-reset-dialog" onOpenAutoFocus={event=>{event.preventDefault();cancel.current?.focus();}} onCloseAutoFocus={event=>{if(opener.current){event.preventDefault();opener.current.focus();}}}>
    <DialogTitle>Вернуть композицию шаблона</DialogTitle>
    <DialogDescription>Ручные объекты будут заменены композицией из сохранённых полей слайда. Заметки и источники сохранятся.</DialogDescription>
    <p>Добавленные объекты и правки текста внутри них не переносятся автоматически. Проверьте вариант «После возврата»: именно он станет слайдом. После применения можно нажать «Отменить правку».</p>
    {snapshot&&<div className="review-pair">
     <div><p>Сейчас · объектов: {snapshot.slide.canvas?.length}</p><SlideCanvas slide={snapshot.slide} brand={snapshot.brand} design={snapshot.design} index={snapshot.index} total={snapshot.total}/></div>
     <div><p>После возврата</p><SlideCanvas slide={{...snapshot.slide,canvas:undefined}} brand={snapshot.brand} design={snapshot.design} index={snapshot.index} total={snapshot.total}/></div>
    </div>}
    {changed&&<p role="alert">Слайд или оформление изменились. Закройте окно и откройте сравнение заново.</p>}
    <div className="row"><Button disabled={disabled||changed} onClick={()=>{onApply();setSnapshot(null);}}>Применить показанный вариант</Button><Button ref={cancel} variant="outline" onClick={()=>setSnapshot(null)}>Отмена</Button></div>
   </DialogContent>
  </Dialog>
 </>;
}
