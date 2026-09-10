import type { ChatSelection } from '../agents/contracts';
import type { Slide } from '../domain/model';

/** Resolve saved IDs against the current document, never against the selected slide. */
export function chatContext(selection: ChatSelection, slides: readonly Slide[]) {
  if (selection.scope === 'document') return {label:'Вся презентация', title:'Поручение ко всей презентации'};
  const index=slides.findIndex(slide=>slide.id===selection.slideId);
  if(index<0)return {label:'Слайд удалён', title:'Слайд этого поручения больше не находится в презентации'};
  const slide=slides[index], prefix=`Слайд ${index+1}`;
  if(selection.elementId){
    const object=slide.canvas?.find(element=>element.id===selection.elementId);
    const name=!object?'Объект недоступен':object.kind==='text'?object.text.trim()||'Пустой текст':object.kind==='image'?'Изображение':object.kind==='chart'?'Диаграмма':object.kind==='table'?'Таблица':'Фигура';
    return {label:`${prefix} · ${name.slice(0,60)}`,title:`Текущее название слайда: ${slide.title}. Объект: ${name}`};
  }
  const field=selection.field?{title:'Заголовок',body:'Основной текст',takeaway:'Вывод'}[selection.field]:null;
  return {label:`${prefix}${field?` · ${field}`:''}`,title:`Текущее название слайда: ${slide.title}`};
}
