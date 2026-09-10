export type CompositionSample={slideId:string;number:number;variant:string};
/** Editorial advice, never a write/export gate. Variants come from the rendered scene. */
export function reviewCompositionRhythm(samples:CompositionSample[],totalSlides:number){
 const columns=samples.filter(s=>s.variant.replace(/-wide$/,'')==='cols');
 const advisories=columns.length>=4&&columns.length>=samples.length/2?[{
   code:'repeated-columns',slideIds:columns.map(s=>s.slideId),
   message:`Слайды ${columns.map(s=>s.number).join(', ')} повторяют композицию с колонками (${columns.length} из ${samples.length} проверенных содержательных слайдов). Если смысл позволяет, используйте парное сравнение или акцентный тезис. Сохраните объём и порядок из брифа. Не меняйте данные и не добавляйте декоративный график только ради разнообразия.`,
 }]:[];
 return {assessedSlides:samples.length,totalSlides,advisories};
}
