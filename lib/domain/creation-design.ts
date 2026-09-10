import {designCatalog} from "./design-catalog";
import { brandSchema, defaultBrand, type Slide } from "./model";
import seed from "../examples/lanka-sales-focus-v3.json";

export type CreationDesign = "focus-v2" | "focus-v3";
/** Browser previews and the agent's creation manifest use the same brand. */
export function creationDesignBrand(id: CreationDesign) {
  return brandSchema.parse(id === "focus-v3" ? seed.doc.brand : defaultBrand);
}
export const creationDesigns = designCatalog.map(entry=>({...entry,status:entry.statusLabel}));

export const creationPreview: Slide = {
  id: "template-preview", layout: "cover", title: "Идеи становятся\nпонятнее", eyebrow: "Команда · следующий шаг",
  body: "От первого вопроса к общему решению", notes: "", metrics: [], chart: [], chartUnit: "", sourceIds: [],
};

/** Illustrative content only; never included in the creation request. */
export const creationPreviewExamples: {id:string;name:string;slide:Slide}[] = [
  {id:'cover',name:'Обложка',slide:creationPreview},
  {id:'content',name:'Содержание',slide:{...creationPreview,id:'template-content',layout:'content',title:'От идеи к общему решению',eyebrow:'Пример содержания',body:'Соберите контекст\nОпределите аудиторию и главный вопрос.\n\nОбсудите варианты\nСравните подходы и сохраните замечания.\n\nВыберите следующий шаг\nЗафиксируйте решение и ответственного.'}},
  {id:'metrics',name:'Показатели',slide:{...creationPreview,id:'template-metrics',layout:'metrics',title:'План работы команды',eyebrow:'Условный пример',body:'Пример структуры: этапы, варианты и результат.',metrics:[{id:'example-stages',label:'Этапа работы',value:3,unit:''},{id:'example-options',label:'Варианта решения',value:2,unit:''},{id:'example-result',label:'Общий результат',value:1,unit:''}]}},
];
