import { validateDoc, type DeckDoc, type Slide } from "../domain/model";
import { scene } from "../domain/scene";
import { designReview,type DesignIssue } from "../domain/design-review";
import { canonicalJson } from "../domain/canonical-json";
import { allowedLockedUpdate } from "../domain/canvas-lock";
import { withCanvas } from "../domain/canvas";

export class EditDesignError extends Error {}

/** Assess the rendered proposal against the saved version, without mutating it. */
export function assertEditDesign(doc:DeckDoc, changes:{slideId:string;after:Slide}[]) {
  const changed=new Map(changes.map(c=>[c.slideId,c.after]));
  const candidate=validateDoc({...doc,slides:doc.slides.map(s=>changed.get(s.id)||s)});
  const key=(issue:DesignIssue)=>`${issue.slideId||""}:${issue.code&&issue.elementId?`${issue.code}:${issue.elementId}`:issue.message}`;
  const existing=new Map(designReview(doc).issues.map(i=>[key(i),i]));
  const problems=designReview(candidate).issues.filter(i=>{
    if(!i.slideId||!changed.has(i.slideId))return false;
    const before=existing.get(key(i));
    return !before||i.contrast!==undefined&&before.contrast!==undefined&&i.contrast/(i.minimum||1)<before.contrast/(before.minimum||1)-0.001;
  })
    .map(i=>`Слайд ${doc.slides.findIndex(s=>s.id===i.slideId)+1}: ${i.message}`);
  doc.slides.forEach((before,index)=>{
    const after=changed.get(before.id);if(!after)return;
    if(before.canvas) {
      if(!after.canvas)problems.push(`Слайд ${index+1}: сохраните ручные объекты canvas.`);
      before.canvas.forEach((object,layer)=>{
        if(object.locked&&(!allowedLockedUpdate(object,after.canvas?.find(e=>e.id===object.id),layer)||after.canvas?.findIndex(e=>e.id===object.id)!==layer))
          problems.push(`Слайд ${index+1}: положение заблокированного объекта защищено. У фонового прямоугольника можно менять только цвет, сохраняя locked:true.`);
      });
      const originalFields=["body","eyebrow","layout","metrics","chart","chartUnit","comparison","table","assetId"] as const;
      if(originalFields.some(key=>canonicalJson(before[key]??null)!==canonicalJson(after[key]??null)))
        problems.push(`Слайд ${index+1}: поля исходного шаблона не управляют объектами. Измените canvas.`);
      if(after.canvas && withCanvas(after,after.canvas).title!==after.title)
        problems.push(`Слайд ${index+1}: название должно соответствовать видимым объектам заголовка.`);
    }
    if(scene(after,doc.brand,index,doc.slides.length,doc.design).overflow&&!scene(before,doc.brand,index,doc.slides.length,doc.design).overflow)
      problems.push(`Слайд ${index+1}: правка создаёт переполнение. Сократите изменяемый текст.`);
    if(!after.canvas&&doc.design==="focus-v3"&&before.layout==="cover"&&after.layout==="cover"&&before.title.includes("\n")&&!after.title.includes("\n"))
      problems.push(`Слайд ${index+1}: сохраните две смысловые части обложки и цветовой акцент, разделённые переносом строки.`);
  });
  if(problems.length)throw new EditDesignError(problems.join(" "));
}
