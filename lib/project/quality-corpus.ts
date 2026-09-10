import {canonicalJson} from '../domain/canonical-json';
import {validateDoc,validateReferences,type State} from '../domain/model';
import {designReview} from '../domain/design-review';
import {scene} from '../domain/scene';
export type CorpusCase={id:string;slideCount:{min:number;max:number};requiresSources:boolean;requiresBaseline:boolean;humanReview:string[]};
/** Structural checks only. Neither timing, factual accuracy nor human approval is inferred. */
export function assessCorpusCase(spec:CorpusCase,input?:{state:State},baseline?:{state:State}){
 const humanReview=[...spec.humanReview,'Иерархия, ритм, читаемость всех страниц','Уместность визуалов и соответствие брифу','Редактура в браузере и Office','Измеренное время до принятого результата'];
 if(!input)return {caseId:spec.id,status:'missing',humanAcceptance:'not-assessed',humanReview};
 try{
  const doc=validateDoc(input.state.doc);validateReferences({...input.state,doc});const issues:string[]=[];
  if(doc.slides.length<spec.slideCount.min||doc.slides.length>spec.slideCount.max)issues.push('Число слайдов вне диапазона брифа.');
  if(spec.requiresSources&&!input.state.sources.length)issues.push('Не приложены исходные материалы.');
  if(spec.requiresBaseline){
   if(!baseline)issues.push('Нет исходной деки для проверки обновления.');
   else{
    const before=validateDoc(baseline.state.doc);
    if(doc.id!==before.id)issues.push('Обновление создало другой документ.');
    if(canonicalJson(doc.brand)!==canonicalJson(before.brand)||doc.design!==before.design)issues.push('Изменён исходный шаблон.');
    if(doc.slides[0]?.title!==before.slides[0]?.title)issues.push('Изменён защищённый заголовок обложки.');
    if(before.slides.some(s=>!doc.slides.some(v=>v.id===s.id)))issues.push('Потеряны ID исходных слайдов.');
    for(const slide of before.slides){const after=doc.slides.find(s=>s.id===slide.id);
     if(slide.canvas?.some(e=>{const next=after?.canvas?.find(v=>v.id===e.id);return !next||(['x','y','w','h'] as const).some(k=>e[k]!==next[k]);}))issues.push('Изменена геометрия или потеряны объекты слайда '+slide.id);
    }
   }
  }
  const review=designReview(doc);issues.push(...review.issues.map(i=>i.message));
  const overflowSlides=doc.slides.flatMap((s,i)=>scene(s,doc.brand,i,doc.slides.length,doc.design).overflow?[i+1]:[]);
  if(overflowSlides.length)issues.push('Переполнение слайдов: '+overflowSlides.join(', '));
  return {caseId:spec.id,status:issues.length?'technical-issues':'awaiting-human-review',slideCount:doc.slides.length,design:doc.design??'classic-v1',issues,overflowSlides,humanAcceptance:'not-assessed',humanReview};
 }catch(e){return {caseId:spec.id,status:'invalid-output',error:(e as Error).message,humanAcceptance:'not-assessed',humanReview};}
}
