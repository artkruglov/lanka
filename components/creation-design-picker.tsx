import {useId,useState} from 'react';
import { creationDesignBrand, creationDesigns, creationPreviewExamples, type CreationDesign } from "../lib/domain/creation-design";
import { SlideCanvas } from "./slide-canvas";

export function CreationDesignPicker({value,onChange,disabled=false,expanded=false}:{value:CreationDesign;onChange:(value:CreationDesign)=>void;disabled?:boolean;expanded?:boolean}) {
  const [exampleId,setExampleId]=useState('cover'),exampleSelectId=useId(),radioGroup=useId();
  const example=creationPreviewExamples.find(item=>item.id===exampleId)??creationPreviewExamples[0];
  return <details className="creation-design-picker" open={expanded||undefined}>
    <summary>Оформление · {creationDesigns.find(d=>d.id===value)?.name} <span>Посмотреть и выбрать</span></summary>
    <fieldset disabled={disabled}>
      <legend>Шаблон новой презентации</legend>
      <p className="creation-design-scope">Выбор применяется к новой презентации. Существующие документы сохранят своё оформление.</p>
      <div className="creation-design-example"><label htmlFor={exampleSelectId}>Пример слайда</label><select id={exampleSelectId} value={exampleId} onChange={e=>setExampleId(e.target.value)}>{creationPreviewExamples.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="creation-design-options">
        {creationDesigns.map(design=><article key={design.id} className="creation-design-option" data-selected={design.id===value}><label>
          <span className="creation-design-preview" aria-hidden="true"><SlideCanvas slide={example.slide} brand={creationDesignBrand(design.id)} design={design.id}/></span>
          <span className="creation-design-heading"><input type="radio" name={radioGroup} value={design.id} checked={design.id===value} onChange={()=>onChange(design.id)}/><strong>{design.name}</strong><small>{design.status}</small></span>
          <span className="creation-design-description">{design.description}</span>
        </label><details className="creation-design-guidance"><summary>Когда использовать</summary><p><strong>Подходит для</strong></p><ul>{design.useFor.map(job=><li key={job}>{job}</li>)}</ul><p><strong>Ограничения</strong></p><ul>{design.avoidFor.map(limit=><li key={limit}>{limit}</li>)}</ul><p>{design.note}</p></details></article>)}
      </div>
      <p>Пример показывает оформление. Агент подберёт композиции под ваш текст; содержание примера не попадёт в презентацию.</p>
    </fieldset>
  </details>;
}
