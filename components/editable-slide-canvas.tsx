"use client";
import { useEffect, useMemo, useRef, useState, useId, type PointerEvent } from "react";
import {createPortal} from "react-dom";
import {Type, Square, ChartColumn, Table2, Image as ImageIcon} from 'lucide-react';
import { SlideCanvas } from "./slide-canvas";
import { slideCanvasObjects, W, H } from "@/lib/domain/scene";
import { compactPagination, growTextBox, fitElement, withCanvas } from "@/lib/domain/canvas";
import { isSlideBackground } from "@/lib/domain/canvas-lock";
import { textStyle } from "@/lib/domain/scene-typography";
import {isDataObject,type DataObject} from '@/lib/domain/data-object';
import {initialDataPlacement} from '@/lib/domain/data-layout';
import {cancelCanvasTextSession,type CanvasTextSession} from '@/lib/domain/canvas-text-session';
import {alignCanvasElement} from '@/lib/domain/canvas-align';
import {applyCanvasDrag} from '@/lib/domain/canvas-drag';
import {duplicateCanvasElement} from '@/lib/domain/canvas-duplicate';
import {reorderCanvasLayer,type LayerDirection} from '@/lib/domain/canvas-layer';
import {CanvasArrangement} from './canvas-arrangement';
import {ImageControls} from './image-controls';
import {TextSizeInput} from './text-size-input';
import {imagePlacement} from '@/lib/domain/image-frame';
import {initialImagePlacement,imagePlacementUnavailable} from '@/lib/domain/image-placement';
import {createBasicObject,basicPlacementUnavailable} from '@/lib/domain/basic-object';
import {imageSources} from '@/lib/domain/image-source';
import type { Brand, CanvasElement, DeckDoc, Slide, Source } from "@/lib/domain/model";

type Props={slide:Slide;brand:Brand;design:DeckDoc["design"];index:number;total:number;disabled?:boolean;sources:Source[];
  onImageUpload?:(file:File,elementId?:string)=>void;imageUploadDisabled?:boolean;imageUploadBlockedReason?:string;
  propertiesTarget?:HTMLElement|null;onShowCanvas?:()=>void;selectedId?:string|null;onEditData:(element:DataObject)=>void;
  onChange:(patch:Partial<Slide>,group:string)=>void;onSelect:(field:string|null)=>void};
/** A drag counts only after this many screen pixels, so a jittery click never turns a template slide into free objects. */
const DRAG_THRESHOLD_PX=5;
const sameGeometry=(a:CanvasElement,b:CanvasElement)=>a.x===b.x&&a.y===b.y&&a.w===b.w&&a.h===b.h&&
  (a.kind!=="image"||b.kind!=="image"||a.frame?.focusX===b.frame?.focusX&&a.frame?.focusY===b.frame?.focusY);
export function EditableSlideCanvas(p:Props) {
  const [refreshUI]=useState(()=>typeof document!=="undefined"&&document.body.dataset.ui==="refresh");
  const objects=useMemo(()=>slideCanvasObjects(p.slide,p.brand,p.index,p.total,p.design),[p.slide,p.brand,p.index,p.total,p.design]);
  const layersPanel=useRef<HTMLDetailsElement|null>(null);
  const selected=p.selectedId??null;
  const [editing,setEditing]=useState<string|null>(null);
  const textSession=useRef<CanvasTextSession|null>(null);
  const beginTextEditing=(id:string,added?:CanvasElement)=>{
    if(editing===id)return;
    const original=added??objects.find(e=>e.id===id);
    if(!original||original.kind!=='text'||original.locked||p.disabled)return;
    textSession.current={slide:structuredClone(p.slide),objects:structuredClone(added?[...objects,added]:objects),original:structuredClone(original),added:Boolean(added)};
    setEditing(id);p.onShowCanvas?.();
  };
  const cancelTextEditing=()=>{
    const session=textSession.current;
    if(session&&(session.written||session.added)&&!p.disabled){
      const patch=cancelCanvasTextSession(p.slide,objects,session);
      if(patch){p.onChange(patch,`${p.slide.id}:cancel-text:${session.original.id}`);if(session.added)p.onSelect(null);}
      else setInsertionError('Объект изменился во время ввода. Его текущая версия сохранена; проверьте историю перед отменой.');
    }
    textSession.current=null;setEditing(null);svg.current?.focus();
  };
  const [insertToolsOpen,setInsertToolsOpen]=useState(false);
  const insertToolsId=useId();
  useEffect(()=>setInsertToolsOpen(false),[p.slide.id]);
  const [croppingId,setCroppingId]=useState<string|null>(null);
  const [preview,setPreview]=useState<CanvasElement[]|null>(null);
  const [insertionError,setInsertionError]=useState<string|null>(null);
  useEffect(()=>setInsertionError(null),[p.slide.id]);
  const svg=useRef<SVGSVGElement>(null),textarea=useRef<HTMLTextAreaElement>(null),composing=useRef(false);
  const imageInput=useRef<HTMLInputElement>(null),uploadTarget=useRef<string|undefined>(undefined);
  const chooseImage=(id?:string)=>{uploadTarget.current=id;imageInput.current?.click();};
  useEffect(()=>{composing.current=false;if(editing)textarea.current?.focus({preventScroll:true});},[editing]);
  const drag=useRef<{id:string;startX:number;startY:number;clientX:number;clientY:number;original:CanvasElement[];resize:boolean;crop:boolean;moved:boolean;wasSelected:boolean;current:CanvasElement[]}|null>(null);
  const elements=preview??objects,active=elements.find(e=>e.id===selected);
  const select=(id:string|null)=>{p.onSelect(id?`element:${id}`:null);};
  const commit=(next:CanvasElement[],group="canvas")=>{p.onChange(withCanvas(p.slide,compactPagination(next)),`${p.slide.id}:${group}`);};
  const update=(next:CanvasElement)=>commit(objects.map(e=>e.id===next.id?fitElement(next):e),`element:${next.id}`);
  const point=(e:PointerEvent)=>{const r=svg.current!.getBoundingClientRect();return {x:(e.clientX-r.left)*W/r.width,y:(e.clientY-r.top)*H/r.height};};
  function start(e:PointerEvent,id:string,resize=false) {
    if(p.disabled)return;
    const object=objects.find(o=>o.id===id);if(!object||object.locked)return;
    // Text changes are already committed on input; clicking another object can leave text mode.
    setEditing(null);
    e.preventDefault();e.stopPropagation();const {x,y}=point(e);
    drag.current={id,startX:x,startY:y,clientX:e.clientX,clientY:e.clientY,original:objects,resize,crop:!resize&&croppingId===id&&object.kind==='image'&&object.frame?.fit==='cover',moved:false,wasSelected:selected===id,current:objects};
    select(id);svg.current?.focus();e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e:PointerEvent) {
    const d=drag.current;if(!d)return;
    // Threshold is measured on screen, not in slide units: 3 slide units were ~1.5 px on an 800 px wide stage.
    if(!d.moved&&Math.hypot(e.clientX-d.clientX,e.clientY-d.clientY)<DRAG_THRESHOLD_PX)return;
    const pt=point(e),dx=pt.x-d.startX,dy=pt.y-d.startY;
    d.moved=true;
    d.current=d.original.map(o=>{
      if(o.id!==d.id)return o;
      if(d.crop&&o.kind==='image'&&o.frame){
        const {draw}=imagePlacement(o,o.frame),clamp=(v:number)=>Math.max(0,Math.min(1,v));
        return {...o,frame:{...o.frame,focusX:clamp(o.frame.focusX-(draw.w>o.w+.01?dx/(draw.w-o.w):0)),focusY:clamp(o.frame.focusY-(draw.h>o.h+.01?dy/(draw.h-o.h):0))}};
      }
      return fitElement(d.resize?{...o,w:Math.max(16,Math.min(W-o.x,o.w+dx)),h:Math.max(16,Math.min(H-o.y,o.h+dy))}:{...o,x:o.x+dx,y:o.y+dy});
    });
    setPreview(d.current);
  }
  function end() {
    const d=drag.current;drag.current=null;setPreview(null);if(!d)return;
    const before=d.original.find(o=>o.id===d.id),after=d.current.find(o=>o.id===d.id);
    // A drag that ends where it started (or is fully clamped by the slide edge) must not create a version or freeze a template slide.
    if(d.moved&&before&&after&&!sameGeometry(before,after)){
      const next=applyCanvasDrag(objects,before,after,d.crop);
      if(next)commit(next,`move:${d.id}`);
      else setInsertionError('Объект изменился во время перетаскивания. Перемещение отменено; повторите его для текущей версии.');
    }
    else if(!d.moved&&d.wasSelected&&before?.kind==="text")beginTextEditing(d.id);
  }
  function add(kind:"text"|"rect"|"image",assetId?:string) {
    const id=crypto.randomUUID();
    const placement=kind==='image'?initialImagePlacement(objects):undefined;
    const next:CanvasElement|undefined=kind==='image'?(placement?{id,...placement,kind:'image',assetId:assetId!}:undefined):createBasicObject(objects,p.brand,p.design,id,kind);
    if(!next){setInsertionError(kind==='image'?imagePlacementUnavailable:basicPlacementUnavailable);return;}
    setInsertionError(null);
    commit([...objects,next]);select(id);if(kind==="text")beginTextEditing(id,next);
  }
  function addData(kind:'chart'|'table'){
    const id=crypto.randomUUID(),box={id,x:160,y:400,w:1280,h:350},style={design:p.design??"classic-v1",brand:p.brand};
    const e:DataObject=kind==='chart'?{...box,kind,style,data:{seriesId:crypto.randomUUID(),unit:'',rows:[{id:crypto.randomUUID(),label:'Категория A',value:20},{id:crypto.randomUUID(),label:'Категория B',value:40}]}}:
      {...box,kind,style,data:{columns:[{id:'name',label:'Название',role:'key',valueType:'text',unit:''},{id:'value',label:'Значение',role:'number',valueType:'number',unit:''}],rows:[{id:crypto.randomUUID(),cells:{name:'Категория A',value:20}},{id:crypto.randomUUID(),cells:{name:'Категория B',value:40}}]}};
    const placed=initialDataPlacement(e,objects);
    if(!placed){setInsertionError(`Для ${kind==='table'?'таблицы':'диаграммы'} нет свободного места. Добавьте новый слайд или освободите место на этом. Слайд не изменён.`);return;}
    setInsertionError(null);commit([...objects,placed]);select(id);p.onEditData(placed);
  }
  const objectName=(e:CanvasElement)=>e.kind==='text'?e.text.slice(0,45):e.kind==='image'?'Изображение':e.kind==='chart'?'Диаграмма':e.kind==='table'?'Таблица':'Фигура';
  const remove=()=>{if(!active||active.locked)return;commit(objects.filter(e=>e.id!==active.id));select(null);setEditing(null);};
  const duplicate=()=>{
    if(!active||p.disabled)return;
    const id=crypto.randomUUID(),next=duplicateCanvasElement(objects,active.id,id);
    if(!next){setInsertionError("Не удалось создать копию: объект заблокирован или достигнут предел 240 объектов на слайде.");return;}
    setInsertionError(null);setEditing(null);setCroppingId(null);commit(next,`duplicate:${id}`);select(id);
  };
  const changeLayer=(direction:LayerDirection)=>{
    if(!active||p.disabled)return;
    const next=reorderCanvasLayer(objects,active.id,direction);
    if(next!==objects)commit(next,`layer:${active.id}:${direction}`);
  };
  const alignObject=(direction:string)=>{
    if(!active||active.locked||p.disabled)return;
    const fitted=alignCanvasElement(active,direction);
    if(fitted===active)return;
    setEditing(null);setCroppingId(null);
    commit(objects.map(e=>e.id===active.id?fitted:e),`align:${active.id}:${direction}`);
  };
  const editingObject=elements.find((e):e is Extract<CanvasElement,{kind:"text"}>=>e.id===editing&&e.kind==="text");
  const editingHelp=active?.kind==='image'&&active.frame?.fit==='cover'&&croppingId===active.id?'Потяните изображение внутри рамки, чтобы выбрать кадр. Размер и положение рамки сохранятся.':'Двойной щелчок — изменить текст · Потяните объект — переместить · Потяните угол — изменить размер';
  const objectPicker=<select aria-label="Выбрать объект" value={selected??""} onChange={e=>{setEditing(null);select(e.target.value||null);if(refreshUI&&layersPanel.current){layersPanel.current.open=false;svg.current?.focus({preventScroll:true});}}}>
        <option value="">Объекты ({elements.filter(e=>!e.locked).length})</option>
        {elements.filter(e=>!e.locked).map((e,i)=><option key={e.id} value={e.id}>{i+1}. {objectName(e)}</option>)}
      </select>;
  const properties=<div data-has-selection={!!active} className={`canvas-toolbar canvas-properties${active?.kind==='image'?' canvas-image-properties':''}`} role="toolbar" aria-label="Свойства объекта" onFocusCapture={e=>{if(e.target.tagName==="INPUT")setEditing(null);}}>
      {!active&&<span>Выберите объект на слайде. Двойной щелчок — редактирование текста.</span>}
      {active&&!active.locked&&<>
      {active.kind==="text"&&<>
        <button aria-label="Редактировать текст на слайде" disabled={p.disabled} onClick={()=>beginTextEditing(active.id)}>Текст</button>
        <label>Размер <TextSizeInput key={active.id} value={active.size} disabled={p.disabled} onChange={size=>update(growTextBox({...active,size}))}/></label>
        <button aria-label="Полужирный" aria-pressed={active.bold} disabled={p.disabled} onClick={()=>update(growTextBox({...active,bold:!active.bold}))}><b>Ж</b></button>
      </>}
      {(active.kind==="text"||active.kind==="rect")&&<label>Цвет <input aria-label="Цвет объекта" type="color" value={active.color} disabled={p.disabled} onChange={e=>update({...active,color:e.target.value})}/></label>}
      {isDataObject(active)&&<button disabled={p.disabled} onClick={()=>p.onEditData(structuredClone(active))}>Данные…</button>}
      {active.kind==='image'&&<ImageControls element={active} sources={p.sources} disabled={p.disabled} cropping={croppingId===active.id} onCrop={()=>{if(croppingId!==active.id)p.onShowCanvas?.();setCroppingId(croppingId===active.id?null:active.id);}} onChange={update}/>}
      {active.kind==='image'&&p.onImageUpload&&<button disabled={p.disabled||p.imageUploadDisabled} title={(p.disabled||p.imageUploadDisabled)&&p.imageUploadBlockedReason?p.imageUploadBlockedReason:undefined} onClick={()=>chooseImage(active.id)}>Заменить файлом…</button>}
      <CanvasArrangement key={active.id} active={active} objects={objects} compact={refreshUI} disabled={p.disabled} onAlign={alignObject} onLayer={changeLayer} onDuplicate={duplicate} onRemove={remove}/>

      {editing&&<><button title="Сохранить введённый текст" onClick={()=>{setEditing(null);svg.current?.focus();}}>Готово</button><button disabled={p.disabled} onClick={cancelTextEditing}>Отменить ввод</button></>}
      </>}
    </div>;
  return <div className="canvas-editor">
    {insertionError&&<div role="alert">{insertionError} <button onClick={()=>setInsertionError(null)}>Закрыть</button></div>}
    <div className="canvas-controls-row">
    <button type="button" className="canvas-insert-toggle" aria-expanded={insertToolsOpen} aria-controls={insertToolsId} onClick={()=>setInsertToolsOpen(!insertToolsOpen)}>{insertToolsOpen?"Скрыть инструменты":"＋ Добавить и выбрать объект"}</button>
    <div id={insertToolsId} className={`canvas-toolbar canvas-insert-tools${insertToolsOpen?' is-open':''}`} role="toolbar" aria-label="Объекты слайда">
      {isSlideBackground(objects[0])&&<label>Фон <input aria-label="Цвет фона слайда" type="color" value={objects[0].color} disabled={p.disabled} onChange={e=>{setEditing(null);const background=objects[0];if(isSlideBackground(background))update({...background,color:e.target.value});}}/></label>}
      <button disabled={p.disabled} onClick={()=>add("text")}>{refreshUI?<Type size={16} aria-hidden="true"/>:'＋ '}Текст</button>
      <button disabled={p.disabled} onClick={()=>add("rect")}>{refreshUI?<Square size={16} aria-hidden="true"/>:'□ '}Фигура</button>
      <button disabled={p.disabled} onClick={()=>addData('chart')}>{refreshUI?<ChartColumn size={16} aria-hidden="true"/>:'＋ '}Диаграмма</button>
      <button disabled={p.disabled} onClick={()=>addData('table')}>{refreshUI?<Table2 size={16} aria-hidden="true"/>:'＋ '}Таблица</button>
      {p.onImageUpload&&<><button disabled={p.disabled||p.imageUploadDisabled} title={(p.disabled||p.imageUploadDisabled)&&p.imageUploadBlockedReason?p.imageUploadBlockedReason:"PNG и JPEG до 5 МБ и 32 Мп"} onClick={()=>chooseImage()}>{refreshUI?<ImageIcon size={16} aria-hidden="true"/>:'＋ '}Изображение</button><input ref={imageInput} type="file" accept="image/png,image/jpeg" hidden aria-label="Файл изображения" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)p.onImageUpload?.(file,uploadTarget.current);}}/></>}
      {!!imageSources(p.sources).length&&<select aria-label="Добавить изображение" value="" disabled={p.disabled} onChange={e=>{if(e.target.value)add("image",e.target.value);}}><option value="">Из документа…</option>{imageSources(p.sources).map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select>}
      {!refreshUI&&objectPicker}
    </div>
    <details ref={layersPanel} className="canvas-layer-list">
      <summary>Слои · {elements.length}</summary>
      {refreshUI&&<label className="canvas-layer-picker">Выбрать объект{objectPicker}</label>}
      <p>Верхние строки находятся перед нижними. Выберите здесь объект, который перекрыт на слайде.</p>
      <ul aria-label="Слои слайда">{[...elements].reverse().map(e=><li key={e.id}>
        <button type="button" disabled={e.locked} aria-pressed={selected===e.id} onClick={()=>{setEditing(null);select(e.id);if(refreshUI&&layersPanel.current){layersPanel.current.open=false;svg.current?.focus({preventScroll:true});}}}>
          <span>{objectName(e)||"Пустой текст"}</span><small>{e.locked?"Заблокирован":e.kind==='text'?"Текст":e.kind==='rect'?"Фигура":e.kind==='image'?"Изображение":e.kind==='chart'?"Диаграмма":"Таблица"}</small>
        </button>
      </li>)}</ul>
    </details>
    </div>
    {p.propertiesTarget&&active?createPortal(properties,p.propertiesTarget):properties}
    <div className="canvas-edit-surface">
      <SlideCanvas slide={{...p.slide,canvas:elements}} brand={p.brand} design={p.design} index={p.index} total={p.total} hiddenTextId={editing??undefined}/>
      <svg ref={svg} className="canvas-interaction" viewBox={`0 0 ${W} ${H}`} tabIndex={0} role="group" aria-label="Редактирование объектов слайда"
        onPointerDown={e=>{if(e.target===e.currentTarget){select(null);setEditing(null);}}}
        onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null);}}
        onKeyDown={e=>{
          if(e.target!==e.currentTarget)return;
          if(e.key==="Escape"){e.preventDefault();const wasDragging=Boolean(drag.current);drag.current=null;setPreview(null);setEditing(null);setCroppingId(null);if(!wasDragging)select(null);return;}
          if(!active||active.locked||p.disabled)return;
          if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'){e.preventDefault();duplicate();return;}
          if(e.key==='Enter'&&isDataObject(active)){e.preventDefault();p.onEditData(structuredClone(active));}
          if(e.key==="Enter"&&active.kind==="text"){e.preventDefault();beginTextEditing(active.id);}
          if(e.key==="Delete"||e.key==="Backspace"){e.preventDefault();remove();}
          if(e.key.startsWith("Arrow")){e.preventDefault();const n=e.shiftKey?10:1;const next=fitElement({...active,x:active.x+(e.key==="ArrowRight"?n:e.key==="ArrowLeft"?-n:0),y:active.y+(e.key==="ArrowDown"?n:e.key==="ArrowUp"?-n:0)});if(!sameGeometry(active,next))update(next);}
        }}>
        {elements.filter(e=>!e.locked).map(e=><rect key={e.id} x={e.x} y={e.y} width={e.w} height={e.h} fill="transparent" className="canvas-hit" aria-label={`Объект: ${objectName(e)}`}
          onPointerDown={event=>start(event,e.id)} onDoubleClick={()=>{if(!p.disabled&&isDataObject(e)){select(e.id);p.onEditData(structuredClone(e));}if(!p.disabled&&e.kind==="text"){select(e.id);beginTextEditing(e.id);}}}/>)}
        {active&&!active.locked&&<g className="canvas-selection">
          <rect x={active.x} y={active.y} width={active.w} height={active.h} fill="none" stroke="#6455D9" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none"/>
          {!editing&&<rect className="canvas-resize" aria-label="Изменить размер объекта" x={active.x+active.w-10} y={active.y+active.h-10} width={20} height={20} fill="white" stroke="#6455D9" strokeWidth={2} vectorEffect="non-scaling-stroke" onPointerDown={e=>start(e,active.id,true)}/>}
        </g>}
        {editingObject&&<foreignObject x={editingObject.x} y={editingObject.y} width={editingObject.w} height={Math.max(editingObject.h,editingObject.size*editingObject.lineHeight)}>
          <textarea ref={textarea} aria-label="Текст объекта на слайде" className="canvas-text-input" value={editingObject.text} maxLength={2400} spellCheck={false}
            style={{fontFamily:textStyle(editingObject).family,fontWeight:textStyle(editingObject).weight,fontSize:editingObject.size,lineHeight:editingObject.lineHeight,letterSpacing:(editingObject.tracking??0)*editingObject.size,color:editingObject.color}}
            onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
            onKeyDown={e=>{if(composing.current||e.nativeEvent.isComposing||e.keyCode===229){e.stopPropagation();return;}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="s")return;e.stopPropagation();if(e.key==="Escape"||e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();if(e.key==="Escape")cancelTextEditing();else {setEditing(null);svg.current?.focus();}}}}
            onChange={e=>{const session=textSession.current;if(session&&JSON.stringify(editingObject)!==JSON.stringify(session.written??session.original))textSession.current={slide:structuredClone(p.slide),objects:structuredClone(objects),original:structuredClone(editingObject)};const next=fitElement(growTextBox({...editingObject,text:e.target.value}));if(textSession.current&&next.kind==='text')textSession.current.written=structuredClone(next);update(next);}}/>
        </foreignObject>}
      </svg>
    </div>
    {!p.slide.canvas&&<p className="canvas-template-note" role="note">Прямые правки закрепят композицию этого слайда и отключат смену дизайна презентации. Чтобы сохранить работу шаблона, меняйте текст в панели «Содержание».</p>}
    <p className="canvas-help canvas-help-classic">{editingHelp}</p>
    <details className="canvas-help-disclosure"><summary>Как редактировать слайд</summary>
    <p className="canvas-help">{editingHelp}</p></details>
  </div>;
}
