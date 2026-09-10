import {reviewCompositionRhythm,type CompositionSample} from './composition-rhythm';
import type { DeckDoc } from "./model";
import { hasContrast } from "./model";
import v1Tokens from "../../design-packs/focus-v1/tokens.json";
import v1Recipes from "../../design-packs/focus-v1/recipes.json";
import v2Tokens from "../../design-packs/focus-v2/tokens.json";
import v2Recipes from "../../design-packs/focus-v2/recipes.json";
import v3Tokens from "../../design-packs/focus-v3/tokens.json";
import v3Recipes from "../../design-packs/focus-v3/recipes.json";
import { scene } from "./scene";
import { focusV3Scene } from "./focus-v3";
import {canvasContrast,type ContrastIssue} from './canvas-contrast';
export type DesignIssue={slideId?:string;message:string}&Partial<ContrastIssue>;
export function designReview(doc:DeckDoc){
  const issues:DesignIssue[]=[];
  if(!hasContrast(doc.brand))issues.push({message:"Проверьте контраст текста и основных цветов."});
  for(const s of doc.slides)if(s.canvas)issues.push(...canvasContrast(s.canvas).map(i=>({...i,slideId:s.id})));
  if (doc.design === "focus-v3") {
    const P = v3Tokens.policy;
    const compositions:CompositionSample[]=[];
    doc.slides.forEach((s, i) => {
      if(s.canvas) {
        if(scene(s,doc.brand,i,doc.slides.length,doc.design).overflow)
          issues.push({slideId:s.id,message:"Объект выходит за слайд или текст не помещается в рамку."});
        return;
      }
      const { overflow, meta } = focusV3Scene(s, doc.brand, i, doc.slides.length);
      if(!["cover","statement","closing"].includes(s.layout))compositions.push({slideId:s.id,number:i+1,variant:meta.variant});
      const say = (message: string) => issues.push({ slideId: s.id, message });
      if (overflow) say("Композиция не вмещает содержание: сократите текст или выберите другую раскладку.");
      if (meta.titleFill > P.maxTitleFill) say(`Заголовок занимает ${Math.round(meta.titleFill * 100)} % ширины: уберите одно-два слова.`);
      if (meta.occupancy < P.occupancy[0]) say("Слайд почти пустой: добавьте аргумент или объедините с соседним.");
      if (meta.occupancy > P.occupancy[1]) say("Слайд перегружен: перенесите подробности в заметки.");
      if (!["cover", "statement", "closing"].includes(s.layout) && meta.contentHeight < P.minContentHeight)
        say("Доказательство слишком маленькое для отдельного слайда.");
      if (meta.primaryTextClasses > P.primaryTextClassesPerSlide) say("Синий используется больше одного раза: оставьте один акцент.");
      if (i >= P.maxAdjacentSameLayout && doc.slides.slice(i - P.maxAdjacentSameLayout, i + 1).every(v => v.layout === s.layout))
        say("Три одинаковые композиции подряд: проверьте ритм.");
      if (s.layout === "split" && i > 0 && doc.slides[i - 1].layout === "split") say("Два сравнения подряд: одно из них, вероятно, не сравнение.");
      const recipe = v3Recipes[s.layout];
      const budget = "bodyWords" in recipe.budgets ? recipe.budgets.bodyWords : undefined;
      if (budget && s.body.trim().split(/\s+/).filter(Boolean).length > budget) say(`Сократите пояснение: ориентир ${budget} слов.`);
    });
    return { issues, composition:reviewCompositionRhythm(compositions,doc.slides.length), certification: P.certification, limitation: "Метрики раскладки проверяют структуру, не красоту; сертификация бренда отдельно." };
  }
  if(doc.design!=="focus-v1"&&doc.design!=="focus-v2")return {issues,certification:"not-assessed"};
  const tokens=doc.design==="focus-v2"?v2Tokens:v1Tokens, recipes=doc.design==="focus-v2"?v2Recipes:v1Recipes;
  doc.slides.forEach((s,i)=>{
    if(s.canvas)return;
    const titleLines=scene(s,doc.brand,i,doc.slides.length,doc.design).items.filter(p=>p.kind==="text"&&p.editField==="title").length;
    if(titleLines>tokens.policy.maxTitleLines)issues.push({slideId:s.id,message:`Заголовок занимает ${titleLines} строк: предел шаблона — ${tokens.policy.maxTitleLines}. Сократите формулировку.`});
    const recipe=recipes[s.layout];
    const max="bodyWords" in recipe?recipe.bodyWords:tokens.policy.maxBodyWords;
    if(s.body.trim().split(/\s+/).filter(Boolean).length>max)issues.push({slideId:s.id,message:`Сократите пояснение: ориентир композиции — ${max} слов. Подробности перенесите в заметки.`});
    if(i>=2&&doc.slides.slice(i-2,i+1).every(v=>v.layout===s.layout))issues.push({slideId:s.id,message:"Три одинаковые композиции подряд: проверьте ритм презентации."});
    if(doc.design==="focus-v2"&&s.layout==="split"&&s.body.split(/\n\s*\n/).some(p=>!p.includes("\n")))issues.push({slideId:s.id,message:"Для сравнения укажите короткую подпись в первой строке, сам пример — в следующих."});
  });
  return {issues,certification:tokens.policy.certification,limitation:"Это проверка правил, а не автоматическая оценка красоты или сертификация бренда."};
}
