import type { Comment, State } from "./model";

/** Resolve against the saved revision. The client supplies an ID, never a fabricated quote. */
export function commentAnchor(state:State, slideId:string, elementId?:string):Comment["anchor"] {
  const slide=state.doc.slides.find(s=>s.id===slideId);
  if(!slide)throw new Error("Слайд недоступен.");
  if(!elementId)return undefined;
  const element=slide.canvas?.find(e=>e.id===elementId);
  if(!element)throw new Error("Объект комментария недоступен. Выберите объект заново.");
  return {elementId,quote:element.kind==="text"?element.text.slice(0,160):element.kind==="image"?"Изображение":element.kind==="chart"?"Диаграмма":element.kind==="table"?"Таблица":"Фигура",revision:state.revision};
}
export function commentInSelection(comment:Comment, selection:{slideId:string;scope?:string;elementId?:string}):boolean {
  return (selection.scope==="document"||comment.slideId===selection.slideId)
    &&(!selection.elementId||!comment.anchor||comment.anchor.elementId===selection.elementId);
}
