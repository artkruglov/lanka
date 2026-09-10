import { z } from "zod";
import { blankSlide, validateDoc, type DeckDoc, type Slide } from "../domain/model";
import { scene } from "../domain/scene";
import { designReview } from "../domain/design-review";

// Agents supply meaning; the application owns IDs, composition and rendering.
const point = z.object({label:z.string().trim().min(1).max(45), text:z.string().trim().min(1).max(180)}).strict();
export const creationAnswerSchema = z.object({
  reply:z.string().trim().min(1).max(2000),
  title:z.string().trim().min(1).max(100),
  assumptions:z.array(z.string().trim().min(1).max(300)).max(6),
  slides:z.array(z.object({
    kind:z.enum(["statement","explanation","comparison","steps"]),
    title:z.string().trim().min(1).max(90),
    titleAccent:z.string().trim().min(1).max(60).optional(),
    text:z.string().trim().max(220),
    points:z.array(point).max(3),
    notes:z.string().max(2000),
  }).strict()).min(3).max(12),
}).strict();

export class CreationLayoutError extends Error {}

export const creationGuide = `
Create a new presentation in the user's language, normally 6–10 slides, or the requested count within 3–12.
Return JSON only: {"reply":"short explanation","title":"deck title","assumptions":["important assumption or missing information"],"slides":[{"kind":"explanation","title":"short subject or supported takeaway","titleAccent":"optional accent part on cover only","text":"brief subtitle or introduction","points":[{"label":"short heading","text":"concrete explanation"}],"notes":"speaker detail"}]}.
No additional fields. You do not choose coordinates, fonts, layout IDs or slide IDs. Follow designProfile.authoring, including per-part budgets. Use concise subject titles, usually 2–5 words; avoid verbose complete sentences for explanatory slides. Do not repeat the title in the subtitle.
For Focus 3, split the cover into a short main title and a meaningful titleAccent; the accent uses the brand color. Omit titleAccent on every other slide.
The first and last slides become cover and conclusion: text <= 180 characters, points=[]; title ideally <= 55 characters.
Middle slides: explanation has 1–3 points; comparison exactly 2 points; steps 2–3 points; statement no points and short text.
Use comparison only for a real comparison, steps for a sequence. Vary meaningful structures, not arbitrary decoration.
Every title <= 90 characters; every text <= 220; point label <= 45 and point text <= 180; notes <= 2000.
Put detail in notes. Keep body text brief and useful, not an outline waiting to be written.
Use only information supplied by the user or in source snapshots. Do not invent statistics, citations, companies' facts or claim verification.
When information is missing, mark assumptions and use qualitative statements or explicit placeholders. Assumptions max 6, each <=300 characters.
This creates a private draft, not an approved or published document. Existing presentation edits are a different operation.`;

export function composePresentation(base: DeckDoc, raw: string) {
  const answer=creationAnswerSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*/,"").replace(/\s*```$/, "")));
  const slides=answer.slides.map((item,index):Slide=>{
    const endpoint=index===0||index===answer.slides.length-1;
    if(endpoint&&item.points.length)throw new Error("На обложке и заключении используйте короткий текст без списка.");
    if(!endpoint&&((item.kind==="comparison"&&item.points.length!==2)||(item.kind==="steps"&&item.points.length<2)||(item.kind==="explanation"&&!item.points.length)||(item.kind==="statement"&&item.points.length)))throw new Error("Содержание не соответствует выбранной структуре слайда.");
    // Preserve additional introductory text in speaker notes; never silently discard content.
    const body=item.points.length?item.points.map((p,i)=>{
      const label=item.kind==="steps"?p.label.replace(new RegExp(`^${i+1}[.)]\\s+`),""):p.label;
      return `${label}\n${p.text}`;
    }).join("\n\n"):item.text;
    const layout:Slide["layout"]=index===0?"cover":index===answer.slides.length-1?"closing":item.kind==="comparison"?"split":item.kind==="steps"?"steps":item.kind==="statement"?"statement":"content";
    if(item.titleAccent&&(index!==0||base.design!=="focus-v3"))throw new CreationLayoutError("Акцентная часть заголовка доступна только на обложке Focus 3.");
    const slide={...blankSlide(layout),title:[item.title,item.titleAccent].filter(Boolean).join("\n"),body,notes:[item.points.length?item.text:"",item.notes].filter(Boolean).join("\n\n")};
    if(!scene(slide,base.brand,index,answer.slides.length,base.design).overflow)return slide;
    throw new CreationLayoutError(`Слайд ${index+1} не вмещается: сократите формулировки. Черновик не заменён.`);
  });
  if(answer.assumptions.length)slides[0].notes=[slides[0].notes,"Допущения:\n"+answer.assumptions.join("\n")].filter(Boolean).join("\n\n");
  const doc=validateDoc({...base,title:answer.title,slides});
  const checks=designReview(doc);
  if(checks.issues.length)throw new CreationLayoutError("Исправьте оформление: "+checks.issues.map(v=>`${v.slideId?`слайд ${doc.slides.findIndex(s=>s.id===v.slideId)+1}: `:""}${v.message}`).join(" "));
  if(doc.design==="focus-v3"&&!answer.slides[0].titleAccent)throw new CreationLayoutError("Обложке Focus 3 нужна короткая акцентная часть titleAccent, как в эталоне.");
  const reply=[answer.reply,`Создан черновик: ${slides.length} слайдов. Проверьте содержание перед использованием.`,
    answer.assumptions.length?"Допущения:\n"+answer.assumptions.map(v=>`• ${v}`).join("\n"):"",
    checks.issues.length?"Замечания к оформлению:\n"+checks.issues.map(v=>`• ${v.message}`).join("\n"):""].filter(Boolean).join("\n\n");
  return {doc,reply,checks};
}
